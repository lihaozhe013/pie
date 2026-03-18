/**
 * Tool-name predicates shared by the chat views.
 *
 * Pi's built-in names are plain `write` / `edit`, but MCP servers expose the
 * same operations under prefixed or namespaced names, so each predicate also
 * accepts the common decorated forms.
 */

/** `read`, `read_file`, and the same word behind a `_` or `.` separator. */
export function isReadToolName(toolName: string): boolean {
  return /^(?:read(?:_file)?|.*[._]read(?:_file)?)$/i.test(toolName);
}

/**
 * Searching tools: `grep` and `find`. Only the last name segment counts, so a
 * tool named `find_user` or `list_issues` stays a visible card of its own.
 */
const SEARCH_TOOL_NAMES = new Set(['grep', 'find']);

/** Listing tools: `ls` alone, for the same reason as the search names above. */
const LIST_TOOL_NAMES = new Set(['ls']);

function lastSegment(toolName: string): string {
  const name = toolName.toLowerCase().trim();
  return name.split(/[._]/).filter(Boolean).pop() ?? '';
}

export function isSearchToolName(toolName: string): boolean {
  return SEARCH_TOOL_NAMES.has(lastSegment(toolName));
}

export function isListToolName(toolName: string): boolean {
  return LIST_TOOL_NAMES.has(lastSegment(toolName));
}

/** The read-only tools that only gather information for the agent. */
export function isExplorationToolName(toolName: string): boolean {
  return isReadToolName(toolName) || isSearchToolName(toolName) || isListToolName(toolName);
}

export function isWriteToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return (
    name === 'write' ||
    name.startsWith('write_') ||
    name.endsWith('.write') ||
    name.endsWith('_write')
  );
}

export function isEditToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return (
    name === 'edit' ||
    name.startsWith('edit_') ||
    name.endsWith('.edit') ||
    name.endsWith('_edit') ||
    name.includes('str_replace') ||
    name.includes('replace_editor')
  );
}

/**
 * Every call except writes, edits, and patches belongs to the Runs panel. Those
 * keep their transcript cards because their diff and file text are the work
 * itself, not execution log noise.
 */
export function isRunsPanelToolName(toolName: string): boolean {
  return !isWriteToolName(toolName) && !isEditToolName(toolName) && !isApplyPatchToolName(toolName);
}

/** Codex-style patch tools (e.g. the pi-apply-patch extension). */
export function isApplyPatchToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return (
    name === 'apply_patch' ||
    name.startsWith('apply_patch_') ||
    name.endsWith('.apply_patch') ||
    name.endsWith('_apply_patch')
  );
}

/** Recognizes shell tools, including names decorated by extensions. */
const SHELL_TOOL_NAMES = new Set([
  'bash',
  'shell',
  'sh',
  'zsh',
  'powershell',
  'pwsh',
  'cmd',
  'exec',
  'exec_command',
  'run_command',
  'run_shell_command',
  'execute_command',
  'terminal',
  'local_shell'
]);

export function isShellToolName(toolName: string): boolean {
  const name = toolName.toLowerCase().trim();
  const head = name.split(/[\s(]/)[0];
  if (SHELL_TOOL_NAMES.has(head)) return true;
  const tail = head.split(/\.|__/).pop() ?? head;
  if (SHELL_TOOL_NAMES.has(tail)) return true;
  return /(^|[._-])(bash|shell|powershell)([._-]|$)/.test(head);
}
