import { memo, useState, useRef, useEffect, useMemo, type CSSProperties } from 'react';
import {
  isQuietActivityBlock,
  isTransientToolBlock,
  type TranscriptToolDisplay
} from '@/lib/quiet-activity';
import { MarkdownBody } from './MarkdownBody';
import { ImagePreview } from './ImagePreview';
import { ThinkingIcon } from './ThinkingIcon';
import { useI18n } from '@/hooks/useI18n';
import {
  TOOL_CARD_MIN_VISIBLE_MS,
  useBodyContent,
  useExitHold,
  useExitingItems
} from '@/hooks/useToolCardMotion';
import { parseCompactionSummary } from '@/lib/compaction-summary';
import {
  getAssistantErrorMessage,
  hasAssistantAnswer,
  isAssistantTruncated,
  splitThinkingPieces
} from '@/lib/message-display';
import { formatTurnDuration, type TurnUsage } from '@/lib/turn-duration';
import { formatCompactCount } from '@/lib/session-stats-format';
import type { SplitDiffFile } from '@/lib/patch';
import {
  applyPatchPreviewToFiles,
  applyPatchResultHasFailures,
  extractApplyPatchPaths,
  getApplyPatchInputText,
  parseApplyPatchInput
} from '@/lib/apply-patch';
import {
  isApplyPatchToolName,
  isEditToolName,
  isShellToolName,
  isWriteToolName
} from '@/lib/tool-names';
import { getToolCallExpansion, setToolCallExpanded } from '@/lib/tool-call-expansion';
import { ToolStatus, useToolState, useToolActivity } from './ToolActivity';
import { isToolCardExpandedByDefault, shellOutputTail } from '@/lib/tool-card-expansion';
// Syntax colors for tool-card content.
import { toolCodeLanguage } from '@/lib/tool-code-language';
import { ToolCodeLanguageProvider, ToolCodeTokens } from './ToolCode';
import {
  isThinkingExpandedByDefault,
  THINKING_EXPANDED_EVENT
} from '@/lib/thinking-expansion-preference';
import { TurnWrittenFiles } from './TurnWrittenFiles';
import { SplitPatchView, SplitFilesView } from './PatchDiffView';
import { CARD_RULE, CARD_RULE_COLOR } from './card-style';
import type { WrittenFile } from '@/lib/turn-written-files';
import { skillExpansionToCommand } from '@/lib/slash-display';
import {
  CODEMODE_TOOL_NAME,
  codemodeCalls,
  codemodeScript,
  codemodeScriptPreview,
  stripCodemodeHeader
} from '@/lib/codemode-view';
import { CodemodeCallList } from './CodemodeToolView';
import { toolFieldsOfInput, type ToolField } from '@/lib/tool-fields';
import { mcpToolLabel, prettyMcpResultText } from '@/lib/mcp-tool-display';
import {
  estimateUpdatedTokens,
  getTokenEstimateText,
  type TokenEstimateCacheEntry
} from '@/lib/token-estimate';
import { getTranscriptNotices } from '@/lib/transcript-notices';
import {
  TRANSCRIPT_NOTICE_WARNING_COLOR,
  transcriptNoticeText
} from '@/components/TranscriptNotices';
import type {
  AgentMessage,
  UserMessage,
  AssistantMessage,
  CustomMessage,
  ToolResultMessage,
  BashExecutionMessage,
  AssistantContentBlock,
  TextContent,
  ImageContent,
  ToolCallContent,
  ThinkingContent
} from '@/lib/types';

const MAX_THINKING_CACHE_ENTRIES = 100;
const thinkingContentCache = new Map<string, Promise<string>>();

// Messages larger than this skip markdown rendering entirely. react-markdown +
// KaTeX + syntax highlighting on multi-hundred-KB payloads (e.g. pasted HAR or
// log dumps) freezes the browser main thread.
const MAX_MARKDOWN_CHARS = 100_000;

function formatMessageBytes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} KB`;
  return `${n} B`;
}

/**
 * MarkdownBody with an oversized-content guard: huge messages render as a
 * click-to-reveal plain-text <pre> instead of running the markdown pipeline.
 */
function SafeMarkdownBody({
  children,
  className,
  ...props
}: React.ComponentProps<typeof MarkdownBody>) {
  const { t } = useI18n();
  const [showRaw, setShowRaw] = useState(false);

  if (children.length <= MAX_MARKDOWN_CHARS) {
    return (
      <MarkdownBody className={className} {...props}>
        {children}
      </MarkdownBody>
    );
  }
  if (!showRaw) {
    return (
      <button
        onClick={() => setShowRaw(true)}
        style={{
          display: 'block',
          width: '100%',
          margin: '4px 0',
          padding: '7px 10px',
          border: '1px solid var(--border)',
          borderRadius: 6,
          background: 'var(--bg-panel)',
          color: 'var(--text-muted)',
          cursor: 'pointer',
          fontSize: 12,
          textAlign: 'left'
        }}
      >
        ⚠ {t('i18n.largeMessageReveal', { size: formatMessageBytes(children.length) })}
      </button>
    );
  }
  return (
    <div
      className={className}
      style={{
        maxHeight: 420,
        overflow: 'auto',
        fontSize: 'var(--font-mono-size, 15px)',
        lineHeight: 1.5
      }}
    >
      <pre
        style={{
          margin: 0,
          padding: '8px 10px',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          fontFamily: 'var(--font-mono)',
          color: 'var(--text-muted)'
        }}
      >
        {children}
      </pre>
    </div>
  );
}

// Cap the user "sent" bubble's height so an abnormally long message does not
// push the conversation off screen; overflow scrolls inside the bubble.
const USER_BUBBLE_MAX_HEIGHT = 300;

function loadThinkingContent(
  sessionId: string,
  entryId: string,
  blockIndex: number
): Promise<string> {
  const key = `${sessionId}:${entryId}:${blockIndex}`;
  const cached = thinkingContentCache.get(key);
  if (cached) {
    thinkingContentCache.delete(key);
    thinkingContentCache.set(key, cached);
    return cached;
  }

  const request = fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/entries/${encodeURIComponent(entryId)}/thinking?blockIndex=${blockIndex}`
  )
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as { thinking?: unknown };
      if (typeof data.thinking !== 'string') throw new Error('Invalid thinking response');
      return data.thinking;
    })
    .catch((error) => {
      thinkingContentCache.delete(key);
      throw error;
    });

  thinkingContentCache.set(key, request);
  if (thinkingContentCache.size > MAX_THINKING_CACHE_ENTRIES) {
    const oldestKey = thinkingContentCache.keys().next().value;
    if (oldestKey) thinkingContentCache.delete(oldestKey);
  }
  return request;
}

interface Props {
  message: AgentMessage;
  isStreaming?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  cwd?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
  entryId?: string;
  searchBlock?: AssistantContentBlock;
  onFork?: (entryId: string) => void;
  forking?: boolean;
  onEditContent?: (message: UserMessage, entryId: string) => void;
  onCancelEdit?: () => void;
  isEditing?: boolean;
  showTimestamp?: boolean;
  prevTimestamp?: number;
  sessionId?: string;
  /**
   * Files this turn wrote, derived by the caller from the whole turn's
   * successful write/edit tool calls. ChatWindow computes this because the
   * saved-message path splits tool calls into their own entries, leaving the
   * final answer text-only.
   */
  writtenFiles?: WrittenFile[];
  /** The whole turn's time, for a final answer with no process details to show it. */
  turnDurationMs?: number;
  /** The whole turn's billed tokens, beside its time; the hover spells them out. */
  turnUsage?: TurnUsage;
  /** How much of the run this transcript shows; see `TranscriptToolDisplay`. */
  toolDisplay?: TranscriptToolDisplay;
  onCompact?: () => void;
  isCompacting?: boolean;
  compactError?: string | null;
}

function formatTime(ts?: number): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  const now = new Date();
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (isToday) return time;
  const date = d.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
  });
  return `${date} ${time}`;
}

export function replaceUserMessageText(message: UserMessage, text: string): UserMessage {
  if (typeof message.content === 'string') return { ...message, content: text };

  const content: Array<TextContent | ImageContent> = [];
  let replaced = false;
  for (const block of message.content) {
    if (block.type !== 'text') {
      content.push(block);
      continue;
    }
    if (!replaced) {
      content.push({ ...block, text });
      replaced = true;
    }
  }
  if (!replaced) content.unshift({ type: 'text', text });
  return { ...message, content };
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Turn usage is rebuilt each render of the transcript: only its numbers matter. */
function sameTurnUsage(a: TurnUsage | undefined, b: TurnUsage | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.input === b.input &&
    a.output === b.output &&
    a.cacheRead === b.cacheRead &&
    a.cacheWrite === b.cacheWrite &&
    a.cost === b.cost
  );
}

/** The turn's tokens spelled out, as the session statistics popover does. */
function turnUsageTitle(usage: TurnUsage, t: Translate, locale: string): string {
  return [
    `${t('session.input')}: ${usage.input.toLocaleString(locale)}`,
    `${t('session.output')}: ${usage.output.toLocaleString(locale)}`,
    ...(usage.cacheRead > 0
      ? [`${t('session.cacheRead')}: ${usage.cacheRead.toLocaleString(locale)}`]
      : []),
    ...(usage.cacheWrite > 0
      ? [`${t('session.cacheWrite')}: ${usage.cacheWrite.toLocaleString(locale)}`]
      : []),
    `${t('session.total')}: ${usage.total.toLocaleString(locale)}`,
    ...(usage.cost > 0 ? [`${t('session.cost')}: $${usage.cost.toFixed(4)}`] : [])
  ].join('\n');
}

function haveSameRelevantToolResults(
  message: AgentMessage,
  previous: Map<string, ToolResultMessage> | undefined,
  next: Map<string, ToolResultMessage> | undefined
): boolean {
  if (previous === next || message.role !== 'assistant') return true;
  for (const block of (message as AssistantMessage).content ?? []) {
    if (
      block.type === 'toolCall' &&
      previous?.get(block.toolCallId) !== next?.get(block.toolCallId)
    ) {
      return false;
    }
  }
  return true;
}

export const MessageView = memo(
  function MessageView({
    message,
    isStreaming,
    toolResults,
    cwd,
    onOpenFile,
    entryId,
    searchBlock,
    onFork,
    forking,
    onEditContent,
    onCancelEdit,
    isEditing,
    showTimestamp,
    prevTimestamp,
    sessionId,
    writtenFiles,
    turnDurationMs,
    turnUsage,
    toolDisplay,
    onCompact,
    isCompacting,
    compactError
  }: Props) {
    if (message.role === 'user') {
      return (
        <UserMessageView
          message={message as UserMessage}
          cwd={cwd}
          onOpenFile={onOpenFile}
          entryId={entryId}
          onFork={onFork}
          forking={forking}
          onEditContent={onEditContent}
          onCancelEdit={onCancelEdit}
          isEditing={isEditing}
        />
      );
    }
    if (message.role === 'assistant') {
      return (
        <AssistantMessageView
          message={message as AssistantMessage}
          isStreaming={isStreaming}
          toolResults={toolResults}
          cwd={cwd}
          onOpenFile={onOpenFile}
          showTimestamp={showTimestamp}
          prevTimestamp={prevTimestamp}
          sessionId={sessionId}
          entryId={entryId}
          searchBlock={searchBlock}
          writtenFiles={writtenFiles}
          turnDurationMs={turnDurationMs}
          turnUsage={turnUsage}
          toolDisplay={toolDisplay}
          onCompact={onCompact}
          isCompacting={isCompacting}
          compactError={compactError}
        />
      );
    }
    if (message.role === 'toolResult') {
      // Rendered inline under its toolCall — skip standalone rendering if paired
      return null;
    }
    if (message.role === 'custom') {
      if ((message as CustomMessage).customType === 'compaction') {
        return <CompactionMessageView message={message as CustomMessage} />;
      }
      return (
        <CustomMessageView message={message as CustomMessage} cwd={cwd} onOpenFile={onOpenFile} />
      );
    }
    if (message.role === 'bashExecution') {
      return <BashExecutionView message={message as BashExecutionMessage} sessionId={sessionId} />;
    }
    return null;
  },
  (prev, next) => {
    return (
      prev.message === next.message &&
      prev.isStreaming === next.isStreaming &&
      haveSameRelevantToolResults(prev.message, prev.toolResults, next.toolResults) &&
      prev.cwd === next.cwd &&
      prev.onOpenFile === next.onOpenFile &&
      prev.entryId === next.entryId &&
      prev.searchBlock === next.searchBlock &&
      prev.onFork === next.onFork &&
      prev.forking === next.forking &&
      prev.onEditContent === next.onEditContent &&
      prev.onCancelEdit === next.onCancelEdit &&
      prev.isEditing === next.isEditing &&
      prev.showTimestamp === next.showTimestamp &&
      prev.prevTimestamp === next.prevTimestamp &&
      prev.writtenFiles === next.writtenFiles &&
      prev.turnDurationMs === next.turnDurationMs &&
      sameTurnUsage(prev.turnUsage, next.turnUsage) &&
      prev.toolDisplay === next.toolDisplay &&
      prev.sessionId === next.sessionId &&
      prev.onCompact === next.onCompact &&
      prev.isCompacting === next.isCompacting &&
      prev.compactError === next.compactError
    );
  }
);

function UserMessageView({
  message,
  cwd,
  onOpenFile,
  entryId,
  onFork,
  forking,
  onEditContent,
  onCancelEdit,
  isEditing
}: {
  message: UserMessage;
  cwd?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
  entryId?: string;
  onFork?: (entryId: string) => void;
  forking?: boolean;
  onEditContent?: (message: UserMessage, entryId: string) => void;
  onCancelEdit?: () => void;
  isEditing?: boolean;
}) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Session files can hold `\r\n` or lone `\r` line endings (#680). Chrome renders
  // a lone `\r` as a space even in the pre-wrap command-args and raw-text views.
  // Copy uses this text too; the session file keeps the original endings.
  const content = (
    typeof message.content === 'string'
      ? message.content
      : message.content
          .filter((b): b is TextContent => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
  ).replace(/\r\n?/g, '\n');

  const imageBlocks: ImageContent[] =
    typeof message.content === 'string'
      ? []
      : message.content.filter((b): b is ImageContent => b.type === 'image');

  const commandText = skillExpansionToCommand(content);
  const commandSeparator = commandText?.search(/\s/) ?? -1;
  const commandName = commandText
    ? commandSeparator === -1
      ? commandText
      : commandText.slice(0, commandSeparator)
    : '';
  const commandArgs =
    commandText && commandSeparator !== -1 ? commandText.slice(commandSeparator + 1) : '';

  const time = formatTime(message.timestamp);
  const canFork = !!entryId && !!onFork;
  const editTarget = commandText ? replaceUserMessageText(message, commandText) : message;

  const imageBlocksNode = imageBlocks.length > 0 && (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: content ? 8 : 0 }}>
      {imageBlocks.map((img, i) => {
        // lib/types.ts ImageContent uses {source:{type,data,media_type,url}}
        // pi-ai on-disk format uses flat {data, mimeType} — handle both
        const flat = img as unknown as { data?: string; mimeType?: string };
        const src = img.source
          ? img.source.type === 'base64'
            ? `data:${img.source.media_type};base64,${img.source.data}`
            : (img.source.url ?? '')
          : flat.data
            ? `data:${flat.mimeType};base64,${flat.data}`
            : '';
        return (
          <ImagePreview key={i} src={src}>
            <img
              src={src}
              alt=""
              style={{
                maxWidth: 240,
                maxHeight: 240,
                borderRadius: 6,
                objectFit: 'contain',
                display: 'block',
                border: '1px solid rgba(59,130,246,0.15)'
              }}
            />
          </ImagePreview>
        );
      })}
    </div>
  );
  const canEdit = !!entryId && !!onEditContent;
  const canCancelEdit = !!isEditing && !!onCancelEdit;

  return (
    <div
      style={{ marginBottom: 10, display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, maxWidth: '85%' }}>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            background: isEditing
              ? 'color-mix(in srgb, var(--accent) 14%, var(--user-bg))'
              : 'var(--user-bg)',
            border: isEditing
              ? '1px solid color-mix(in srgb, var(--accent) 62%, var(--user-bg))'
              : '1px solid rgba(59,130,246,0.2)',
            boxShadow: isEditing
              ? '0 0 0 2px color-mix(in srgb, var(--accent) 16%, transparent)'
              : undefined,
            borderRadius: 12,
            padding: '8px 12px',
            fontSize: 'calc(14px + var(--chat-font-size-offset, 0px))',
            lineHeight: 1.6,
            color: 'var(--text)',
            wordBreak: 'break-word',
            maxHeight: USER_BUBBLE_MAX_HEIGHT,
            overflowY: 'auto'
          }}
        >
          {commandText ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
              {imageBlocksNode}
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
                <button
                  onClick={() => setExpanded((prev) => !prev)}
                  title={expanded ? t('i18n.collapse') : t('i18n.expand')}
                  aria-expanded={expanded}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    flexShrink: 0,
                    padding: 0,
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--accent)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--font-mono-size, 15px)',
                    textAlign: 'left'
                  }}
                >
                  <span
                    style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {commandName}
                  </span>
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{
                      flexShrink: 0,
                      opacity: 0.75,
                      transform: expanded ? 'rotate(180deg)' : 'none',
                      transition: 'transform 0.15s'
                    }}
                    aria-hidden="true"
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                {commandArgs && (
                  <span
                    style={{
                      color: 'var(--text)',
                      fontSize: 'calc(14px + var(--chat-font-size-offset, 0px))',
                      lineHeight: 1.6,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      minWidth: 0,
                      flex: 1
                    }}
                  >
                    {commandArgs}
                  </span>
                )}
              </div>
              {expanded && (
                <MarkdownBody
                  className="markdown-user-message"
                  keepLineBreaks
                  cwd={cwd}
                  onOpenFile={onOpenFile}
                >
                  {content}
                </MarkdownBody>
              )}
            </div>
          ) : (
            <>
              {imageBlocksNode}
              {content && (
                <SafeMarkdownBody
                  className="markdown-user-message"
                  keepLineBreaks
                  cwd={cwd}
                  onOpenFile={onOpenFile}
                >
                  {content}
                </SafeMarkdownBody>
              )}
            </>
          )}
        </div>
      </div>

      {/* The turn's copy lives under the whole turn (components/TurnCopy);
          here only the actions that belong to this message remain. */}
      {(canFork || canEdit || canCancelEdit || time) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 6,
            marginTop: 3
          }}
        >
          {(canFork || canEdit || canCancelEdit) && (
            <div
              style={{
                display: 'flex',
                gap: 3,
                opacity: hovered || forking || canCancelEdit ? 1 : 0,
                pointerEvents: hovered || forking || canCancelEdit ? 'auto' : 'none',
                transition: 'opacity 0.12s'
              }}
            >
              {canEdit && !canCancelEdit && (
                <button
                  onClick={() => onEditContent!(editTarget, entryId!)}
                  title={t('i18n.editFromHereTitle')}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '3px 8px',
                    height: 22,
                    background: 'none',
                    border: 'none',
                    borderRadius: 5,
                    color: 'var(--text-dim)',
                    cursor: 'pointer',
                    fontSize: 11,
                    fontWeight: 400,
                    whiteSpace: 'nowrap',
                    transition: 'color 0.12s'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.color = 'var(--accent)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.color = 'var(--text-dim)';
                  }}
                >
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="15 10 20 15 15 20" />
                    <path d="M4 4v7a4 4 0 0 0 4 4h12" />
                  </svg>
                  {t('i18n.editFromHere')}
                </button>
              )}
              {canCancelEdit && (
                <button
                  type="button"
                  onClick={onCancelEdit}
                  title={t('i18n.cancel')}
                  aria-label={t('i18n.cancel')}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '3px 8px',
                    height: 22,
                    background: 'none',
                    border: 'none',
                    borderRadius: 5,
                    color: 'var(--accent)',
                    cursor: 'pointer',
                    fontSize: 11,
                    fontWeight: 500,
                    whiteSpace: 'nowrap'
                  }}
                >
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    aria-hidden="true"
                  >
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                  {t('i18n.cancel')}
                </button>
              )}
              {canFork && (
                <button
                  onClick={() => {
                    onFork!(entryId!);
                  }}
                  disabled={forking}
                  title={forking ? t('i18n.creatingSession') : t('i18n.newSessionTitle')}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '3px 8px',
                    height: 22,
                    background: 'none',
                    border: 'none',
                    borderRadius: 5,
                    color: forking ? 'var(--accent)' : 'var(--text-dim)',
                    cursor: forking ? 'not-allowed' : 'pointer',
                    fontSize: 11,
                    fontWeight: 400,
                    whiteSpace: 'nowrap',
                    transition: 'color 0.12s'
                  }}
                  onMouseEnter={(e) => {
                    if (!forking) e.currentTarget.style.color = 'var(--accent)';
                  }}
                  onMouseLeave={(e) => {
                    if (!forking) e.currentTarget.style.color = 'var(--text-dim)';
                  }}
                >
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <line x1="6" y1="3" x2="6" y2="15" />
                    <circle cx="18" cy="6" r="3" />
                    <circle cx="6" cy="18" r="3" />
                    <path d="M18 9a9 9 0 0 1-9 9" />
                  </svg>
                  {forking ? t('i18n.creating') : t('i18n.newSession')}
                </button>
              )}
            </div>
          )}
          {time && <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>{time}</span>}
        </div>
      )}
    </div>
  );
}

function AssistantMessageView({
  message,
  isStreaming,
  toolResults,
  cwd,
  onOpenFile,
  showTimestamp,
  prevTimestamp,
  sessionId,
  entryId,
  searchBlock,
  writtenFiles,
  turnDurationMs,
  turnUsage,
  toolDisplay,
  onCompact,
  isCompacting,
  compactError
}: {
  message: AssistantMessage;
  isStreaming?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  cwd?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
  showTimestamp?: boolean;
  prevTimestamp?: number;
  sessionId?: string;
  entryId?: string;
  searchBlock?: AssistantContentBlock;
  writtenFiles?: WrittenFile[];
  turnDurationMs?: number;
  turnUsage?: TurnUsage;
  toolDisplay?: TranscriptToolDisplay;
  onCompact?: () => void;
  isCompacting?: boolean;
  compactError?: string | null;
}) {
  const { locale, t } = useI18n();
  const time = showTimestamp ? formatTime(message.timestamp) : null;
  const { live } = useToolActivity();
  const blockItems = useMemo(
    () =>
      (message.content ?? [])
        .map((block, originalIndex) => ({ block, originalIndex }))
        // A card appears once the call runs: while the model is still writing its
        // arguments there is nothing to show but a half-streamed JSON blob.
        .filter(
          ({ block }) =>
            !isQuietActivityBlock(block) &&
            !isTransientToolBlock(block, toolResults, live, toolDisplay)
        ),
    [message.content, toolResults, live, toolDisplay]
  );
  // A card that just left (a shell that succeeded) stays where it stood until it
  // has been visible long enough to be read — a command that finished in a blink
  // is topped up to that moment — then fades and folds away where it stood.
  const heldItems = useExitingItems(blockItems, (item) => String(item.originalIndex), {
    minVisibleMs: TOOL_CARD_MIN_VISIBLE_MS
  });
  const blocks = useMemo(() => blockItems.map(({ block }) => block), [blockItems]);
  const providerError = getAssistantErrorMessage(message, { isStreaming });
  const truncated = isAssistantTruncated(message, { isStreaming });
  const unansweredTruncation = truncated && !hasAssistantAnswer(message);
  const blockItemsRef = useRef(blockItems);
  blockItemsRef.current = blockItems;
  const tokenEstimateCacheRef = useRef<Map<number, TokenEstimateCacheEntry>>(new Map());
  const estimatedTokens = useMemo(() => {
    if (!isStreaming) {
      tokenEstimateCacheRef.current = new Map();
      return 0;
    }
    const nextCache = new Map<number, TokenEstimateCacheEntry>();
    let total = 0;
    for (const { block, originalIndex } of blockItems) {
      const text = getTokenEstimateText(block);
      if (text === null) continue;
      const tokens = estimateUpdatedTokens(tokenEstimateCacheRef.current.get(originalIndex), text);
      nextCache.set(originalIndex, { text, tokens });
      total += tokens;
    }
    tokenEstimateCacheRef.current = nextCache;
    return total;
  }, [blockItems, isStreaming]);

  // Streaming-based timing for thinking blocks
  const blockStartTimesRef = useRef<Map<number, number>>(new Map());
  const [streamingDurations, setStreamingDurations] = useState<Map<number, number>>(new Map());

  // Thinking duration of a completed message: the whole response's generation time, which pi
  // records since 1.1 (`durationMs`, from the request's start). Older messages only have
  // timestamps: the time since the previous message.
  const messageDurationMs =
    message.role === 'assistant' ? recordedDurationMs(message.durationMs) : undefined;
  const thinkingDurationFromFile = useMemo<number | undefined>(() => {
    const ms =
      messageDurationMs ??
      (message.timestamp && prevTimestamp ? message.timestamp - prevTimestamp : undefined);
    if (ms === undefined) return undefined;
    const secs = Math.round(ms / 1000);
    return secs > 0 ? secs : undefined;
  }, [messageDurationMs, message.timestamp, prevTimestamp]);

  // Tool call durations in milliseconds: the execution time pi records on each result since 1.1,
  // as the pi CLI's "Took" shows it. An older result only has timestamps, the result's minus this
  // message's (when its request started), which counts the model's generation too.
  const toolCallDurations = useMemo<Map<string, number>>(() => {
    const map = new Map<string, number>();
    if (!toolResults) return map;
    for (const [callId, result] of toolResults) {
      const ms =
        recordedDurationMs(result.durationMs) ??
        (result.timestamp && message.timestamp ? result.timestamp - message.timestamp : undefined);
      if (ms !== undefined && ms >= TOOL_DURATION_MIN_MS) map.set(callId, ms);
    }
    return map;
  }, [toolResults, message.timestamp]);

  useEffect(() => {
    if (!isStreaming) {
      // Finalise any un-finished thinking block durations on stream end
      const now = new Date().getTime();
      setStreamingDurations((prev: Map<number, number>) => {
        const next = new Map(prev);
        for (const [idx, start] of blockStartTimesRef.current) {
          if (!next.has(idx)) next.set(idx, Math.round((now - start) / 1000));
        }
        return next;
      });
      return;
    }
    const tick = () => {
      const items = blockItemsRef.current;
      const now = Date.now();

      // Record start time for each block the first time we see it
      items.forEach(({ originalIndex }) => {
        if (!blockStartTimesRef.current.has(originalIndex))
          blockStartTimesRef.current.set(originalIndex, now);
      });

      // When a non-last block has a successor already started, finalise its duration
      setStreamingDurations((prev: Map<number, number>) => {
        let changed = false;
        const next = new Map(prev);
        for (let i = 0; i < items.length - 1; i++) {
          const originalIndex = items[i].originalIndex;
          const nextOriginalIndex = items[i + 1].originalIndex;
          if (!next.has(originalIndex) && blockStartTimesRef.current.has(originalIndex)) {
            const start = blockStartTimesRef.current.get(originalIndex)!;
            const nextStart = blockStartTimesRef.current.get(nextOriginalIndex) ?? now;
            next.set(originalIndex, Math.round((nextStart - start) / 1000));
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    };
    const id = setInterval(tick, 300);
    return () => clearInterval(id);
  }, [isStreaming]);

  if (blocks.length === 0 && heldItems.length === 0 && !providerError && !truncated) return null;

  return (
    <div data-message-role="assistant" data-entry-id={entryId} style={{ marginBottom: 10 }}>
      {/* Streaming stats: estimated tokens; gone once the turn settles. */}
      {isStreaming && Math.round(estimatedTokens) > 0 && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-dim)',
            marginBottom: 4,
            display: 'flex',
            alignItems: 'center',
            gap: 6
          }}
        >
          <span
            style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text)' }}
            title={t('i18n.estimatedTokens')}
          >
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                fontSize: 11,
                fontWeight: 400
              }}
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="5" y1="1.5" x2="5" y2="8.5" />
                <polyline points="2 6 5 8.5 8 6" />
              </svg>
              {Math.round(estimatedTokens)}
            </span>
          </span>
        </div>
      )}

      {/* Keep activity steps visually distinct from the message body. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {/* Not keyed by the entry id: a message of this run gets one when the file is
            read again, and its blocks keep their state across that read (#1184). */}
        {heldItems.map(({ item: { block, originalIndex }, exiting, fading }) => (
          <BlockView
            key={originalIndex}
            block={block}
            exiting={exiting}
            fading={fading}
            searchTarget={block === searchBlock}
            toolResults={toolResults}
            isStreaming={isStreaming}
            streamingDuration={
              streamingDurations.get(originalIndex) ??
              (block.type === 'thinking' ? thinkingDurationFromFile : undefined)
            }
            toolCallDurations={toolCallDurations}
            cwd={cwd}
            onOpenFile={onOpenFile}
            sessionId={sessionId}
            entryId={entryId}
            blockIndex={originalIndex}
          />
        ))}
      </div>

      {providerError && (
        <div
          role="alert"
          style={{
            marginTop: blocks.length > 0 ? 8 : 0,
            padding: '7px 10px',
            border: '1px solid rgba(239,68,68,0.3)',
            borderRadius: 6,
            background: 'rgba(239,68,68,0.07)',
            color: '#ef4444',
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere'
          }}
        >
          Error: {providerError}
        </div>
      )}

      {truncated && (
        <div
          role="alert"
          style={{
            marginTop: blocks.length > 0 || providerError ? 8 : 0,
            padding: '7px 10px',
            border: '1px solid rgba(234,179,8,0.3)',
            borderRadius: 6,
            background: 'rgba(234,179,8,0.07)',
            color: '#ca8a04',
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere'
          }}
        >
          {t(unansweredTruncation ? 'chat.truncatedWithoutAnswer' : 'chat.truncatedByOutputLimit')}
          {unansweredTruncation && onCompact && (
            <button
              type="button"
              onClick={onCompact}
              disabled={isCompacting}
              style={{
                display: 'block',
                marginTop: 8,
                padding: '3px 8px',
                border: '1px solid currentColor',
                borderRadius: 5,
                background: 'transparent',
                color: 'inherit',
                cursor: isCompacting ? 'default' : 'pointer',
                font: 'inherit'
              }}
            >
              {t(isCompacting ? 'chat.compacting' : 'chat.compactContext')}
            </button>
          )}
          {unansweredTruncation && compactError && (
            <div style={{ marginTop: 8, color: '#ef4444', whiteSpace: 'pre-wrap' }}>
              {compactError}
            </div>
          )}
        </div>
      )}

      {writtenFiles && writtenFiles.length > 0 && <TurnWrittenFiles files={writtenFiles} />}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginTop: 4
        }}
      >
        {(turnUsage !== undefined || turnDurationMs !== undefined) && !isStreaming && (
          <div
            style={{ fontSize: 11, color: 'var(--text-dim)' }}
            title={turnUsage ? turnUsageTitle(turnUsage, t, locale) : undefined}
          >
            {[
              turnUsage
                ? t('chat.turnTokens', { count: formatCompactCount(turnUsage.total) })
                : null,
              turnDurationMs !== undefined
                ? t('chat.turnDuration', { time: formatTurnDuration(turnDurationMs) })
                : null
            ]
              .filter(Boolean)
              .join(' \u00b7 ')}
          </div>
        )}
        {time && !isStreaming && (
          <span style={{ fontSize: 10, color: 'var(--text-dim)', marginLeft: 'auto' }}>{time}</span>
        )}
      </div>
    </div>
  );
}

function BlockView({
  block,
  exiting,
  fading,
  searchTarget,
  toolResults,
  isStreaming,
  streamingDuration,
  toolCallDurations,
  cwd,
  onOpenFile,
  sessionId,
  entryId,
  blockIndex
}: {
  block: AssistantContentBlock;
  /** The block just left the transcript and is fading out. */
  exiting?: boolean;
  /** The leaving card's hold is spent: the exit fold plays now. */
  fading?: boolean;
  searchTarget?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  isStreaming?: boolean;
  streamingDuration?: number;
  toolCallDurations?: Map<string, number>;
  cwd?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
  sessionId?: string;
  entryId?: string;
  blockIndex: number;
}) {
  if (block.type === 'text') {
    return (
      <div data-message-text data-search-target={searchTarget || undefined}>
        <TextBlock
          block={block as TextContent}
          isStreaming={isStreaming}
          cwd={cwd}
          onOpenFile={onOpenFile}
        />
      </div>
    );
  }
  if (block.type === 'thinking') {
    return (
      <ThinkingBlock
        block={block as ThinkingContent}
        duration={streamingDuration}
        sessionId={sessionId}
        entryId={entryId}
        blockIndex={blockIndex}
      />
    );
  }
  if (block.type === 'toolCall') {
    const tc = block as ToolCallContent;
    const result = toolResults?.get(tc.toolCallId);
    const duration = toolCallDurations?.get(tc.toolCallId);
    return (
      <ToolCallBlock
        block={tc}
        result={result}
        duration={duration}
        exiting={exiting}
        fading={fading}
      />
    );
  }
  return null;
}

function TextBlock({
  block,
  isStreaming,
  cwd,
  onOpenFile
}: {
  block: TextContent;
  isStreaming?: boolean;
  cwd?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
}) {
  return (
    <SafeMarkdownBody isStreaming={isStreaming} cwd={cwd} onOpenFile={onOpenFile}>
      {block.text}
    </SafeMarkdownBody>
  );
}

// A model looping in its thinking can write megabytes. As one text node, every
// streamed chunk laid all of it out again (the prompt anchor reads layout after
// each commit). As pieces, only the last one changes. Thinking that fits one
// piece stays one text node.
function ThinkingText({ text }: { text: string }) {
  const pieces = useMemo(() => splitThinkingPieces(text), [text]);
  if (pieces.length === 1) return text;
  // No memo: React already skips a div whose text is unchanged, and a memo
  // bailout keeps the old props, each a slice pinning the whole thinking of
  // its chunk (995 MB retained streaming 2M Chinese characters).
  return pieces.map((piece, index) => <div key={index}>{piece.text}</div>);
}

export function ThinkingBlock({
  block,
  duration,
  sessionId,
  entryId,
  blockIndex
}: {
  block: ThinkingContent;
  duration?: number;
  sessionId?: string;
  entryId?: string;
  blockIndex: number;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(isThinkingExpandedByDefault);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The block outlives a change of entry id (a message of this run gets its id
  // when the file is read again, #1184): what was loaded for another entry goes.
  const loadKey = `${sessionId}:${entryId}:${blockIndex}`;
  const [loadedKey, setLoadedKey] = useState(loadKey);
  if (loadedKey !== loadKey) {
    setLoadedKey(loadKey);
    setContent(null);
    setLoading(false);
    setError(null);
  }
  const tRef = useRef(t);
  tRef.current = t;

  // Keep already-mounted blocks in sync when the preference changes.
  useEffect(() => {
    const onChange = () => setExpanded(isThinkingExpandedByDefault());
    window.addEventListener(THINKING_EXPANDED_EVENT, onChange);
    return () => window.removeEventListener(THINKING_EXPANDED_EVENT, onChange);
  }, []);

  // Load deferred history content whenever the block is expanded.
  // loadThinkingContent() memoizes in-flight promises and drops failed ones
  // from its cache, so re-running this effect is cheap and a failed load can
  // be retried by collapsing and expanding the block again.
  useEffect(() => {
    if (!expanded || !block.deferred || content !== null) return;
    if (!sessionId || !entryId) {
      setError(tRef.current('i18n.thinkingUnavailable'));
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadThinkingContent(sessionId, entryId, blockIndex)
      .then((value) => {
        if (!cancelled) {
          setContent(value);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, block.deferred, content, sessionId, entryId, blockIndex]);

  return (
    <div
      className="thinking-block"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 6,
        minWidth: 0,
        borderRadius: 7,
        padding: '6px 10px',
        background: 'var(--bg-subtle)',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--font-mono-size, 15px)',
        lineHeight: 1.5
      }}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={t('activity.thought')}
        title={t('activity.thought')}
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          width: expanded ? 14 : '100%',
          flexShrink: expanded ? 0 : 1,
          minWidth: 0,
          minHeight: '1.5em',
          padding: 0,
          background: 'transparent',
          border: 'none',
          color: 'var(--text-muted)',
          cursor: 'pointer',
          font: 'inherit',
          textAlign: 'left'
        }}
      >
        <ThinkingIcon active={expanded} />
        {!expanded && (
          <span
            style={{
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {t('activity.thought')}
          </span>
        )}
      </button>
      {expanded && (
        <div
          style={{
            flex: 1,
            minWidth: 0,
            color: error ? '#f87171' : 'var(--text-muted)',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere'
          }}
        >
          {loading
            ? t('i18n.loadingThinking')
            : (error ?? <ThinkingText text={(block.deferred ? content : block.thinking) ?? ''} />)}
        </div>
      )}
      {duration !== undefined && (
        <span
          style={{ flexShrink: 0, color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums' }}
        >
          {duration}s
        </span>
      )}
    </div>
  );
}

/** A duration pi recorded on a message, or undefined when there is none to trust. */
function recordedDurationMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Below this a tool card shows no time: it would read 0.0s on every quick read or search. */
const TOOL_DURATION_MIN_MS = 100;

/**
 * The quiet card has no outline — its surface tint in
 * `styles/tool-cards.css` draws the card — so every divider inside it is the
 * border token at less than half strength: a whisper, not a rule.
 */

/** A tool's run time as the pi CLI's "Took" writes it: 2.4s, then 3m 5s, then 1h 2m 5s. */
export function formatToolDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
}

function ToolCallBlock({
  block,
  result,
  duration,
  executing,
  exiting,
  fading
}: {
  block: ToolCallContent;
  result?: ToolResultMessage;
  duration?: number;
  executing?: boolean;
  /** The card is on its way out of the transcript: it keeps its last look and fades. */
  exiting?: boolean;
  /** The leaving card's hold is spent: the exit fold plays now. */
  fading?: boolean;
}) {
  const { t } = useI18n();
  // only explicit user choices are state; lifecycle defaults stay derived.
  const [expansionOverride, setExpansionOverride] = useState(() =>
    getToolCallExpansion(block.toolCallId)
  );
  const toolError =
    (result?.isError ?? false) ||
    (isApplyPatchToolName(block.toolName) && applyPatchResultHasFailures(result?.details));
  const activityState = useToolState(block.toolCallId, result !== undefined, toolError);
  const toolState = executing ? 'running' : activityState;
  // A card on its way out (`exiting`) keeps however it stood, so an open shell
  // or codemode card lingers open with its result until its fade, not folded.
  const expanded =
    expansionOverride ?? (exiting || isToolCardExpandedByDefault(block.toolName, toolState));
  // A card only moves when it lived in this page: a call that was still running
  // at mount. Restored history, a re-render or a scroll never replays the fade.
  const [enteredLive] = useState(() => toolState === 'running' || toolState === 'pending');
  // The body's content is kept while it folds shut, so closing is not a cut.
  const bodyContent = useBodyContent(expanded);
  // A shell's output opens on its tail; the lines above it wait behind a button.
  const [showAllOutput, setShowAllOutput] = useState(false);
  const toggleExpanded = () => {
    const next = !expanded;
    setToolCallExpanded(block.toolCallId, next);
    setExpansionOverride(next);
  };
  const resultDiff = result && !result.isError ? getResultDiff(result) : null;
  // A write with a stored patch is reviewed as the change itself: the full file
  // text and the arguments would only repeat what the diff already shows.
  const writeDiffOnly = resultDiff !== null && isWriteToolName(block.toolName);
  const writtenFileText = writeDiffOnly ? null : getWrittenFileText(block);
  const inputStr = writtenFileText ?? getToolCallInputText(block);
  const isStreamingInput = block.rawInput !== undefined;
  const isEditTool = isEditToolName(block.toolName);
  const patchFiles = getApplyPatchFiles(block, result);
  const patchLabel = isApplyPatchToolName(block.toolName) ? summarizeApplyPatchInput(block) : null;
  // A script and the calls it made, instead of the input JSON. Streamed input is
  // still incomplete JSON and keeps the generic view.
  const codemodeCode =
    block.toolName === CODEMODE_TOOL_NAME && !isStreamingInput ? codemodeScript(block.input) : null;
  const codemode =
    codemodeCode === null ? null : { code: codemodeCode, ...codemodeCalls(result?.details) };
  // A running script's progress snapshot has calls but no content yet.
  const codemodeRunning = codemode !== null && result !== undefined && result.content.length === 0;

  // Flat arguments as rows instead of a JSON blob, unless the card has a view of
  // its own (a write's file text, codemode, an applied patch). See `lib/tool-fields.ts`.
  const toolFields =
    !isStreamingInput &&
    !writeDiffOnly &&
    writtenFileText === null &&
    codemode === null &&
    patchFiles === null
      ? toolFieldsOfInput(block.input)
      : null;

  // `server/tool` instead of the registered `mcp__server__tool`, as pi's TUI shows it.
  const mcpLabel = mcpToolLabel(block.toolName, result?.details);

  // Result display
  const resultContent = result
    ? codemode
      ? stripCodemodeHeader(result.content)
      : result.content
    : [];
  const joinedResultText = result
    ? resultContent
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
    : null;
  const resultText =
    mcpLabel && joinedResultText !== null
      ? prettyMcpResultText(joinedResultText)
      : joinedResultText;
  const resultImages = getMessageImages(resultContent);
  const resultIsEmpty =
    resultText === null ? false : resultText.trim() === '(no output)' || resultText.trim() === '';
  const isError =
    (result?.isError ?? false) ||
    (isApplyPatchToolName(block.toolName) && applyPatchResultHasFailures(result?.details));
  const shellTool = isShellToolName(block.toolName);
  const codemodeTool = block.toolName === CODEMODE_TOOL_NAME;
  // Only a long shell result folds: a short one reads whole, as before.
  const shellTail = shellTool && resultText !== null ? shellOutputTail(resultText) : null;
  const codemodeCallCount = codemode ? codemode.calls.length + codemode.omitted : 0;
  // the syntax of everything this card shows — a file's code for read/write/
  // edit, a shell script for bash/powershell (lib/tool-code-language.ts). Nothing
  // is colored while the input is still streaming JSON.
  const codeLanguage = isStreamingInput ? undefined : toolCodeLanguage(block.toolName, block.input);

  // A run-panel card (a user-run bash command here) leaves the transcript once
  // it succeeded; while it is on its way out (`exiting`) it keeps drawing itself
  // as it stood — open — first held visibly, then fading (`fading`).
  if ((shellTool || codemodeTool) && toolState === 'success' && !exiting) return null;

  return (
    <ToolCodeLanguageProvider lang={codeLanguage}>
      <div
        className={exiting && fading ? 'tool-card-exit' : undefined}
        inert={exiting ? true : undefined}
      >
        <div
          className="tool-card"
          data-state={toolState}
          data-live={enteredLive ? 'true' : undefined}
          aria-busy={toolState === 'running'}
          style={{
            // no border and no tint here — `.tool-card` in tool-cards.css
            // draws the quiet surface; workspace.css lifts this 7px to --ui-radius-md.
            borderRadius: 7,
            overflow: 'hidden',
            fontSize: 12
          }}
        >
          {/* ── Tool call header ── */}
          <div style={{ display: 'flex', alignItems: 'stretch', minWidth: 0 }}>
            <button
              onClick={toggleExpanded}
              aria-expanded={expanded}
              className="tool-card-header"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                flex: 1,
                minWidth: 0,
                // Roomier rows improve scanning of tool arguments.
                padding: '7px 12px',
                background: 'none',
                border: 'none',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                fontSize: 12,
                textAlign: 'left'
              }}
            >
              <span
                title={mcpLabel ? block.toolName : undefined}
                style={{
                  color: isError ? '#f87171' : 'var(--text-muted)',
                  fontFamily: 'var(--font-mono)',
                  fontWeight: 600,
                  fontSize: 11,
                  flexShrink: 0
                }}
              >
                {mcpLabel ? (
                  <>
                    <span style={{ fontWeight: 500, opacity: 0.75 }}>{mcpLabel.server}/</span>
                    {mcpLabel.tool}
                  </>
                ) : (
                  block.toolName
                )}
              </span>
              <span
                style={{
                  color: 'var(--text-dim)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: 1,
                  minWidth: 0
                }}
              >
                {isStreamingInput
                  ? t('chat.generatingToolInput')
                  : (patchLabel ??
                    (codemode ? codemodeScriptPreview(codemode.code) : getToolPreview(block)))}
              </span>
              {!(shellTool && expanded && toolState === 'running') && (
                <ToolStatus state={toolState} />
              )}
              {codemodeCallCount > 0 && (
                <span
                  style={{
                    fontSize: 11,
                    color: 'var(--text-dim)',
                    flexShrink: 0,
                    fontVariantNumeric: 'tabular-nums'
                  }}
                >
                  {codemodeCallCount === 1
                    ? t('codemode.callCountOne')
                    : t('codemode.callCount', { count: codemodeCallCount })}
                </span>
              )}
              {duration !== undefined && (
                <span
                  style={{
                    fontSize: 11,
                    color: 'var(--text-dim)',
                    flexShrink: 0,
                    fontVariantNumeric: 'tabular-nums'
                  }}
                >
                  {formatToolDuration(duration)}
                </span>
              )}
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                fill="none"
                stroke="var(--text-dim)"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{
                  flexShrink: 0,
                  transform: expanded ? 'rotate(180deg)' : 'none',
                  transition: 'transform 0.15s'
                }}
              >
                <polyline points="2 3.5 5 6.5 8 3.5" />
              </svg>
            </button>
          </div>

          {/* The body folds open and shut (`styles/tool-cards.css`): its content is
            clipped, not unmounted mid-fold, so closing reads as a movement. */}
          <div
            className="tool-card-body"
            data-open={expanded ? 'true' : undefined}
            inert={expanded ? undefined : true}
          >
            <div className="tool-card-body-inner">
              {bodyContent && (
                <div className="tool-card-body-content">
                  {/* The executed steps come first; the script remains available on demand. */}
                  {bodyContent && codemode && (
                    <CodemodeCallList calls={codemode.calls} omitted={codemode.omitted} />
                  )}
                  {bodyContent && codemode && (
                    <details className="codemode-script">
                      <summary>{t('codemode.script')}</summary>
                      <pre>
                        <ToolCodeTokens text={codemode.code.replace(/\r/g, '').trimEnd()} />
                      </pre>
                    </details>
                  )}

                  {/* ── Expanded: input args when no richer view exists ── */}
                  {bodyContent &&
                    !codemode &&
                    (isStreamingInput || !isEditTool) &&
                    !patchFiles &&
                    !writeDiffOnly &&
                    (toolFields ? (
                      <div
                        style={{
                          padding: '8px 12px 10px',
                          borderTop: CARD_RULE
                        }}
                      >
                        <ToolFieldRows fields={toolFields} />
                      </div>
                    ) : (
                      <pre
                        style={{
                          margin: 0,
                          padding: '9px 12px',
                          color: 'var(--text-muted)',
                          fontSize: 'var(--font-mono-size, 15px)',
                          lineHeight: 1.5,
                          overflow: 'auto',
                          background: 'var(--tool-card-pane)',
                          borderTop: CARD_RULE,
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-all'
                        }}
                      >
                        <ToolCodeTokens text={inputStr} />
                      </pre>
                    ))}

                  {/* ── Expanded: applied-patch split diff ── */}
                  {bodyContent && patchFiles && (
                    <div style={{ borderTop: CARD_RULE }}>
                      <SplitFilesView files={patchFiles} />
                    </div>
                  )}

                  {/* ── Paired result — only shown when expanded ── */}
                  {bodyContent && result && patchFiles && isError && (
                    <PairedResult
                      text={resultText ?? ''}
                      isEmpty={resultIsEmpty}
                      isError={isError}
                    />
                  )}
                  {bodyContent &&
                    result &&
                    !patchFiles &&
                    !codemodeRunning &&
                    !(shellTool && toolState === 'running' && resultIsEmpty) &&
                    (resultDiff ? (
                      <PairedDiffResult diff={resultDiff} />
                    ) : (
                      (!resultIsEmpty || resultImages.length === 0) &&
                      (shellTail && !showAllOutput ? (
                        <ShellTailResult
                          text={shellTail.tail}
                          hiddenLines={shellTail.hiddenLines}
                          isError={isError}
                          onShowAll={() => setShowAllOutput(true)}
                        />
                      ) : (
                        <PairedResult
                          text={resultText ?? ''}
                          isEmpty={resultIsEmpty}
                          isError={isError}
                        />
                      ))
                    ))}

                  {/* back to the shell's tail after the whole output was shown. */}
                  {bodyContent && shellTail && showAllOutput && (
                    <ShellOutputFooter onShowLess={() => setShowAllOutput(false)} />
                  )}

                  {/* Keep execution feedback at the reading edge, after the output buffer. */}
                  {shellTool && bodyContent && toolState === 'running' && (
                    <div className="shell-running" role="status">
                      <ToolStatus state={toolState} />
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* ── Result images — always visible, independent of the collapsed details ── */}
          {resultImages.length > 0 && <ResultImages images={resultImages} />}
        </div>
      </div>
    </ToolCodeLanguageProvider>
  );
}

interface ResultDiff {
  text: string;
}

function PairedDiffResult({ diff }: { diff: ResultDiff }) {
  return (
    <div className="tool-card-pane" style={{ borderTop: CARD_RULE }}>
      <SplitPatchView text={diff.text} />
    </div>
  );
}

/** A shell result's last lines, with earlier output behind a Show all button. */
function ShellTailResult({
  text,
  hiddenLines,
  isError,
  onShowAll
}: {
  text: string;
  hiddenLines: number;
  isError: boolean;
  onShowAll: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="tool-card-pane" style={{ borderTop: CARD_RULE }}>
      <button
        type="button"
        onClick={onShowAll}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          padding: '6px 12px',
          border: 'none',
          borderBottom: CARD_RULE,
          background: 'none',
          color: 'var(--accent)',
          cursor: 'pointer',
          fontSize: 'var(--font-mono-size, 15px)',
          fontVariantNumeric: 'tabular-nums',
          textAlign: 'left'
        }}
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
        {t('chat.showAllOutput', { count: hiddenLines })}
      </button>
      <pre
        style={{
          margin: 0,
          padding: '8px 12px',
          color: isError ? '#f87171' : 'var(--text-muted)',
          fontSize: 'var(--font-mono-size, 15px)',
          lineHeight: 1.55,
          overflow: 'auto',
          maxHeight: 400,
          background: 'var(--tool-card-pane)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all'
        }}
      >
        <ToolCodeTokens text={text} />
      </pre>
    </div>
  );
}

/** Return to the shell output tail after showing the full result. */
function ShellOutputFooter({ onShowLess }: { onShowLess: () => void }) {
  const { t } = useI18n();
  return (
    <div
      style={{
        borderTop: CARD_RULE
      }}
    >
      <button
        type="button"
        onClick={onShowLess}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          padding: '6px 12px',
          border: 'none',
          background: 'none',
          color: 'var(--text-dim)',
          cursor: 'pointer',
          fontSize: 'var(--font-mono-size, 15px)',
          textAlign: 'left'
        }}
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M18 15l-6-6-6 6" />
        </svg>
        {t('chat.showLessOutput')}
      </button>
    </div>
  );
}

/**
 * Split diff rows for an apply_patch-style tool call.
 *
 * Prefers parsing the V4A patch document from the call input. The extension's
 * applied result preview contains the complete old/new file with unchanged
 * lines, so it is only used as a fallback when the call input is unavailable.
 * A single call may contain several file operations — each becomes its own
 * file section.
 */
function getApplyPatchFiles(
  block: ToolCallContent,
  result?: ToolResultMessage
): SplitDiffFile[] | null {
  if (!isApplyPatchToolName(block.toolName)) return null;

  const fromInput = parseApplyPatchInput(getApplyPatchInputText(block.input, block.rawInput));
  if (fromInput) return fromInput;

  const details =
    result && !result.isError
      ? (result as ToolResultMessage & { details?: unknown }).details
      : undefined;
  if (isRecord(details)) {
    const fromPreview = applyPatchPreviewToFiles(details.preview);
    if (fromPreview) return fromPreview;
  }

  return null;
}

/** Header label listing the files targeted by an apply_patch call. */
function summarizeApplyPatchInput(block: ToolCallContent): string | null {
  const paths = extractApplyPatchPaths(getApplyPatchInputText(block.input, block.rawInput));
  if (paths.length === 0) return null;
  return paths.join(', ').slice(0, 120);
}

function getResultDiff(result: ToolResultMessage): ResultDiff | null {
  const details = (result as ToolResultMessage & { details?: unknown }).details;
  if (!isRecord(details)) return null;

  const patch = typeof details.patch === 'string' ? details.patch : null;
  if (patch) return { text: patch };

  const diff = typeof details.diff === 'string' ? details.diff : null;
  if (diff) return { text: diff };

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ResultImages({ images }: { images: ImageContent[] }) {
  return (
    <div
      className="tool-card-pane"
      style={{
        display: 'flex',
        gap: 8,
        flexWrap: 'wrap',
        padding: '10px',
        background: 'var(--tool-card-pane)',
        borderTop: CARD_RULE
      }}
    >
      {images.map((image, index) => {
        const src = imageSource(image);
        if (!src) return null;
        return (
          <ImagePreview key={`${src}-${index}`} src={src} style={{ maxWidth: '100%' }}>
            <img
              src={src}
              alt=""
              loading="lazy"
              style={{
                display: 'block',
                maxWidth: 'min(100%, 720px)',
                maxHeight: 520,
                borderRadius: 6,
                objectFit: 'contain',
                border: `1px solid ${CARD_RULE_COLOR}`
              }}
            />
          </ImagePreview>
        );
      })}
    </div>
  );
}

function PairedResult({
  text,
  isEmpty,
  isError
}: {
  text: string;
  isEmpty: boolean;
  isError: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="tool-card-pane" style={{ borderTop: CARD_RULE }}>
      <pre
        style={{
          margin: 0,
          padding: '9px 12px',
          color: isError ? '#f87171' : isEmpty ? 'var(--text-dim)' : 'var(--text-muted)',
          fontSize: 'var(--font-mono-size, 15px)',
          lineHeight: 1.5,
          overflow: 'auto',
          maxHeight: 400,
          background: 'var(--tool-card-pane)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          fontStyle: isEmpty ? 'italic' : 'normal',
          opacity: isEmpty ? 0.6 : 1
        }}
      >
        {isEmpty ? t('i18n.noOutput') : <ToolCodeTokens text={text} />}
      </pre>
    </div>
  );
}

function CompactionMessageView({ message }: { message: CustomMessage }) {
  const { t } = useI18n();
  // Collapsed by default, as in pi's TUI: a summary can run to pages.
  const [expanded, setExpanded] = useState(false);
  const summary = getMessageText(message.content);
  const time = formatTime(message.timestamp);
  const tokensBefore = (message.details as { tokensBefore?: unknown } | undefined)?.tokensBefore;
  // pi's showCacheMissNotices (#1265): what the compaction billed, in its card.
  const costNotice = getTranscriptNotices(message).find(
    (notice) => notice.kind === 'summary_cost' && notice.source === 'compaction'
  );

  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          borderRadius: 8,
          overflow: 'hidden',
          background: 'var(--bg-subtle)'
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '7px 10px',
            borderBottom: CARD_RULE,
            color: 'var(--text-muted)'
          }}
        >
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 650 }}>
            compaction
          </span>
          {time && (
            <span style={{ marginLeft: 'auto', color: 'var(--text-dim)', fontSize: 10 }}>
              {time}
            </span>
          )}
        </div>

        <div style={{ padding: '11px 13px 12px' }}>
          <button
            type="button"
            aria-expanded={expanded}
            title={expanded ? t('i18n.collapse') : t('i18n.expand')}
            onClick={() => setExpanded((v) => !v)}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              width: '100%',
              padding: 0,
              border: 'none',
              background: 'transparent',
              color: 'var(--text)',
              cursor: 'pointer',
              font: 'inherit',
              textAlign: 'left'
            }}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              style={{
                flexShrink: 0,
                marginTop: 4,
                color: 'var(--text-muted)',
                transform: expanded ? 'rotate(90deg)' : 'none',
                transition: 'transform 0.15s'
              }}
            >
              <polyline points="4 2.5 7.5 6 4 9.5" />
            </svg>
            <span style={{ minWidth: 0 }}>
              <span
                style={{
                  display: 'block',
                  fontSize: 'calc(15px + var(--chat-font-size-offset, 0px))',
                  fontWeight: 700,
                  lineHeight: 1.35
                }}
              >
                {t('i18n.conversationCompacted')}
              </span>
              {typeof tokensBefore === 'number' && Number.isFinite(tokensBefore) && (
                <span
                  style={{
                    display: 'block',
                    marginTop: 3,
                    color: 'var(--text-muted)',
                    fontSize: 'calc(13px + var(--chat-font-size-offset, 0px))',
                    lineHeight: 1.5
                  }}
                >
                  {t('i18n.compactedFromTokens', { tokens: tokensBefore.toLocaleString() })}
                </span>
              )}
              {costNotice && (
                <span
                  style={{
                    display: 'block',
                    marginTop: 2,
                    color: TRANSCRIPT_NOTICE_WARNING_COLOR,
                    fontSize: 'calc(12px + var(--chat-font-size-offset, 0px))',
                    lineHeight: 1.5
                  }}
                >
                  {transcriptNoticeText(t, costNotice)}
                </span>
              )}
            </span>
          </button>
          {expanded && <CompactionSummaryDetails summary={summary} />}
        </div>
      </div>
    </div>
  );
}

export function CompactionSummaryDetails({ summary }: { summary: string }) {
  const { t } = useI18n();
  const parsedSummary = useMemo(() => parseCompactionSummary(summary), [summary]);

  return (
    <div style={{ marginTop: 10 }}>
      <div
        style={{
          marginBottom: 10,
          color: 'var(--text)',
          fontSize: 'calc(14px + var(--chat-font-size-offset, 0px))',
          lineHeight: 1.5
        }}
      >
        {t('i18n.compactionDescription')}
      </div>
      {parsedSummary.body ? (
        <MarkdownBody className="markdown-compaction-message">{parsedSummary.body}</MarkdownBody>
      ) : (
        <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{t('i18n.noSummary')}</span>
      )}
      <CompactionFileMetadata
        readFiles={parsedSummary.readFiles}
        modifiedFiles={parsedSummary.modifiedFiles}
      />
    </div>
  );
}

function CompactionFileMetadata({
  readFiles,
  modifiedFiles
}: {
  readFiles: string[];
  modifiedFiles: string[];
}) {
  const { t } = useI18n();
  const total = readFiles.length + modifiedFiles.length;
  if (total === 0) return null;

  const parts = [];
  if (readFiles.length > 0) parts.push(`${readFiles.length} read`);
  if (modifiedFiles.length > 0) parts.push(`${modifiedFiles.length} modified`);

  return (
    <details className="compaction-file-details">
      <summary>{t('i18n.fileContext', { details: parts.join(', ') })}</summary>
      {modifiedFiles.length > 0 && (
        <CompactionFileList title={t('i18n.modifiedFiles')} files={modifiedFiles} />
      )}
      {readFiles.length > 0 && <CompactionFileList title={t('i18n.readFiles')} files={readFiles} />}
    </details>
  );
}

function CompactionFileList({ title, files }: { title: string; files: string[] }) {
  return (
    <div className="compaction-file-section">
      <div className="compaction-file-title">{title}</div>
      <ul className="compaction-file-list">
        {files.map((file) => (
          <li key={file}>{file}</li>
        ))}
      </ul>
    </div>
  );
}

function CustomMessageView({
  message,
  cwd,
  onOpenFile
}: {
  message: CustomMessage;
  cwd?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
}) {
  const { t } = useI18n();
  // Expanded by default: pi's TUI always draws a displayed custom message in full.
  const [contentExpanded, setContentExpanded] = useState(true);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const text = getMessageText(message.content);
  const images = getMessageImages(message.content);
  const hasDetails = message.details !== undefined;
  const detailsText = hasDetails ? safeJson(message.details) : '';
  const title = formatCustomType(message.customType);
  const time = formatTime(message.timestamp);

  return (
    <div style={{ marginBottom: 10 }}>
      <div
        style={{
          borderRadius: 8,
          overflow: 'hidden',
          background: 'var(--bg-subtle)'
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '7px 10px',
            borderBottom: contentExpanded ? CARD_RULE : 'none',
            color: 'var(--text-muted)',
            fontSize: 12
          }}
        >
          <button
            type="button"
            onClick={() => setContentExpanded((v) => !v)}
            aria-expanded={contentExpanded}
            title={contentExpanded ? t('i18n.collapse') : t('i18n.expand')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              minWidth: 0,
              flex: 1,
              padding: 0,
              border: 'none',
              background: 'none',
              color: 'inherit',
              cursor: 'pointer',
              fontSize: 'inherit',
              textAlign: 'left'
            }}
          >
            <span
              style={{
                color: 'var(--text-muted)',
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                fontWeight: 650,
                flexShrink: 0
              }}
            >
              {title}
            </span>
            {!contentExpanded && text && (
              <span
                style={{
                  color: 'var(--text-dim)',
                  fontSize: 11,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  minWidth: 0
                }}
              >
                {text.slice(0, 300).replace(/\s+/g, ' ').trim()}
              </span>
            )}
            {time && (
              <span
                style={{
                  marginLeft: 'auto',
                  color: 'var(--text-dim)',
                  fontSize: 10,
                  flexShrink: 0
                }}
              >
                {time}
              </span>
            )}
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              stroke="var(--text-dim)"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              style={{
                flexShrink: 0,
                transform: contentExpanded ? 'rotate(180deg)' : 'none',
                transition: 'transform 0.15s'
              }}
            >
              <polyline points="2 3.5 5 6.5 8 3.5" />
            </svg>
          </button>
        </div>

        {contentExpanded && (
          <>
            <div style={{ padding: '6px 9px' }}>
              {images.length > 0 && (
                <div
                  style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: text ? 8 : 0 }}
                >
                  {images.map((img, i) => {
                    const src = imageSource(img);
                    if (!src) return null;
                    return (
                      <ImagePreview key={i} src={src}>
                        <img
                          src={src}
                          alt=""
                          style={{
                            maxWidth: 240,
                            maxHeight: 240,
                            borderRadius: 6,
                            objectFit: 'contain',
                            display: 'block',
                            border: `1px solid ${CARD_RULE_COLOR}`
                          }}
                        />
                      </ImagePreview>
                    );
                  })}
                </div>
              )}
              {text ? (
                <MarkdownBody className="markdown-custom-message" cwd={cwd} onOpenFile={onOpenFile}>
                  {text}
                </MarkdownBody>
              ) : (
                <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>
                  {t('i18n.noMessage')}
                </span>
              )}
            </div>

            {hasDetails && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '4px 9px',
                  borderTop: CARD_RULE
                }}
              >
                <button
                  onClick={() => setDetailsExpanded((v) => !v)}
                  style={{
                    marginLeft: 'auto',
                    padding: '3px 7px',
                    border: 'none',
                    background: 'none',
                    color: 'var(--text-dim)',
                    cursor: 'pointer',
                    fontSize: 11
                  }}
                >
                  {detailsExpanded ? t('i18n.hideDetails') : t('i18n.showDetails')}
                </button>
              </div>
            )}

            {hasDetails && detailsExpanded && (
              <pre
                style={{
                  margin: 0,
                  padding: '9px 10px',
                  borderTop: CARD_RULE,
                  background: 'var(--bg)',
                  color: 'var(--text-muted)',
                  fontSize: 'var(--font-mono-size, 15px)',
                  lineHeight: 1.5,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: 360,
                  overflow: 'auto',
                  fontFamily: 'var(--font-mono)'
                }}
              >
                {detailsText}
              </pre>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function getMessageText(content: CustomMessage['content'] | UserMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is TextContent => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function getMessageImages(
  content: CustomMessage['content'] | UserMessage['content']
): ImageContent[] {
  if (typeof content === 'string') return [];
  return content.filter((b): b is ImageContent => b.type === 'image');
}

function imageSource(img: ImageContent): string {
  const flat = img as unknown as { data?: string; mimeType?: string };
  if (img.source) {
    return img.source.type === 'base64'
      ? `data:${img.source.media_type};base64,${img.source.data}`
      : (img.source.url ?? '');
  }
  return flat.data ? `data:${flat.mimeType};base64,${flat.data}` : '';
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function getToolCallInputText(block: ToolCallContent): string {
  return block.rawInput ?? JSON.stringify(block.input, null, 2);
}

const WRITE_VIEW_KEYS = new Set(['path', 'file_path', 'content']);

// A write's file text in place of its JSON: the header already shows the path.
// Streamed input is still incomplete JSON, and any other argument (a mode, a
// title) would vanish from this view, so those calls, and an empty file, keep
// the generic view.
function getWrittenFileText(block: ToolCallContent): string | null {
  if (block.rawInput !== undefined || !isWriteToolName(block.toolName)) return null;
  const { content } = block.input;
  if (typeof content !== 'string' || content === '') return null;
  return Object.keys(block.input).every((key) => WRITE_VIEW_KEYS.has(key)) ? content : null;
}

const TOOL_FIELD_LABEL: CSSProperties = {
  padding: '4px 12px 4px 0',
  color: 'var(--text-dim)',
  fontSize: 'var(--font-mono-size, 15px)',
  whiteSpace: 'nowrap',
  verticalAlign: 'top'
};

const TOOL_FIELD_VALUE: CSSProperties = {
  padding: '4px 0',
  color: 'var(--text-muted)',
  fontSize: 'var(--font-mono-size, 15px)',
  fontFamily: 'var(--font-mono)',
  overflowWrap: 'anywhere'
};

// A value with newlines of its own keeps them, scrolled in place.
const TOOL_FIELD_BLOCK: CSSProperties = {
  margin: 0,
  padding: '8px 10px',
  maxHeight: 260,
  overflow: 'auto',
  borderRadius: 6,
  background: 'var(--tool-card-pane)',
  font: 'inherit',
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap'
};

function ToolFieldRows({ fields }: { fields: ToolField[] }) {
  return (
    <table style={{ borderCollapse: 'collapse' }}>
      <tbody>
        {fields.map((field) => (
          <tr key={field.key}>
            <td style={TOOL_FIELD_LABEL}>{field.key}</td>
            <td style={TOOL_FIELD_VALUE}>
              {/* the card's own syntax colors a command or a file's text. */}
              {field.multiline ? (
                <pre style={TOOL_FIELD_BLOCK}>
                  <ToolCodeTokens text={field.value} />
                </pre>
              ) : (
                <ToolCodeTokens text={field.value} />
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function formatCustomType(type: string): string {
  return type || 'extension';
}

function getToolPreview(block: ToolCallContent): string {
  const input = block.input;
  if (!input || typeof input !== 'object') return '';
  const keys = Object.keys(input);
  if (keys.length === 0) return '';

  // Common tool input patterns
  if ('command' in input) return String(input.command).slice(0, 120);
  if ('path' in input) return String(input.path).slice(0, 120);
  if ('file_path' in input) return String(input.file_path).slice(0, 120);
  if ('pattern' in input) return String(input.pattern).slice(0, 120);
  if ('query' in input) return String(input.query).slice(0, 120);

  const first = input[keys[0]];
  return String(first).slice(0, 120);
}

function BashExecutionView({
  message,
  sessionId
}: {
  message: BashExecutionMessage;
  sessionId?: string;
}) {
  const [fullOutput, setFullOutput] = useState<string | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [fullError, setFullError] = useState<string | null>(null);

  const isPending = !message.output && message.exitCode === undefined && !message.cancelled;
  const isError = message.cancelled || (message.exitCode !== undefined && message.exitCode !== 0);
  const fullOutputUrl =
    sessionId && message.fullOutputPath
      ? `/api/agent/${encodeURIComponent(sessionId)}/bash-output?path=${encodeURIComponent(message.fullOutputPath)}`
      : null;
  const showFullButton = message.truncated && fullOutputUrl && fullOutput === null;
  const displayOutput = fullOutput ?? message.output;

  async function loadFullOutput() {
    if (!fullOutputUrl) return;
    setLoadingFull(true);
    setFullError(null);
    try {
      const res = await fetch(fullOutputUrl);
      const d = (await res.json()) as {
        success?: boolean;
        data?: { output?: string };
        error?: string;
      };
      if (d.success) {
        setFullOutput(d.data?.output ?? '');
      } else {
        setFullError(d.error ?? 'failed');
      }
    } catch (e) {
      setFullError(String(e));
    } finally {
      setLoadingFull(false);
    }
  }

  // Reuse the existing ToolCallBlock so user-run bash looks identical to an
  // agent-run bash tool call: same header, collapse behavior, result pane.
  // Synthesize an equivalent ToolCallContent + ToolResultMessage pair.
  const toolName = message.excludeFromContext ? 'bash (local)' : 'bash';
  const block: ToolCallContent = {
    type: 'toolCall',
    toolCallId: `bash-${message.timestamp ?? ''}`,
    toolName,
    input: { command: message.command }
  };
  const result: ToolResultMessage | undefined = isPending
    ? undefined
    : {
        role: 'toolResult',
        toolCallId: block.toolCallId,
        toolName,
        content: displayOutput ? [{ type: 'text', text: displayOutput }] : [],
        isError,
        timestamp: message.timestamp
      };

  // A command the user ran itself keeps its live card, and folds it away when it
  // ends: hold it until it has been visible long enough to be read, then fade.
  const {
    open: cardOpen,
    exiting: cardExiting,
    fading: cardFading
  } = useExitHold(isPending || isError, { minVisibleMs: TOOL_CARD_MIN_VISIBLE_MS });

  if (!cardOpen) return null;

  return (
    <div style={{ margin: '6px 0' }}>
      <ToolCallBlock
        block={block}
        result={result}
        executing={isPending}
        exiting={cardExiting}
        fading={cardFading}
      />
      {message.truncated && fullOutputUrl && (
        <div style={{ padding: '4px 10px', fontSize: 11, marginTop: -1 }}>
          {showFullButton && (
            <button
              onClick={loadFullOutput}
              disabled={loadingFull}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--accent)',
                cursor: loadingFull ? 'default' : 'pointer',
                fontSize: 11,
                padding: 0,
                textDecoration: 'underline'
              }}
            >
              {loadingFull ? 'loading…' : 'view full output'}
            </button>
          )}
          <a
            href={`${fullOutputUrl}&download=1`}
            style={{
              marginLeft: showFullButton ? 10 : 0,
              color: 'var(--accent)',
              fontSize: 11,
              textDecoration: 'underline'
            }}
          >
            download full output
          </a>
          {fullError && (
            <span style={{ marginLeft: 6, color: 'var(--text-dim)', fontSize: 11 }}>
              ({fullError})
            </span>
          )}
        </div>
      )}
    </div>
  );
}
