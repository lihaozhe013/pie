/**
 * One task attempt, executed by the same in-process Pi SDK session chat uses.
 *
 * The runner owns the conversation with one SDK session: it starts the session
 * with the task's preset, sends the prompt (or a goal in autonomous mode),
 * tracks what the agent is doing for the board, answers an `ask_user` dialog,
 * and reports one outcome. The orchestrator owns the database and the queue.
 */
import { readGoalFacts, goalCommand, MAX_GOAL_OBJECTIVE_CHARS } from '../goal-driver';
import { getToolNamesForPreset, AUTONOMOUS_TOOL_PRESET } from '../tool-presets';
import type { WorkMode } from '../work-mode';
import type { AgentSessionWrapper } from '../rpc-manager';
import type { TaskActivity, TaskActivityKind, TaskAnswerInput, PendingQuestion } from './types';

export type TaskRunStatus = 'succeeded' | 'failed' | 'timeout' | 'aborted';

export interface TaskRunOutcome {
  status: TaskRunStatus;
  /** The SDK session has no process exit code; successful runs report 0. */
  exitCode: number | null;
  /** A short human-readable report for the board. */
  summary: string;
  outputTail: string;
  sessionId: string;
}

export interface TaskRunRequest {
  taskId: number;
  prompt: string;
  cwd: string;
  /** The queue's model for this run; omitted, the SDK uses Pi's default. */
  model?: { provider: string; modelId: string } | null;
  sessionId: string;
  sessionName: string;
  /** True uses the Autonomous preset, omits ask_user, and starts a goal. */
  autonomous: boolean;
  /** Appended to the session's system prompt; empty adds nothing. */
  systemPromptAppend?: string | null;
  /** `null` leaves the run without a watchdog. */
  timeoutMs: number | null;
  now?: () => Date;
  onActivity?: (activity: TaskActivity) => void;
  onQuestion?: (question: PendingQuestion | null) => void;
  onOutput?: (tail: string) => void;
}

export interface TaskRunHandle {
  sessionId: string;
  result: Promise<TaskRunOutcome>;
  answer(input: TaskAnswerInput): Promise<void>;
  abort(): Promise<void>;
  activity(): TaskActivity | null;
  output(): string;
}

/** How long an abort waits for the SDK to settle before forcing the session down. */
export const TASK_ABORT_GRACE_MS = 5_000;

const SUMMARY_LIMIT = 4_000;
const TASK_TAIL_LIMIT = 64 * 1024;
const TOOL_READ = new Set(['read', 'ls', 'grep', 'find', 'glob']);
const TOOL_WRITE = new Set(['write', 'edit', 'apply_patch', 'patch']);

class NoPendingQuestionError extends Error {
  readonly code = 'no_pending_question';
  constructor() {
    super('The task has no pending question');
    this.name = 'NoPendingQuestionError';
  }
}

function assistantText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const record = message as { role?: unknown; content?: unknown };
  if (record.role !== 'assistant' || !Array.isArray(record.content)) return '';
  return record.content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        Boolean(block) &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
    )
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function toolDetail(name: string, args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const record = args as Record<string, unknown>;
  void name;
  for (const key of ['file_path', 'filePath', 'path', 'command', 'pattern', 'query']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 160);
  }
  return null;
}

function activityKindForTool(name: string): TaskActivityKind {
  if (TOOL_WRITE.has(name)) return 'writing';
  if (TOOL_READ.has(name)) return 'reading';
  return 'running';
}

function appendTail(current: string, text: string): string {
  const next = current + text;
  return next.length <= TASK_TAIL_LIMIT ? next : next.slice(next.length - TASK_TAIL_LIMIT);
}

function clipSummary(text: string): string {
  return text.length <= SUMMARY_LIMIT ? text : `${text.slice(0, SUMMARY_LIMIT)}…`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** The objective a goal gets: the task prompt, clipped to the package's limit. */
function goalObjective(prompt: string): string {
  return prompt.length <= MAX_GOAL_OBJECTIVE_CHARS
    ? prompt
    : `${prompt.slice(0, MAX_GOAL_OBJECTIVE_CHARS - 1)}…`;
}

export function startTaskRun(request: TaskRunRequest): TaskRunHandle {
  const now = request.now ?? (() => new Date());
  let session: AgentSessionWrapper | null = null;
  let unsubscribe: (() => void) | null = null;
  let latestActivity: TaskActivity | null = null;
  let pendingQuestion: PendingQuestion | null = null;
  let outputTail = '';
  let lastAssistantText = '';
  let activeSessionId = request.sessionId;
  let abortRequested = false;
  let timedOut = false;
  let finished = false;
  let goalSeen = false;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutKillTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveResult!: (outcome: TaskRunOutcome) => void;

  const result = new Promise<TaskRunOutcome>((resolve) => {
    resolveResult = resolve;
  });

  const setActivity = (kind: TaskActivityKind, detail: string | null) => {
    latestActivity = { taskId: request.taskId, kind, detail, at: now().toISOString() };
    try {
      request.onActivity?.(latestActivity);
    } catch {
      // A board callback must not break the run.
    }
  };

  const setQuestion = (question: PendingQuestion | null) => {
    pendingQuestion = question;
    try {
      request.onQuestion?.(question);
    } catch {
      // A board callback must not break the run.
    }
  };

  const append = (text: string) => {
    if (!text) return;
    outputTail = appendTail(outputTail, text);
    try {
      request.onOutput?.(outputTail);
    } catch {
      // A board callback must not break the run.
    }
  };

  const respond = (id: string, payload: Record<string, unknown>) => {
    void session?.send({ type: 'extension_ui_response', id, ...payload }).catch(() => {
      // The session may have shut down; nothing left to answer.
    });
  };

  const finish = (outcome: TaskRunOutcome) => {
    if (finished) return;
    finished = true;
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (timeoutKillTimer) clearTimeout(timeoutKillTimer);
    unsubscribe?.();
    unsubscribe = null;
    setActivity('waiting', null);
    resolveResult(outcome);
  };

  /**
   * A timed-out agent gets a short graceful abort, then its runtime is destroyed.
   * Without the second step a hung session could keep writing after the queue
   * already settled the task as failed.
   */
  const finishTimeout = () => {
    if (finished) return;
    timedOut = true;
    // Finish first: `finish` unsubscribes, so destroying the session cannot
    // re-enter this handler through its own terminal event.
    finish(outcome('timeout', timeoutSummary(request.timeoutMs)));
    try {
      session?.destroy();
    } catch {
      // The wrapper may already be gone; the result still records the timeout.
    }
  };

  const outcome = (
    status: TaskRunStatus,
    summary: string,
    exitCode: number | null = null
  ): TaskRunOutcome => ({
    status,
    exitCode,
    summary,
    outputTail,
    sessionId: activeSessionId
  });

  const goalFacts = () => {
    if (!session) return undefined;
    try {
      return readGoalFacts(session.inner.sessionManager.getBranch() as never);
    } catch {
      return undefined;
    }
  };

  const settleIfFinished = (record: Record<string, unknown>) => {
    if (record.type !== 'agent_settled') return false;
    const aborted = record.aborted === true;
    if (abortRequested) {
      finish(outcome('aborted', 'aborted by user'));
      return true;
    }
    if (timedOut) {
      finishTimeout();
      return true;
    }
    if (!request.autonomous) {
      if (aborted) {
        finish(outcome('failed', 'The agent stopped before completing the task'));
      } else {
        finish(
          outcome(
            'succeeded',
            clipSummary(lastAssistantText || 'The task finished without a final message'),
            0
          )
        );
      }
      return true;
    }

    const facts = goalFacts();
    if (facts?.status === 'complete') {
      finish(
        outcome(
          'succeeded',
          clipSummary(lastAssistantText || 'The goal completed without a final message'),
          0
        )
      );
      return true;
    }
    if (!facts && goalSeen) {
      finish(outcome('failed', 'The goal was cleared before it completed'));
      return true;
    }
    if (aborted) {
      finish(outcome('failed', 'The goal stopped before completing the task'));
      return true;
    }
    // A goal continuation is queued. Keep the task running; only its completion
    // (or the watchdog/abort) settles it.
    return false;
  };

  const handleUiRequest = (record: Record<string, unknown>) => {
    const id = typeof record.id === 'string' ? record.id : null;
    if (!id) return;
    const method = record.method;
    const title = typeof record.title === 'string' ? record.title : '';
    const metadata =
      record.question && typeof record.question === 'object'
        ? (record.question as { options?: unknown })
        : null;
    if (!metadata || (method !== 'select' && method !== 'input')) {
      // Only ask_user is rendered on the task board. Any other extension dialog
      // receives the same "no one can answer" treatment a task always gave it.
      respond(id, { cancelled: true });
      return;
    }
    const options = Array.isArray(metadata.options)
      ? metadata.options.filter((option): option is string => typeof option === 'string')
      : [];
    setQuestion({
      requestId: id,
      question: title,
      options,
      awaitingInput: false,
      askedAt: now().toISOString()
    });
    append(`\n[question] ${title}\n`);
  };

  const handleEvent = (record: Record<string, unknown>) => {
    const type = record.type;
    if (type === 'extension_ui_request') {
      handleUiRequest(record);
      return;
    }
    if (type === 'extension_ui_closed') {
      const id = typeof record.id === 'string' ? record.id : null;
      if (id && pendingQuestion?.requestId === id) {
        setQuestion(null);
        append('\n[question] closed\n');
      }
      return;
    }
    if (type === 'entry_appended') {
      const facts = goalFacts();
      if (facts) goalSeen = true;
      return;
    }
    if (type === 'agent_start') {
      setActivity('waiting', null);
      return;
    }
    if (type === 'message_start') {
      const message = record.message as { role?: unknown } | undefined;
      if (message?.role === 'assistant') setActivity('waiting', null);
      return;
    }
    if (type === 'message_update') {
      const update = record.assistantMessageEvent as
        | { type?: unknown; delta?: unknown; toolCall?: { toolName?: unknown } }
        | undefined;
      const updateType = update && typeof update.type === 'string' ? update.type : undefined;
      if (updateType && updateType.startsWith('thinking')) {
        setActivity('thinking', null);
      } else if (updateType && updateType.startsWith('text')) {
        setActivity('thinking', null);
        if (typeof update?.delta === 'string') append(update.delta);
      } else if (updateType === 'toolcall_end') {
        const name = update?.toolCall?.toolName;
        if (typeof name === 'string') setActivity(activityKindForTool(name), name);
      }
      return;
    }
    if (type === 'tool_execution_start') {
      const name = typeof record.toolName === 'string' ? record.toolName : 'tool';
      setActivity(activityKindForTool(name), toolDetail(name, record.args));
      append(`\n[${name}] ${toolDetail(name, record.args) ?? ''}\n`);
      return;
    }
    if (type === 'message_end') {
      const text = assistantText(record.message);
      if (text) {
        lastAssistantText = text;
        append(`\n${text}\n`);
      }
      setActivity('waiting', null);
      return;
    }
    if (type === 'agent_end') {
      setActivity('waiting', null);
      return;
    }
    if (type === 'agent_settled') {
      settleIfFinished(record);
    }
  };

  const abortSession = async () => {
    if (!session) return;
    try {
      await session.send({ type: 'abort' });
    } catch {
      // The session may already have settled.
    }
  };

  const run = async () => {
    try {
      const { startRpcSession } = await import('../rpc-manager');
      const started = await startRpcSession(request.sessionId, '', request.cwd, {
        newSessionId: request.sessionId,
        toolNames: getToolNamesForPreset(
          request.autonomous ? AUTONOMOUS_TOOL_PRESET : 'full'
        ),
        ...(request.autonomous ? { mode: 'autonomous' as WorkMode } : {}),
        ...(request.model ? { initialModel: request.model } : {}),
        ...(request.systemPromptAppend?.trim()
          ? { systemPromptAppend: request.systemPromptAppend }
          : {}),
        askUser: !request.autonomous
      });
      session = started.session;
      activeSessionId = started.realSessionId || session.sessionId || request.sessionId;
      unsubscribe = session.onEvent(handleEvent);
      await session.waitUntilReady();

      if (abortRequested) {
        await abortSession();
        finish(outcome('aborted', 'aborted by user'));
        return;
      }

      try {
        await session.send({ type: 'set_session_name', name: request.sessionName });
      } catch {
        // A title is a convenience; the task does not depend on it.
      }

      if (request.autonomous) {
        const commandResult = (await session.send({ type: 'get_commands' })) as {
          commands?: Array<{ name?: unknown }>;
        };
        const goalAvailable = (commandResult?.commands ?? []).some(
          (command) => command.name === 'goal'
        );
        if (!goalAvailable) {
          finish(
            outcome(
              'failed',
              'Autonomous mode needs a goal package, but no goal command is registered in this session'
            )
          );
          return;
        }
      }

      if (abortRequested) {
        await abortSession();
        finish(outcome('aborted', 'aborted by user'));
        return;
      }

      setActivity('starting', null);
      if (request.autonomous) {
        await session.send({ type: 'append_user_message', message: request.prompt });
        if (abortRequested) {
          await abortSession();
          finish(outcome('aborted', 'aborted by user'));
          return;
        }
      }
      const kickoff = request.autonomous
        ? goalCommand('start', goalObjective(request.prompt))
        : request.prompt;
      await session.send({ type: 'prompt', message: kickoff });

      if (request.timeoutMs !== null) {
        timeoutTimer = setTimeout(() => {
          if (finished) return;
          timedOut = true;
          void abortSession();
          timeoutKillTimer = setTimeout(finishTimeout, TASK_ABORT_GRACE_MS);
          timeoutKillTimer.unref?.();
        }, Math.max(request.timeoutMs, 0));
        timeoutTimer.unref?.();
      }

      if (abortRequested) await abortSession();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finish(
        outcome(
          abortRequested ? 'aborted' : 'failed',
          abortRequested ? 'aborted by user' : message
        )
      );
      try {
        session?.destroy();
      } catch {
        // A start that failed may have left no wrapper to close.
      }
    }
  };

  void run();

  return {
    sessionId: activeSessionId,
    result,
    async answer(input: TaskAnswerInput): Promise<void> {
      const question = pendingQuestion;
      if (!question) throw new NoPendingQuestionError();
      const answer = typeof input.answer === 'string' ? input.answer.trim() : '';
      if (input.cancelled) {
        respond(question.requestId, { cancelled: true });
        setQuestion(null);
        append('\n[question] dismissed\n');
        return;
      }
      if (!answer) throw new Error('An answer is required');
      // The inline ask_user card sends an option or typed text in one response;
      // this is the same value the chat view's question card delivers.
      respond(question.requestId, { value: answer });
      setQuestion(null);
      append(`\n[answer] ${answer}\n`);
    },
    async abort(): Promise<void> {
      abortRequested = true;
      await abortSession();
      const forced = delay(TASK_ABORT_GRACE_MS);
      await Promise.race([result, forced]);
      if (!finished) {
        finish(outcome('aborted', 'aborted by user'));
        try {
          session?.destroy();
        } catch {
          // The wrapper may already be gone.
        }
      }
    },
    activity(): TaskActivity | null {
      return latestActivity;
    },
    output(): string {
      return outputTail;
    }
  };
}

function timeoutSummary(timeoutMs: number | null): string {
  const ms = timeoutMs ?? 0;
  if (ms < 60_000) {
    const seconds = Math.max(1, Math.round(ms / 1_000));
    return `The task did not finish within ${seconds} seconds`;
  }
  const minutes = Math.round(ms / 60_000);
  return `The task did not finish within ${minutes} minutes`;
}
