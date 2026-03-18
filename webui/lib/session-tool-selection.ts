import type { SessionManager } from '@earendil-works/pi-coding-agent';
import {
  isSelectableToolName,
  sortToolNames,
  type SessionExtensionToolsPolicy
} from './tool-presets';
import type { SessionEntry } from './types';

export const TOOL_SELECTION_TYPE = 'pie:tool-selection';

export interface SessionToolSelectionData {
  version: 1;
  tools: string[];
  /** Missing in entries written before custom presets could pin extension tools. */
  extensionTools?: SessionExtensionToolsPolicy;
}

export interface SessionToolSelection {
  tools: string[];
  extensionTools: SessionExtensionToolsPolicy;
}

/**
 * Written when the user returns a session to pi's configured defaults. The session
 * log is append-only, so an earlier pin can only be retracted by a later entry that
 * says so; without it the newest pin would win forever (#700).
 */
export interface ClearedSessionToolSelectionData {
  version: 1;
  cleared: true;
}

const CLEARED = Symbol('cleared-tool-selection');

function isExtensionToolsPolicy(value: unknown): value is SessionExtensionToolsPolicy {
  return value === 'all' || value === 'selected';
}

function parseToolSelectionData(data: unknown): SessionToolSelection | typeof CLEARED | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const candidate = data as {
    version?: unknown;
    tools?: unknown;
    cleared?: unknown;
    extensionTools?: unknown;
  };
  if (candidate.version !== 1) return undefined;
  if (candidate.cleared === true) return CLEARED;
  if (
    !Array.isArray(candidate.tools) ||
    candidate.tools.some((tool) => !isSelectableToolName(tool)) ||
    (candidate.extensionTools !== undefined && !isExtensionToolsPolicy(candidate.extensionTools))
  )
    return undefined;
  return {
    tools: sortToolNames(candidate.tools as string[]),
    extensionTools: candidate.extensionTools ?? 'all'
  };
}

/**
 * Return the newest valid persisted selection. Undefined means the session carries no
 * selection of its own - legacy sessions, sessions created without an override, and
 * sessions explicitly returned to the configured defaults all resolve that way.
 */
export function readSessionToolSelectionDetails(
  entries: readonly SessionEntry[]
): SessionToolSelection | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== 'custom' || entry.customType !== TOOL_SELECTION_TYPE) continue;
    const selection = parseToolSelectionData(entry.data);
    if (selection === undefined) continue;
    return selection === CLEARED ? undefined : selection;
  }
  return undefined;
}

/** The newest selection's tools, or undefined for no pin. */
export function readSessionToolSelection(entries: readonly SessionEntry[]): string[] | undefined {
  return readSessionToolSelectionDetails(entries)?.tools;
}

/** How the newest selection treats unnamed extension tools; no pin keeps Pi's `all`. */
export function readSessionExtensionToolsPolicy(
  entries: readonly SessionEntry[]
): SessionExtensionToolsPolicy {
  return readSessionToolSelectionDetails(entries)?.extensionTools ?? 'all';
}

export function validateSessionToolSelection(
  tools: unknown,
  extensionTools: unknown = 'all'
): string[] {
  const parsed = parseToolSelectionData({ version: 1, tools, extensionTools });
  if (parsed === undefined || parsed === CLEARED) {
    throw new Error('toolNames must contain only valid tool names');
  }
  return parsed.tools;
}

export function appendSessionToolSelection(
  sessionManager: SessionManager,
  tools: readonly string[],
  extensionTools: SessionExtensionToolsPolicy = 'all'
): void {
  sessionManager.appendCustomEntry(TOOL_SELECTION_TYPE, {
    version: 1,
    tools: [...tools],
    extensionTools
  } satisfies SessionToolSelectionData);
}

/** Retract any earlier pin so the session follows settings.json defaultTools again. */
export function appendClearedSessionToolSelection(sessionManager: SessionManager): void {
  sessionManager.appendCustomEntry(TOOL_SELECTION_TYPE, {
    version: 1,
    cleared: true
  } satisfies ClearedSessionToolSelectionData);
}
