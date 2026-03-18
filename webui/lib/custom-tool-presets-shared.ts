import { CANONICAL_CODING_TOOLS, isSelectableToolName, sortToolNames } from './tool-presets';

/**
 * User-defined tool presets: combinations of coding and extension tools, saved in
 * `pie-tool-presets.json` in the agent directory and offered beside the built-in
 * presets in the composer's tool dropdown. `lib/custom-tool-presets.ts` holds the
 * file; these rules are shared with the client, whose editor validates a draft
 * before sending the whole document to `PUT /api/tools/presets`.
 */

export const CUSTOM_TOOL_PRESETS_VERSION = 1;
export const CUSTOM_TOOL_PRESET_MAX_COUNT = 20;
export const CUSTOM_TOOL_PRESET_NAME_MAX = 40;
export const CUSTOM_TOOL_PRESET_ID_MAX = 64;

/**
 * The coding tools a new preset can start from. A saved preset may also name
 * extension tools, which `isSelectableToolName` admits; `powershell` remains
 * the shell alias and is stored as `bash`.
 */
export const CUSTOM_TOOL_PRESET_TOOLS: readonly string[] = CANONICAL_CODING_TOOLS;

export { CANONICAL_CODING_TOOLS } from './tool-presets';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface CustomToolPreset {
  id: string;
  name: string;
  /**
   * Whether installed extension tools the preset does not name stay active.
   * Missing in an older file means true, the behavior those presets had.
   */
  includeExtensions: boolean;
  tools: string[];
}

export interface CustomToolPresetDocument {
  version: typeof CUSTOM_TOOL_PRESETS_VERSION;
  presets: CustomToolPreset[];
}

/** A new preset id, unique enough for one user's list. */
export function makeCustomToolPresetId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  // A UUID can start with a digit; the id pattern wants a letter or underscore first.
  return uuid ? `p${uuid.replaceAll('-', '')}` : `p${Date.now().toString(36)}`;
}

/** The selected names, deduplicated, coding tools first and `powershell` as `bash`. */
export function normalizeCustomPresetTools(tools: unknown): string[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const selected = new Set<string>();
  for (const tool of tools) {
    if (typeof tool !== 'string') return undefined;
    const name = tool === 'powershell' ? 'bash' : tool;
    if (!isSelectableToolName(name)) return undefined;
    selected.add(name);
  }
  // An empty combination is not stored: Chat only is the built-in preset for that.
  if (selected.size === 0) return undefined;
  return sortToolNames([...selected]);
}

/** Trimmed and length-checked, so a name is never whitespace or over the limit. */
export function normalizeCustomPresetName(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined;
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= CUSTOM_TOOL_PRESET_NAME_MAX ? trimmed : undefined;
}

function parsePresetId(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > CUSTOM_TOOL_PRESET_ID_MAX) {
    return undefined;
  }
  return ID_PATTERN.test(value) ? value : undefined;
}

/**
 * The valid presets of a parsed document, or undefined when the value is not one.
 * Unknown fields are dropped; duplicate ids and case-insensitive duplicate names
 * are rejected rather than silently merged, so an id always names one preset and
 * the dropdown never shows two entries under one name.
 */
export function parseCustomToolPresetDocument(value: unknown): CustomToolPreset[] | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as { version?: unknown; presets?: unknown };
  if (candidate.version !== CUSTOM_TOOL_PRESETS_VERSION || !Array.isArray(candidate.presets)) {
    return undefined;
  }
  if (candidate.presets.length > CUSTOM_TOOL_PRESET_MAX_COUNT) return undefined;

  const ids = new Set<string>();
  const names = new Set<string>();
  const presets: CustomToolPreset[] = [];
  for (const entry of candidate.presets) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const fields = entry as Record<string, unknown>;
    const id = parsePresetId(fields.id);
    const name = normalizeCustomPresetName(fields.name);
    const tools = normalizeCustomPresetTools(fields.tools);
    const includeExtensions = fields.includeExtensions;
    if (includeExtensions !== undefined && typeof includeExtensions !== 'boolean') return undefined;
    if (id === undefined || name === undefined || tools === undefined) return undefined;
    const idKey = id.toLowerCase();
    const nameKey = name.toLowerCase();
    if (ids.has(idKey) || names.has(nameKey)) return undefined;
    ids.add(idKey);
    names.add(nameKey);
    presets.push({ id, name, tools, includeExtensions: includeExtensions ?? true });
  }
  return presets;
}

/** Throwing form for API routes: the message is the diagnostic of a 400 refusal. */
export function validateCustomToolPresetDocument(value: unknown): CustomToolPreset[] {
  const presets = parseCustomToolPresetDocument(value);
  if (presets === undefined) {
    throw new Error(
      `Expected a tool preset document: { version: ${CUSTOM_TOOL_PRESETS_VERSION}, presets: [{ id, name, tools, includeExtensions? }] } with at most ${CUSTOM_TOOL_PRESET_MAX_COUNT} presets, unique ids and names, non-empty names up to ${CUSTOM_TOOL_PRESET_NAME_MAX} characters, and non-empty lists of valid tool names`
    );
  }
  return presets;
}

/** Whether `name` is usable for the preset with `id` in `presets` (case-insensitive uniqueness). */
export function customPresetNameError(
  presets: readonly CustomToolPreset[],
  id: string,
  name: string
): 'required' | 'too-long' | 'taken' | undefined {
  const normalized = name.trim();
  if (normalized.length === 0) return 'required';
  if (normalized.length > CUSTOM_TOOL_PRESET_NAME_MAX) return 'too-long';
  const key = normalized.toLowerCase();
  const taken = presets.some(
    (preset) => preset.id !== id && preset.name.trim().toLowerCase() === key
  );
  return taken ? 'taken' : undefined;
}
