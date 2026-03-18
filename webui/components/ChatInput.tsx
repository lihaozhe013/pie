import React, {
  memo,
  useRef,
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
  useImperativeHandle,
  forwardRef,
  KeyboardEvent
} from 'react';
import type {
  BuiltinSlashCommandResult,
  CompactResultInfo,
  QueuedMessages,
  SlashCommandInfo
} from '@/hooks/useAgentSession';
import type { SkillsResponse } from '@/lib/api-types';
import type { TextContent, UserMessage } from '@/lib/types';
import {
  clearDraft,
  getDraft,
  mergeRestoredSubmissionDraft,
  mergeRestoredSubmissionText,
  rekeyDraft as rekeyStoredDraft,
  setDraft
} from '@/lib/draft-store';
import { namePastedFiles } from '@/lib/file-upload-client';
import {
  buildEntriesFromFiles,
  buildAtInsertText,
  extractAtQuery,
  filterFileEntries,
  type AtQueryMatch,
  type FileIndexEntry
} from '@/lib/file-fuzzy';
import { addAttachedFiles, composeMessageWithFiles, type AttachedFile } from '@/lib/attached-files';
import { getMarkdownListContinuation } from '@/lib/markdown-list-continuation';
import { isBareMcpCommand, isBuiltinMcpCommand } from '@/lib/mcp-command';
import { FolderIcon, getFileIcon } from './FileIcons';
import { DismissButton } from './DismissButton';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useEnterSendMode } from '@/hooks/useEnterSendMode';
import { useI18n } from '@/hooks/useI18n';
import { useChatAppearance } from '@/hooks/useChatAppearance';
import { useFontPreferences } from '@/hooks/useFontPreferences';
import {
  CUSTOM_TOOL_PRESET_PREFIX,
  customPresetSelection,
  type ToolPresetSelection
} from '@/lib/tool-presets';
import type { CustomToolPreset } from '@/lib/custom-tool-presets-shared';
import { SelectorRow } from './SelectorRow';
import { ModelSelector, type ModelSelectorOption } from './ModelSelector';
import { ComposerHub } from './ComposerHub';
import type { GoalAction, GoalFacts } from '@/lib/goal-driver';

export { filterModelOptions } from './ModelSelector';

interface Props {
  onSend: (message: string) => void;
  onAbort: () => void;
  onSteer?: (message: string) => void;
  onFollowUp?: (message: string) => void;
  onPromptWithStreamingBehavior?: (message: string, behavior: 'steer' | 'followUp') => void;
  isStreaming: boolean;
  /** Text-only composer without the session controls or outer spacing. */
  compact?: boolean;
  model?: { provider: string; modelId: string } | null;
  isAutoModelSelection?: boolean;
  modelNames?: Record<string, string>;
  modelList?: { id: string; name: string; provider: string; input?: string[] }[];
  modelError?: string | null;
  /** Diagnostics from resolving `enabledModels`, e.g. a pattern that matched nothing. */
  modelScopeWarnings?: string[];
  onModelChange?: (provider: string, modelId: string) => void;
  modelSwitching?: boolean;
  /** The model new sessions start with, starred in the model selector. */
  defaultModel?: { provider: string; modelId: string } | null;
  /** Saves a model as the default for new sessions and selects it here. */
  onSetDefaultModel?: (provider: string, modelId: string) => void;
  onCompact?: () => void;
  onAbortCompaction?: () => void;
  isCompacting?: boolean;
  compactError?: string | null;
  onDismissCompactError?: () => void;
  compactResult?: CompactResultInfo | null;
  toolPreset?: ToolPresetSelection;
  onToolPresetChange?: (preset: ToolPresetSelection) => void;
  /** The user's custom presets, shown under the built-in ones. */
  customToolPresets?: CustomToolPreset[];
  /** Opens the preset editor; absent while the dropdown offers no customization. */
  onManageToolPresets?: () => void;
  thinkingLevel?: 'auto' | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** New session has not committed a thinking level; the button still shows the resolved default. */
  isAutoThinkingSelection?: boolean;
  onThinkingLevelChange?: (
    level: 'auto' | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  ) => void;
  availableThinkingLevels?: string[] | null;
  thinkingLevelMap?: Record<string, string | null> | null;
  /** `defaultThinkingLevel` saved in settings, starred in the reasoning menu. */
  savedDefaultThinkingLevel?: string | null;
  /** Saves a reasoning level as the default for new sessions and selects it here. */
  onSetDefaultThinkingLevel?: (
    level: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  ) => void;
  retryInfo?: { attempt: number; maxAttempts: number; errorMessage?: string } | null;
  queuedMessages?: QueuedMessages | null;
  inputHistory?: string[];
  onRecallQueue?: () => void;
  slashCommands?: SlashCommandInfo[];
  slashCommandsLoading?: boolean;
  onLoadSlashCommands?: () => Promise<SlashCommandInfo[]> | SlashCommandInfo[];
  onBuiltinCommand?: (message: string) => Promise<BuiltinSlashCommandResult>;
  soundEnabled?: boolean;
  onSoundToggle?: () => void;
  onAudioUnlock?: () => void;
  draftKey?: string;
  /** Session working directory — enables the @ file autocomplete menu */
  cwd?: string | null;
  /** Files picked or pasted into the composer, uploaded into the working directory like a drop. */
  onAttachFiles?: (files: File[]) => void;
  /** The goal an installed goal package keeps for this session, shown in the composer hub. */
  goal?: GoalFacts;
  /** Sends a goal command; without it the hub offers no goal entry. */
  onGoalCommand?: (action: GoalAction, objective?: string) => void;
  /** Context usage of this session, read beside the compact action. */
  contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null;
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (text: string) => void;
  replaceMessage: (message: UserMessage) => void;
  prependText: (text: string) => void;
  addFileMentions: (paths: string[]) => void;
  rekeyDraft: (previousKey: string, nextKey: string) => void;
  restoreSubmission: (text: string, targetDraftKey?: string) => void;
  focus: () => void;
}

// "configured" sends no override, so the session follows settings.json defaultTools.
const TOOL_PRESETS = [
  'configured',
  'plan',
  'autonomous',
  'orchestrator',
  'chat-only',
  'read-only',
  'default',
  'full'
] as const;
type ToolPresetLabel = (typeof TOOL_PRESETS)[number];
const TOOL_PRESET_MAP: Record<ToolPresetLabel, ToolPresetSelection> = {
  configured: 'configured',
  plan: 'plan',
  autonomous: 'autonomous',
  orchestrator: 'orchestrator',
  'chat-only': 'none',
  'read-only': 'read-only',
  default: 'default',
  full: 'full'
};

/** One selectable row of the tool dropdown: a check, the label, and a dim description. */
function PresetMenuItem({
  label,
  description,
  active,
  title,
  onSelect
}: {
  label: string;
  description: string;
  active: boolean;
  title?: string;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      title={title}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        padding: '7px 12px',
        background: active ? 'var(--bg-selected)' : 'none',
        border: 'none',
        color: active ? 'var(--text)' : 'var(--text-muted)',
        cursor: 'pointer',
        fontSize: 12,
        textAlign: 'left',
        fontWeight: active ? 600 : 400,
        whiteSpace: 'nowrap'
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = 'var(--bg-hover)';
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = 'none';
      }}
    >
      {active ? (
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ flexShrink: 0 }}
        >
          <polyline points="1.5 5 4 7.5 8.5 2.5" />
        </svg>
      ) : (
        <span style={{ width: 10, flexShrink: 0 }} />
      )}
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {label}
      </span>
      {description && (
        <span style={{ fontSize: 11, color: 'var(--text-dim)', marginLeft: 8 }}>{description}</span>
      )}
    </button>
  );
}
const COMPOSITION_END_ENTER_GRACE_MS = 100;
const TEXT_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const ANCHORED_MENU_GAP = 8;

export function getUpwardMenuMaxHeight(
  menuBottom: number,
  visibleTop: number,
  gap = ANCHORED_MENU_GAP
): number {
  return Math.max(0, Math.floor(menuBottom - visibleTop - gap));
}

export function cycleListIndex(index: number, length: number, delta: number): number {
  if (length <= 0) return 0;
  return (((index + delta) % length) + length) % length;
}

// Plain replacement for when execCommand is unavailable or refuses: no undo
// entry, but the mention still lands and React's onChange still fires.
function setTextareaRange(
  textarea: HTMLTextAreaElement,
  start: number,
  end: number,
  text: string
): void {
  textarea.setRangeText(text, start, end, 'end');
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

// Replace [start, end) with `text` as native edits so the textarea's own
// undo/redo history records them. With a collapsed caret inside the range the
// typed prefix is deleted and the tail forward-deleted, so undo returns to
// what the user had typed.
export function replaceTextareaRange(
  textarea: HTMLTextAreaElement,
  start: number,
  end: number,
  text: string,
  cursorOffset = text.length
): void {
  const selectionStart = textarea.selectionStart;
  const selectionEnd = textarea.selectionEnd;
  textarea.focus();

  if (selectionStart === selectionEnd && start <= selectionStart && end >= selectionEnd) {
    const finalLength = textarea.value.length - (end - start) + text.length;
    for (
      let edits = selectionStart - start;
      edits > 0 && textarea.selectionStart > start;
      edits--
    ) {
      if (!document.execCommand('delete')) break;
    }
    if (document.execCommand('insertText', false, text)) {
      for (
        let edits = end - selectionEnd;
        edits > 0 && textarea.value.length > finalLength;
        edits--
      ) {
        if (!document.execCommand('forwardDelete')) break;
      }
    } else {
      // Whatever prefix the deletes left is still in [start, caret); the tail is untouched.
      setTextareaRange(textarea, start, textarea.selectionStart + (end - selectionEnd), text);
    }
  } else {
    textarea.setSelectionRange(start, end);
    if (!document.execCommand('insertText', false, text))
      setTextareaRange(textarea, start, end, text);
  }

  if (cursorOffset !== text.length) {
    textarea.setSelectionRange(start + cursorOffset, start + cursorOffset);
  }
}

export function replaceLinksWithMarkdown(
  text: string,
  links: Iterable<{ label: string; href: string; occurrence: number }>
): string | null {
  let result = '';
  let searchFrom = 0;
  let replaced = false;

  for (const { label, href, occurrence } of links) {
    if (!label || !href) continue;
    let index = 0;
    for (let match = 0; match <= occurrence; match++) {
      index = text.indexOf(label, match ? index + label.length : 0);
      if (index < 0) break;
    }
    if (index < searchFrom) continue;
    const escapedLabel = label.replace(/([\\[\]])/g, '\\$1');
    const escapedHref = href.replace(/([\\()])/g, '\\$1');
    result += `${text.slice(searchFrom, index)}[${escapedLabel}](${escapedHref})`;
    searchFrom = index + label.length;
    replaced = true;
  }

  return replaced ? result + text.slice(searchFrom) : null;
}

function getVisibleTopBoundary(element: HTMLElement): number {
  let visibleTop = window.visualViewport?.offsetTop ?? 0;

  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const overflowY = window.getComputedStyle(parent).overflowY;
    if (
      overflowY === 'auto' ||
      overflowY === 'scroll' ||
      overflowY === 'hidden' ||
      overflowY === 'clip'
    ) {
      visibleTop = Math.max(visibleTop, parent.getBoundingClientRect().top + parent.clientTop);
    }
  }

  return visibleTop;
}

function subscribeUpwardMenuMaxHeight(
  menu: HTMLElement,
  onChange: (height: number) => void
): () => void {
  let frameId: number | null = null;
  const update = () => {
    frameId = null;
    onChange(
      getUpwardMenuMaxHeight(menu.getBoundingClientRect().bottom, getVisibleTopBoundary(menu))
    );
  };
  const scheduleUpdate = () => {
    if (frameId !== null) cancelAnimationFrame(frameId);
    frameId = requestAnimationFrame(update);
  };

  update();
  const parent = menu.parentElement;
  const layoutContainer = parent?.parentElement;
  const anchorObserver =
    typeof ResizeObserver === 'undefined' || !parent ? null : new ResizeObserver(scheduleUpdate);
  if (parent) anchorObserver?.observe(parent);
  if (layoutContainer) anchorObserver?.observe(layoutContainer);
  const viewport = window.visualViewport;
  viewport?.addEventListener('resize', scheduleUpdate);
  viewport?.addEventListener('scroll', scheduleUpdate);
  window.addEventListener('resize', scheduleUpdate);
  window.addEventListener('scroll', scheduleUpdate, true);

  return () => {
    anchorObserver?.disconnect();
    viewport?.removeEventListener('resize', scheduleUpdate);
    viewport?.removeEventListener('scroll', scheduleUpdate);
    window.removeEventListener('resize', scheduleUpdate);
    window.removeEventListener('scroll', scheduleUpdate, true);
    if (frameId !== null) cancelAnimationFrame(frameId);
  };
}

const THINKING_LEVELS = [
  'auto',
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
] as const;
const THINKING_LEVEL_DESC_KEYS: Record<(typeof THINKING_LEVELS)[number], string> = {
  auto: 'chat.thinkingUseDefault',
  off: 'chat.thinkingOff',
  minimal: 'chat.thinkingMinimal',
  low: 'chat.thinkingLow',
  medium: 'chat.thinkingMedium',
  high: 'chat.thinkingHigh',
  xhigh: 'chat.thinkingXhigh',
  max: 'chat.thinkingMax'
};

type BuiltinSlashCommand = {
  name: string;
  description: string;
  source: 'builtin';
  availableWhileStreaming?: boolean;
};

type SlashCommandPaletteItem = SlashCommandInfo | BuiltinSlashCommand;

type SlashCommandSource = SlashCommandPaletteItem['source'];

const BUILTIN_SLASH_COMMANDS: BuiltinSlashCommand[] = [
  { name: 'compact', description: 'chat.commandCompact', source: 'builtin' },
  { name: 'auto-compact', description: 'chat.commandAutoCompact', source: 'builtin' },
  { name: 'reload', description: 'chat.commandReload', source: 'builtin' },
  { name: 'name', description: 'chat.commandName', source: 'builtin' },
  {
    name: 'session',
    description: 'chat.commandSession',
    source: 'builtin',
    availableWhileStreaming: true
  },
  {
    name: 'copy',
    description: 'chat.commandCopy',
    source: 'builtin',
    availableWhileStreaming: true
  },
  { name: 'clone', description: 'chat.commandClone', source: 'builtin' }
];

function getBuiltinSlashCommand(message: string): BuiltinSlashCommand | undefined {
  const match = message.trim().match(/^\/([^\s]+)(?:\s|$)/);
  if (!match) return undefined;
  return BUILTIN_SLASH_COMMANDS.find((command) => command.name === match[1]);
}

export function canRunBuiltinSlashCommandWhileStreaming(message: string): boolean {
  return getBuiltinSlashCommand(message)?.availableWhileStreaming === true;
}

/**
 * Whether a message sent while a run streams goes to the built-in handler
 * first: a built-in that may run then, or a bare `/mcp`, which opens
 * Settings › MCP when pi's built-in MCP extension owns it (useAgentSession)
 * and is otherwise sent as before.
 */
export function offersBuiltinSlashCommandWhileStreaming(message: string): boolean {
  return canRunBuiltinSlashCommandWhileStreaming(message) || isBareMcpCommand(message);
}

export function isExactSlashCommand(message: string, command: SlashCommandPaletteItem): boolean {
  return command.source === 'builtin' && message.trim() === `/${command.name}`;
}

/**
 * Whether Enter on the highlighted palette entry submits the message rather
 * than completing it to "/name ": a built-in typed in full (while a run
 * streams, only one that may run then), or a bare `/mcp` on pi's built-in
 * `/mcp`, which opens Settings › MCP at once, as it does before the command
 * list has loaded. Every other extension command still takes a second Enter.
 */
export function submitsSlashCommandOnEnter(
  message: string,
  command: SlashCommandPaletteItem,
  isStreaming: boolean
): boolean {
  if (command.source === 'builtin') {
    return (
      isExactSlashCommand(message, command) &&
      (!isStreaming || command.availableWhileStreaming === true)
    );
  }
  return isBuiltinMcpCommand(command) && isBareMcpCommand(message);
}

export const RUN_END_CLICK_GUARD_MS = 600;

/**
 * When a run ends, Compact (and the tools button) take the place Stop held in
 * the controls row, so the second click of a double click on Stop, or a click
 * aimed at Stop just as the run ends, lands on them. Such a pointer click is
 * ignored; a keyboard one (Enter/Space, `detail` 0) never is.
 */
export function isRunEndStrayClick(detail: number, msSinceRunEnd: number): boolean {
  return detail > 0 && msSinceRunEnd < RUN_END_CLICK_GUARD_MS;
}

export function canClearBuiltinCommandInput(message: string, submittedMessage: string): boolean {
  return message.trim() === submittedMessage;
}

/**
 * Whether the composer box stacks its draft above its buttons instead of sitting
 * them side by side. A phone has no room for the steer and follow-up buttons next
 * to the draft: in one row the two of them take more than half the width and the
 * placeholder is cut to "立即引导 / 排队后...". So while a run streams they move to
 * their own right-aligned row below the draft. Quote mode (`compact`) stacks for
 * its own reason: it is a short excerpt, not a full composer.
 */
export function stacksComposerLayout(
  compact: boolean,
  isMobile: boolean,
  isStreaming: boolean
): boolean {
  return compact || (isMobile && isStreaming);
}

const SLASH_SOURCES: SlashCommandSource[] = ['builtin', 'extension', 'prompt', 'skill'];

const SLASH_SOURCE_GROUP_LABEL_KEYS: Record<SlashCommandSource, string> = {
  builtin: 'chat.builtIn',
  extension: 'chat.extensions',
  prompt: 'chat.prompts',
  skill: 'chat.skills'
};

const SLASH_SOURCE_ORDER: Record<SlashCommandSource, number> = {
  builtin: 0,
  extension: 1,
  prompt: 2,
  skill: 3
};

function slashMatchRank(
  command: SlashCommandPaletteItem,
  query: string,
  t: (key: string) => string
): number {
  const name = command.name.toLowerCase();
  const description = getSlashDescription(command, t).toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (description.includes(query)) return 3;
  return 4;
}

function getSlashDescription(command: SlashCommandPaletteItem, t: (key: string) => string): string {
  return command.source === 'builtin' ? t(command.description) : (command.description ?? '');
}

// Skill slash commands are named "skill:<skillName>"; look the skill up in the
// dormancy map fetched from /api/skills. Unknown skills are treated as active.
function isDormantSkillCommand(
  command: SlashCommandPaletteItem,
  dormancy: Record<string, boolean>
): boolean {
  if (command.source !== 'skill' || !command.name.startsWith('skill:')) return false;
  return dormancy[command.name.slice('skill:'.length)] === true;
}

export function buildSlashCommandLayout(
  commands: SlashCommandPaletteItem[],
  dormancy: Record<string, boolean>
) {
  let index = 0;
  const groups = SLASH_SOURCES.map((source) => {
    const sourceCommands = commands.filter((command) => command.source === source);
    const orderedCommands =
      source === 'skill'
        ? [
            ...sourceCommands.filter((command) => !isDormantSkillCommand(command, dormancy)),
            ...sourceCommands.filter((command) => isDormantSkillCommand(command, dormancy))
          ]
        : sourceCommands;
    return {
      source,
      items: orderedCommands.map((command) => ({ command, index: index++ }))
    };
  }).filter((group) => group.items.length > 0);

  return {
    commands: groups.flatMap((group) => group.items.map(({ command }) => command)),
    groups
  };
}

/**
 * A composer that only restores a message over an empty draft: the draft must
 * hold neither text nor chips.
 */
function canRestoreUserMessage(value: string, attachedFileCount: number): boolean {
  return !value.trim() && attachedFileCount === 0;
}

export function getUserMessageText(message: UserMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((block): block is TextContent => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function QueuedMessageRow({ kind, text }: { kind: 'steer' | 'follow-up'; text: string }) {
  const { t } = useI18n();
  return (
    <div
      title={text}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '3px 10px',
        fontSize: 12,
        color: 'var(--text-muted)',
        minWidth: 0
      }}
    >
      <span
        style={{
          flexShrink: 0,
          fontSize: 10,
          fontFamily: 'var(--font-mono)',
          padding: '1px 7px',
          borderRadius: 999,
          border: `1px solid ${kind === 'steer' ? 'color-mix(in srgb, var(--accent) 45%, transparent)' : 'var(--border)'}`,
          color: kind === 'steer' ? 'var(--accent)' : 'var(--text-dim)'
        }}
      >
        {kind === 'steer' ? t('chat.steer') : t('chat.followUp')}
      </span>
      <span
        style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {text}
      </span>
    </div>
  );
}

function ModelNoticeBanner({
  tone,
  title,
  body,
  onClose
}: {
  tone: 'error' | 'warning';
  title: string;
  body: string;
  onClose?: () => void;
}) {
  const color = tone === 'error' ? '239,68,68' : '234,179,8';
  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        maxHeight: 120,
        marginBottom: 8,
        padding: '7px 10px',
        overflowY: 'auto',
        border: `1px solid rgba(${color},0.3)`,
        borderRadius: 6,
        background: `rgba(${color},0.07)`,
        color: `rgb(${color})`,
        fontSize: 11,
        lineHeight: 1.45
      }}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flexShrink: 0, marginTop: 1 }}
        aria-hidden="true"
      >
        <path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 600 }}>{title}</div>
        <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{body}</div>
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Dismiss"
          style={{
            flexShrink: 0,
            background: 'none',
            border: 'none',
            padding: '0 2px',
            cursor: 'pointer',
            color: 'inherit',
            opacity: 0.7,
            fontSize: 13,
            lineHeight: 1
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

export function ModelErrorBanner({ error }: { error?: string | null }) {
  const { t } = useI18n();
  if (!error) return null;
  return <ModelNoticeBanner tone="error" title={t('chat.modelError')} body={error} />;
}

/** Surfaces `enabledModels` patterns that matched nothing, so a typo is visible (#307). */
export function ModelScopeWarningBanner({ warnings }: { warnings?: string[] }) {
  const { t } = useI18n();
  if (!warnings || warnings.length === 0) return null;
  return (
    <ModelNoticeBanner
      tone="warning"
      title={warnings.length > 1 ? t('chat.modelScopeWarnings') : t('chat.modelScopeWarning')}
      body={warnings.join('\n')}
    />
  );
}

// Memoized: its props hold still while a reply streams or a tool runs, and the
// chat around it re-renders through both.
export const ChatInput = memo(
  forwardRef<ChatInputHandle, Props>(function ChatInput(
    {
      onSend,
      onAbort,
      onSteer,
      onFollowUp,
      isStreaming,
      model,
      isAutoModelSelection,
      modelNames,
      modelList,
      modelError,
      modelScopeWarnings,
      onModelChange,
      modelSwitching,
      defaultModel,
      onSetDefaultModel,
      onCompact,
      onAbortCompaction,
      isCompacting,
      compactError,
      onDismissCompactError,
      compactResult,
      contextUsage,
      toolPreset,
      onToolPresetChange,
      customToolPresets,
      onManageToolPresets,
      thinkingLevel,
      isAutoThinkingSelection = false,
      onThinkingLevelChange,
      availableThinkingLevels,
      thinkingLevelMap,
      savedDefaultThinkingLevel,
      onSetDefaultThinkingLevel,
      retryInfo,
      queuedMessages,
      inputHistory = [],
      onRecallQueue,
      slashCommands,
      slashCommandsLoading,
      onLoadSlashCommands,
      onBuiltinCommand,
      soundEnabled,
      onSoundToggle,
      onAudioUnlock,
      onPromptWithStreamingBehavior,
      draftKey,
      cwd,
      onAttachFiles,
      goal,
      onGoalCommand,
      compact = false
    }: Props,
    ref
  ) {
    const { t } = useI18n();
    const { fontSize } = useChatAppearance();
    const { ui: uiFontFamily, uiWeight } = useFontPreferences();
    const isMobile = useIsMobile();
    const enterSendMode = useEnterSendMode();
    const [value, setValue] = useState(() => (draftKey ? (getDraft(draftKey)?.value ?? '') : ''));
    const [toolDropdownOpen, setToolDropdownOpen] = useState(false);
    const [thinkingDropdownOpen, setThinkingDropdownOpen] = useState(false);
    const [controlsMenuOpen, setControlsMenuOpen] = useState(false);
    // Files dropped, picked, or pasted into the composer show as chips; their
    // `@path` mentions join the prompt only when it is sent.
    const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>(() =>
      draftKey ? (getDraft(draftKey)?.files ?? []) : []
    );
    const trimmedValue = value.trimStart();
    const bashMode = trimmedValue.startsWith('!');
    const bashExcluded = bashMode && trimmedValue.startsWith('!!');
    const [slashMenuOpen, setSlashMenuOpen] = useState(false);
    const [slashActiveIndex, setSlashActiveIndex] = useState(0);
    const [slashMenuMaxHeight, setSlashMenuMaxHeight] = useState<number | null>(null);
    const [atQuery, setAtQuery] = useState<AtQueryMatch | null>(null);
    const [atMenuOpen, setAtMenuOpen] = useState(false);
    const [atMenuMaxHeight, setAtMenuMaxHeight] = useState<number | null>(null);
    const [atActiveIndex, setAtActiveIndex] = useState(0);
    const [historyMenuOpen, setHistoryMenuOpen] = useState(false);
    const [historyActiveIndex, setHistoryActiveIndex] = useState(0);
    const [builtinCommandPending, setBuiltinCommandPending] = useState(false);
    const builtinCommandPendingRef = useRef(false);
    const [fileIndex, setFileIndex] = useState<{
      cwd: string;
      entries: FileIndexEntry[];
      truncated: boolean;
    } | null>(null);
    const [fileIndexLoading, setFileIndexLoading] = useState(false);
    const [atServerResult, setAtServerResult] = useState<{
      cwd: string;
      query: string;
      matches: FileIndexEntry[];
    } | null>(null);
    const [skillDormancyState, setSkillDormancyState] = useState<{
      cwd: string;
      values: Record<string, boolean>;
    } | null>(null);
    const skillDormancy = cwd && skillDormancyState?.cwd === cwd ? skillDormancyState.values : {};

    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const toolDropdownRef = useRef<HTMLDivElement>(null);
    const thinkingDropdownRef = useRef<HTMLDivElement>(null);
    const controlsMenuRef = useRef<HTMLDivElement>(null);
    const historyMenuRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const isComposingRef = useRef(false);
    const lastCompositionEndAtRef = useRef(0);
    const slashCommandsRequestedRef = useRef(false);
    const slashMenuRef = useRef<HTMLDivElement>(null);
    const slashItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const atMenuRef = useRef<HTMLDivElement>(null);
    const atItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const historyItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const fileIndexMetaRef = useRef<{ cwd: string; fetchedAt: number } | null>(null);
    const fileIndexFetchingRef = useRef<string | null>(null);
    const draftKeyRef = useRef(draftKey);
    const valueRef = useRef(value);
    const attachedFilesRef = useRef(attachedFiles);
    valueRef.current = value;
    attachedFilesRef.current = attachedFiles;

    useImperativeHandle(ref, () => ({
      insertIfEmpty(text: string) {
        const ta = textareaRef.current;
        const current = ta ? ta.value : value;
        if (current.trim()) return;
        valueRef.current = text;
        setValue(text);
        setAtQuery(null);
        requestAnimationFrame(() => {
          if (!ta) return;
          ta.focus();
          ta.style.height = 'auto';
          ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
        });
      },
      replaceMessage(message: UserMessage) {
        const ta = textareaRef.current;
        const current = ta ? ta.value : value;
        if (!canRestoreUserMessage(current, attachedFilesRef.current.length)) return;

        const restoredText = getUserMessageText(message);
        valueRef.current = restoredText;
        setValue(restoredText);
        setAtQuery(null);
        setHistoryMenuOpen(false);
        requestAnimationFrame(() => {
          if (!ta) return;
          ta.focus();
          ta.style.height = 'auto';
          ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
        });
      },
      prependText(text: string) {
        if (!text.trim()) return;
        const ta = textareaRef.current;
        const current = ta ? ta.value : value;
        // Mirrors the TUI's queue restore: queued text first, then whatever
        // the user already typed, separated by a blank line.
        const combined = [text, current].filter((t) => t.trim()).join('\n\n');
        valueRef.current = combined;
        setValue(combined);
        setAtQuery(null);
        requestAnimationFrame(() => {
          if (!ta) return;
          ta.focus();
          ta.setSelectionRange(combined.length, combined.length);
          ta.style.height = 'auto';
          ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
        });
      },
      rekeyDraft(previousKey: string, nextKey: string) {
        if (previousKey === nextKey) return;
        if (draftKeyRef.current !== previousKey) {
          rekeyStoredDraft(previousKey, nextKey);
          return;
        }

        const currentDraft = { value: valueRef.current, files: attachedFilesRef.current };
        const moved = rekeyStoredDraft(previousKey, nextKey, currentDraft) ?? { value: '' };
        // The merge keeps this composer's chips; only the text can change.
        const unchanged = moved.value === currentDraft.value;
        draftKeyRef.current = nextKey;
        if (unchanged) return;

        valueRef.current = moved.value;
        setValue(moved.value);
        setAtQuery(null);
        setHistoryMenuOpen(false);
      },
      restoreSubmission(text: string, targetDraftKey?: string) {
        if (!text.trim()) return;

        // clearInput is queued before the submission handler runs. Compose with
        // that queued state so a fast rejection cannot observe stale DOM text and
        // then get overwritten by the clear.
        const currentDraftKey = draftKeyRef.current;
        const destinationDraftKey = targetDraftKey ?? currentDraftKey;
        const targetsCurrentComposer = destinationDraftKey === currentDraftKey;
        const storedDraft =
          !targetsCurrentComposer && destinationDraftKey ? getDraft(destinationDraftKey) : null;
        const restoredDraft = mergeRestoredSubmissionDraft(
          text,
          targetsCurrentComposer ? valueRef.current : (storedDraft?.value ?? ''),
          targetsCurrentComposer ? attachedFilesRef.current : (storedDraft?.files ?? [])
        );
        // The first optimistic message switches ChatWindow out of its empty-state
        // layout and remounts this component. Persist synchronously so recovery is
        // not lost if this instance is the one being unmounted.
        if (destinationDraftKey) setDraft(destinationDraftKey, restoredDraft);
        if (!targetsCurrentComposer) return;
        // Session promotion can rekey this composer before React flushes the
        // functional updates below, so update the imperative snapshot first.
        valueRef.current = restoredDraft.value;
        setValue((current) => {
          const restored = mergeRestoredSubmissionText(text, current);
          valueRef.current = restored;
          return restored;
        });
        setAtQuery(null);
        setHistoryMenuOpen(false);
        requestAnimationFrame(() => {
          const ta = textareaRef.current;
          if (!ta) return;
          ta.focus();
          ta.setSelectionRange(ta.value.length, ta.value.length);
          ta.style.height = 'auto';
          ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
        });
      },
      // The caret goes after a draft that came back, so typing continues it.
      focus() {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      },
      insertText(text: string) {
        const ta = textareaRef.current;
        if (!ta) {
          setValue((v) => v + (v ? ' ' : '') + text);
          return;
        }
        const start = ta.selectionStart ?? ta.value.length;
        const end = ta.selectionEnd ?? ta.value.length;
        const before = ta.value.slice(0, start);
        const sep = before.length > 0 && !before.endsWith(' ') ? ' ' : '';
        replaceTextareaRange(ta, start, end, sep + text);
        setAtQuery(null);
      },
      addFileMentions(paths: string[]) {
        // The compact quote composer takes no attachments.
        if (compact || paths.length === 0) return;
        const next = addAttachedFiles(attachedFilesRef.current, paths);
        if (next === attachedFilesRef.current) return;
        attachedFilesRef.current = next;
        setAttachedFiles(next);
      }
    }));

    const handleFilePick = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files ?? []);
        // Clearing the value lets the same file be picked again.
        e.target.value = '';
        if (onAttachFiles) onAttachFiles(files);
      },
      [onAttachFiles]
    );

    const removeFile = useCallback((index: number) => {
      setAttachedFiles((prev) => {
        const next = prev.filter((_, i) => i !== index);
        attachedFilesRef.current = next;
        return next;
      });
    }, []);

    const clearFiles = useCallback(() => {
      attachedFilesRef.current = [];
      setAttachedFiles([]);
    }, []);

    const clearInput = useCallback(() => {
      valueRef.current = '';
      setValue('');
      setAtQuery(null);
      setHistoryMenuOpen(false);
      if (draftKey) clearDraft(draftKey);
      if (draftKeyRef.current && draftKeyRef.current !== draftKey) clearDraft(draftKeyRef.current);
      clearFiles();
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    }, [clearFiles, draftKey]);

    useEffect(() => {
      if (!draftKey || draftKeyRef.current !== draftKey) return;
      setDraft(draftKey, { value, files: attachedFiles });
    }, [attachedFiles, draftKey, value]);

    useEffect(() => {
      const previousDraftKey = draftKeyRef.current;
      if (previousDraftKey === draftKey) return;

      if (previousDraftKey) {
        setDraft(previousDraftKey, {
          value: valueRef.current,
          files: attachedFilesRef.current
        });
      }

      const draft = draftKey ? getDraft(draftKey) : null;
      draftKeyRef.current = draftKey;
      const nextValue = draft?.value ?? '';
      const nextFiles = draft?.files ?? [];
      valueRef.current = nextValue;
      attachedFilesRef.current = nextFiles;
      setValue(nextValue);
      setAtQuery(null);
      setHistoryMenuOpen(false);
      setAttachedFiles(nextFiles);
    }, [draftKey]);

    const resizeTextarea = useCallback(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.style.height = 'auto';
      if (ta.value) ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    }, []);

    useLayoutEffect(resizeTextarea, [value, fontSize, uiFontFamily, uiWeight, resizeTextarea]);

    useEffect(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      let previousWidth = -1;
      const observer = new ResizeObserver(([entry]) => {
        // Height updates also notify the observer; only remeasure on width changes.
        if (entry.contentRect.width === previousWidth) return;
        previousWidth = entry.contentRect.width;
        resizeTextarea();
      });
      observer.observe(ta);
      return () => observer.disconnect();
    }, [resizeTextarea]);

    useEffect(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      // Shift+Enter on desktop, Enter on mobile keyboards: every newline the
      // textarea inserts arrives here, while IME confirmations and sends do not.
      const continueList = (event: InputEvent) => {
        if (event.inputType !== 'insertLineBreak' || event.isComposing) return;
        const edit = getMarkdownListContinuation(ta.value, ta.selectionStart, ta.selectionEnd);
        if (!edit) return;
        event.preventDefault();
        ta.setSelectionRange(edit.start, edit.end);
        // insertText keeps the edit on the native undo stack and fires the input
        // event that updates the controlled value.
        document.execCommand(edit.text ? 'insertText' : 'delete', false, edit.text);
      };
      ta.addEventListener('beforeinput', continueList);
      return () => ta.removeEventListener('beforeinput', continueList);
    }, []);

    const runBuiltinCommand = useCallback(
      async (msg: string): Promise<boolean> => {
        if (attachedFiles.length || !msg.startsWith('/') || !onBuiltinCommand) return false;
        if (builtinCommandPendingRef.current) return true;
        builtinCommandPendingRef.current = true;
        setBuiltinCommandPending(true);
        try {
          const result = await onBuiltinCommand(msg);
          if (!result.handled) return false;
          if (!result.error && canClearBuiltinCommandInput(valueRef.current, msg)) clearInput();
          return true;
        } finally {
          builtinCommandPendingRef.current = false;
          setBuiltinCommandPending(false);
        }
      },
      [attachedFiles.length, clearInput, onBuiltinCommand]
    );

    const handleSend = useCallback(async () => {
      // The chips become the `@path` mentions the prompt ends with, exactly as
      // dropping a file used to type them into the textarea.
      const msg = composeMessageWithFiles(
        value,
        attachedFiles.map((file) => file.path)
      );
      if (!msg) return;
      onAudioUnlock?.();
      const builtinAllowed = !isStreaming || offersBuiltinSlashCommandWhileStreaming(msg);
      if (builtinAllowed && (await runBuiltinCommand(msg))) return;
      if (isStreaming) return;
      clearInput();
      onSend(msg);
    }, [value, attachedFiles, isStreaming, runBuiltinCommand, onSend, clearInput, onAudioUnlock]);

    const slashQuery =
      !compact && value.startsWith('/') && !/\s/.test(value.slice(1))
        ? value.slice(1).toLowerCase()
        : null;

    const filteredSlashCommands = (() => {
      if (slashQuery === null) return [];
      const builtinCommands = isStreaming
        ? BUILTIN_SLASH_COMMANDS.filter((command) => command.availableWhileStreaming)
        : BUILTIN_SLASH_COMMANDS;
      const commands = [...builtinCommands, ...(slashCommands ?? [])];
      return [...commands]
        .filter((command) => {
          const name = command.name.toLowerCase();
          const description = getSlashDescription(command, t).toLowerCase();
          return name.includes(slashQuery) || description.includes(slashQuery);
        })
        .sort((a, b) => {
          const rankDelta = slashMatchRank(a, slashQuery, t) - slashMatchRank(b, slashQuery, t);
          if (rankDelta !== 0) return rankDelta;
          return (
            SLASH_SOURCE_ORDER[a.source] - SLASH_SOURCE_ORDER[b.source] ||
            TEXT_COLLATOR.compare(a.name, b.name)
          );
        });
    })();

    const { commands: displayedSlashCommands, groups: groupedSlashCommands } =
      buildSlashCommandLayout(filteredSlashCommands, skillDormancy);

    const slashCommandCountLabel =
      filteredSlashCommands.length === 1
        ? t(slashQuery ? 'chat.match' : 'chat.command')
        : t(slashQuery ? 'chat.matches' : 'chat.commands', { count: filteredSlashCommands.length });
    const hasInputText = Boolean(value.trim());
    const hasAttachments = attachedFiles.length > 0;
    const canQueueStreamingMessage = hasInputText || hasAttachments;
    const stackedComposer = stacksComposerLayout(compact, isMobile, isStreaming);

    // ── @ file autocomplete ──────────────────────────────────────────────────
    // Recomputed from the text before the caret on every change/caret move.
    // Disabled entirely when there is no cwd (new session without a directory).
    const updateAtQuery = useCallback(
      (text: string, cursor: number | null) => {
        if (!cwd) {
          setAtQuery(null);
          return;
        }
        const pos = cursor ?? text.length;
        setAtQuery(extractAtQuery(text.slice(0, pos)));
      },
      [cwd]
    );

    const atQueryText = atQuery?.query ?? null;
    const atLocalMatches: FileIndexEntry[] = React.useMemo(
      () =>
        atQueryText !== null && fileIndex && fileIndex.cwd === cwd
          ? filterFileEntries(fileIndex.entries, atQueryText)
          : [],
      [atQueryText, fileIndex, cwd]
    );

    // When the client index is truncated (repo larger than the index cap),
    // local filtering cannot see deep files, so queries are also ranked
    // server-side against the full listing. Local matches render immediately
    // and are replaced when the (debounced) server result for the current
    // query arrives; stale responses are ignored via the query/cwd tag.
    const needsServerSearch = Boolean(atQueryText && fileIndex?.truncated && fileIndex.cwd === cwd);
    useEffect(() => {
      if (!needsServerSearch || !cwd || !atQueryText) return;
      const fetchCwd = cwd;
      const query = atQueryText;
      const timer = setTimeout(() => {
        fetch(`/api/file-index?cwd=${encodeURIComponent(fetchCwd)}&q=${encodeURIComponent(query)}`)
          .then((res) => {
            if (!res.ok) throw new Error(`file search failed: ${res.status}`);
            return res.json() as Promise<{ matches?: FileIndexEntry[] }>;
          })
          .then((data) => setAtServerResult({ cwd: fetchCwd, query, matches: data.matches ?? [] }))
          .catch(() => {
            // Keep showing local matches; the next keystroke retries.
          });
      }, 150);
      return () => clearTimeout(timer);
    }, [needsServerSearch, atQueryText, cwd]);

    const serverResultInUse =
      needsServerSearch &&
      atServerResult !== null &&
      atServerResult.cwd === cwd &&
      atServerResult.query === atQueryText;
    const atMatches: FileIndexEntry[] = serverResultInUse ? atServerResult.matches : atLocalMatches;

    // Open/reset the menu whenever the @token appears or changes (mirrors the
    // slash menu: Escape closes it, the next keystroke re-opens it).
    const atTokenKey =
      atQuery === null ? null : `${atQuery.start}:${atQuery.quoted ? 1 : 0}:${atQuery.query}`;
    useEffect(() => {
      if (atTokenKey === null) {
        setAtMenuOpen(false);
        setAtActiveIndex(0);
        return;
      }
      setAtMenuOpen(true);
      setAtActiveIndex(0);
    }, [atTokenKey]);

    // Fetch the file index when the menu opens. The server caches per cwd for
    // ~10s, so re-opening refreshes cheaply; while typing nothing refetches.
    const atTokenActive = atQuery !== null;
    useEffect(() => {
      if (!atTokenActive || !cwd) return;
      const meta = fileIndexMetaRef.current;
      if (meta && meta.cwd === cwd && Date.now() - meta.fetchedAt < 10_000) return;
      if (fileIndexFetchingRef.current === cwd) return;
      fileIndexFetchingRef.current = cwd;
      const fetchCwd = cwd;
      setFileIndexLoading(true);
      fetch(`/api/file-index?cwd=${encodeURIComponent(fetchCwd)}`)
        .then((res) => {
          if (!res.ok) throw new Error(`file index failed: ${res.status}`);
          return res.json() as Promise<{ files?: string[]; truncated?: boolean }>;
        })
        .then((data) => {
          setFileIndex({
            cwd: fetchCwd,
            entries: buildEntriesFromFiles(data.files ?? []),
            truncated: !!data.truncated
          });
          fileIndexMetaRef.current = { cwd: fetchCwd, fetchedAt: Date.now() };
        })
        .catch(() => {
          // Leave any previous index in place; next open retries.
          fileIndexMetaRef.current = null;
        })
        .finally(() => {
          fileIndexFetchingRef.current = null;
          setFileIndexLoading(false);
        });
    }, [atTokenActive, cwd]);

    const applyAtCompletion = useCallback(
      (entry: FileIndexEntry) => {
        if (!atQuery) return;
        const ta = textareaRef.current;
        if (!ta) return;
        const cursor = ta.selectionStart ?? ta.value.length;
        // Completing inside a quoted token (@"my dir/… with the caret before the
        // closing quote): replace that old quote too, since the insertion has one.
        const replaceEnd = cursor + (atQuery.quoted && ta.value[cursor] === '"' ? 1 : 0);
        const insert = buildAtInsertText(entry.path, entry.isDir, atQuery.quoted);
        const newPos = atQuery.start + insert.cursorOffset;
        replaceTextareaRange(ta, atQuery.start, replaceEnd, insert.text, insert.cursorOffset);
        // The native input event updates the controlled value. Re-derive using the
        // adjusted caret because quoted directories place it before the last quote.
        setAtQuery(extractAtQuery(ta.value.slice(0, newPos)));
      },
      [atQuery]
    );

    useEffect(() => {
      if (atActiveIndex >= atMatches.length) {
        setAtActiveIndex(Math.max(0, atMatches.length - 1));
      }
    }, [atMatches.length, atActiveIndex]);

    useEffect(() => {
      atItemRefs.current.length = atMatches.length;
    }, [atMatches.length]);

    useEffect(() => {
      if (!atMenuOpen) return;
      atItemRefs.current[atActiveIndex]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, [atActiveIndex, atMenuOpen]);

    useEffect(() => {
      if (historyActiveIndex >= inputHistory.length) {
        setHistoryActiveIndex(Math.max(0, inputHistory.length - 1));
      }
    }, [inputHistory.length, historyActiveIndex]);

    useEffect(() => {
      historyItemRefs.current.length = inputHistory.length;
    }, [inputHistory.length]);

    useEffect(() => {
      if (!historyMenuOpen) return;
      historyItemRefs.current[historyActiveIndex]?.scrollIntoView({
        block: 'nearest',
        inline: 'nearest'
      });
    }, [historyActiveIndex, historyMenuOpen]);

    const applyHistoryInput = useCallback((text: string) => {
      setValue(text);
      setHistoryMenuOpen(false);
      setHistoryActiveIndex(0);
      setAtQuery(null);
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(text.length, text.length);
        ta.style.height = 'auto';
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    }, []);

    const applySlashCommand = useCallback((command: SlashCommandPaletteItem) => {
      const nextValue = `/${command.name} `;
      setValue(nextValue);
      setSlashMenuOpen(false);
      setSlashActiveIndex(0);
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(nextValue.length, nextValue.length);
        ta.style.height = 'auto';
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    }, []);

    const sendQueued = useCallback(
      (mode: 'steer' | 'followup') => {
        const msg = composeMessageWithFiles(
          value,
          attachedFiles.map((file) => file.path)
        );
        if (!msg) return;
        onAudioUnlock?.();
        const hasQueuedAttachments = attachedFiles.length > 0;
        const queue = () => {
          const streamingBehavior = mode === 'steer' ? 'steer' : 'followUp';
          if (msg.startsWith('/') && onPromptWithStreamingBehavior) {
            clearInput();
            onPromptWithStreamingBehavior(msg, streamingBehavior);
            return;
          }
          clearInput();
          if (mode === 'steer' && onSteer) {
            onSteer(msg);
          } else if (mode === 'followup' && onFollowUp) {
            onFollowUp(msg);
          }
        };
        if (
          !hasQueuedAttachments &&
          onBuiltinCommand &&
          canRunBuiltinSlashCommandWhileStreaming(msg)
        ) {
          void runBuiltinCommand(msg);
          return;
        }
        if (!hasQueuedAttachments && onBuiltinCommand && isBareMcpCommand(msg)) {
          // Settings › MCP opens when pi's built-in MCP extension owns /mcp; another
          // extension's /mcp is queued as before. The composer is disabled meanwhile.
          void runBuiltinCommand(msg).then(
            (handled) => {
              if (!handled) queue();
            },
            () => queue()
          );
          return;
        }
        queue();
      },
      [
        value,
        attachedFiles,
        onBuiltinCommand,
        onPromptWithStreamingBehavior,
        onSteer,
        onFollowUp,
        clearInput,
        onAudioUnlock,
        runBuiltinCommand
      ]
    );

    const getNextSlashIndex = useCallback(
      (direction: 'up' | 'down' | 'left' | 'right') => {
        const lastIndex = displayedSlashCommands.length - 1;
        if (lastIndex < 0) return 0;

        if (direction === 'left') return Math.max(0, slashActiveIndex - 1);
        if (direction === 'right') return Math.min(lastIndex, slashActiveIndex + 1);

        const currentNode = slashItemRefs.current[slashActiveIndex];
        if (!currentNode) {
          return direction === 'down'
            ? Math.min(lastIndex, slashActiveIndex + 1)
            : Math.max(0, slashActiveIndex - 1);
        }

        const currentRect = currentNode.getBoundingClientRect();
        const currentX = currentRect.left + currentRect.width / 2;
        const currentY = currentRect.top + currentRect.height / 2;
        let bestIndex = -1;
        let bestScore = Number.POSITIVE_INFINITY;

        for (let index = 0; index <= lastIndex; index += 1) {
          if (index === slashActiveIndex) continue;
          const node = slashItemRefs.current[index];
          if (!node) continue;
          const rect = node.getBoundingClientRect();
          const candidateY = rect.top + rect.height / 2;
          const verticalDelta = candidateY - currentY;
          if (direction === 'down' ? verticalDelta <= 4 : verticalDelta >= -4) continue;

          const candidateX = rect.left + rect.width / 2;
          const score = Math.abs(verticalDelta) * 1000 + Math.abs(candidateX - currentX);
          if (score < bestScore) {
            bestIndex = index;
            bestScore = score;
          }
        }

        if (bestIndex >= 0) return bestIndex;
        return direction === 'down'
          ? Math.min(lastIndex, slashActiveIndex + 1)
          : Math.max(0, slashActiveIndex - 1);
      },
      [displayedSlashCommands.length, slashActiveIndex]
    );

    const handleKeyDown = useCallback(
      (e: KeyboardEvent<HTMLTextAreaElement>) => {
        const nativeEvent = e.nativeEvent;
        const enterKey = e.key === 'Enter' && !e.shiftKey;
        const sendShortcut =
          isMobile || enterSendMode === 'ctrlEnter'
            ? enterKey && (e.ctrlKey || e.metaKey)
            : enterKey;
        // Popup menus and the IME guard take plain Enter in either send mode on a
        // desktop keyboard. Mobile keyboards insert a line break on Enter, so they
        // keep using the send shortcut there.
        const acceptShortcut = isMobile ? sendShortcut : enterKey;
        const recentlyComposed =
          Date.now() - lastCompositionEndAtRef.current < COMPOSITION_END_ENTER_GRACE_MS;
        const isComposing =
          isComposingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229;

        if (acceptShortcut && (isComposing || recentlyComposed)) {
          if (recentlyComposed) e.preventDefault();
          return;
        }

        if (historyMenuOpen && !isComposing) {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHistoryActiveIndex((i) => Math.min(Math.max(0, inputHistory.length - 1), i + 1));
            return;
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHistoryActiveIndex((i) => Math.max(0, i - 1));
            return;
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            setHistoryMenuOpen(false);
            return;
          }
          if ((e.key === 'Tab' || acceptShortcut) && inputHistory[historyActiveIndex]) {
            e.preventDefault();
            applyHistoryInput(inputHistory[historyActiveIndex]);
            return;
          }
        }

        if (slashMenuOpen && slashQuery !== null) {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSlashActiveIndex(getNextSlashIndex('down'));
            return;
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSlashActiveIndex(getNextSlashIndex('up'));
            return;
          }
          if (e.key === 'ArrowRight') {
            e.preventDefault();
            setSlashActiveIndex(getNextSlashIndex('right'));
            return;
          }
          if (e.key === 'ArrowLeft') {
            e.preventDefault();
            setSlashActiveIndex(getNextSlashIndex('left'));
            return;
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            setSlashMenuOpen(false);
            return;
          }
          const selectedCommand = displayedSlashCommands[slashActiveIndex];
          if (e.key === 'Tab' && selectedCommand) {
            e.preventDefault();
            applySlashCommand(selectedCommand);
            return;
          }
          if (acceptShortcut && selectedCommand) {
            e.preventDefault();
            if (sendShortcut && submitsSlashCommandOnEnter(value, selectedCommand, isStreaming)) {
              setSlashMenuOpen(false);
              void handleSend();
            } else {
              applySlashCommand(selectedCommand);
            }
            return;
          }
        }

        // @ file menu — skip while composing so IME candidate navigation
        // (arrows/Enter/Tab) is never intercepted.
        if (atMenuOpen && atQuery !== null && !isComposing) {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setAtActiveIndex((i) => cycleListIndex(i, atMatches.length, 1));
            return;
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            setAtActiveIndex((i) => cycleListIndex(i, atMatches.length, -1));
            return;
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            setAtMenuOpen(false);
            return;
          }
          if ((e.key === 'Tab' || acceptShortcut) && atMatches[atActiveIndex]) {
            e.preventDefault();
            applyAtCompletion(atMatches[atActiveIndex]);
            return;
          }
        }

        if (
          e.key === 'ArrowUp' &&
          !isComposing &&
          !isStreaming &&
          inputHistory.length > 0 &&
          value.trim().length === 0
        ) {
          e.preventDefault();
          setSlashMenuOpen(false);
          setAtMenuOpen(false);
          setHistoryActiveIndex(inputHistory.length - 1);
          setHistoryMenuOpen(true);
          return;
        }

        // Esc stops the agent when no slash/@/history menu or IME composition is active.
        if (e.key === 'Escape' && !isComposing && isStreaming && onAbort) {
          e.preventDefault();
          onAbort();
          return;
        }

        if (sendShortcut) {
          e.preventDefault();
          if (isStreaming && (onSteer || onFollowUp)) {
            sendQueued((e.altKey && onFollowUp) || !onSteer ? 'followup' : 'steer');
          } else {
            handleSend();
          }
        }
      },
      [
        isMobile,
        enterSendMode,
        isStreaming,
        onSteer,
        onFollowUp,
        onAbort,
        slashMenuOpen,
        slashQuery,
        displayedSlashCommands,
        slashActiveIndex,
        applySlashCommand,
        sendQueued,
        handleSend,
        getNextSlashIndex,
        atMenuOpen,
        atQuery,
        atMatches,
        atActiveIndex,
        applyAtCompletion,
        historyMenuOpen,
        inputHistory,
        historyActiveIndex,
        applyHistoryInput,
        value
      ]
    );

    const handleInput = useCallback(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    }, []);

    const handlePaste = useCallback(
      (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
        const items = Array.from(e.clipboardData?.items ?? []);
        // Everything the clipboard holds as a file — screenshots, copied files —
        // uploads into the working directory, exactly like a drop would.
        const fileItems = items.filter((item) => item.kind === 'file');
        if (!compact && fileItems.length && onAttachFiles) {
          const files = fileItems
            .map((item) => item.getAsFile())
            .filter((f): f is File => f !== null);
          if (files.length) {
            e.preventDefault();
            onAttachFiles(namePastedFiles(files));
            return;
          }
        }

        const html = e.clipboardData.getData('text/html');
        const text = e.clipboardData.getData('text/plain');
        if (!html || !text) return;
        const document = new DOMParser().parseFromString(html, 'text/html');
        const links = Array.from(document.querySelectorAll('a[href]'), (link) => {
          const label = link.textContent ?? '';
          const range = document.createRange();
          range.setStart(document.body, 0);
          range.setEndBefore(link);
          return {
            label,
            href: link.getAttribute('href')?.trim() ?? '',
            occurrence: label ? range.toString().split(label).length - 1 : 0
          };
        });
        const markdown = replaceLinksWithMarkdown(text, links);
        if (markdown === null) return;

        const ta = e.currentTarget;
        const start = ta.selectionStart;
        const nextValue = ta.value.slice(0, start) + markdown + ta.value.slice(ta.selectionEnd);
        e.preventDefault();
        valueRef.current = nextValue;
        setValue(nextValue);
        setHistoryMenuOpen(false);
        updateAtQuery(nextValue, start + markdown.length);
        requestAnimationFrame(() => {
          ta.focus();
          ta.setSelectionRange(start + markdown.length, start + markdown.length);
        });
      },
      [compact, onAttachFiles, updateAtQuery]
    );

    useEffect(() => {
      if (slashQuery === null) {
        setSlashMenuOpen(false);
        setSlashActiveIndex(0);
        slashCommandsRequestedRef.current = false;
        return;
      }
      setSlashMenuOpen(true);
      setSlashActiveIndex(0);
      if (!slashCommandsRequestedRef.current && onLoadSlashCommands) {
        slashCommandsRequestedRef.current = true;
        Promise.resolve(onLoadSlashCommands()).catch(() => {
          slashCommandsRequestedRef.current = false;
        });
      }
    }, [slashQuery, onLoadSlashCommands]);

    // Lazy-load skill dormancy (disable-model-invocation) each time the slash
    // palette opens, so toggles made in the skills panel are reflected on the
    // next open. Failures degrade silently to the unannotated palette.
    useEffect(() => {
      if (!slashMenuOpen || !cwd) return;
      const requestCwd = cwd;
      let cancelled = false;
      setSkillDormancyState({ cwd: requestCwd, values: {} });
      fetch(`/api/skills?cwd=${encodeURIComponent(requestCwd)}`)
        .then((res) => {
          if (!res.ok) throw new Error(`skills fetch failed: ${res.status}`);
          return res.json() as Promise<Partial<SkillsResponse>>;
        })
        .then((data) => {
          if (cancelled) return;
          const dormancy: Record<string, boolean> = {};
          for (const skill of data.skills ?? [])
            dormancy[skill.name] = skill.disableModelInvocation;
          setSkillDormancyState({ cwd: requestCwd, values: dormancy });
        })
        .catch(() => {
          if (!cancelled) setSkillDormancyState({ cwd: requestCwd, values: {} });
        });
      return () => {
        cancelled = true;
      };
    }, [slashMenuOpen, cwd]);

    useEffect(() => {
      if (slashActiveIndex >= displayedSlashCommands.length) {
        setSlashActiveIndex(Math.max(0, displayedSlashCommands.length - 1));
      }
    }, [displayedSlashCommands.length, slashActiveIndex]);

    useEffect(() => {
      slashItemRefs.current.length = displayedSlashCommands.length;
    }, [displayedSlashCommands.length]);

    useEffect(() => {
      if (!slashMenuOpen) return;
      slashItemRefs.current[slashActiveIndex]?.scrollIntoView({
        block: 'nearest',
        inline: 'nearest'
      });
    }, [slashActiveIndex, slashMenuOpen]);

    useLayoutEffect(() => {
      if (!slashMenuOpen || slashQuery === null) {
        setSlashMenuMaxHeight(null);
        return;
      }
      const menu = slashMenuRef.current;
      if (!menu) return;
      return subscribeUpwardMenuMaxHeight(menu, (nextHeight) => {
        setSlashMenuMaxHeight((current) => (current === nextHeight ? current : nextHeight));
      });
    }, [slashMenuOpen, slashQuery]);

    useLayoutEffect(() => {
      if (!atMenuOpen || atQuery === null) {
        setAtMenuMaxHeight(null);
        return;
      }
      const menu = atMenuRef.current;
      if (!menu) return;
      return subscribeUpwardMenuMaxHeight(menu, (nextHeight) => {
        setAtMenuMaxHeight((current) => (current === nextHeight ? current : nextHeight));
      });
    }, [atMenuOpen, atQuery]);

    // Build model options: prefer modelList (has provider info), fallback to modelNames
    const modelOptions: ModelSelectorOption[] = (() => {
      if (modelList && modelList.length > 0) {
        return modelList.map((m) => ({ provider: m.provider, modelId: m.id, name: m.name }));
      }
      return Object.entries(modelNames ?? {}).map(([modelId, name]) => ({
        provider: model?.provider ?? 'unknown',
        modelId,
        name
      }));
    })();

    const resolvedThinkingLevel = thinkingLevel && thinkingLevel !== 'auto' ? thinkingLevel : null;
    const thinkingDisplayLabel = (() => {
      const lvl = resolvedThinkingLevel ?? 'auto';
      if (lvl === 'auto' || !thinkingLevelMap) return lvl;
      return thinkingLevelMap[lvl] ?? lvl;
    })();
    const toolPresetLabel = (() => {
      const current = toolPreset ?? 'configured';
      if (current.startsWith(CUSTOM_TOOL_PRESET_PREFIX)) {
        const preset = (customToolPresets ?? []).find(
          (candidate) => customPresetSelection(candidate.id) === current
        );
        return preset ? preset.name : t('chat.customPresetMissing');
      }
      const builtin =
        Object.entries(TOOL_PRESET_MAP).find(([, v]) => v === current)?.[0] ?? 'configured';
      return builtin === 'chat-only'
        ? t('chat.chatOnly')
        : builtin === 'plan'
          ? t('chat.planMode')
          : builtin === 'autonomous'
            ? t('chat.autonomousMode')
            : builtin === 'orchestrator'
              ? t('chat.orchestratorMode')
              : builtin;
    })();

    // Close dropdowns on outside click
    useEffect(() => {
      const handler = (e: MouseEvent) => {
        if (toolDropdownRef.current && !toolDropdownRef.current.contains(e.target as Node)) {
          setToolDropdownOpen(false);
        }
        if (
          thinkingDropdownRef.current &&
          !thinkingDropdownRef.current.contains(e.target as Node)
        ) {
          setThinkingDropdownOpen(false);
        }
        if (controlsMenuRef.current && !controlsMenuRef.current.contains(e.target as Node)) {
          setControlsMenuOpen(false);
        }
        if (
          historyMenuRef.current &&
          !historyMenuRef.current.contains(e.target as Node) &&
          !textareaRef.current?.contains(e.target as Node)
        ) {
          setHistoryMenuOpen(false);
        }
      };
      document.addEventListener('mousedown', handler);
      return () => document.removeEventListener('mousedown', handler);
    }, []);

    useEffect(() => {
      if (!isStreaming) return;
      setToolDropdownOpen(false);
    }, [isStreaming]);

    // Set in the commit that swaps Stop for Send, before any click can reach it.
    const runEndedAtRef = useRef(Number.NEGATIVE_INFINITY);
    useLayoutEffect(() => {
      if (!isStreaming) return;
      return () => {
        runEndedAtRef.current = performance.now();
      };
    }, [isStreaming]);
    const isStrayClick = (e: React.MouseEvent) =>
      isRunEndStrayClick(e.detail, performance.now() - runEndedAtRef.current);

    useEffect(() => {
      if (!isMobile) setControlsMenuOpen(false);
    }, [isMobile]);

    return (
      <fieldset
        disabled={builtinCommandPending}
        aria-busy={builtinCommandPending}
        className={compact ? undefined : 'chat-input-shell'}
        style={{
          flexShrink: 0,
          minWidth: 0,
          margin: 0,
          border: 0,
          background: 'transparent',
          padding: compact ? 0 : '0 16px 8px',
          paddingRight: compact ? 0 : isMobile ? 16 : 52, // desktop: 16px base + 36px for ChatMinimap alignment
          opacity: builtinCommandPending ? 0.5 : 1,
          transition: 'opacity 0.15s'
        }}
      >
        {/* Hidden file input. No `capture`: phones still offer the photo library and camera. */}
        {!compact && (
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={handleFilePick}
          />
        )}
        <div style={{ maxWidth: 'var(--chat-content-max-width, 820px)', margin: '0 auto' }}>
          <ModelErrorBanner error={modelError} />
          <ModelScopeWarningBanner warnings={modelScopeWarnings} />
          {/* Queued steering / follow-up messages (delivered by pi on upcoming turns) */}
          {(queuedMessages?.steering.length ?? 0) + (queuedMessages?.followUp.length ?? 0) > 0 && (
            <div
              style={{
                marginBottom: 8,
                border: '1px solid var(--border)',
                borderRadius: 6,
                background: 'var(--bg-panel)',
                padding: '5px 0'
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  padding: '2px 8px 4px 10px'
                }}
              >
                <span
                  style={{
                    fontSize: 10,
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--text-dim)',
                    textTransform: 'uppercase',
                    letterSpacing: 0.4
                  }}
                >
                  {t('chat.queued', {
                    count:
                      (queuedMessages?.steering.length ?? 0) +
                      (queuedMessages?.followUp.length ?? 0)
                  })}
                </span>
                {onRecallQueue && (
                  <button
                    onClick={onRecallQueue}
                    title={t('chat.recallTitle')}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '4px 12px',
                      fontSize: 12,
                      color: 'var(--text)',
                      background: 'transparent',
                      border: '1px solid var(--border)',
                      borderRadius: 7,
                      cursor: 'pointer',
                      transition: 'background 0.12s, border-color 0.12s',
                      whiteSpace: 'nowrap'
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'var(--bg-hover)';
                      e.currentTarget.style.borderColor =
                        'color-mix(in srgb, var(--accent) 45%, var(--border))';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent';
                      e.currentTarget.style.borderColor = 'var(--border)';
                    }}
                  >
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="9 14 4 9 9 4" />
                      <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
                    </svg>
                    {t('chat.recall')}
                  </button>
                )}
              </div>
              {queuedMessages?.steering.map((text, i) => (
                <QueuedMessageRow key={`steer-${i}`} kind="steer" text={text} />
              ))}
              {queuedMessages?.followUp.map((text, i) => (
                <QueuedMessageRow key={`followup-${i}`} kind="follow-up" text={text} />
              ))}
            </div>
          )}
          {/* Retry banner */}
          {retryInfo && (
            <div
              style={{
                marginBottom: 8,
                padding: '5px 10px',
                background: 'rgba(234,179,8,0.08)',
                border: '1px solid rgba(234,179,8,0.25)',
                borderRadius: 6,
                fontSize: 12,
                color: 'rgba(180,130,0,0.9)',
                display: 'flex',
                alignItems: 'center',
                gap: 6
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
                style={{ flexShrink: 0 }}
              >
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
              {t('chat.retrying', { attempt: retryInfo.attempt, max: retryInfo.maxAttempts })}
              {retryInfo.errorMessage && (
                <span style={{ opacity: 0.7, marginLeft: 4 }}>— {retryInfo.errorMessage}</span>
              )}
            </div>
          )}
          {compactError && (
            <div
              role="alert"
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 6,
                marginBottom: 8,
                padding: onDismissCompactError ? '3px 3px 3px 10px' : '7px 10px',
                background: 'rgba(239,68,68,0.07)',
                border: '1px solid rgba(239,68,68,0.3)',
                borderRadius: 6,
                color: '#ef4444',
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                lineHeight: 1.5
              }}
            >
              <span
                style={{
                  minWidth: 0,
                  flex: 1,
                  padding: onDismissCompactError ? '4px 0' : 0,
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere'
                }}
              >
                {compactError}
              </span>
              {onDismissCompactError && (
                <DismissButton
                  onClick={onDismissCompactError}
                  title={t('chat.dismissCompactError')}
                />
              )}
            </div>
          )}
          {/* Attached files: dropped or picked into the working directory, shown
              as chips. The prompt still receives their `@path` mentions. */}
          {attachedFiles.length > 0 && (
            <div className="chat-attachment-chips" role="list" aria-label={t('chat.attachedFiles')}>
              {attachedFiles.map((file, i) => (
                <div
                  key={file.path}
                  className="chat-attachment-chip"
                  role="listitem"
                  title={file.path}
                >
                  {getFileIcon(file.name, 14)}
                  <span className="chat-attachment-chip-name">{file.name}</span>
                  <button
                    type="button"
                    className="chat-attachment-chip-remove"
                    onClick={() => removeFile(i)}
                    title={t('chat.removeAttachedFile', { name: file.name })}
                    aria-label={t('chat.removeAttachedFile', { name: file.name })}
                  >
                    <svg
                      width="8"
                      height="8"
                      viewBox="0 0 8 8"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      aria-hidden="true"
                    >
                      <line x1="1" y1="1" x2="7" y2="7" />
                      <line x1="7" y1="1" x2="1" y2="7" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
          {/* Main input */}
          <div style={{ position: 'relative', minWidth: 0 }}>
            {historyMenuOpen && inputHistory.length > 0 && (
              <div
                ref={historyMenuRef}
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: 'calc(100% + 8px)',
                  zIndex: 120,
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  boxShadow: '0 -6px 20px rgba(0,0,0,0.12)',
                  overflow: 'hidden',
                  maxHeight: 'min(44vh, 360px)'
                }}
              >
                <div
                  title={t('chat.inputHistory')}
                  style={{
                    height: 30,
                    padding: '0 10px',
                    borderBottom: '1px solid var(--border)',
                    display: 'flex',
                    alignItems: 'center',
                    color: 'var(--text-dim)'
                  }}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M3 12a9 9 0 1 0 3-6.7" />
                    <path d="M3 4v5h5" />
                    <path d="M12 7v5l3 2" />
                  </svg>
                </div>
                <div
                  style={{
                    maxHeight: 'calc(min(44vh, 360px) - 31px)',
                    overflowY: 'auto',
                    padding: 4
                  }}
                >
                  {inputHistory.map((item, index) => {
                    const active = index === historyActiveIndex;
                    return (
                      <button
                        key={`${index}:${item}`}
                        ref={(node) => {
                          historyItemRefs.current[index] = node;
                        }}
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          applyHistoryInput(item);
                        }}
                        onMouseEnter={() => setHistoryActiveIndex(index)}
                        style={{
                          width: '100%',
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: 8,
                          padding: '7px 8px',
                          border: 'none',
                          borderRadius: 6,
                          background: active ? 'var(--bg-selected)' : 'none',
                          color: 'var(--text)',
                          cursor: 'pointer',
                          textAlign: 'left',
                          fontSize: 12.5,
                          lineHeight: 1.45
                        }}
                      >
                        <span
                          style={{
                            flexShrink: 0,
                            fontFamily: 'var(--font-mono)',
                            fontSize: 11,
                            color: 'var(--text-dim)',
                            paddingTop: 1
                          }}
                        >
                          {index + 1}
                        </span>
                        <span
                          style={{
                            minWidth: 0,
                            display: '-webkit-box',
                            WebkitBoxOrient: 'vertical',
                            WebkitLineClamp: 2,
                            overflow: 'hidden',
                            overflowWrap: 'anywhere'
                          }}
                        >
                          {item}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {slashMenuOpen && slashQuery !== null && (
              <div
                ref={slashMenuRef}
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: 'calc(100% + 8px)',
                  zIndex: 120,
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  boxShadow: '0 -6px 20px rgba(0,0,0,0.12)',
                  overflow: 'hidden',
                  boxSizing: 'border-box',
                  display: 'flex',
                  flexDirection: 'column',
                  maxHeight:
                    slashMenuMaxHeight === null
                      ? 'min(72.8vh, 598px)'
                      : `min(72.8vh, 598px, ${slashMenuMaxHeight}px)`
                }}
              >
                <div
                  style={{
                    padding: '8px 10px',
                    borderBottom: '1px solid var(--border)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    fontSize: 11,
                    color: 'var(--text-dim)',
                    flexShrink: 0
                  }}
                >
                  <span>
                    {slashCommandsLoading
                      ? t('chat.loadingCommands')
                      : t('chat.slashCommands', { label: slashCommandCountLabel })}
                  </span>
                  <span style={{ fontFamily: 'var(--font-mono)' }}>{t('chat.tabEnter')}</span>
                </div>
                <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: 10 }}>
                  {!slashCommandsLoading && filteredSlashCommands.length === 0 ? (
                    <div style={{ padding: '2px 2px 4px', fontSize: 12, color: 'var(--text-dim)' }}>
                      {t('chat.noCommands')}
                    </div>
                  ) : (
                    groupedSlashCommands.map((group) => (
                      <section key={group.source} style={{ marginBottom: 12 }}>
                        <div
                          style={{
                            position: 'sticky',
                            top: -10,
                            zIndex: 1,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 8,
                            padding: '4px 0 6px',
                            background: 'var(--bg)',
                            color: 'var(--text-dim)',
                            fontSize: 10,
                            fontWeight: 600,
                            textTransform: 'uppercase'
                          }}
                        >
                          <span>{t(SLASH_SOURCE_GROUP_LABEL_KEYS[group.source])}</span>
                          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 500 }}>
                            {group.items.length}
                          </span>
                        </div>
                        <div
                          style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                            gap: 8
                          }}
                        >
                          {group.items.map(({ command, index }) => {
                            const active = index === slashActiveIndex;
                            const dormant = isDormantSkillCommand(command, skillDormancy);
                            return (
                              <button
                                key={`${command.source}:${command.name}`}
                                ref={(node) => {
                                  slashItemRefs.current[index] = node;
                                }}
                                type="button"
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  applySlashCommand(command);
                                }}
                                onMouseEnter={() => setSlashActiveIndex(index)}
                                style={{
                                  width: '100%',
                                  minWidth: 0,
                                  minHeight: 58,
                                  display: 'flex',
                                  flexDirection: 'column',
                                  gap: 4,
                                  justifyContent: 'center',
                                  padding: '9px 10px',
                                  border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                                  borderRadius: 7,
                                  background: active ? 'var(--bg-selected)' : 'var(--bg-panel)',
                                  color: 'var(--text)',
                                  cursor: 'pointer',
                                  textAlign: 'left',
                                  boxShadow: active
                                    ? '0 0 0 1px color-mix(in srgb, var(--accent) 28%, transparent)'
                                    : 'none'
                                }}
                              >
                                <span
                                  style={{
                                    fontSize: 13,
                                    fontFamily: 'var(--font-mono)',
                                    overflowWrap: 'anywhere',
                                    wordBreak: 'break-word',
                                    color: dormant ? 'var(--text-dim)' : undefined
                                  }}
                                >
                                  /{command.name}
                                  {dormant && (
                                    <span
                                      style={{
                                        marginLeft: 6,
                                        padding: '0 4px',
                                        border: '1px solid var(--border)',
                                        borderRadius: 3,
                                        fontSize: 9,
                                        color: 'var(--text-dim)',
                                        whiteSpace: 'nowrap'
                                      }}
                                    >
                                      {t('chat.dormant')}
                                    </span>
                                  )}
                                </span>
                                {command.description && (
                                  <span
                                    style={{
                                      display: '-webkit-box',
                                      WebkitBoxOrient: 'vertical',
                                      WebkitLineClamp: 2,
                                      overflow: 'hidden',
                                      fontSize: 11,
                                      lineHeight: 1.35,
                                      color: 'var(--text-dim)'
                                    }}
                                  >
                                    {getSlashDescription(command, t)}
                                  </span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </section>
                    ))
                  )}
                </div>
              </div>
            )}
            {atMenuOpen &&
              atQuery !== null &&
              (() => {
                const indexLoading = fileIndexLoading && (!fileIndex || fileIndex.cwd !== cwd);
                const matchCountLabel =
                  atMatches.length === 1
                    ? t('chat.match')
                    : t('chat.matches', { count: atMatches.length });
                // With a truncated index, local results are provisional — the
                // debounced server search over the full listing replaces them.
                const truncatedHint =
                  fileIndex?.truncated && !serverResultInUse
                    ? atQuery.query
                      ? t('chat.searchingAll')
                      : t('chat.indexTruncated')
                    : '';
                return (
                  <div
                    ref={atMenuRef}
                    style={{
                      position: 'absolute',
                      left: 0,
                      right: 0,
                      bottom: 'calc(100% + 8px)',
                      zIndex: 120,
                      background: 'var(--bg)',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      boxShadow: '0 -6px 20px rgba(0,0,0,0.12)',
                      overflow: 'hidden',
                      boxSizing: 'border-box',
                      display: 'flex',
                      flexDirection: 'column',
                      maxHeight:
                        atMenuMaxHeight === null
                          ? 'min(48vh, 400px)'
                          : `min(48vh, 400px, ${atMenuMaxHeight}px)`
                    }}
                  >
                    <div
                      style={{
                        padding: '8px 10px',
                        borderBottom: '1px solid var(--border)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                        fontSize: 11,
                        color: 'var(--text-dim)',
                        flexShrink: 0
                      }}
                    >
                      <span>
                        {indexLoading
                          ? t('chat.loadingFiles')
                          : t('chat.files', { label: matchCountLabel, hint: truncatedHint })}
                      </span>
                      <span style={{ fontFamily: 'var(--font-mono)' }}>{t('chat.tabEnter')}</span>
                    </div>
                    <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: 4 }}>
                      {!indexLoading && atMatches.length === 0 ? (
                        <div style={{ padding: '6px 8px', fontSize: 12, color: 'var(--text-dim)' }}>
                          {needsServerSearch && !serverResultInUse
                            ? t('chat.searching')
                            : t('chat.noMatchingFiles')}
                        </div>
                      ) : (
                        atMatches.map((entry, index) => {
                          const active = index === atActiveIndex;
                          const name = entry.path.split('/').pop() ?? entry.path;
                          const dirPrefix = entry.path.slice(0, entry.path.length - name.length);
                          return (
                            <button
                              key={`${entry.isDir ? 'd' : 'f'}:${entry.path}`}
                              ref={(node) => {
                                atItemRefs.current[index] = node;
                              }}
                              type="button"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                applyAtCompletion(entry);
                              }}
                              onMouseEnter={() => setAtActiveIndex(index)}
                              style={{
                                width: '100%',
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                                padding: '6px 8px',
                                border: 'none',
                                borderRadius: 6,
                                background: active ? 'var(--bg-selected)' : 'none',
                                color: 'var(--text)',
                                cursor: 'pointer',
                                textAlign: 'left',
                                fontSize: 12.5,
                                fontFamily: 'var(--font-mono)'
                              }}
                            >
                              <span
                                style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}
                              >
                                {entry.isDir ? <FolderIcon size={14} /> : getFileIcon(name, 14)}
                              </span>
                              <span
                                style={{
                                  minWidth: 0,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap'
                                }}
                              >
                                {dirPrefix && (
                                  <span style={{ color: 'var(--text-dim)' }}>{dirPrefix}</span>
                                )}
                                {name}
                                {entry.isDir && <span style={{ color: 'var(--text-dim)' }}>/</span>}
                              </span>
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>
                );
              })()}
            <div
              // a stable styling hook, excluding the compact quote composer.
              className={compact ? undefined : 'composer-surface'}
              style={
                {
                  minWidth: 0,
                  display: 'flex',
                  flexDirection: stackedComposer ? 'column' : 'row',
                  gap: 8,
                  alignItems: stackedComposer ? 'stretch' : 'center',
                  background: 'var(--bg)',
                  border: compact
                    ? 'none'
                    : `1px solid ${
                        bashMode
                          ? 'var(--tool-bg)'
                          : isStreaming && (onSteer || onFollowUp)
                            ? 'rgba(234,179,8,0.4)'
                            : 'color-mix(in srgb, var(--border) 70%, transparent)'
                      }`,
                  borderRadius: compact ? 0 : 14,
                  padding: compact ? 0 : isMobile ? '6px 6px 6px 12px' : '10px 10px 10px 14px',
                  boxShadow: compact
                    ? 'none'
                    : '0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.10)',
                  transition: 'border-color 0.15s, background 0.15s, box-shadow 0.15s'
                } as React.CSSProperties
              }
            >
              <textarea
                ref={textareaRef}
                className="chat-input-textarea"
                aria-label={compact ? t('chat.quoteQuestion') : undefined}
                value={value}
                onChange={(e) => {
                  valueRef.current = e.target.value;
                  setValue(e.target.value);
                  setHistoryMenuOpen(false);
                  updateAtQuery(e.target.value, e.target.selectionStart);
                }}
                onSelect={(e) => {
                  const el = e.currentTarget;
                  updateAtQuery(el.value, el.selectionStart);
                }}
                onKeyDown={handleKeyDown}
                onCompositionStart={() => {
                  isComposingRef.current = true;
                }}
                onCompositionEnd={(e) => {
                  isComposingRef.current = false;
                  lastCompositionEndAtRef.current = Date.now();
                  const el = e.currentTarget;
                  updateAtQuery(el.value, el.selectionStart);
                }}
                onInput={handleInput}
                onPaste={handlePaste}
                placeholder={
                  isStreaming && (onSteer || onFollowUp)
                    ? t('chat.steerPlaceholder')
                    : isStreaming
                      ? t('chat.agentPlaceholder')
                      : t('chat.messagePlaceholder')
                }
                rows={1}
                style={{
                  flex: stackedComposer ? 'none' : 1,
                  minWidth: 0,
                  width: '100%',
                  background: 'none',
                  border: 'none',
                  outline: 'none',
                  resize: 'none',
                  color: 'var(--text)',
                  fontSize: 'var(--chat-content-font-size, 14px)',
                  lineHeight: 1.6,
                  fontFamily: 'inherit',
                  minHeight: compact ? 96 : 24,
                  maxHeight: 200,
                  overflow: 'auto'
                }}
              />

              {isStreaming ? (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    flexShrink: 0,
                    alignSelf: 'flex-end'
                  }}
                >
                  {onSteer && (
                    <button
                      onClick={() => sendQueued('steer')}
                      disabled={!canQueueStreamingMessage}
                      title={t('chat.steerHint')}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 5,
                        padding: '7px 12px',
                        background: canQueueStreamingMessage ? 'rgba(234,179,8,0.12)' : 'none',
                        border: '1px solid rgba(234,179,8,0.35)',
                        borderRadius: 8,
                        color: canQueueStreamingMessage ? 'rgba(180,130,0,1)' : 'var(--text-dim)',
                        cursor: canQueueStreamingMessage ? 'pointer' : 'not-allowed',
                        fontSize: 13,
                        fontWeight: 600,
                        letterSpacing: '-0.01em',
                        transition: 'background 0.12s'
                      }}
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 10 10"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M5 1 L9 5 L5 9" />
                        <line x1="1" y1="5" x2="9" y2="5" />
                      </svg>
                      {t('chat.steer')}
                    </button>
                  )}
                  {onFollowUp && (
                    <button
                      onClick={() => sendQueued('followup')}
                      disabled={!canQueueStreamingMessage}
                      title={`${t('chat.followUpHint')} (${isMobile ? 'Ctrl/Cmd+' : ''}Alt/Option+Enter)`}
                      aria-keyshortcuts={
                        isMobile ? 'Control+Alt+Enter Meta+Alt+Enter' : 'Alt+Enter'
                      }
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 5,
                        padding: '7px 12px',
                        background: canQueueStreamingMessage ? 'rgba(129,140,248,0.12)' : 'none',
                        border: '1px solid rgba(129,140,248,0.35)',
                        borderRadius: 8,
                        color: canQueueStreamingMessage ? 'rgba(99,102,241,1)' : 'var(--text-dim)',
                        cursor: canQueueStreamingMessage ? 'pointer' : 'not-allowed',
                        fontSize: 13,
                        fontWeight: 600,
                        letterSpacing: '-0.01em',
                        transition: 'background 0.12s'
                      }}
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 10 10"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <line x1="5" y1="1" x2="5" y2="6" />
                        <polyline points="2.5 3.5 5 1 7.5 3.5" />
                        <line x1="2" y1="9" x2="8" y2="9" />
                      </svg>
                      {t('chat.followUp')}
                    </button>
                  )}
                </div>
              ) : isCompacting && onAbortCompaction ? (
                // Compaction holds the session the way a run does, so the button
                // that sends becomes the button that stops it. One place to stop
                // things, and no dead Send while the context is being rewritten.
                <button
                  onClick={onAbortCompaction}
                  title={t('chat.stopCompaction')}
                  aria-label={t('chat.stopCompaction')}
                  style={{
                    flexShrink: 0,
                    alignSelf: 'flex-end',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                    ...(isMobile ? { width: 36, height: 36, padding: 0 } : { padding: '7px 14px' }),
                    background: 'rgba(239,68,68,0.08)',
                    border: '1px solid rgba(239,68,68,0.3)',
                    borderRadius: 8,
                    color: '#ef4444',
                    cursor: 'pointer',
                    fontSize: 13,
                    fontWeight: 600,
                    letterSpacing: '-0.01em',
                    transition: 'background 0.15s'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(239,68,68,0.16)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'rgba(239,68,68,0.08)';
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 10 10" fill="none">
                    <rect x="1.5" y="1.5" width="7" height="7" rx="1.5" fill="currentColor" />
                  </svg>
                  {!isMobile && t('chat.stop')}
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={!value.trim() && !hasAttachments}
                  title={t('chat.send')}
                  aria-label={t('chat.send')}
                  style={{
                    flexShrink: 0,
                    alignSelf: 'flex-end',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                    // Mobile: icon-only so the placeholder and draft keep the width.
                    ...(isMobile ? { width: 36, height: 36, padding: 0 } : { padding: '7px 14px' }),
                    background:
                      value.trim() || hasAttachments ? 'var(--accent)' : 'var(--bg-panel)',
                    border: 'none',
                    borderRadius: 8,
                    color:
                      value.trim() || hasAttachments ? 'var(--accent-contrast)' : 'var(--text-dim)',
                    cursor: value.trim() || hasAttachments ? 'pointer' : 'not-allowed',
                    fontSize: 13,
                    fontWeight: 600,
                    letterSpacing: '-0.01em',
                    boxShadow:
                      value.trim() || hasAttachments
                        ? '0 1px 3px color-mix(in srgb, var(--accent) 25%, transparent)'
                        : 'none',
                    transition: 'background 0.15s, box-shadow 0.15s'
                  }}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 14 14"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <line x1="2" y1="7" x2="11" y2="7" />
                    <polyline points="7.5 3 12 7 7.5 11" />
                  </svg>
                  {!isMobile && t('chat.send')}
                </button>
              )}
            </div>
          </div>

          {/* Bash mode status label */}
          {bashMode && (
            <div
              className="text-xs px-2 py-1"
              style={{ color: bashExcluded ? 'var(--text-muted)' : 'var(--accent)', marginTop: 4 }}
            >
              {t('chat.shell')} · {bashExcluded ? t('chat.outputLocal') : t('chat.outputModel')}
            </div>
          )}

          {/* Bottom bar: left | center (context) | right */}
          {!compact && (
            <div
              className="chat-input-controls"
              style={{
                marginTop: isMobile ? 4 : 8,
                display: isMobile ? 'grid' : 'flex',
                gridTemplateColumns: isMobile ? 'minmax(0, 1fr) auto' : undefined,
                alignItems: 'center',
                gap: 6
              }}
            >
              {/* LEFT: attach + model selector (idle) or steer/followup toggle (streaming) */}
              <div
                style={{
                  flex: isMobile ? '1 1 auto' : '0 0 auto',
                  minWidth: 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 2
                }}
              >
                <button
                  onClick={() => fileInputRef.current?.click()}
                  title={t('chat.attachFiles')}
                  style={{
                    flexShrink: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 32,
                    height: 32,
                    padding: 0,
                    background: 'none',
                    border: 'none',
                    borderRadius: 9,
                    color: hasAttachments ? 'var(--accent)' : 'var(--text-muted)',
                    cursor: 'pointer',
                    opacity: 1,
                    transition: 'background 0.12s, color 0.12s'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--bg-hover)';
                    e.currentTarget.style.color = hasAttachments ? 'var(--accent)' : 'var(--text)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'none';
                    e.currentTarget.style.color = hasAttachments
                      ? 'var(--accent)'
                      : 'var(--text-muted)';
                  }}
                >
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <polyline points="21 15 16 10 5 21" />
                  </svg>
                </button>
                {/* Model selector - visible always, disabled while the session or switch is busy */}
                {(modelOptions.length > 0 || model || modelError) && onModelChange && (
                  <ModelSelector
                    options={modelOptions}
                    value={model}
                    onChange={onModelChange}
                    onReselect={onModelChange}
                    disabled={isStreaming}
                    busy={modelSwitching}
                    isAutoSelection={isAutoModelSelection}
                    defaultValue={defaultModel}
                    onSetDefault={onSetDefaultModel}
                  />
                )}
              </div>

              {/* spacer */}
              {!isMobile && <div style={{ flex: 1 }} />}

              {/* RIGHT: thinking + tools preset + sound (idle) | Stop + sound (streaming) */}
              <div
                ref={controlsMenuRef}
                style={{
                  flex: '0 0 auto',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  position: 'relative',
                  marginLeft: isMobile ? 0 : 'auto'
                }}
              >
                {isMobile && (
                  <button
                    type="button"
                    title={controlsMenuOpen ? undefined : t('chat.controls')}
                    aria-label={t('chat.controls')}
                    aria-expanded={controlsMenuOpen}
                    aria-hidden={controlsMenuOpen || undefined}
                    tabIndex={controlsMenuOpen ? -1 : undefined}
                    onClick={() => {
                      setControlsMenuOpen(true);
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: '100%',
                      height: 32,
                      padding: '8px 10px',
                      background: 'none',
                      border: 'none',
                      borderRadius: 9,
                      color: 'var(--text-muted)',
                      cursor: controlsMenuOpen ? 'default' : 'pointer',
                      fontSize: 12,
                      fontWeight: 500,
                      visibility: controlsMenuOpen ? 'hidden' : 'visible',
                      pointerEvents: controlsMenuOpen ? 'none' : 'auto',
                      transition: 'background 0.12s, color 0.12s'
                    }}
                    onMouseEnter={(e) => {
                      if (controlsMenuOpen) return;
                      e.currentTarget.style.background = 'var(--bg-hover)';
                      e.currentTarget.style.color = 'var(--text)';
                    }}
                    onMouseLeave={(e) => {
                      if (controlsMenuOpen) return;
                      e.currentTarget.style.background = 'none';
                      e.currentTarget.style.color = 'var(--text-muted)';
                    }}
                  >
                    {t('chat.controls')}
                  </button>
                )}
                <div
                  style={{
                    display: isMobile ? (controlsMenuOpen ? 'flex' : 'none') : 'flex',
                    alignItems: 'center',
                    gap: isMobile ? 1 : 2,
                    ...(isMobile
                      ? {
                          position: 'absolute',
                          right: 0,
                          bottom: 0,
                          zIndex: 60,
                          padding: 1,
                          width: 'max-content',
                          maxWidth: 'calc(100vw - 32px)',
                          flexWrap: 'nowrap',
                          justifyContent: 'flex-end',
                          border: '1px solid color-mix(in srgb, var(--border) 72%, transparent)',
                          borderRadius: 10,
                          background: 'color-mix(in srgb, var(--bg-panel) 92%, var(--bg))',
                          boxShadow: '0 8px 24px rgba(0,0,0,0.14)',
                          backdropFilter: 'blur(10px)'
                        }
                      : null)
                  }}
                >
                  {onThinkingLevelChange && (
                    <div ref={thinkingDropdownRef} style={{ position: 'relative' }}>
                      <button
                        onClick={() => setThinkingDropdownOpen((v) => !v)}
                        title={
                          isStreaming
                            ? t('chat.currentReasoning', { level: thinkingDisplayLabel })
                            : t('chat.changeReasoning', { level: thinkingDisplayLabel })
                        }
                        aria-label={t('chat.changeReasoningLabel')}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: 5,
                          padding: isMobile ? '0 6px' : '8px 12px',
                          width: isMobile ? 'auto' : undefined,
                          height: 32,
                          background: thinkingDropdownOpen ? 'var(--bg-hover)' : 'none',
                          border: 'none',
                          borderRadius: 9,
                          color: 'var(--text-muted)',
                          cursor: 'pointer',
                          fontSize: 12,
                          transition: 'background 0.12s, color 0.12s'
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = 'var(--bg-hover)';
                          e.currentTarget.style.color = 'var(--text)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = thinkingDropdownOpen
                            ? 'var(--bg-hover)'
                            : 'none';
                          e.currentTarget.style.color = 'var(--text-muted)';
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
                        >
                          <path d="M9.5 2A5.5 5.5 0 0 0 4 7.5c0 1.7.78 3.21 2 4.21V14a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1v-2.29c1.22-1 2-2.51 2-4.21A5.5 5.5 0 0 0 9.5 2z" />
                          <line x1="7" y1="18" x2="12" y2="18" />
                          <line x1="8" y1="21" x2="11" y2="21" />
                        </svg>
                        {(!isMobile || controlsMenuOpen) && (
                          <span style={{ whiteSpace: 'nowrap' }}>{thinkingDisplayLabel}</span>
                        )}
                      </button>
                      {thinkingDropdownOpen && (
                        <div
                          style={{
                            position: 'absolute',
                            bottom: 'calc(100% + 6px)',
                            ...(isMobile ? { left: 0 } : { right: 0 }),
                            zIndex: 100,
                            background: 'var(--bg)',
                            border: '1px solid var(--border)',
                            borderRadius: 8,
                            boxShadow: '0 -4px 16px rgba(0,0,0,0.10)',
                            overflow: 'hidden',
                            minWidth: 180
                          }}
                        >
                          {THINKING_LEVELS.filter((lvl) => {
                            if (!availableThinkingLevels) return true;
                            if (lvl === 'auto') return true;
                            return availableThinkingLevels.includes(lvl);
                          }).map((lvl) => {
                            const isActive =
                              lvl === 'auto'
                                ? isAutoThinkingSelection
                                : !isAutoThinkingSelection && resolvedThinkingLevel === lvl;
                            const desc = t(THINKING_LEVEL_DESC_KEYS[lvl]);
                            const mappedVal =
                              lvl !== 'auto' && thinkingLevelMap
                                ? thinkingLevelMap[lvl]
                                : undefined;
                            const displayLabel =
                              mappedVal != null && mappedVal !== lvl ? mappedVal : lvl;
                            const showOriginal = mappedVal != null && mappedVal !== lvl;
                            return (
                              <SelectorRow
                                key={lvl}
                                active={isActive}
                                onSelect={() => {
                                  setThinkingDropdownOpen(false);
                                  if (lvl === 'auto') {
                                    if (!isAutoThinkingSelection) onThinkingLevelChange('auto');
                                    return;
                                  }
                                  if (!isActive || isAutoThinkingSelection)
                                    onThinkingLevelChange(lvl);
                                }}
                                gutter={Boolean(onSetDefaultThinkingLevel)}
                                star={
                                  onSetDefaultThinkingLevel && lvl !== 'auto'
                                    ? {
                                        isDefault: savedDefaultThinkingLevel === lvl,
                                        saveLabel: t('chat.saveDefaultThinking'),
                                        defaultLabel: t('chat.defaultThinking'),
                                        onSave: () => {
                                          setThinkingDropdownOpen(false);
                                          onSetDefaultThinkingLevel(lvl);
                                        }
                                      }
                                    : undefined
                                }
                              >
                                <span style={{ flex: 1 }}>
                                  {displayLabel}
                                  {showOriginal && (
                                    <span
                                      style={{
                                        fontSize: 10,
                                        color: 'var(--text-dim)',
                                        fontFamily: 'var(--font-mono)',
                                        marginLeft: 5
                                      }}
                                    >
                                      ({lvl})
                                    </span>
                                  )}
                                </span>
                                <span
                                  style={{ fontSize: 11, color: 'var(--text-dim)', marginLeft: 8 }}
                                >
                                  {desc}
                                </span>
                              </SelectorRow>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                  {onToolPresetChange && (
                    <div ref={toolDropdownRef} style={{ position: 'relative' }}>
                      <button
                        onClick={(e) => {
                          if (!isStreaming && !isStrayClick(e)) setToolDropdownOpen((v) => !v);
                        }}
                        disabled={isStreaming}
                        title={
                          isStreaming
                            ? t('chat.currentToolPreset', { preset: toolPresetLabel })
                            : t('chat.changeToolPreset') + `: ${toolPresetLabel}`
                        }
                        aria-label={t('chat.changeToolPreset')}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: 5,
                          padding: isMobile ? '0 6px' : '8px 12px',
                          width: isMobile ? 'auto' : undefined,
                          height: 32,
                          background: toolDropdownOpen ? 'var(--bg-hover)' : 'none',
                          border: 'none',
                          borderRadius: 9,
                          color: 'var(--text-muted)',
                          cursor: isStreaming ? 'not-allowed' : 'pointer',
                          fontSize: 12,
                          opacity: isStreaming ? 0.5 : 1,
                          transition: 'background 0.12s, color 0.12s'
                        }}
                        onMouseEnter={(e) => {
                          if (isStreaming) return;
                          e.currentTarget.style.background = 'var(--bg-hover)';
                          e.currentTarget.style.color = 'var(--text)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = toolDropdownOpen
                            ? 'var(--bg-hover)'
                            : 'none';
                          e.currentTarget.style.color = 'var(--text-muted)';
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
                        >
                          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                        </svg>
                        {(!isMobile || controlsMenuOpen) && (
                          <span style={{ whiteSpace: 'nowrap' }}>{toolPresetLabel}</span>
                        )}
                      </button>
                      {toolDropdownOpen && (
                        <div
                          style={{
                            position: 'absolute',
                            bottom: 'calc(100% + 6px)',
                            right: isMobile ? undefined : 0,
                            left: isMobile ? 0 : undefined,
                            zIndex: 100,
                            background: 'var(--bg)',
                            border: '1px solid var(--border)',
                            borderRadius: 8,
                            boxShadow: '0 -4px 16px rgba(0,0,0,0.10)',
                            overflowY: 'auto',
                            overflowX: 'hidden',
                            minWidth: 160,
                            maxWidth: 320,
                            maxHeight: 'min(60dvh, 420px)'
                          }}
                        >
                          {TOOL_PRESETS.map((lvl) => {
                            const preset = TOOL_PRESET_MAP[lvl];
                            const isActive = (toolPreset ?? 'configured') === preset;
                            let desc: string;
                            if (lvl === 'configured') desc = t('chat.configuredTools');
                            else if (lvl === 'plan') desc = t('chat.planModeTools');
                            else if (lvl === 'autonomous')
                              desc = t('chat.autonomousModeTools');
                            else if (lvl === 'orchestrator')
                              desc = t('chat.orchestratorModeTools');
                            else if (lvl === 'chat-only') desc = t('chat.chatOnly');
                            else if (lvl === 'read-only')
                              desc = t('chat.readOnlyTools', { count: 4 });
                            else if (lvl === 'default') desc = t('chat.builtInTools', { count: 4 });
                            else desc = t('chat.allBuiltInTools');
                            return (
                              <PresetMenuItem
                                key={lvl}
                                label={
                                  lvl === 'autonomous'
                                    ? t('chat.autonomousMode')
                                    : lvl === 'orchestrator'
                                      ? t('chat.orchestratorMode')
                                      : lvl
                                }
                                description={desc}
                                active={isActive}
                                onSelect={() => {
                                  setToolDropdownOpen(false);
                                  if (!isActive) onToolPresetChange(preset);
                                }}
                              />
                            );
                          })}
                          {(customToolPresets ?? []).map((preset) => {
                            const selection = customPresetSelection(preset.id);
                            const isActive = (toolPreset ?? 'configured') === selection;
                            return (
                              <PresetMenuItem
                                key={preset.id}
                                label={preset.name}
                                description={t('chat.toolCount', { count: preset.tools.length })}
                                active={isActive}
                                title={preset.tools.join(', ')}
                                onSelect={() => {
                                  setToolDropdownOpen(false);
                                  if (!isActive) onToolPresetChange(selection);
                                }}
                              />
                            );
                          })}
                          {onManageToolPresets && (
                            <>
                              <div
                                role="separator"
                                style={{ height: 1, margin: '3px 0', background: 'var(--border)' }}
                              />
                              <PresetMenuItem
                                label={t('chat.customizeToolPresets')}
                                description=""
                                active={false}
                                onSelect={() => {
                                  setToolDropdownOpen(false);
                                  onManageToolPresets();
                                }}
                              />
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {(onCompact || onGoalCommand) && (
                    <ComposerHub
                      goal={goal}
                      running={isStreaming}
                      onGoalCommand={onGoalCommand}
                      onGoalStop={onAbort}
                      onCompact={onCompact}
                      onAbortCompaction={onAbortCompaction}
                      isCompacting={isCompacting}
                      compactResult={compactResult}
                      contextUsage={contextUsage}
                    />
                  )}

                  {isStreaming && (
                    <button
                      onClick={onAbort}
                      title={t('chat.stopAgent')}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '8px 14px',
                        height: 32,
                        background: 'rgba(239,68,68,0.08)',
                        border: '1px solid rgba(239,68,68,0.3)',
                        borderRadius: 9,
                        color: '#ef4444',
                        cursor: 'pointer',
                        fontSize: 12,
                        fontWeight: 600,
                        whiteSpace: 'nowrap',
                        letterSpacing: '-0.01em',
                        transition: 'background 0.12s'
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'rgba(239,68,68,0.16)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'rgba(239,68,68,0.08)';
                      }}
                    >
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                        <rect x="1.5" y="1.5" width="7" height="7" rx="1.5" fill="currentColor" />
                      </svg>
                      {t('chat.stop')}
                    </button>
                  )}

                  {onSoundToggle !== undefined && (
                    <button
                      onClick={onSoundToggle}
                      title={soundEnabled ? t('chat.disableSound') : t('chat.enableSound')}
                      aria-label={soundEnabled ? t('chat.disableSound') : t('chat.enableSound')}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 5,
                        width: isMobile ? 32 : 32,
                        height: 32,
                        padding: 0,
                        background: 'none',
                        border: 'none',
                        borderRadius: 9,
                        color: soundEnabled ? 'var(--text-muted)' : 'var(--text-dim)',
                        cursor: 'pointer',
                        opacity: soundEnabled ? 1 : 0.55,
                        transition: 'background 0.12s, color 0.12s, opacity 0.12s'
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'var(--bg-hover)';
                        e.currentTarget.style.color = 'var(--text)';
                        e.currentTarget.style.opacity = '1';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'none';
                        e.currentTarget.style.color = soundEnabled
                          ? 'var(--text-muted)'
                          : 'var(--text-dim)';
                        e.currentTarget.style.opacity = soundEnabled ? '1' : '0.55';
                      }}
                    >
                      {soundEnabled ? (
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                          <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                        </svg>
                      ) : (
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                          <line x1="23" y1="9" x2="17" y2="15" />
                          <line x1="17" y1="9" x2="23" y2="15" />
                        </svg>
                      )}
                    </button>
                  )}
                  {isMobile && controlsMenuOpen && (
                    <button
                      type="button"
                      title={t('chat.collapseControls')}
                      aria-label={t('chat.collapseControls')}
                      aria-expanded={true}
                      onClick={() => {
                        setToolDropdownOpen(false);
                        setThinkingDropdownOpen(false);
                        setControlsMenuOpen(false);
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 36,
                        height: 32,
                        padding: 0,
                        marginLeft: 0,
                        background: 'var(--bg-hover)',
                        border: 'none',
                        borderLeft: '1px solid color-mix(in srgb, var(--border) 72%, transparent)',
                        borderRadius: '0 9px 9px 0',
                        color: 'var(--text)',
                        cursor: 'pointer',
                        transition: 'background 0.12s, color 0.12s'
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'var(--bg-selected)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'var(--bg-hover)';
                      }}
                    >
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                      >
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </fieldset>
    );
  })
);
