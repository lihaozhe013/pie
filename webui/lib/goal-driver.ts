/**
 * Pie's whole contract with an installed Pi goal package.
 *
 * An autonomous goal is not implemented here: an installed package
 * (`pi-better-goal`, or `pi-codex-goal`) owns the continuation loop, the token
 * budget, the completion report and the pause rules. Pie reads one status
 * word from the package's session entries and sends `/goal …` back, so the
 * goal dialog needs a status, an objective and five commands instead of a goal
 * engine. Whatever a package adds on top — tasks, drafts, auditors, permission
 * holds — is deliberately not read here.
 */

/**
 * The extension status key carrying {@link GoalBridge} to the browser: the live
 * session publishes it, and the composer reads it without a separate route.
 */
export const GOAL_STATUS_KEY = 'pie-goal';

/**
 * The session entry types this bridge reads. Both packages write `set` and
 * `clear` records under their own type; `pi-better-goal` also writes
 * `continuation-state` records there, and still understands `pi-codex-goal`
 * entries from sessions that used the older package.
 */
export const GOAL_ENTRY_TYPES: readonly string[] = ['pi-better-goal', 'pi-codex-goal'];

/** The command both packages register for `/goal …`. */
export const GOAL_COMMAND_NAME = 'goal';

/**
 * The status and widget keys the packages publish beside Pie's own bridge.
 * The goal dialog already reports the goal, so those duplicates stay out of the
 * status bar and the widget row.
 */
export const GOAL_PACKAGE_KEYS: readonly string[] = ['pi-better-goal', 'codex-goal'];

/** Whether a status or widget key belongs to the goal Pie itself reports. */
export function isGoalSurfaceKey(key: string): boolean {
  return key === GOAL_STATUS_KEY || GOAL_PACKAGE_KEYS.includes(key);
}

/**
 * How far a goal has come, in the only three shapes the composer shows. A
 * package may add status words; an unknown one is treated as waiting, because
 * the goal exists and can still be paused or resumed.
 */
export type GoalPhase = 'running' | 'waiting' | 'done';

/** What the package last said about its goal. */
export interface GoalFacts {
  /** The package's own status word, shown as written when it is not one we know. */
  status: string;
  /** The objective the package is working toward. */
  objective: string;
  /** Tokens the package has counted for this goal, when it reports them. */
  tokensUsed?: number;
  /** The budget the goal was given, or null when it has none. */
  tokenBudget?: number | null;
}

/** What one live session reports about goals. */
export interface GoalBridge {
  /** The package's `/goal` command is registered in this session. */
  available: boolean;
  goal?: GoalFacts;
}

/** The commands the goal dialog sends, as the packages parse them. */
export type GoalAction = 'start' | 'pause' | 'resume' | 'complete' | 'clear';

/** The package rejects longer objectives; stay below it so a long prompt still works. */
export const MAX_GOAL_OBJECTIVE_CHARS = 4000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isGoalEntry(entry: unknown): boolean {
  return (
    isRecord(entry) &&
    entry.type === 'custom' &&
    typeof entry.customType === 'string' &&
    GOAL_ENTRY_TYPES.includes(entry.customType)
  );
}

function factFrom(value: unknown): GoalFacts | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.status !== 'string' || value.status === '') return undefined;
  const facts: GoalFacts = {
    status: value.status,
    objective: typeof value.objective === 'string' ? value.objective : ''
  };
  // Usage is what the package counted, not something Pie estimates; a package
  // that does not report it leaves the numbers out instead of showing zeros.
  const usage = isRecord(value.usage) ? value.usage.tokensUsed : undefined;
  if (typeof usage === 'number' && Number.isFinite(usage) && usage >= 0) {
    facts.tokensUsed = usage;
  }
  if (typeof value.tokenBudget === 'number' && Number.isFinite(value.tokenBudget)) {
    facts.tokenBudget = value.tokenBudget;
  } else if (value.tokenBudget === null) {
    facts.tokenBudget = null;
  }
  return facts;
}

/**
 * The latest goal on the branch: a `set` record writes it, a `clear` record
 * retracts it, and the package's other record kinds say nothing about it.
 * A goal the session never had, or one written in a shape we cannot read, is
 * absent rather than guessed.
 */
export function readGoalFacts(entries: readonly unknown[]): GoalFacts | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isGoalEntry(entry) || !isRecord(entry)) continue;
    if (!isRecord(entry.data)) continue;
    if (entry.data.kind === 'clear') return undefined;
    if (entry.data.kind !== 'set') continue;
    return factFrom(entry.data.goal);
  }
  return undefined;
}

/** Where the goal stands, for the dialog's three states. */
export function goalPhase(goal: GoalFacts | undefined): GoalPhase | undefined {
  if (!goal) return undefined;
  if (goal.status === 'complete') return 'done';
  if (goal.status === 'active') return 'running';
  return 'waiting';
}

/** The click the goal entry sends, given where the goal stands now. */
export function goalToggleAction(goal: GoalFacts | undefined): GoalAction {
  const phase = goalPhase(goal);
  if (phase === 'running') return 'pause';
  if (phase === 'waiting') return 'resume';
  if (phase === 'done') return 'clear';
  return 'start';
}

/** The `/goal` invocation for one click, as the package parses it. */
export function goalCommand(action: GoalAction, objective = ''): string {
  switch (action) {
    case 'start':
      return `/goal ${objective}`;
    case 'pause':
      return '/goal pause';
    case 'resume':
      return '/goal resume';
    case 'complete':
      return '/goal complete';
    case 'clear':
      return '/goal clear';
  }
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) =>
      isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : ''
    )
    .filter(Boolean)
    .join('\n');
}

/**
 * The objective a start falls back to: the message the person last wrote, for a
 * start that was not given one. Slash commands are skipped — the packages read a leading command as a workflow
 * binding, not as an objective — and a session with nothing to work on has no
 * objective at all.
 */
export function lastUserObjective(entries: readonly unknown[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.type !== 'message' || !isRecord(entry.message)) continue;
    if (entry.message.role !== 'user') continue;
    const text = messageText(entry.message.content).trim();
    if (!text || text.startsWith('/')) continue;
    return text.slice(0, MAX_GOAL_OBJECTIVE_CHARS).trim();
  }
  return undefined;
}

/** The status text one live session publishes; always a value, `null` included. */
export function formatGoalBridge(bridge: GoalBridge): string {
  return JSON.stringify(
    bridge.goal
      ? { available: bridge.available, goal: bridge.goal }
      : { available: bridge.available }
  );
}

/**
 * Read the published status back. A missing or unreadable value means "nothing
 * was published", which is different from a session that has no goal.
 */
export function parseGoalBridge(text: string | undefined): GoalBridge | undefined {
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const goal = factFrom(parsed.goal);
  return goal
    ? { available: parsed.available === true, goal }
    : { available: parsed.available === true };
}
