export interface ToolEntry {
  name: string;
  description: string;
  active: boolean;
  /** Active, but left out of requests: the model calls it only from codemode scripts. */
  declarationHidden?: boolean;
  parameters?: Record<string, unknown>;
  promptGuidelines?: string[];
  exposure?: string;
  sourceInfo?: {
    path?: string;
    source?: string;
    scope?: string;
    origin?: string;
  };
}

/**
 * A tool name a preset or a session selection may name: a Pi tool, an inline
 * Pie tool, a goal tool, or an MCP tool. Names are plain identifiers, not
 * shell text; the upper bound keeps a corrupt file from making huge rows.
 */
export const SELECTABLE_TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export function isSelectableToolName(value: unknown): value is string {
  return typeof value === 'string' && SELECTABLE_TOOL_NAME_PATTERN.test(value);
}

/** Coding tools first in their canonical order, then the other names alphabetically. */
export function sortToolNames(names: readonly string[]): string[] {
  const order = new Map(CANONICAL_CODING_TOOLS.map((name, index) => [name, index]));
  return [...new Set(names)].sort((left, right) => {
    const leftIndex = order.get(left);
    const rightIndex = order.get(right);
    if (leftIndex !== undefined || rightIndex !== undefined) {
      return (leftIndex ?? Number.MAX_SAFE_INTEGER) - (rightIndex ?? Number.MAX_SAFE_INTEGER);
    }
    return left.localeCompare(right);
  });
}

/** Presets that pin an explicit tool list onto the session. */
export const CONCRETE_TOOL_PRESET_VALUES = ['none', 'read-only', 'default', 'full'] as const;
export type ConcreteToolPreset = (typeof CONCRETE_TOOL_PRESET_VALUES)[number];

/**
 * "configured" is not a tool list: it means "send no override", so pi resolves the
 * loadout from settings.json defaultTools exactly like the `pi` CLI does. Sessions
 * left on it stay unpinned and keep following the setting as it changes.
 */
export const CONFIGURED_TOOL_PRESET = 'configured';

/**
 * "plan" pins the read-only tools like "read-only" does, and additionally stores a work
 * mode: the agent discusses and asks questions instead of implementing. The two cannot be
 * told apart by tool names, so the mode is persisted separately (`lib/work-mode.ts`).
 */
export const PLAN_TOOL_PRESET = 'plan';
/**
 * The task queue's autonomous preset. It pins the same coding tools as `full`,
 * but carries a work mode: the agent must decide for itself, may not ask, and
 * keeps working until the goal reports completion.
 */
export const AUTONOMOUS_TOOL_PRESET = 'autonomous';
/**
 * The queue operator preset. It pins the full coding toolset and adds the one
 * `task_manager` tool, scoped to the session's own project.
 */
export const ORCHESTRATOR_TOOL_PRESET = 'orchestrator';
export const TOOL_PRESET_VALUES = [
  'configured',
  PLAN_TOOL_PRESET,
  AUTONOMOUS_TOOL_PRESET,
  ORCHESTRATOR_TOOL_PRESET,
  'none',
  'read-only',
  'default',
  'full'
] as const;
export type ToolPreset = (typeof TOOL_PRESET_VALUES)[number];

/**
 * How a pinned session treats tools it did not name. `all` is Pi's historical
 * extension behavior: a preset replaces the coding tools and installed
 * extension tools stay available. `selected` is the custom-preset behavior:
 * only the named coding and extension tools are active.
 */
export type SessionExtensionToolsPolicy = 'all' | 'selected';

/**
 * The extension tools Pie ships or loads itself. A session's live tool list is
 * still authoritative; this list is the Settings fallback and the order the
 * editor uses. `task_manager` is opt-in because its extension is only loaded
 * when the preset names it or the session is on Orchestrator.
 */
export const PIE_EXTENSION_TOOL_NAMES = [
  'ask_user',
  'task_manager',
  'codemode',
  'tool_search',
  'get_goal',
  'update_goal',
  'goal_resume',
  'release_workflow',
  'get_background_activity'
] as const;

export const PRESET_NONE: string[] = [];
export const PRESET_READ_ONLY: string[] = ['read', 'grep', 'find', 'ls'];
export const PRESET_DEFAULT: string[] = ['read', 'bash', 'edit', 'write'];
export const PRESET_FULL: string[] = ['bash', 'read', 'edit', 'write', 'grep', 'find', 'ls'];

const BUILTIN_TOOL_NAMES = new Set([...PRESET_FULL, 'powershell']);

/** The canonical coding tool names a custom preset may combine (`powershell` is a platform shell alias). */
export const CANONICAL_CODING_TOOLS: readonly string[] = PRESET_FULL;

export function isToolPreset(value: unknown): value is ToolPreset {
  return typeof value === 'string' && (TOOL_PRESET_VALUES as readonly string[]).includes(value);
}

export function isConcreteToolPreset(value: unknown): value is ConcreteToolPreset {
  return (
    typeof value === 'string' && (CONCRETE_TOOL_PRESET_VALUES as readonly string[]).includes(value)
  );
}

export function getPresetFromTools(tools: ToolEntry[]): ConcreteToolPreset {
  const activeTools = tools.filter((t) => t.active);
  return getPresetFromToolNames(activeTools.map((tool) => tool.name));
}

function canonicalCodingToolKey(toolNames: readonly string[]): string {
  return toolNames
    .map((name) => (name === 'powershell' ? 'bash' : name))
    .filter((name) => BUILTIN_TOOL_NAMES.has(name))
    .sort()
    .join(',');
}

const CANONICAL_KEY_READ_ONLY = canonicalCodingToolKey(PRESET_READ_ONLY);
const CANONICAL_KEY_DEFAULT = canonicalCodingToolKey(PRESET_DEFAULT);
const CANONICAL_KEY_FULL = canonicalCodingToolKey(PRESET_FULL);

/** All names, not only coding ones, so a custom preset with extension tools matches exactly. */
function canonicalSelectionToolKey(toolNames: readonly string[]): string {
  return toolNames
    .map((name) => (name === 'powershell' ? 'bash' : name))
    .sort()
    .join(',');
}

/** The built-in preset whose tool set is exactly `key`, or undefined for any other list. */
function builtinPresetForKey(key: string): ConcreteToolPreset | undefined {
  if (key === CANONICAL_KEY_READ_ONLY) return 'read-only';
  if (key === CANONICAL_KEY_DEFAULT) return 'default';
  if (key === CANONICAL_KEY_FULL) return 'full';
  return undefined;
}

export function getPresetFromToolNames(toolNames: readonly string[]): ConcreteToolPreset {
  if (toolNames.length === 0) return 'none';
  return builtinPresetForKey(canonicalCodingToolKey(toolNames)) ?? 'default';
}

/** Undefined means "no explicit selection": let pi resolve settings.json defaultTools. */
export function getToolNamesForPreset(preset: ToolPreset): string[] | undefined {
  if (preset === CONFIGURED_TOOL_PRESET) return undefined;
  if (preset === PLAN_TOOL_PRESET) return [...PRESET_READ_ONLY];
  if (preset === AUTONOMOUS_TOOL_PRESET || preset === ORCHESTRATOR_TOOL_PRESET)
    return [...PRESET_FULL];
  if (preset === 'none') return [...PRESET_NONE];
  if (preset === 'read-only') return [...PRESET_READ_ONLY];
  if (preset === 'full') return [...PRESET_FULL];
  return [...PRESET_DEFAULT];
}

/** The work mode a preset turns on, or undefined when the session has no special mode. */
export function getWorkModeForPreset(
  preset: ToolPresetSelection
): 'plan' | 'autonomous' | 'orchestrator' | undefined {
  if (preset === PLAN_TOOL_PRESET) return 'plan';
  if (preset === AUTONOMOUS_TOOL_PRESET) return 'autonomous';
  if (preset === ORCHESTRATOR_TOOL_PRESET) return 'orchestrator';
  return undefined;
}

/** A reference to one user-defined preset, as the custom preset list holds it. */
export interface CustomToolPresetRef {
  id: string;
  tools: readonly string[];
  /** Absent means true, as an older preset file does. */
  includeExtensions?: boolean;
}

export const CUSTOM_TOOL_PRESET_PREFIX = 'custom:';

/** A built-in preset or a `custom:<id>` reference into the user's preset list. */
export type ToolPresetSelection = ToolPreset | `${typeof CUSTOM_TOOL_PRESET_PREFIX}${string}`;

export function isToolPresetSelection(value: unknown): value is ToolPresetSelection {
  return (
    isToolPreset(value) ||
    (typeof value === 'string' &&
      value.startsWith(CUSTOM_TOOL_PRESET_PREFIX) &&
      value.length > CUSTOM_TOOL_PRESET_PREFIX.length)
  );
}

/** The `custom:<id>` selection for a preset, so callers never spell the prefix. */
export function customPresetSelection(id: string): ToolPresetSelection {
  return `${CUSTOM_TOOL_PRESET_PREFIX}${id}`;
}

function matchCustomPreset(
  customPresets: readonly CustomToolPresetRef[],
  key: string
): ToolPresetSelection | undefined {
  for (const preset of customPresets) {
    if (canonicalSelectionToolKey(preset.tools) === key) return customPresetSelection(preset.id);
  }
  return undefined;
}

/**
 * The tool list a selection pins, or undefined for "configured": a custom preset that no
 * longer exists (deleted in another window, or cleared with the session still preferring
 * it) resolves that way, so sessions follow the configured defaults again.
 */
/**
 * Whether a selection keeps every installed extension tool active. Built-in
 * presets do; a custom preset chooses, and an older one that predates the
 * choice keeps the old all-extensions behavior.
 */
export function getExtensionToolsPolicyForSelection(
  selection: ToolPresetSelection,
  customPresets: readonly CustomToolPresetRef[] = []
): SessionExtensionToolsPolicy {
  if (!selection.startsWith(CUSTOM_TOOL_PRESET_PREFIX)) return 'all';
  const id = selection.slice(CUSTOM_TOOL_PRESET_PREFIX.length);
  const preset = customPresets.find((candidate) => candidate.id === id);
  return preset?.includeExtensions === false ? 'selected' : 'all';
}

export function getToolNamesForSelection(
  selection: ToolPresetSelection,
  customPresets: readonly CustomToolPresetRef[] = []
): string[] | undefined {
  if (selection.startsWith(CUSTOM_TOOL_PRESET_PREFIX)) {
    const id = selection.slice(CUSTOM_TOOL_PRESET_PREFIX.length);
    const preset = customPresets.find((candidate) => candidate.id === id);
    return preset ? [...preset.tools] : undefined;
  }
  return isToolPreset(selection) ? getToolNamesForPreset(selection) : undefined;
}

/**
 * The preset a session is on. A stored Plan mode wins over the tool names, because Plan pins
 * the same read-only tools as the Read-only preset. A custom preset is recognized by an
 * exact tool-set match against the user's list; unknown lists keep the historical `default`
 * label.
 */
export function getPresetForSession(
  toolNames: readonly string[] | undefined,
  workMode: 'plan' | 'autonomous' | 'orchestrator' | undefined,
  customPresets: readonly CustomToolPresetRef[] = [],
  extensionTools: SessionExtensionToolsPolicy = 'all'
): ToolPresetSelection {
  if (workMode === 'plan') return PLAN_TOOL_PRESET;
  if (workMode === 'autonomous') return AUTONOMOUS_TOOL_PRESET;
  if (workMode === 'orchestrator') return ORCHESTRATOR_TOOL_PRESET;
  if (toolNames === undefined) return CONFIGURED_TOOL_PRESET;
  if (toolNames.length === 0) return 'none';
  const fullCustom = matchCustomPreset(customPresets, canonicalSelectionToolKey(toolNames));
  const codingCustom =
    extensionTools === 'all'
      ? matchCustomPreset(customPresets, canonicalCodingToolKey(toolNames))
      : undefined;
  const custom = fullCustom ?? codingCustom;
  // A selected-only custom preset may use exactly a built-in coding list; it is still custom.
  if (extensionTools === 'selected' && custom) return custom;
  return builtinPresetForKey(canonicalCodingToolKey(toolNames)) ?? custom ?? 'default';
}
