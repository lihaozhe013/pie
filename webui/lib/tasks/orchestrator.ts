/**
 * One loop per project: claim → run → gate → settle.
 *
 * A project's loop is a per-process singleton plus one `proper-lockfile` lock at
 * `<agentDir>/pie-task-locks/<sha256>.lock`, so two servers cannot drive the
 * same project. Different projects have different locks and different loops:
 * each project stays strictly serial, while projects may run concurrently.
 * Nothing here calls an LLM to decide anything.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import lockfile from 'proper-lockfile';
import { notifyTaskEvent } from '../web-push';
import { getAgentDir } from '../session-reader';
import { projectIdentityKey } from '../project-identity';
import { markTaskSessionActive, clearTaskSessionActive } from './active-sessions';
import { readTaskConfig, resolveTaskPolicy } from './config';
import { runVerificationGate } from './gate';
import { buildTaskPrompt } from './prompt';
import { TaskQueue, clipOutputTail, TaskLockedError } from './queue';
import { getTaskStore, type TaskStore } from './store';
import { startTaskRun, TASK_ABORT_GRACE_MS, type TaskRunHandle, type TaskRunOutcome } from './runner';
import { hasBusySessionForCwd } from './runtime-sessions';
import type { spawn } from 'node:child_process';
import type {
  OrchestratorStatus,
  TaskActivity,
  TaskAnswerInput,
  TaskConfig,
  TaskProjectSummary,
  TaskRecord
} from './types';

/** How much of a failed verification's own output travels with the reason. */
export const VERIFY_REASON_OUTPUT_MAX = 1_200;

/** How often a started queue checks whether a chat session still owns the project. */
export const TASK_QUEUE_IDLE_POLL_MS = 500;

/**
 * The output the command itself printed, normalized to one line ending. It is
 * what makes `exit 1` actionable: "'sleep' is not recognized" says what to fix,
 * and the digest, the tool result, and the board all read the same summary.
 */
function verificationOutput(output: string): string {
  const normalized = output.replace(/\r\n?/g, '\n');
  return clipOutputTail(normalized.trimEnd(), VERIFY_REASON_OUTPUT_MAX);
}

/** The queue state holds one line, so the reason takes the output's first line. */
function firstOutputLine(output: string, limit = 120): string {
  const line = output
    .split('\n')
    .map((candidate) => candidate.trim())
    .find(Boolean);
  if (!line) return '';
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

export type TaskNotificationKind = 'complete' | 'done' | 'blocked' | 'failed' | 'question';

export interface TaskNotification {
  kind: TaskNotificationKind;
  task: Pick<TaskRecord, 'id' | 'title'> | null;
  /** The project whose queue produced this notification. */
  project: { projectKey: string; cwd: string };
  reason?: string;
}

export type TaskNotifier = (notification: TaskNotification) => void | Promise<void>;

export class OrchestratorConflictError extends Error {
  readonly code: string;
  constructor(code: 'already_running' | 'not_running' | 'no_pending_question', message: string) {
    super(message);
    this.name = 'OrchestratorConflictError';
    this.code = code;
  }
}

export interface TaskOrchestratorOptions {
  store?: TaskStore;
  agentDir?: string;
  queue?: TaskQueue;
  /** The queue this instance drives. `cwd` is its display root. */
  projectKey?: string;
  cwd?: string;
  lockPath?: string;
  notifier?: TaskNotifier;
  /** Tests replace the gate process and the clock. */
  spawnFn?: typeof spawn;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export const TASK_LOCK_DIR_NAME = 'pie-task-locks';

/** A stable, filesystem-safe lock per project key. */
export function projectLockPath(
  agentDir: string,
  projectKey: string,
  lockName?: string
): string {
  const name =
    lockName ?? createHash('sha256').update(projectKey).digest('hex').slice(0, 24);
  return join(agentDir, TASK_LOCK_DIR_NAME, `${name}.lock`);
}


async function defaultNotifier(notification: TaskNotification): Promise<void> {
  // The server bundle is a single file and `lib/rpc-manager.ts` already imports web push
  // statically, so there is nothing left to defer; the try/catch keeps notifications best-effort.
  try {
    await notifyTaskEvent(notification);
  } catch {
    // Notifications are best-effort; the queue does not depend on them.
  }
}

interface ActiveRun {
  taskId: number;
  token: string;
  handle: TaskRunHandle;
}

export class TaskOrchestrator {
  readonly queue: TaskQueue;
  readonly projectKey: string;
  readonly cwd: string;
  private readonly agentDir: string;
  private readonly lockPath: string;
  private readonly notifier: TaskNotifier;
  private readonly options: TaskOrchestratorOptions;

  private loop: Promise<void> | null = null;
  private starting = false;
  private stopping = false;
  private releaseLock: (() => Promise<void>) | null = null;
  private activeRun: ActiveRun | null = null;
  private currentActivity: TaskActivity | null = null;

  constructor(options: TaskOrchestratorOptions = {}) {
    this.options = options;
    this.agentDir = options.agentDir ?? getAgentDir();
    this.cwd = options.cwd ?? process.cwd();
    this.projectKey = options.projectKey ?? projectIdentityKey(this.cwd);
    const store = options.store ?? getTaskStore();
    this.queue = options.queue ?? new TaskQueue(store);
    this.lockPath =
      options.lockPath ?? projectLockPath(this.agentDir, this.projectKey);
    this.notifier = options.notifier ?? defaultNotifier;
  }

  get project(): { projectKey: string; cwd: string } {
    return { projectKey: this.projectKey, cwd: this.cwd };
  }

  get running(): boolean {
    return this.loop !== null;
  }

  config(): TaskConfig {
    return readTaskConfig(this.agentDir);
  }

  status(): OrchestratorStatus {
    const state = this.queue.status(this.projectKey, this.cwd, this.running);
    return {
      ...state,
      activeSessions: [],
      activity: this.activeRun ? this.currentActivity : null
    };
  }

  /** The live tail of the active task, or '' when nothing runs. */
  output(taskId: number): string {
    return this.activeRun?.taskId === taskId ? (this.activeRun.handle.output() ?? '') : '';
  }

  private notify(notification: Omit<TaskNotification, 'project'>): void {
    const full: TaskNotification = { ...notification, project: this.project };
    void Promise.resolve()
      .then(() => this.notifier(full))
      .catch(() => {
        // A failed notification never changes a task outcome.
      });
  }

  /**
   * Acquire the lock, recover what the last process left running, and drain the
   * queue. Resolves when the loop stops; routes start it without awaiting.
   */
  start(): Promise<void> {
    if (this.starting || this.loop) {
      return Promise.reject(
        new OrchestratorConflictError('already_running', 'The queue is already running')
      );
    }
    this.starting = true;
    const loop = this.runLoop().finally(() => {
      this.starting = false;
      this.loop = null;
      this.currentActivity = null;
      const release = this.releaseLock;
      this.releaseLock = null;
      if (release) void release().catch(() => {});
    });
    this.loop = loop;
    return loop;
  }

  private async acquireLock(): Promise<void> {
    mkdirSync(dirname(this.lockPath), { recursive: true });
    try {
      const release = await lockfile.lock(this.lockPath, {
        realpath: false,
        stale: 30_000,
        update: 10_000
      });
      this.releaseLock = async () => {
        await release();
      };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'ELOCKED') {
        throw new OrchestratorConflictError(
          'already_running',
          'Another Pie process is driving this project queue'
        );
      }
      throw error;
    }
  }

  private async runLoop(): Promise<void> {
    await this.acquireLock();
    this.stopping = false;
    const recovered = this.queue.recoverInterrupted(this.projectKey);
    if (recovered.length > 0) {
      this.notify({
        kind: 'blocked',
        task: recovered[recovered.length - 1],
        reason: 'orchestrator restarted during the run'
      });
      // A recovered row needs a person: recovery already paused the queue, and
      // clearing that pause here would resume work nobody reviewed.
      return;
    }
    this.queue.setQueueState(this.projectKey, this.cwd, {
      state: 'RUNNING',
      pausedReason: null,
      activeTaskId: null
    });

    try {
      while (!this.stopping) {
        const state = this.queue.getQueueState(this.projectKey, this.cwd);
        if (state.state === 'PAUSED') break;
        // Chat has priority: a queued task starts only while no conversation is
        // running in this project. A chat that starts during a run is allowed
        // to continue beside it; the next claim waits for both to be free.
        const hasPending = this.queue
          .listTasks(this.projectKey)
          .some((task) => task.status === 'PENDING');
        if (hasPending && !(await this.waitForProjectIdle())) break;
        const sessionId = randomUUID();
        let task: TaskRecord | null;
        try {
          task = this.queue.claimNext(this.projectKey, sessionId);
        } catch (error) {
          // The serial invariant was violated; refuse to run two agents.
          const reason = error instanceof Error ? error.message : String(error);
          this.queue.setQueueState(this.projectKey, this.cwd, {
            state: 'PAUSED',
            pausedReason: reason,
            activeTaskId: null
          });
          this.notify({ kind: 'failed', task: null, reason });
          break;
        }
        if (!task) {
          this.queue.setQueueState(this.projectKey, this.cwd, {
            state: 'IDLE',
            activeTaskId: null
          });
          this.notify({ kind: 'complete', task: null });
          break;
        }
        // An abort or pause that arrived between the state check and the claim
        // must not let the task run behind the person's back.
        const afterClaim = this.queue.getQueueState(this.projectKey, this.cwd);
        if (afterClaim.state === 'PAUSED') {
          try {
            this.queue.settle(task.id, task.claimedToken ?? '', {
              status: 'BLOCKED',
              resultSummary: 'aborted by user',
              exitCode: null,
              sessionId: task.sessionId,
              queueState: {
                state: 'PAUSED',
                pausedReason: afterClaim.pausedReason ?? 'aborted by user',
                activeTaskId: null
              }
            });
          } catch {
            // The task was already settled; the pause still stops the loop.
          }
          break;
        }
        this.queue.setQueueState(this.projectKey, this.cwd, {
          state: 'RUNNING',
          activeTaskId: task.id
        });
        let outcome: 'done' | 'stopped';
        try {
          outcome = await this.executeTask(task);
        } catch (error) {
          // A thrown error must never leave a row IN_PROGRESS with no session.
          const reason = error instanceof Error ? error.message : String(error);
          try {
            this.queue.settle(task.id, task.claimedToken ?? '', {
              status: 'FAILED',
              resultSummary: reason.slice(0, 2_000),
              exitCode: null,
              sessionId: task.sessionId,
              queueState: { state: 'PAUSED', pausedReason: reason, activeTaskId: null }
            });
          } catch {
            // Already settled by the run itself.
          }
          this.notify({ kind: 'failed', task, reason });
          break;
        }
        if (outcome === 'done') continue;
        break;
      }
    } finally {
      this.stopping = false;
    }
  }

  /** Resolve with the terminal status this attempt settled as. */
  private async executeTask(task: TaskRecord): Promise<'done' | 'stopped'> {
    const token = task.claimedToken;
    const sessionId = task.sessionId;
    if (!token || !sessionId) {
      throw new Error('the claimed task is missing its token or session id');
    }
    const config = this.config();
    const policy = resolveTaskPolicy(config, task);

    markTaskSessionActive(sessionId);
    this.currentActivity = null;

    const handle = startTaskRun({
      taskId: task.id,
      prompt: buildTaskPrompt({
        task,
        verifyCommands: policy.verifyCommands,
        autonomous: policy.autonomous
      }),
      cwd: task.cwd,
      sessionId,
      model: policy.model,
      sessionName: task.title.replace(/\s+/g, ' ').slice(0, 160),
      autonomous: policy.autonomous,
      systemPromptAppend: policy.instructions,
      timeoutMs: policy.taskTimeoutMs,
      now: this.options.now,
      onActivity: (activity) => {
        this.currentActivity = activity;
      },
      onQuestion: (question) => {
        try {
          this.queue.setPendingQuestion(task.id, question);
        } catch (error) {
          console.warn('[pie] could not persist the task question:', error);
        }
        if (question) {
          this.notify({ kind: 'question', task, reason: question.question });
        }
      }
    });

    this.activeRun = { taskId: task.id, token, handle };
    let outcome: TaskRunOutcome;
    try {
      outcome = await handle.result;
    } finally {
      this.activeRun = null;
      this.currentActivity = null;
      clearTaskSessionActive(sessionId);
    }

    const settle = (input: Parameters<TaskQueue['settle']>[2]) => {
      try {
        this.queue.settle(task.id, token, input);
      } catch (error) {
        if (error instanceof TaskLockedError) return;
        throw error;
      }
    };

    if (outcome.status === 'aborted') {
      settle({
        status: 'BLOCKED',
        resultSummary: 'aborted by user',
        exitCode: outcome.exitCode,
        sessionId,
        outputTail: clipOutputTail(outcome.outputTail),
        queueState: { state: 'PAUSED', pausedReason: 'aborted by user', activeTaskId: null }
      });
      this.notify({ kind: 'blocked', task, reason: 'aborted by user' });
      return 'stopped';
    }

    if (outcome.status === 'timeout') {
      settle({
        status: 'FAILED',
        resultSummary: outcome.summary,
        exitCode: outcome.exitCode,
        sessionId,
        outputTail: clipOutputTail(outcome.outputTail),
        queueState: { state: 'PAUSED', pausedReason: outcome.summary, activeTaskId: null }
      });
      this.notify({ kind: 'failed', task, reason: outcome.summary });
      return 'stopped';
    }

    if (outcome.status === 'failed') {
      settle({
        status: 'FAILED',
        resultSummary: outcome.summary,
        exitCode: outcome.exitCode,
        sessionId,
        outputTail: clipOutputTail(outcome.outputTail),
        queueState: { state: 'PAUSED', pausedReason: outcome.summary, activeTaskId: null }
      });
      this.notify({ kind: 'failed', task, reason: outcome.summary });
      return 'stopped';
    }

    // The agent exited cleanly. The gate decides whether the work counts.
    const gate = await runVerificationGate(policy.verifyCommands, {
      cwd: task.cwd,
      timeoutMs: policy.verifyTimeoutMs,
      platform: this.options.platform,
      spawnFn: this.options.spawnFn,
      env: this.options.env
    });
    if (!gate.ok) {
      const reason = gate.timedOut
        ? `Verification timed out: ${gate.failedCommand ?? 'unknown command'}`
        : `Verification failed (exit ${gate.exitCode ?? 'null'}): ${gate.failedCommand ?? 'unknown command'}`;
      const output = verificationOutput(gate.output);
      const detail = firstOutputLine(output);
      const pausedReason = detail ? `${reason} — ${detail}` : reason;
      settle({
        status: 'BLOCKED',
        resultSummary: clipOutputTail(
          [reason, output ? `Output:\n${output}` : '', outcome.summary]
            .filter(Boolean)
            .join('\n\n'),
          2_000
        ),
        exitCode: outcome.exitCode,
        sessionId,
        verifyExit: gate.exitCode,
        verifyOutput: clipOutputTail(gate.output),
        outputTail: clipOutputTail(outcome.outputTail),
        queueState: { state: 'PAUSED', pausedReason, activeTaskId: null }
      });
      this.notify({ kind: 'blocked', task, reason: pausedReason });
      return 'stopped';
    }

    const verifiedNote =
      policy.verifyCommands.length > 0
        ? `Verification passed (${policy.verifyCommands.length} command${
            policy.verifyCommands.length === 1 ? '' : 's'
          })`
        : null;
    const summary = [outcome.summary, verifiedNote].filter(Boolean).join('\n\n');

    settle({
      status: 'DONE',
      resultSummary: clipOutputTail(summary, 2_000),
      exitCode: outcome.exitCode,
      sessionId,
      verifyExit: 0,
      outputTail: clipOutputTail(outcome.outputTail),
      // State is left as it is: a pause requested during the run must survive
      // the settle, and the loop's next iteration is what reads it.
      queueState: { activeTaskId: null }
    });
    this.notify({ kind: 'done', task, reason: verifiedNote ?? undefined });
    return 'done';
  }

  /**
   * Wait until no chat session is running in this project. The queue loop stays
   * started and holds its lock while waiting, so a pause or shutdown can still
   * stop it between two sleeps. Returns false when it should stop.
   */
  private async waitForProjectIdle(): Promise<boolean> {
    while (!this.stopping) {
      const state = this.queue.getQueueState(this.projectKey, this.cwd);
      if (state.state === 'PAUSED') return false;
      if (!hasBusySessionForCwd(this.cwd)) return true;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, TASK_QUEUE_IDLE_POLL_MS);
      });
    }
    return false;
  }

  /** Take effect between tasks, never mid-run. */
  async pause(reason?: string, originSessionId?: string | null): Promise<OrchestratorStatus> {
    const state = this.queue.getQueueState(this.projectKey, this.cwd);
    if (state.state === 'PAUSED') return this.status();
    this.queue.setQueueState(
      this.projectKey,
      this.cwd,
      {
        state: 'PAUSED',
        pausedReason: reason ?? 'paused by user',
        activeTaskId: state.activeTaskId
      },
      originSessionId
    );
    return this.status();
  }

  async resume(): Promise<OrchestratorStatus> {
    if (this.starting || this.loop) {
      throw new OrchestratorConflictError('already_running', 'The queue is already running');
    }
    this.queue.setQueueState(this.projectKey, this.cwd, {
      state: 'RUNNING',
      pausedReason: null
    });
    void this.start().catch((error) => {
      console.warn('[pie] the task queue could not resume:', error);
      this.queue.setQueueState(this.projectKey, this.cwd, {
        state: 'PAUSED',
        pausedReason: error instanceof Error ? error.message : String(error),
        activeTaskId: null
      });
    });
    return this.status();
  }

  /**
   * Stop the running task for real. The run settles as BLOCKED and the loop
   * pauses, because an abort usually means the task itself is wrong.
   */
  async abort(originSessionId?: string | null): Promise<OrchestratorStatus> {
    const active = this.activeRun;
    this.queue.setQueueState(
      this.projectKey,
      this.cwd,
      { state: 'PAUSED', pausedReason: 'aborted by user' },
      originSessionId
    );
    if (active) {
      await active.handle.abort();
    }
    return this.status();
  }

  async answer(
    taskId: number,
    input: TaskAnswerInput,
    originSessionId?: string | null
  ): Promise<void> {
    const active = this.activeRun;
    const task = this.queue.getTask(taskId);
    if (!active || active.taskId !== taskId || !task.pendingQuestion) {
      throw new OrchestratorConflictError(
        'no_pending_question',
        'The task has no pending question'
      );
    }
    await active.handle.answer(input);
    try {
      this.queue.resolveQuestion(taskId, { ...input, originSessionId });
    } catch (error) {
      // The answer reached the session; a failed bookkeeping write must not undo it.
      console.warn('[pie] could not record the task answer:', error);
    }
  }

  /** Abort the active session and settle its task, so a restart leaves no zombie agent. */
  async shutdown(graceMs = TASK_ABORT_GRACE_MS): Promise<void> {
    this.stopping = true;
    const active = this.activeRun;
    if (active) {
      try {
        await active.handle.abort();
      } catch {
        // The session may already be gone.
      }
    }
    if (this.loop) {
      await Promise.race([
        this.loop.catch(() => {}),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, graceMs);
          timer.unref?.();
        })
      ]);
    }
    const release = this.releaseLock;
    this.releaseLock = null;
    if (release) await release().catch(() => {});
  }
}

declare global {
  var __pieTaskOrchestrators: Map<string, TaskOrchestrator> | undefined;
  var __pieTaskOrchestratorStore: TaskStore | undefined;
  var __pieTaskOrchestratorRecovery: Promise<void> | undefined;
}

/**
 * The project list with the in-process loops overlaid on the stored state. The
 * database says what happened; a live orchestrator also says what is happening
 * between two writes.
 */
export function listTaskProjects(store: TaskStore = getTaskStore()): TaskProjectSummary[] {
  return store.listProjectSummaries().map((project) => {
    const orchestrator = activeTaskOrchestrator(project.projectKey);
    if (!orchestrator) return project;
    const status = orchestrator.status();
    return {
      ...project,
      state: status.state,
      pausedReason: status.pausedReason,
      activeTaskId: status.activeTaskId,
      running: status.running
    };
  });
}

function registry(): Map<string, TaskOrchestrator> {
  return (globalThis.__pieTaskOrchestrators ??= new Map());
}

/**
 * The one orchestrator for a project. Route handlers are bundled separately and
 * hot reload re-evaluates modules, so the registry lives on `globalThis`.
 */
export function getTaskOrchestrator(
  projectKey: string,
  cwd: string,
  options: TaskOrchestratorOptions = {}
): TaskOrchestrator {
  const existing = registry().get(projectKey);
  if (existing) return existing;
  const orchestrator = new TaskOrchestrator({ ...options, projectKey, cwd });
  registry().set(projectKey, orchestrator);
  return orchestrator;
}

export function getTaskOrchestratorForCwd(
  cwd: string,
  options: TaskOrchestratorOptions = {}
): TaskOrchestrator {
  return getTaskOrchestrator(projectIdentityKey(cwd), cwd, options);
}

/** The orchestrator this process already created, without creating one. */
export function activeTaskOrchestrator(projectKey: string): TaskOrchestrator | null {
  return registry().get(projectKey) ?? null;
}

export function activeTaskOrchestrators(): TaskOrchestrator[] {
  return [...registry().values()];
}

/** Only tests reset this. */
export function resetTaskOrchestrator(): void {
  registry().clear();
  globalThis.__pieTaskOrchestratorRecovery = undefined;
}

/**
 * At startup, a queue left RUNNING or a task left IN_PROGRESS belongs to a
 * process that is gone. Recover it only when no live process holds that
 * project's lock: a second server sharing the database must not mark another
 * server's running task as blocked.
 */
export function ensureTaskQueuesRecovered(agentDir: string = getAgentDir()): Promise<void> {
  if (globalThis.__pieTaskOrchestratorRecovery) {
    return globalThis.__pieTaskOrchestratorRecovery;
  }
  const recovery = recoverTaskQueues(agentDir).finally(() => {
    // Keep a successful recovery cached; a failed one can be retried by the
    // next request. The promise below is replaced only on failure.
  });
  globalThis.__pieTaskOrchestratorRecovery = recovery;
  return recovery;
}

async function recoverTaskQueues(agentDir: string): Promise<void> {
  const store = getTaskStore();
  const candidates = store
    .listProjectSummaries()
    .filter(
      (project) => project.activeTaskId !== null || project.state === 'RUNNING'
    )
    .filter((project) => !activeTaskOrchestrator(project.projectKey));
  for (const project of candidates) {
    const lockPath = projectLockPath(agentDir, project.projectKey);
    mkdirSync(dirname(lockPath), { recursive: true });
    let release: (() => Promise<void>) | null = null;
    try {
      release = await lockfile.lock(lockPath, {
        realpath: false,
        stale: 30_000,
        update: 10_000
      });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== 'ELOCKED') {
        console.warn('[pie] could not probe a task queue lock:', error);
      }
      continue;
    }
    try {
      const recovered = store.recoverInterrupted(
        project.projectKey,
        'orchestrator restarted during the run'
      );
      if (recovered.length === 0) {
        const state = store.getQueueState(project.projectKey, project.cwd);
        if (state.state === 'RUNNING') {
          store.setQueueState(project.projectKey, project.cwd, {
            state: 'IDLE',
            pausedReason: null,
            activeTaskId: null
          });
        }
      }
    } catch (error) {
      console.warn('[pie] could not recover a task queue:', error);
    } finally {
      await release().catch(() => {});
    }
  }
}

/** Shutdown hook: abort every active session and settle its task. */
export async function shutdownTaskOrchestrators(): Promise<void> {
  await Promise.allSettled(
    activeTaskOrchestrators().map((orchestrator) => orchestrator.shutdown())
  );
}

/** The old name kept for the instrumentation hook. */
export const shutdownActiveTaskOrchestrator = shutdownTaskOrchestrators;
