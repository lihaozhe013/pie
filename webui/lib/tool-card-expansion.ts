/**
 * Writes and edits default open; shells, patches, and codemode open only during
 * execution. Explicit choices continue to take precedence over these lifecycle defaults.
 */

import { CODEMODE_TOOL_NAME } from './codemode-view';
import {
  isWriteToolName,
  isEditToolName,
  isApplyPatchToolName,
  isShellToolName
} from './tool-names';

/** How many trailing lines of a shell result stay visible while the rest waits. */
export const SHELL_OUTPUT_TAIL_LINES = 16;

export type ToolState = 'pending' | 'running' | 'success' | 'error';

/** Defaults are derived every render, never stored as a user's explicit choice. */
export function isToolCardExpandedByDefault(
  toolName: string,
  state: ToolState = 'pending'
): boolean {
  return (
    isWriteToolName(toolName) ||
    isEditToolName(toolName) ||
    (state === 'running' &&
      (isShellToolName(toolName) ||
        isApplyPatchToolName(toolName) ||
        toolName === CODEMODE_TOOL_NAME))
  );
}

/**
 * The last `SHELL_OUTPUT_TAIL_LINES` lines of a shell result, with the count of the
 * ones left out. Null when the whole result already fits (or is empty), so the
 * card can draw its normal output pane.
 */
export function shellOutputTail(text: string): { tail: string; hiddenLines: number } | null {
  if (!text) return null;
  const lines = text.split('\n');
  // A trailing newline ends the last line, it does not start another.
  const lineCount =
    lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  if (lineCount <= SHELL_OUTPUT_TAIL_LINES) return null;
  const hiddenLines = lineCount - SHELL_OUTPUT_TAIL_LINES;
  return { tail: lines.slice(hiddenLines).join('\n'), hiddenLines };
}
