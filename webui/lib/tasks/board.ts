/**
 * Pure helpers for the task board. Keeping them out of the component makes the
 * ordering and question rules testable without a browser.
 */
import { ASK_USER_OTHER_LABEL } from '../ask-user-labels';
import { projectIdentityKey } from '../project-identity';
import { isQueuedTaskPrompt } from './prompt';
import type { ExtensionUiRequest, SessionInfo } from '../types';
import type {
  OrchestratorStatus,
  TaskConfig,
  TaskProjectSummary,
  TaskRecord,
  TaskRunRecord,
  TaskStatus,
  TaskWatchRecord
} from './types';

export interface TaskQueuePayload {
  /** The project this board is reading; null before any project exists. */
  project: { projectKey: string; cwd: string } | null;
  tasks: TaskRecord[];
  runs: TaskRunRecord[];
  orchestrator: OrchestratorStatus | null;
  /** Every project's queue, for the project switcher and its running marks. */
  projects: TaskProjectSummary[];
  config: TaskConfig;
  /** The session watching the queues, when one is. */
  watch?: TaskWatchRecord | null;
}

export interface TaskGroups {
  running: TaskRecord[];
  queued: TaskRecord[];
  blocked: TaskRecord[];
  done: TaskRecord[];
}

/** A live conversation is project work too; the board shows it beside queued tasks. */
export interface ChatTask {
  session: SessionInfo;
  title: string;
  running: boolean;
  awaiting: boolean;
  status: TaskStatus;
}

/** How many conversations the board keeps visible without the chat sidebar. */
export const CHAT_TASK_LIMIT = 30;

/**
 * The project's live conversations that the queue does not already represent.
 * Task sessions own their session rows, so they are filtered out to keep one
 * row per piece of work, and only running or input-waiting conversations stay:
 * the board is the queue, so idle conversations go back to the chat sidebar
 * and finished work appears only in the Finished drawer.
 */
export function chatTasksForProject(
  sessions: readonly SessionInfo[],
  input: {
    projectKey: string | null;
    linkedSessionIds: ReadonlySet<string>;
    runningIds: ReadonlySet<string>;
    awaitingIds: ReadonlySet<string>;
    limit?: number;
  }
): ChatTask[] {
  if (!input.projectKey) return [];
  const rows = sessions
    .filter((session) => {
      if (input.linkedSessionIds.has(session.id)) return false;
      if (isQueuedTaskPrompt(session.firstMessage)) return false;
      return (session.projectKey || projectIdentityKey(session.cwd)) === input.projectKey;
    })
    .map((session): ChatTask => {
      const running = input.runningIds.has(session.id);
      const awaiting = input.awaitingIds.has(session.id);
      return {
        session,
        title:
          session.name?.trim() ||
          (session.messageCount > 0 ? session.firstMessage?.trim() : '') ||
          '',
        running,
        awaiting,
        status: running ? 'IN_PROGRESS' : 'BLOCKED'
      };
    })
    .filter((chat) => chat.running || chat.awaiting)
    .sort(
      (a, b) =>
        Number(b.running) - Number(a.running) ||
        b.session.modified.localeCompare(a.session.modified) ||
        a.session.id.localeCompare(b.session.id)
    );
  return rows.slice(0, input.limit ?? CHAT_TASK_LIMIT);
}

export function isTaskLocked(task: Pick<TaskRecord, 'status'>): boolean {
  return task.status === 'IN_PROGRESS';
}

/** The queue board groups every status into four readable sections. */
export function groupTasks(tasks: TaskRecord[]): TaskGroups {
  const groups: TaskGroups = { running: [], queued: [], blocked: [], done: [] };
  for (const task of tasks) {
    if (task.status === 'IN_PROGRESS') groups.running.push(task);
    else if (task.status === 'PENDING') groups.queued.push(task);
    else if (task.status === 'DONE') groups.done.push(task);
    else groups.blocked.push(task);
  }
  const byRank = (a: TaskRecord, b: TaskRecord) => a.rank - b.rank || a.id - b.id;
  groups.queued.sort(byRank);
  return groups;
}

/**
 * The pending order after moving one task. Returns null when the task is not
 * pending or the move does nothing, so the caller sends no request.
 */
export function reorderPending(
  tasks: TaskRecord[],
  taskId: number,
  direction: 'up' | 'down'
): number[] | null {
  const pending = tasks
    .filter((task) => task.status === 'PENDING')
    .sort((a, b) => a.rank - b.rank || a.id - b.id);
  const index = pending.findIndex((task) => task.id === taskId);
  if (index < 0) return null;
  const target = direction === 'up' ? index - 1 : index + 1;
  if (target < 0 || target >= pending.length) return null;
  const ordered = pending.map((task) => task.id);
  const [moved] = ordered.splice(index, 1);
  ordered.splice(target, 0, moved);
  return ordered;
}

/**
 * The one primary queue action: start from idle, pause while the loop runs,
 * resume after a pause. Stopping the active task is a separate destructive
 * control, so this never returns `abort`.
 */
export function queuePrimaryAction(
  status: OrchestratorStatus | null
): 'start' | 'pause' | 'resume' {
  if (!status) return 'start';
  if (status.state === 'PAUSED') return 'resume';
  if (status.state === 'RUNNING' && status.running) return 'pause';
  return 'start';
}

/**
 * An `ask_user` question rendered by the existing AskUserPanel. Its request
 * shape is the same one the chat host uses, so the panel is not duplicated.
 */
export function questionRequestFor(task: TaskRecord): ExtensionUiRequest | null {
  const question = task.pendingQuestion;
  if (!question) return null;
  return {
    type: 'extension_ui_request',
    id: `task-${task.id}-${question.requestId}`,
    method: question.options.length > 0 ? 'select' : 'input',
    title: question.question,
    options: question.options.length > 0 ? [...question.options, ASK_USER_OTHER_LABEL] : undefined,
    question: { options: question.options }
  } as ExtensionUiRequest;
}

/**
 * Where the detail pane belongs. The side column needs desktop room; the sheet
 * needs an explicit open because it covers the board. A draft opens either one
 * before any task exists, which is how the very first task gets made.
 */
export function detailPlacement(options: {
  overlay: boolean;
  hasTask: boolean;
  hasDraft: boolean;
  sheetOpen: boolean;
}): 'side' | 'sheet' | 'none' {
  if (!options.hasTask && !options.hasDraft) return 'none';
  if (!options.overlay) return 'side';
  return options.sheetOpen || options.hasDraft ? 'sheet' : 'none';
}

/**
 * The ids between two rows, inclusive, in the order they are shown. A target
 * that is not in the list (a filtered or removed row) selects only itself.
 */
export function rangeSelection(order: number[], fromId: number, toId: number): number[] {
  const from = order.indexOf(fromId);
  const to = order.indexOf(toId);
  if (from < 0 || to < 0) return [toId];
  return order.slice(Math.min(from, to), Math.max(from, to) + 1);
}

/** Ids of the tasks a "remove completed" action would delete. */
export function completedTaskIds(tasks: Pick<TaskRecord, 'id' | 'status'>[]): number[] {
  return tasks.filter((task) => task.status === 'DONE').map((task) => task.id);
}

export function taskElapsedMs(task: TaskRecord, now = Date.now()): number | null {
  const start = task.runStartedAt ?? task.updatedAt;
  const end = task.finishedAt ?? (task.status === 'IN_PROGRESS' ? null : task.updatedAt);
  const startMs = Date.parse(start);
  if (!Number.isFinite(startMs)) return null;
  const endMs = end ? Date.parse(end) : now;
  if (!Number.isFinite(endMs)) return null;
  return Math.max(0, endMs - startMs);
}

/** A task runs its verification commands only when the list is not empty. */
export function hasVerification(task: TaskRecord, config: TaskConfig): boolean {
  return (task.verifyCommands ?? config.verifyCommands).length > 0;
}

/** The last path segment of a project root, for display beside the queue. */
export function projectLabelFromPath(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, '');
  if (!trimmed) return root;
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return index >= 0 ? trimmed.slice(index + 1) || trimmed : trimmed;
}
