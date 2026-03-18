import {
  getAssistantErrorMessage,
  getDisplayableAssistantBlocks,
  isHiddenCustomMessage
} from './message-display';
import { isRunsPanelToolName } from './tool-names';
import type {
  AgentMessage,
  AssistantContentBlock,
  BashExecutionMessage,
  CustomMessage,
  ImageContent,
  ToolCallContent,
  ToolResultMessage,
  UserMessage
} from './types';

/**
 * What a turn copy keeps.
 *
 * - `answers`: the conversation alone, for a document or a fresh chat.
 * - `transcript`: the replies plus the writes, edits, and patches the kept
 *   transcript cards show, so every run the Runs panel lists stays out.
 * - `execution`: every tool call the turn made, including the runs the
 *   transcript and the panel keep as history.
 *
 * Thinking stays out of every mode: it is how the agent worked, not what it
 * did. Exploration calls appear only in the execution log, where they are runs
 * like any other.
 */
export type TurnCopyMode = 'answers' | 'transcript' | 'execution';

export interface TurnCopyInput {
  mode: TurnCopyMode;
  /** One turn: its anchor message through the message before the next anchor. */
  messages: readonly AgentMessage[];
  /** Stored results by call id; a missing result means the call has none yet. */
  toolResults?: ReadonlyMap<string, ToolResultMessage>;
}

function messageText(content: UserMessage['content'] | CustomMessage['content']): string {
  return typeof content === 'string'
    ? content
    : content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}

function imagesOf(
  content: UserMessage['content'] | CustomMessage['content'],
  mark: (block: ImageContent) => string
): string[] {
  return typeof content === 'string'
    ? []
    : content.flatMap((block) => (block.type === 'image' ? [mark(block)] : []));
}

function imageMarker(block: ImageContent): string {
  const media = block.source?.media_type;
  return media ? `*[Image: ${media}]*` : '*[Image]*';
}

/** A fence longer than any backtick run inside `body`, so pasted output cannot close it. */
function fenced(body: string, language: string): string {
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
  return `${'`'.repeat(Math.max(3, longest + 1))}${language}\n${body}\n${'`'.repeat(
    Math.max(3, longest + 1)
  )}`;
}

function jsonBlock(value: unknown): string {
  let body: string;
  try {
    body = JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    body = String(value);
  }
  return fenced(body, 'json');
}

function isEmptyDetails(details: unknown): boolean {
  if (details === undefined || details === null) return true;
  if (Array.isArray(details)) return details.length === 0;
  if (typeof details !== 'object') return false;
  return Object.keys(details as Record<string, unknown>).length === 0;
}

function toolResultText(result: ToolResultMessage): string {
  return result.content
    .map((block) => (block.type === 'text' ? block.text : imageMarker(block)))
    .join('\n\n')
    .trim();
}

/**
 * Whether a call belongs in the copy. The kept record is defined by the calls
 * the default transcript shows, not by the display mode in effect: a reader
 * copies the same record whether the tool cards are on screen or not. The
 * execution log is where every other run belongs.
 */
function keepsToolCall(
  call: ToolCallContent,
  result: ToolResultMessage | undefined,
  mode: TurnCopyMode
): boolean {
  if (mode === 'answers') return false;
  if (mode === 'execution') return true;
  if (isRunsPanelToolName(call.toolName)) return false;
  return result !== undefined;
}

function toolSection(
  call: ToolCallContent,
  result: ToolResultMessage | undefined,
  mode: TurnCopyMode
): string {
  const parts = [`### ${call.toolName}`, jsonBlock(call.input)];
  if (!result) return parts.join('\n\n');

  parts.push(result.isError ? '**Error**' : '**Result**');
  const text = toolResultText(result);
  if (text) parts.push(fenced(text, 'text'));
  // The structured details a tool recorded, kept as data rather than as the
  // card's rendering of it.
  if (mode === 'execution' && !isEmptyDetails(result.details)) {
    parts.push('**Details**', jsonBlock(result.details));
  }
  return parts.join('\n\n');
}

function assistantParts(
  blocks: AssistantContentBlock[],
  mode: TurnCopyMode,
  toolResults: ReadonlyMap<string, ToolResultMessage> | undefined
): string[] {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      const text = block.text.trim();
      if (text) parts.push(text);
      continue;
    }
    if (block.type === 'image') {
      parts.push(imageMarker(block));
      continue;
    }
    if (block.type !== 'toolCall') continue; // Thinking is never copied.
    const result = toolResults?.get(block.toolCallId);
    if (keepsToolCall(block, result, mode)) parts.push(toolSection(block, result, mode));
  }
  return parts;
}

function bashParts(message: BashExecutionMessage, mode: TurnCopyMode): string[] {
  if (mode === 'answers') return [];
  const parts = [
    '### Shell (run by the user)',
    jsonBlock({
      command: message.command,
      exitCode: message.exitCode ?? null,
      cancelled: Boolean(message.cancelled)
    })
  ];
  const output = message.output.trim();
  if (output) parts.push(fenced(output, 'text'));
  if (message.truncated) parts.push('*Output truncated by the tool.*');
  return parts;
}

/**
 * One turn as Markdown: the user's prompt, then what the assistant replied and
 * the tool steps the chosen mode keeps. Order follows the stored transcript, so
 * a reader can follow the work and a new session can pick it up.
 */
export function buildTurnCopy({ mode, messages, toolResults }: TurnCopyInput): string {
  const parts: string[] = [];
  let assistantOpen = false;

  for (const message of messages) {
    if (message.role === 'user') {
      const body = [messageText(message.content).trim(), ...imagesOf(message.content, imageMarker)]
        .filter(Boolean)
        .join('\n\n');
      if (!body) continue;
      parts.push(`## User\n\n${body}`);
      assistantOpen = false;
      continue;
    }

    if (message.role === 'assistant') {
      const body = assistantParts(getDisplayableAssistantBlocks(message), mode, toolResults);
      const error = getAssistantErrorMessage(message)?.trim();
      if (error) body.push(`*Response failed: ${error}*`);
      if (body.length === 0) continue;
      if (!assistantOpen) {
        parts.push('## Assistant');
        assistantOpen = true;
      }
      parts.push(body.join('\n\n'));
      continue;
    }

    if (message.role === 'bashExecution') {
      const body = bashParts(message, mode);
      if (body.length === 0) continue;
      parts.push(body.join('\n\n'));
      continue;
    }

    if (message.role === 'custom') {
      if (mode === 'answers' || !message.display || isHiddenCustomMessage(message)) continue;
      const text = messageText(message.content).trim();
      if (!text) continue;
      const quoted = text
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
      parts.push(`> **${message.customType}**\n>\n${quoted}`);
    }
  }

  return parts.join('\n\n');
}
