/**
 * The queue controller: validation, ordering, and the guards around claims.
 *
 * Every state transition that must survive a race is guarded by the statement in
 * `store.ts`; this module adds the human-facing rules and typed errors so the
 * routes can answer with the documented HTTP codes.
 */
import { realpathSync, statSync } from 'node:fs';
import { normalizeCwd } from '../cwd-path';
import { allowFileRoot, getAllowedFileRoots, isExistingFilePathAllowed } from '../file-access';
import { isPathWithinRoots } from '../path-security';
import { projectIdentityKey } from '../project-identity';
import { getTaskStore, newClaimToken, type TaskStore } from './store';
import { TASK_TITLE_MAX_LENGTH, taskTitleFromDescription } from './title';
import type {
  OrchestratorStatus,
  PendingQuestion,
  QueueState,
  QueueStateRecord,
  TaskCreateInput,
  TaskMoveAction,
  TaskRecord,
  TaskRunRecord,
  TaskSettleInput,
  TaskUpdateInput
} from './types';

export const TASK_DESCRIPTION_MAX_LENGTH = 20_000;
export const TASK_COMMAND_MAX_LENGTH = 2_000;
export const TASK_COMMAND_MAX_COUNT = 20;
export const TASK_OUTPUT_TAIL_MAX_LENGTH = 8_000;

/**
 * A refused directory names the way out. The board's picker and the tool's
 * `authorizeCwd` are the only two ways in, and a caller that sees this message
 * can use the second one without asking a person to click first.
 */
export const TASK_CWD_NOT_ALLOWED_MESSAGE =
  'The working directory is not allowed. Open it once in the task board, or queue the task with authorizeCwd: true.';

/** The canonical path, so an approval covers the directory links point at. */
function realPathOf(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

/** The requested task is running: edit, delete, and reorder are refused. */
export class TaskLockedError extends Error {
  readonly code = 'task_locked';
  constructor(message = 'The running task cannot be changed') {
    super(message);
    this.name = 'TaskLockedError';
  }
}

export class TaskNotFoundError extends Error {
  readonly code = 'task_not_found';
  constructor(message = 'Task not found') {
    super(message);
    this.name = 'TaskNotFoundError';
  }
}

export class TaskInputError extends Error {
  readonly code = 'invalid_input';
  constructor(message: string) {
    super(message);
    this.name = 'TaskInputError';
  }
}

/** The requested move cannot apply to this task's status. */
export class TaskMoveError extends Error {
  readonly code = 'task_not_pending';
  constructor(message = 'Only a queued task can be reordered') {
    super(message);
    this.name = 'TaskMoveError';
  }
}

export interface TaskQueueOptions {
  now?: () => Date;
  /** Injectable root set for tests; defaults to the app's file-access allow-list. */
  allowedRoots?: () => Promise<Set<string>> | Set<string>;
}

function cleanTitle(value: unknown): string {
  const title = typeof value === 'string' ? value.trim() : '';
  if (!title) throw new TaskInputError('A title or description is required');
  if (title.length > TASK_TITLE_MAX_LENGTH) {
    throw new TaskInputError(`The title must be at most ${TASK_TITLE_MAX_LENGTH} characters`);
  }
  return title;
}

function cleanDescription(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new TaskInputError('The description must be a string');
  const description = value.trim();
  if (!description) return null;
  if (description.length > TASK_DESCRIPTION_MAX_LENGTH) {
    throw new TaskInputError(
      `The description must be at most ${TASK_DESCRIPTION_MAX_LENGTH} characters`
    );
  }
  return description;
}

function cleanCommands(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new TaskInputError('verify_commands must be an array of strings');
  }
  const commands = value.map((entry) => entry.trim()).filter(Boolean);
  if (commands.length > TASK_COMMAND_MAX_COUNT) {
    throw new TaskInputError(
      `verify_commands must hold at most ${TASK_COMMAND_MAX_COUNT} commands`
    );
  }
  for (const command of commands) {
    if (command.length > TASK_COMMAND_MAX_LENGTH) {
      throw new TaskInputError(
        `Each verification command must be at most ${TASK_COMMAND_MAX_LENGTH} characters`
      );
    }
  }
  return commands;
}

export function clipOutputTail(text: string, limit = TASK_OUTPUT_TAIL_MAX_LENGTH): string {
  if (text.length <= limit) return text;
  return `…${text.slice(text.length - limit)}`;
}

/** The project identity a working directory belongs to. */
export function projectKeyOfCwd(cwd: string): string {
  return projectIdentityKey(normalizeCwd(cwd));
}

export class TaskQueue {
  readonly store: TaskStore;
  private readonly now: () => Date;
  private readonly allowedRoots: () => Promise<Set<string>> | Set<string>;

  constructor(store: TaskStore, options: TaskQueueOptions = {}) {
    this.store = store;
    this.now = options.now ?? (() => new Date());
    this.allowedRoots = options.allowedRoots ?? getAllowedFileRoots;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  /**
   * A working directory must exist and stay inside the same allow-list the file
   * routes use. No other client-supplied path is accepted anywhere in the queue.
   *
   * `authorize` is only ever set from a tool call, after the person named the
   * directory; it records the approval for the next process instead of asking
   * the person to click through the board first.
   */
  async validateCwd(cwd: unknown, options: { authorize?: boolean } = {}): Promise<string> {
    if (typeof cwd !== 'string' || !cwd.trim()) {
      throw new TaskInputError('A working directory is required');
    }
    const target = normalizeCwd(cwd.trim());
    let stats;
    try {
      stats = statSync(target);
    } catch {
      throw new TaskInputError('The working directory does not exist');
    }
    if (!stats.isDirectory()) throw new TaskInputError('The working directory must be a directory');
    const roots = await this.allowedRoots();
    if (isExistingFilePathAllowed(target, roots) || this.usesOwnTaskCwd(target)) return target;
    if (options.authorize === true) {
      allowFileRoot(realPathOf(target));
      return target;
    }
    throw new TaskInputError(TASK_CWD_NOT_ALLOWED_MESSAGE);
  }

  /**
   * A directory the queue already stores on a task was authorized when that task
   * was queued, so it stays authorized after a restart, before any file route
   * has looked at it. The trust is the queue's own durable rows.
   */
  private usesOwnTaskCwd(target: string): boolean {
    const roots = new Set(this.store.listTasks().map((task) => task.cwd));
    return roots.size > 0 && isPathWithinRoots(target, roots);
  }

  listTasks(projectKey?: string): TaskRecord[] {
    return this.store.listTasks(projectKey);
  }

  getTask(id: number): TaskRecord {
    const task = this.store.getTask(id);
    if (!task) throw new TaskNotFoundError();
    return task;
  }

  listRuns(projectKey?: string, limit?: number): TaskRunRecord[] {
    return this.store.listRuns(projectKey, limit);
  }

  listRunsForTask(id: number): TaskRunRecord[] {
    return this.store.listRunsForTask(id);
  }

  getQueueState(projectKey: string, cwd = ''): QueueStateRecord {
    return this.store.getQueueState(projectKey, cwd);
  }

  setQueueState(
    projectKey: string,
    cwd: string,
    patch: Partial<Pick<QueueStateRecord, 'state' | 'pausedReason' | 'activeTaskId'>>,
    originSessionId?: string | null
  ): QueueStateRecord {
    return this.store.setQueueState(projectKey, cwd, patch, originSessionId);
  }

  async createTask(input: TaskCreateInput): Promise<TaskRecord> {
    const description = cleanDescription(input?.description);
    const title = cleanTitle(input?.title || taskTitleFromDescription(description));
    const cwd = await this.validateCwd(input?.cwd, { authorize: input?.authorizeCwd === true });
    const projectKey = projectKeyOfCwd(cwd);
    return this.store.insertTask({
      title,
      description,
      projectKey,
      cwd,
      rank: this.store.nextRank(projectKey),
      verifyCommands: cleanCommands(input?.verifyCommands),
      createdBy: input?.createdBy ?? null,
      now: this.timestamp()
    });
  }

  async updateTask(id: number, input: TaskUpdateInput): Promise<TaskRecord> {
    const current = this.getTask(id);
    if (current.status === 'IN_PROGRESS') throw new TaskLockedError();

    const fields: Parameters<TaskStore['updateTaskFields']>[1] = {};
    if (input?.description !== undefined) {
      const description = cleanDescription(input.description);
      fields.description = description;
      // The board has no separate title field: the first line of the new
      // description becomes the label unless a caller supplied one.
      if (input.title === undefined && description) {
        fields.title = taskTitleFromDescription(description);
      }
    }
    if (input?.title !== undefined) fields.title = cleanTitle(input.title);
    if (input?.cwd !== undefined) {
      const cwd = await this.validateCwd(input.cwd, { authorize: input?.authorizeCwd === true });
      const projectKey = projectKeyOfCwd(cwd);
      fields.cwd = cwd;
      if (projectKey !== current.projectKey) {
        fields.projectKey = projectKey;
        fields.rank = this.store.nextRank(projectKey);
      }
    }
    if (input?.verifyCommands !== undefined) {
      fields.verifyCommands = cleanCommands(input.verifyCommands);
    }
    const updated = this.store.updateTaskFields(id, fields);
    if (!updated) {
      // Lost a race with a claim between the read and the guarded update.
      throw this.getTask(id).status === 'IN_PROGRESS'
        ? new TaskLockedError()
        : new TaskNotFoundError();
    }
    if (updated.projectKey !== current.projectKey) {
      this.store.clearProjectStateIfEmpty(current.projectKey, current.cwd);
    }
    return updated;
  }

  deleteTask(id: number): void {
    const current = this.store.getTask(id);
    if (!current) throw new TaskNotFoundError();
    if (current.status === 'IN_PROGRESS') throw new TaskLockedError();
    if (!this.store.deleteTask(id)) {
      throw this.store.getTask(id)?.status === 'IN_PROGRESS'
        ? new TaskLockedError()
        : new TaskNotFoundError();
    }
  }

  /**
   * Reorder inside the pending segment. Up and down swap with the adjacent
   * pending task; a position is 1-based within the pending segment.
   */
  moveTask(id: number, action: TaskMoveAction): TaskRecord[] {
    const current = this.getTask(id);
    if (current.status !== 'PENDING') throw new TaskMoveError();

    const projectKey = current.projectKey;
    const pending = this.store.pendingTasks(projectKey);
    const index = pending.findIndex((task) => task.id === id);
    if (index < 0) throw new TaskMoveError();

    let targetIndex = index;
    if (typeof action?.position === 'number') {
      if (!Number.isFinite(action.position)) throw new TaskInputError('position must be a number');
      targetIndex = Math.min(Math.max(Math.trunc(action.position) - 1, 0), pending.length - 1);
    } else if (action?.direction === 'up') {
      targetIndex = Math.max(index - 1, 0);
    } else if (action?.direction === 'down') {
      targetIndex = Math.min(index + 1, pending.length - 1);
    } else {
      throw new TaskInputError('A move needs a direction or a position');
    }

    if (targetIndex !== index) {
      const ordered = pending.map((task) => task.id);
      const [moved] = ordered.splice(index, 1);
      ordered.splice(targetIndex, 0, moved);
      this.store.rewritePendingRanks(projectKey, ordered);
    }
    return this.listTasks(projectKey);
  }

  /**
   * Claim the next task and open a session for it. The claim asserts that no
   * other row is running, so the serial invariant does not depend on the loop.
   */
  claimNext(projectKey: string, sessionId: string): TaskRecord | null {
    return this.store.claimNextPending(projectKey, newClaimToken(), sessionId);
  }

  attachSession(id: number, sessionId: string): void {
    this.store.attachSession(id, sessionId);
  }

  setPendingQuestion(id: number, question: PendingQuestion | null): void {
    this.store.setPendingQuestion(id, question);
  }

  /** Record the answer and clear the pending question in one transaction. */
  resolveQuestion(
    id: number,
    input: { answer?: string; cancelled?: boolean; originSessionId?: string | null }
  ): void {
    this.store.resolveQuestion(id, input);
  }

  settle(id: number, token: string, input: TaskSettleInput): TaskRecord {
    const settled = this.store.settleTask(id, token, input);
    if (!settled) {
      throw new TaskLockedError('The task is no longer owned by this run');
    }
    return settled;
  }

  retryTask(id: number, originSessionId?: string | null): TaskRecord {
    const task = this.getTask(id);
    if (task.status !== 'BLOCKED' && task.status !== 'FAILED') {
      throw new TaskInputError('Only a blocked or failed task can be retried');
    }
    const retried = this.store.retryTask(id, originSessionId);
    if (!retried) throw new TaskLockedError();
    return retried;
  }

  markDone(id: number, note: string | null, originSessionId?: string | null): TaskRecord {
    const task = this.getTask(id);
    if (task.status === 'IN_PROGRESS') throw new TaskLockedError();
    const summary = (note?.trim() || task.resultSummary) ?? 'marked done by hand';
    const done = this.store.markTaskDone(
      id,
      summary.slice(0, TASK_OUTPUT_TAIL_MAX_LENGTH),
      originSessionId
    );
    if (!done) throw new TaskLockedError();
    return done;
  }

  /** A restart finds this project's interrupted rows and blocks them. */
  recoverInterrupted(projectKey: string): TaskRecord[] {
    return this.store.recoverInterrupted(
      projectKey,
      'orchestrator restarted during the run'
    );
  }

  status(projectKey: string, cwd: string, running: boolean): Omit<OrchestratorStatus, 'activity'> {
    const state = this.store.getQueueState(projectKey, cwd);
    return {
      projectKey,
      cwd: state.cwd,
      state: state.state as QueueState,
      pausedReason: state.pausedReason,
      activeTaskId: state.activeTaskId,
      activeSessions: [],
      running
    };
  }
}

declare global {
  var __pieTaskQueue: TaskQueue | undefined;
}

/** One controller per process, recreated when the store singleton changes. */
export function getTaskQueue(): TaskQueue {
  const store = getTaskStore();
  if (!globalThis.__pieTaskQueue || globalThis.__pieTaskQueue.store !== store) {
    globalThis.__pieTaskQueue = new TaskQueue(store);
  }
  return globalThis.__pieTaskQueue;
}
