/**
 * The runs of a conversation, for the Runs panel. A run is any tool call, plus
 * the writes and edits whose diff the transcript keeps in the default display
 * mode.
 *
 * The transcript no longer carries these calls: a command's live output and its
 * final result belong to one history that stays readable after the run ends,
 * whether it succeeded or failed. The entries here are display views derived
 * from stored messages plus the live execution state, never a second record.
 */

import {
  CODEMODE_TOOL_NAME,
  codemodeCalls,
  codemodeScript,
  codemodeScriptPreview,
  stripCodemodeHeader,
  type CodemodeCallView
} from './codemode-view';
import { isRunsPanelToolName, isShellToolName, isApplyPatchToolName } from './tool-names';
import {
  belongsToRunsPanel,
  TRANSCRIPT_TOOL_DISPLAY_DEFAULT,
  type TranscriptToolDisplay
} from './quiet-activity';
import {
  applyPatchPreviewToFiles,
  extractApplyPatchPaths,
  getApplyPatchInputText,
  parseApplyPatchInput
} from './apply-patch';
import { parseUnifiedPatch, type SplitDiffFile } from './patch';
import type {
  AgentMessage,
  AssistantMessage,
  BashExecutionMessage,
  ToolCallContent,
  ToolResultMessage
} from './types';

export type ExecutionHistoryStatus = 'running' | 'success' | 'error' | 'cancelled';

export interface ExecutionHistoryEntry {
  id: string;
  kind: 'shell' | 'codemode' | 'tool';
  toolName: string;
  /**
   * The full command, script, or input JSON. Empty for a write-like call, whose
   * `diffFiles` is the input that matters.
   */
  command: string;
  /** One line for the collapsed row. */
  preview: string;
  status: ExecutionHistoryStatus;
  /** Still displayed in the active section after completion. */
  active?: boolean;
  /** Text output; empty while a run has not printed anything yet. */
  output: string;
  /** The script of a codemode call, when it has one. */
  script?: string;
  /** Calls the codemode script made, in the order they ran. */
  calls?: CodemodeCallView[];
  /** Earlier codemode calls a progress snapshot left out. */
  omittedCalls?: number;
  /** A `!` command the user ran in the composer. */
  userInitiated?: boolean;
  /** The change a write, an edit, or a patch made, for the panel's diff pane. */
  diffFiles?: SplitDiffFile[];
  timestamp?: number;
  durationMs?: number;
  /** A shell result whose full output was written elsewhere. */
  truncated?: boolean;
  fullOutputPath?: string;
}

/** Trailing lines shown before the whole output waits behind a button. */
export const EXECUTION_OUTPUT_TAIL_LINES = 40;

/** The client-only run of a `!` command before its stored message arrives. */
export const PENDING_BASH_ID = 'bash-pending';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function inputText(input: unknown): string {
  if (!isRecord(input)) return typeof input === 'string' ? input : '';
  for (const key of ['command', 'cmd', 'script', 'input'] as const) {
    const value = input[key];
    if (typeof value === 'string') return value;
  }
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return '';
  }
}

function limitPreview(line: string): string {
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

function inputJson(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2) ?? '';
  } catch {
    return '';
  }
}

/** A tool's most useful argument, one line for the collapsed row. */
function toolInputPreview(input: unknown): string {
  if (!isRecord(input)) return limitPreview(typeof input === 'string' ? input : '');
  for (const key of [
    'command',
    'cmd',
    'path',
    'file_path',
    'filePath',
    'pattern',
    'query',
    'url',
    'name',
    'description',
    'prompt'
  ] as const) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return limitPreview(value.replace(/\s+/g, ' ').trim());
    }
  }
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value.trim()) {
      return limitPreview(value.replace(/\s+/g, ' ').trim());
    }
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  return '';
}

function firstCommandLine(command: string): string {
  for (const line of command.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return limitPreview(trimmed);
  }
  return '';
}

function resultText(content: ToolResultMessage['content'] | undefined): string {
  if (!content) return '';
  return content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        block.type === 'text' && typeof block.text === 'string'
    )
    .map((block) => block.text)
    .join('\n');
}

function recordedDuration(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function entryDuration(
  message: AssistantMessage,
  result: ToolResultMessage | undefined
): number | undefined {
  if (!result) return undefined;
  return (
    recordedDuration(result.durationMs) ??
    (result.timestamp !== undefined && message.timestamp !== undefined
      ? Math.max(0, result.timestamp - message.timestamp)
      : undefined)
  );
}

function runStatus(result: ToolResultMessage | undefined): ExecutionHistoryStatus {
  if (!result) return 'running';
  if (isRecord(result.details) && result.details.cancelled === true) return 'cancelled';
  return result.isError ? 'error' : 'success';
}

function bashExecutionStatus(message: BashExecutionMessage): ExecutionHistoryStatus {
  if (message.cancelled) return 'cancelled';
  if (message.exitCode !== undefined) return message.exitCode === 0 ? 'success' : 'error';
  return 'running';
}

function shellEntry(
  message: AssistantMessage,
  block: ToolCallContent,
  result: ToolResultMessage | undefined,
  live: boolean
): ExecutionHistoryEntry {
  const command = inputText(block.input);
  return {
    id: block.toolCallId,
    kind: 'shell',
    toolName: block.toolName,
    command,
    preview: firstCommandLine(command),
    status: live ? 'running' : runStatus(result),
    output: resultText(result?.content),
    timestamp: message.timestamp,
    durationMs: entryDuration(message, result)
  };
}

function codemodeEntry(
  message: AssistantMessage,
  block: ToolCallContent,
  result: ToolResultMessage | undefined,
  live: boolean
): ExecutionHistoryEntry {
  const script = codemodeScript(block.input);
  const command = script ?? inputText(block.input);
  const calls = codemodeCalls(result?.details);
  return {
    id: block.toolCallId,
    kind: 'codemode',
    toolName: block.toolName,
    command,
    preview:
      script !== null ? limitPreview(codemodeScriptPreview(script)) : firstCommandLine(command),
    status: live ? 'running' : runStatus(result),
    output: resultText(result ? stripCodemodeHeader(result.content) : undefined),
    ...(script !== null ? { script } : {}),
    calls: calls.calls,
    omittedCalls: calls.omitted,
    timestamp: message.timestamp,
    durationMs: entryDuration(message, result)
  };
}

function toolEntry(
  message: AssistantMessage,
  block: ToolCallContent,
  result: ToolResultMessage | undefined,
  live: boolean
): ExecutionHistoryEntry {
  const command = inputJson(block.input);
  return {
    id: block.toolCallId,
    kind: 'tool',
    toolName: block.toolName,
    command,
    preview: toolInputPreview(block.input),
    status: live ? 'running' : runStatus(result),
    output: resultText(result?.content),
    timestamp: message.timestamp,
    durationMs: entryDuration(message, result)
  };
}

/** The change a write, an edit, or a patch made, when the result records one. */
function runDiffFiles(
  block: ToolCallContent,
  result: ToolResultMessage | undefined
): SplitDiffFile[] | undefined {
  if (isApplyPatchToolName(block.toolName)) {
    const fromInput = parseApplyPatchInput(getApplyPatchInputText(block.input, block.rawInput));
    if (fromInput) return fromInput;
    const details = result && !result.isError ? result.details : undefined;
    return (isRecord(details) && applyPatchPreviewToFiles(details.preview)) || undefined;
  }

  const details = result?.details;
  if (!isRecord(details)) return undefined;
  const text =
    typeof details.patch === 'string'
      ? details.patch
      : typeof details.diff === 'string'
        ? details.diff
        : null;
  return (text && parseUnifiedPatch(text)) || undefined;
}

/** The one line naming what a kept-card call touched. */
function keptCardSummary(block: ToolCallContent): string {
  if (isApplyPatchToolName(block.toolName)) {
    const paths = extractApplyPatchPaths(getApplyPatchInputText(block.input, block.rawInput));
    if (paths.length > 0) return limitPreview(paths.join(', '));
  }
  return toolInputPreview(block.input);
}

/**
 * A write, an edit, or a patch: its diff is the work, so the panel shows the
 * change rather than the call's arguments, which for a write is the whole file.
 */
function keptCardEntry(
  message: AssistantMessage,
  block: ToolCallContent,
  result: ToolResultMessage | undefined,
  live: boolean
): ExecutionHistoryEntry {
  const diffFiles = runDiffFiles(block, result);
  return {
    id: block.toolCallId,
    kind: 'tool',
    toolName: block.toolName,
    command: '',
    preview: keptCardSummary(block),
    status: live ? 'running' : runStatus(result),
    output: resultText(result?.content),
    ...(diffFiles ? { diffFiles } : {}),
    timestamp: message.timestamp,
    durationMs: entryDuration(message, result)
  };
}

function userBashEntry(message: BashExecutionMessage, index: number): ExecutionHistoryEntry {
  const status = bashExecutionStatus(message);
  const toolName = message.excludeFromContext ? 'bash (local)' : 'bash';
  return {
    id: `bash-${message.timestamp ?? index}`,
    kind: 'shell',
    toolName,
    command: message.command,
    preview: firstCommandLine(message.command),
    status,
    output: message.output,
    userInitiated: true,
    timestamp: message.timestamp,
    ...(message.truncated ? { truncated: true } : {}),
    ...(message.fullOutputPath ? { fullOutputPath: message.fullOutputPath } : {})
  };
}

/**
 * Every run in the loaded conversation, oldest first.
 *
 * `running` is the same live set the transcript cards use, and `results` also
 * carries a running call's partial result, so a command's output grows in the
 * panel while it runs. A call the session never executed leaves no entry.
 */
export function buildExecutionHistory(
  messages: readonly AgentMessage[],
  results: ReadonlyMap<string, ToolResultMessage>,
  running: ReadonlySet<string>,
  options: {
    pendingBash?: { command: string; excludeFromContext?: boolean } | null;
    /** `conversation` collects the transcript's kept cards here too. */
    toolDisplay?: TranscriptToolDisplay;
  } = {}
): ExecutionHistoryEntry[] {
  const entries: ExecutionHistoryEntry[] = [];
  const toolDisplay = options.toolDisplay ?? TRANSCRIPT_TOOL_DISPLAY_DEFAULT;

  for (const [index, message] of messages.entries()) {
    if (message.role === 'bashExecution') {
      entries.push(userBashEntry(message, index));
      continue;
    }
    if (message.role !== 'assistant') continue;

    for (const block of message.content) {
      if (block.type !== 'toolCall') continue;
      if (!belongsToRunsPanel(block.toolName, toolDisplay)) continue;

      const result = results.get(block.toolCallId);
      const live = running.has(block.toolCallId);
      if (!result && !live) continue;

      const keptCard = !isRunsPanelToolName(block.toolName);
      const codemode = block.toolName === CODEMODE_TOOL_NAME;
      entries.push(
        keptCard
          ? keptCardEntry(message, block, result, live)
          : codemode
            ? codemodeEntry(message, block, result, live)
            : isShellToolName(block.toolName)
              ? shellEntry(message, block, result, live)
              : toolEntry(message, block, result, live)
      );
    }
  }

  if (options.pendingBash) {
    const command = options.pendingBash.command;
    entries.push({
      id: PENDING_BASH_ID,
      kind: 'shell',
      toolName: options.pendingBash.excludeFromContext ? 'bash (local)' : 'bash',
      command,
      preview: firstCommandLine(command),
      status: 'running',
      output: '',
      userInitiated: true
    });
  }

  return entries;
}

/**
 * Keep a run that just disappeared from the derived list in its old place.
 *
 * pi emits `tool_execution_end` before the stored `toolResult` message, so one
 * render can see a finished call with neither a result nor a live marker. The
 * retained run is replaced by the same id when the result arrives, and the
 * panel removes it if no result ever does.
 */
export function retainExecutionHistory(
  previous: readonly ExecutionHistoryEntry[],
  current: readonly ExecutionHistoryEntry[]
): ExecutionHistoryEntry[] {
  const byId = new Map(current.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  const merged: ExecutionHistoryEntry[] = [];
  for (const entry of previous) {
    const replacement = byId.get(entry.id);
    if (replacement) {
      merged.push(replacement);
      seen.add(entry.id);
    } else {
      merged.push(entry);
    }
  }
  for (const entry of current) {
    if (seen.has(entry.id)) continue;
    merged.push(entry);
  }
  return merged;
}

/** Track independently completed live runs without treating restored history as live. */
export function updateActiveRunHolds(
  previous: readonly ExecutionHistoryEntry[],
  current: readonly ExecutionHistoryEntry[],
  holds: ReadonlyMap<string, number>,
  now: number,
  holdMs: number
): Map<string, number> {
  const next = new Map([...holds].filter(([, until]) => until > now));
  const prior = new Map(previous.map((entry) => [entry.id, entry]));
  const pending = prior.get(PENDING_BASH_ID);
  for (const entry of current) {
    const before =
      prior.get(entry.id) ??
      (entry.userInitiated && pending?.command === entry.command ? pending : undefined);
    if (entry.status === 'running') next.delete(entry.id);
    else if (before?.status === 'running' && !next.has(entry.id)) {
      next.set(entry.id, now + holdMs);
    }
  }
  const present = new Set(current.map((entry) => entry.id));
  for (const id of next.keys()) if (!present.has(id)) next.delete(id);
  return next;
}

/** The last lines of a run's output, with the number left above them. */
export function executionOutputTail(
  text: string,
  maxLines = EXECUTION_OUTPUT_TAIL_LINES
): { tail: string; hiddenLines: number } | null {
  if (!text) return null;
  const lines = text.split('\n');
  const lineCount =
    lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  if (lineCount <= maxLines) return null;
  const hiddenLines = lineCount - maxLines;
  return { tail: lines.slice(hiddenLines).join('\n'), hiddenLines };
}

/** A run's duration in the same short form the tool cards used. */
export function formatExecutionDuration(ms: number | undefined): string | null {
  if (ms === undefined || ms < 100) return null;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
}
