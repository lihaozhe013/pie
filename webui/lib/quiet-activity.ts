import { isExplorationToolName, isRunsPanelToolName } from './tool-names';
import type { AssistantContentBlock, ToolResultMessage } from './types';

/**
 * How much of a run the conversation transcript shows: the kept cards, or
 * nothing but the user's messages and the agent's replies.
 */
export type TranscriptToolDisplay = 'cards' | 'conversation';

/** The default: the transcript stays conversation-only; the Runs panel keeps every call. */
export const TRANSCRIPT_TOOL_DISPLAY_DEFAULT: TranscriptToolDisplay = 'conversation';

/**
 * Exploration calls leave no card: the composer status row carries them while
 * they run, and their result is context the model reads, not a step the user
 * asked to inspect.
 */
export function isQuietActivityBlock(block: AssistantContentBlock): boolean {
  return (
    block.type === 'thinking' ||
    (block.type === 'toolCall' && isExplorationToolName(block.toolName))
  );
}

/**
 * Whether a call belongs to the Runs panel instead of the transcript.
 *
 * In the default mode only the calls that `isRunsPanelToolName` assigns there
 * leave the transcript. `conversation` sends every call there, including the
 * writes and edits whose diff was the transcript's own work.
 */
export function belongsToRunsPanel(
  toolName: string,
  display: TranscriptToolDisplay = TRANSCRIPT_TOOL_DISPLAY_DEFAULT
): boolean {
  return display === 'conversation' || isRunsPanelToolName(toolName);
}

/**
 * A tool call earns a card once it actually runs, not while the model is still
 * writing its arguments: a half-streamed JSON blob would intrude on the
 * conversation, while a running call's card is the progress the user asked for.
 *
 * Every call the Runs panel owns lives there, running, successful or failed,
 * and never draws a transcript card. Every rule here reads persisted results
 * and the reported running calls, never a streamed fragment as if it were a
 * result.
 */
export function isTransientToolBlock(
  block: AssistantContentBlock,
  results?: ReadonlyMap<string, ToolResultMessage>,
  running?: ReadonlySet<string>,
  display: TranscriptToolDisplay = TRANSCRIPT_TOOL_DISPLAY_DEFAULT
): boolean {
  if (block.type !== 'toolCall') return false;
  if (belongsToRunsPanel(block.toolName, display)) return true;
  if (running?.has(block.toolCallId)) return false;
  const result = results?.get(block.toolCallId);
  return result === undefined;
}

/** Display filtering never changes the stored transcript or exported history. */
export function mainTranscriptBlocks(
  blocks: AssistantContentBlock[],
  results?: ReadonlyMap<string, ToolResultMessage>,
  running?: ReadonlySet<string>,
  display: TranscriptToolDisplay = TRANSCRIPT_TOOL_DISPLAY_DEFAULT
): AssistantContentBlock[] {
  return blocks.filter(
    (block) =>
      !isQuietActivityBlock(block) && !isTransientToolBlock(block, results, running, display)
  );
}
