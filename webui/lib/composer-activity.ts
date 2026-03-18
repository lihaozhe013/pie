import type { AgentPhase } from '@/hooks/useAgentSession';
import { compactSummaryText, type CompactSummary } from './compact-summary';
import {
  isExplorationToolName,
  isListToolName,
  isSearchToolName,
  isShellToolName
} from './tool-names';
import {
  estimateUpdatedTokens,
  getTokenEstimateText,
  type BlockEstimator,
  type TokenEstimateCacheEntry
} from './token-estimate';
import {
  streamRateKey,
  streamRateStart,
  streamTokensPerSecond,
  type StreamRateStart
} from './stream-token-rate';
import type { AgentMessage, AssistantMessage } from './types';

/** The i18n translate function shape this module needs. */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

type ToolInput = Record<string, unknown> | undefined;

interface RunningTool {
  id: string;
  name: string;
  progress?: string;
}

/**
 * One line above the composer describes what the agent is doing right now.
 *
 * Explicit execution/wait phases win over stale streamed reasoning: after a tool
 * call the reasoning block is still the last streamed content, while the turn has
 * already moved on. Compaction takes precedence over everything, because
 * auto-compaction can hold a turn for a long time and the underlying phase would
 * read as a hang.
 */
export function composerActivityLabel(
  phase: AgentPhase,
  messages: AgentMessage[],
  streaming: AssistantMessage | null,
  compacting: boolean,
  t: Translate
): string | null {
  if (compacting) return t('chat.compacting');
  if (phase?.kind === 'running_tools') {
    if (phase.tools.length === 0) return t('chat.runningTool');
    return summarizeRunningTools(phase.tools, collectToolInputs(messages, streaming), t);
  }
  // The model writes a call's arguments before pi reports it as running, and while
  // it does the phase can still name the previous wait. Naming the tool keeps the
  // row alive through that stretch instead of blanking it until execution starts.
  const drafting = lastStreamedToolCall(streaming);
  if (drafting !== null) return t('activity.preparingTool', { name: drafting });
  if (phase?.kind === 'waiting_model') return t('activity.waitingProvider');
  if (phase?.kind === 'running_command') return t('chat.runningCommand');
  if (streaming?.content.at(-1)?.type === 'thinking') return t('activity.thinking');
  return null;
}

/**
 * The words the row keeps for its fade-out, which is the only place a finished
 * compaction can report itself now that it has no button of its own: what it
 * saved replaces the last label while the row leaves. A new run clears it, so
 * the next exit speaks for itself.
 */
export function nextCompactHold(
  hold: string | null,
  running: boolean,
  compacting: boolean,
  wasCompacting: boolean,
  result: CompactSummary | null | undefined,
  t: Translate
): string | null {
  if (running) return null;
  if (wasCompacting && !compacting && result) return compactSummaryText(result, t);
  return hold;
}

/** The tool whose arguments the streaming reply is still writing, if any. */
function lastStreamedToolCall(streaming: AssistantMessage | null): string | null {
  const block = streaming?.content.at(-1);
  return block?.type === 'toolCall' ? block.toolName : null;
}

/**
 * When the run the row would time began: its latest user prompt's time, so a
 * browser attaching to a run already in flight (a reload, a reconnect, another
 * tab's prompt) still counts from the start. Null when no prompt carries a
 * time; a run an extension started after the prompt is approximated by it.
 */
export function runStartHint(messages: AgentMessage[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    const timestamp = message.timestamp;
    if (typeof timestamp === 'number' && Number.isFinite(timestamp)) return timestamp;
  }
  return null;
}

/** No block index reaches this key: the executing call's slot stays its own. */
const RUNNING_TOOL_ESTIMATE_KEY = -1;

/**
 * The ~tokens after the label, one block at a time — never a total. While the
 * model writes a call's arguments or thinking, the count is that block's and
 * grows as it streams. While a single call executes it is what its arguments
 * cost, frozen: the model is silent, and the number changing call to call is
 * itself the progress signal. A grouped row names several calls, so no single
 * number applies. Branch order mirrors `composerActivityLabel`, so a number
 * only ever annotates what the label names.
 */
export function composerActivityTokens(
  phase: AgentPhase,
  messages: AgentMessage[],
  streaming: AssistantMessage | null,
  compacting: boolean,
  estimator: BlockEstimator
): number | null {
  if (compacting) return null;
  if (phase?.kind === 'running_tools') {
    if (phase.tools.length !== 1) return null;
    const input = collectToolInputs(messages, streaming).get(phase.tools[0].id);
    if (input === undefined) return null;
    return estimator.estimate(JSON.stringify(input), RUNNING_TOOL_ESTIMATE_KEY);
  }
  const content = streaming?.content ?? [];
  const block = content.at(-1);
  // The model writes a call's arguments before pi reports it as running — the
  // same stretch the label reads as "Preparing".
  if (block?.type === 'toolCall')
    return estimator.estimate(getTokenEstimateText(block), content.length - 1);
  if (phase?.kind === 'waiting_model' || phase?.kind === 'running_command') return null;
  if (block?.type === 'thinking')
    return estimator.estimate(getTokenEstimateText(block), content.length - 1);
  return null;
}

/**
 * The live speed beside the label's number. That number is one block at a time
 * by design; the rate instead measures the whole streaming reply — how fast
 * this model writes — and shares its anchor with the message header's badge
 * (`stream-token-rate`), so the two never disagree about the same stream.
 * Branch order mirrors `composerActivityTokens`: the rate shows exactly while
 * that count is growing, and hides whenever the model is silent.
 */
export interface ReplyRateEstimator {
  rate(
    phase: AgentPhase,
    streaming: AssistantMessage | null,
    compacting: boolean,
    now: number
  ): number | null;
}

export function createReplyRateEstimator(): ReplyRateEstimator {
  let cache: Map<number, TokenEstimateCacheEntry> | null = null;
  let replyKey: string | null | undefined;
  let start: StreamRateStart | null = null;
  return {
    rate(phase, streaming, compacting, now) {
      if (compacting) return null;
      // While a call executes the model is silent and the count is frozen: a
      // rate over frozen tokens would only fall as the tool runs.
      if (phase?.kind === 'running_tools') return null;
      if (!streaming) return null;
      const block = streaming.content.at(-1);
      // The label prefers the wait over stale thinking; only a call being
      // written survives it, because the model is streaming its arguments.
      const draftingCall = block?.type === 'toolCall';
      const activeThinking =
        block?.type === 'thinking' &&
        phase?.kind !== 'waiting_model' &&
        phase?.kind !== 'running_command';
      if (!draftingCall && !activeThinking) return null;

      // A new reply restarts from its own blocks; earlier ones are final, so
      // their cache entries hit instead of being re-estimated.
      const key = streamRateKey(streaming);
      if (key !== replyKey) {
        replyKey = key;
        cache = new Map();
        start = null;
      }
      const next = new Map<number, TokenEstimateCacheEntry>();
      let total = 0;
      for (const [index, item] of streaming.content.entries()) {
        const text = getTokenEstimateText(item);
        if (text === null) continue;
        const tokens = estimateUpdatedTokens(cache?.get(index), text);
        next.set(index, { text, tokens });
        total += tokens;
      }
      cache = next;
      if (total <= 0) return null;
      start ??= streamRateStart(key, total, now);
      return streamTokensPerSecond(start, total, now);
    }
  };
}

/** Streamed arguments arrive before the call is reported as running. */
function collectToolInputs(
  messages: AgentMessage[],
  streaming: AssistantMessage | null
): Map<string, ToolInput> {
  const calls = new Map<string, ToolInput>();
  for (const message of [...messages, ...(streaming ? [streaming] : [])]) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (block.type === 'toolCall') calls.set(block.toolCallId, block.input);
    }
  }
  return calls;
}

/**
 * The status line stays a single fixed-height row, so concurrent calls are grouped
 * by kind instead of growing the line count. A group of one keeps its concrete
 * detail (path, pattern, command, tool name); a group of several becomes a count.
 */
function summarizeRunningTools(
  tools: RunningTool[],
  inputs: Map<string, ToolInput>,
  t: Translate
): string {
  const reads: string[] = [];
  const searches: string[] = [];
  const listings: string[] = [];
  const shells: string[] = [];
  const others: string[] = [];
  for (const tool of tools) {
    if (isSearchToolName(tool.name)) searches.push(searchLabel(tool, inputs.get(tool.id), t));
    else if (isListToolName(tool.name)) listings.push(listingLabel(tool, inputs.get(tool.id), t));
    else if (isExplorationToolName(tool.name)) reads.push(readLabel(tool, inputs.get(tool.id), t));
    else if (isShellToolName(tool.name)) shells.push(shellLabel(tool, inputs.get(tool.id), t));
    else others.push(tool.name);
  }

  if (tools.length === 1) {
    const [label] = [...reads, ...searches, ...listings, ...shells];
    if (label !== undefined) return withProgress(label, tools[0]);
    return withProgress(t('chat.runningNamedTool', { name: tools[0].name }), tools[0]);
  }

  const parts: string[] = [];
  if (reads.length === 1) parts.push(reads[0]);
  else if (reads.length > 1) parts.push(t('activity.readingFiles', { count: reads.length }));
  if (searches.length === 1) parts.push(searches[0]);
  else if (searches.length > 1)
    parts.push(t('activity.searchingCount', { count: searches.length }));
  if (listings.length === 1) parts.push(listings[0]);
  else if (listings.length > 1) parts.push(t('activity.listingCount', { count: listings.length }));
  if (shells.length === 1) parts.push(shells[0]);
  else if (shells.length > 1) parts.push(t('activity.runningCommands', { count: shells.length }));
  if (others.length > 0) parts.push(otherToolsLabel(others, t));
  return parts.join(' · ');
}

function readLabel(tool: RunningTool, input: ToolInput, t: Translate): string {
  const path = input?.path ?? input?.file_path ?? input?.filePath;
  return typeof path === 'string' && path.trim()
    ? t('activity.readingFile', { path })
    : t('activity.reading');
}

function searchLabel(tool: RunningTool, input: ToolInput, t: Translate): string {
  const pattern = input?.pattern ?? input?.query;
  if (typeof pattern !== 'string' || !pattern.trim()) return t('activity.searching');
  const path = input?.path ?? input?.file_path ?? input?.filePath;
  return typeof path === 'string' && path.trim()
    ? t('activity.searchingPatternIn', { pattern: pattern.trim(), path })
    : t('activity.searchingPattern', { pattern: pattern.trim() });
}

function listingLabel(tool: RunningTool, input: ToolInput, t: Translate): string {
  const path = input?.path ?? input?.file_path ?? input?.filePath;
  return typeof path === 'string' && path.trim()
    ? t('activity.listingPath', { path })
    : t('activity.listing');
}

function shellLabel(tool: RunningTool, input: ToolInput, t: Translate): string {
  const command = input?.command ?? input?.cmd;
  if (typeof command !== 'string' || !command.trim())
    return t('chat.runningNamedTool', { name: tool.name });
  return t('activity.runningCommand', { command: command.trim().replace(/\s+/g, ' ') });
}

function otherToolsLabel(names: string[], t: Translate): string {
  if (names.length === 1) return t('chat.runningNamedTool', { name: names[0] });
  if (names.length <= 3) return t('chat.runningTools', { names: names.join(', ') });
  return t('chat.runningToolsMore', {
    names: names.slice(0, 2).join(', '),
    count: names.length - 2
  });
}

function withProgress(label: string, tool: RunningTool): string {
  return tool.progress ? `${label} ${tool.progress}` : label;
}
