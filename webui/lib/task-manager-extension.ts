/**
 * The orchestrator's queue tool.
 *
 * The tool is one callable surface over `lib/tasks/agent-tools.ts`, loaded only
 * for a session on the Orchestrator preset. It is scoped to the session's own
 * project: there is no cwd argument, and a task id from another project is
 * refused. The extension also owns the watch that wakes an idle session.
 */
// pi-ai 1.5 stopped re-exporting TypeBox; see `lib/ask-user-extension.ts`.
import { Type } from 'typebox';
import {
  defineTool,
  type ExtensionContext,
  type InlineExtension
} from '@earendil-works/pi-coding-agent';
import { registerSessionLivenessProvider } from './session-liveness';
import {
  formatTaskEventDigest,
  formatTaskToolResult,
  TASK_MANAGER_TOOL_NAME,
  TaskTools,
  type TaskToolResult,
  type TaskWatchBudget
} from './tasks/agent-tools';
import {
  getTaskOrchestrator,
  listTaskProjects
} from './tasks/orchestrator';
import { getTaskQueue } from './tasks/queue';
import { TASK_EVENT_PAGE_LIMIT, getTaskStore } from './tasks/store';

export const TASK_MANAGER_EXTENSION_NAME = 'pie-task-manager';

/** The custom message a wake or a replay appends to the transcript. */
export const TASK_EVENT_CUSTOM_TYPE = 'pie-task-event';

/** One poll per 1.5 s: the same design the board uses, not a second transport. */
export const TASK_WATCH_POLL_MS = 1_500;
/** A watch ends after this many wakes... */
export const TASK_WATCH_MAX_WAKES = 100;
/** ...or this much wall-clock time, whichever comes first. */
export const TASK_WATCH_MAX_DURATION_MS = 2 * 60 * 60 * 1000;
/** How many events a restart replay summarises, so a long absence stays one digest. */
export const TASK_WATCH_REPLAY_LIMIT = 20;

const TASK_STATUS_SCHEMA = Type.Union([
  Type.Literal('PENDING'),
  Type.Literal('IN_PROGRESS'),
  Type.Literal('DONE'),
  Type.Literal('BLOCKED'),
  Type.Literal('FAILED')
]);

const TASK_ACTION_SCHEMA = Type.Union([
  Type.Literal('list'),
  Type.Literal('create'),
  Type.Literal('update'),
  Type.Literal('move'),
  Type.Literal('delete'),
  Type.Literal('start'),
  Type.Literal('pause'),
  Type.Literal('resume'),
  Type.Literal('abort'),
  Type.Literal('retry'),
  Type.Literal('mark_done'),
  Type.Literal('answer'),
  Type.Literal('events'),
  Type.Literal('watch')
]);

const GUIDELINES = [
  'This tool manages only the current project: the session working directory is the queue identity. There is no cwd argument, and ids from another project are refused. Read or change every task through this tool.',
  'Create tasks with a description and, when you know them, verification commands. The cwd is this session directory. A task without a way to check itself may be reported back as blocked.',
  'One queued task runs at a time in this project; a chat session may run beside it, and the queue waits for a running chat before claiming its next task. Different projects may run concurrently.',
  'Starting the queue turns the watch on. Results and events cover this project only; other projects are not yours to inspect or control.',
  'Ask the user before deleting a task, aborting a run, or marking work done without a run, and pass confirm: true only after they agree.',
  'A queue event digest is a snapshot, and a wake arrives when the turn allows it. Call action: "list" before you answer, and trust the tool over any text.'
];

export interface TaskManagerExtensionOptions {
  /** Tests shorten the poll; a session uses the documented 1.5 s. */
  pollMs?: number;
  maxWakes?: number;
  maxDurationMs?: number;
  now?: () => number;
}

interface ActiveWatch {
  sessionId: string;
  sessionFile: string | undefined;
  cwd: string;
  projectKey: string;
  startedAt: number;
  timer: ReturnType<typeof setInterval>;
  releaseLiveness: () => void;
  /** A wake only wakes an idle session; a busy one gets it at its next prompt. */
  isIdle: () => boolean;
  /** Whether this watch has seen the queue busy; only then does idle end it. */
  sawWork: boolean;
}

interface WatchOutcome {
  ok: boolean;
  code?: string;
  error?: string;
  watch?: TaskWatchBudget & { sessionId: string };
}

function toolsFor(sessionId: string, cwd: string): TaskTools {
  const store = getTaskStore();
  return new TaskTools({
    queue: getTaskQueue(),
    store,
    orchestratorFor: (projectKey, projectCwd) => getTaskOrchestrator(projectKey, projectCwd),
    sessionId,
    cwd
  });
}

function toolsForContext(ctx: ExtensionContext): TaskTools {
  return toolsFor(ctx.sessionManager.getSessionId(), ctx.cwd);
}

function respond(result: TaskToolResult) {
  return {
    content: [{ type: 'text' as const, text: formatTaskToolResult(result) }],
    details: result
  };
}

export function createTaskManagerExtension(
  options: TaskManagerExtensionOptions = {}
): InlineExtension {
  const pollMs = options.pollMs ?? TASK_WATCH_POLL_MS;
  const maxWakes = options.maxWakes ?? TASK_WATCH_MAX_WAKES;
  const maxDurationMs = options.maxDurationMs ?? TASK_WATCH_MAX_DURATION_MS;
  const now = options.now ?? (() => Date.now());

  return {
    name: TASK_MANAGER_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      const store = () => getTaskStore();
      let watch: ActiveWatch | null = null;

      const snapshot = (cwd: string, sessionId: string) =>
        toolsFor(sessionId, cwd).projectsSnapshot();

      const budget = (): TaskWatchBudget => {
        const row = store().getWatch();
        return {
          wakes: row?.wakes ?? 0,
          maxWakes,
          startedAt: row?.startedAt ?? new Date(now()).toISOString(),
          maxDurationMs
        };
      };

      const watchFacts = (): WatchOutcome => {
        const row = store().getWatch();
        if (!row) return { ok: true, watch: undefined };
        return {
          ok: true,
          watch: {
            sessionId: row.sessionId,
            startedAt: row.startedAt,
            wakes: row.wakes,
            maxWakes,
            maxDurationMs
          }
        };
      };

      const queueHasWork = (projectKey: string): boolean =>
        getTaskQueue()
          .listTasks(projectKey)
          .some((task) => task.status === 'PENDING' || task.status === 'IN_PROGRESS');

      const queueIsIdle = (projectKey: string): boolean =>
        !queueHasWork(projectKey) &&
        (listTaskProjects(store()).find((project) => project.projectKey === projectKey)?.state ??
          'IDLE') === 'IDLE';

      /** Release the timer and the liveness provider, then forget the row. */
      const stopWatch = (sessionId: string): void => {
        if (watch && watch.sessionId === sessionId) {
          clearInterval(watch.timer);
          watch.releaseLiveness();
          watch = null;
        }
        store().clearWatch(sessionId);
      };

      /**
       * Stop and leave a note in the transcript. The note never starts a turn:
       * ending a watch is bookkeeping, and the digest that came before it is
       * what the model has to answer.
       */
      const endWatch = (sessionId: string, reason: string): void => {
        const row = store().getWatch();
        const wakes = row?.wakes ?? 0;
        stopWatch(sessionId);
        pi.sendMessage({
          customType: TASK_EVENT_CUSTOM_TYPE,
          content: `Task watch ended (${reason}) after ${wakes} of ${maxWakes} wakes. Ask for it again with task_manager action: "watch".`,
          display: true
        });
      };

      /**
       * One poll: read what is new for this project, drop its own calls, and
       * wake once with a digest. Every guard is here so a watcher cannot outlive
       * its budget or keep spending turns on an idle queue.
       */
      const tick = (sessionId: string): void => {
        if (!watch || watch.sessionId !== sessionId) return;
        try {
          // Another session took the row over (this one's row was stale, or a
          // restart cleared it): drop our timer without touching its watch.
          const row = store().getWatch();
          if (!row || row.sessionId !== sessionId) {
            stopWatch(sessionId);
            return;
          }
          if (now() - watch.startedAt >= maxDurationMs) {
            endWatch(sessionId, 'time budget');
            return;
          }
          if (!queueIsIdle(watch.projectKey)) watch.sawWork = true;

          // Peek first: a wake that is not sent (busy session, spent budget) must
          // not consume the events, or the agent's own tool call never sees them.
          const events = store()
            .peekSessionEvents(sessionId, TASK_EVENT_PAGE_LIMIT, watch.projectKey)
            .filter((event) => event.originSessionId !== sessionId);
          if (events.length === 0) {
            // A queue that drained is not worth another poll, and a watch that has
            // never seen work stays put instead of ending the moment it starts.
            if (queueIsIdle(watch.projectKey) && watch.sawWork) endWatch(sessionId, 'queue idle');
            return;
          }

          if (row.wakes >= maxWakes) {
            endWatch(sessionId, 'wake budget');
            return;
          }

          // `followUp` on a streaming session parks the message in the agent's
          // queue until the next prompt, so it arrives late and stale. Wait for
          // the turn to end and this tick will find the events still unseen.
          if (!watch.isIdle()) return;

          const digest = formatTaskEventDigest(events, snapshot(watch.cwd, sessionId), {
            ...budget(),
            wakes: row.wakes + 1,
            at: new Date(now()).toISOString()
          });
          pi.sendMessage(
            { customType: TASK_EVENT_CUSTOM_TYPE, content: digest, display: true },
            { triggerTurn: true, deliverAs: 'followUp' }
          );
          store().setEventCursor(sessionId, events[events.length - 1].id);
          const bumped = store().bumpWatchWakes();

          if ((bumped?.wakes ?? 0) >= maxWakes) {
            endWatch(sessionId, 'wake budget');
            return;
          }
          if (queueIsIdle(watch.projectKey)) endWatch(sessionId, 'queue idle');
        } catch (error) {
          console.warn('[pie] the task watch could not poll the queue:', error);
        }
      };

      const beginWatch = (ctx: ExtensionContext, tools: TaskTools): WatchOutcome => {
        const sessionId = ctx.sessionManager.getSessionId();
        const row = store().getWatch();
        if (row && row.sessionId !== sessionId) {
          const stale = now() - Date.parse(row.startedAt) >= maxDurationMs || row.wakes >= maxWakes;
          if (!stale) {
            return {
              ok: false,
              code: 'watch_held',
              error: `Session ${row.sessionId} is already watching the queue`
            };
          }
        }
        if (watch) stopWatch(watch.sessionId);

        const startedAt = new Date(now()).toISOString();
        store().setWatch(sessionId, startedAt);
        const releaseLiveness = registerSessionLivenessProvider({
          name: 'pie-task-watch',
          sessionId,
          ...(ctx.sessionManager.getSessionFile()
            ? { sessionFile: ctx.sessionManager.getSessionFile() }
            : {}),
          isActive: () => watch !== null && watch.sessionId === sessionId
        });
        const timer = setInterval(() => tick(sessionId), pollMs);
        timer.unref?.();
        watch = {
          sessionId,
          sessionFile: ctx.sessionManager.getSessionFile(),
          cwd: tools.cwd,
          projectKey: tools.projectKey,
          startedAt: now(),
          timer,
          releaseLiveness,
          isIdle: () => ctx.isIdle(),
          sawWork: !queueIsIdle(tools.projectKey)
        };
        return {
          ok: true,
          watch: { sessionId, startedAt, wakes: 0, maxWakes, maxDurationMs }
        };
      };

      /**
       * After a restart nothing is watching, and the backlog is real. Replay one
       * non-triggering digest so the session knows what changed without spending a
       * turn on a queue it is not driving.
       */
      const replay = (ctx: ExtensionContext): void => {
        try {
          const sessionId = ctx.sessionManager.getSessionId();
          const projectKey = toolsForContext(ctx).projectKey;
          const row = store().getWatch();
          if (row?.sessionId === sessionId) {
            // This process has no watch for it: the previous one is gone.
            store().clearWatch(sessionId);
          }
          const cursor = store().getEventCursor(sessionId);
          const page = store().listEventsSince(cursor, TASK_WATCH_REPLAY_LIMIT, projectKey);
          if (page.length === 0) return;
          store().setEventCursor(sessionId, page[page.length - 1].id);
          const events = page.filter((event) => event.originSessionId !== sessionId);
          if (events.length === 0) return;
          pi.sendMessage({
            customType: TASK_EVENT_CUSTOM_TYPE,
            content: `Since this session last read the queue:\n${formatTaskEventDigest(
              events,
              snapshot(ctx.cwd, sessionId)
            )}`,
            display: true
          });
        } catch (error) {
          console.warn('[pie] the orchestrator could not replay the queue:', error);
        }
      };

      pi.on('session_start', (_event, ctx) => {
        replay(ctx);
      });
      pi.on('session_shutdown', (_event, ctx) => {
        const sessionId = ctx.sessionManager.getSessionId();
        if (watch && watch.sessionId === sessionId) stopWatch(sessionId);
      });

      pi.registerTool(
        defineTool({
          name: TASK_MANAGER_TOOL_NAME,
          label: 'Manage this project task queue',
          description:
            'Read and change this project task queue. The queue is the session working directory: tasks created here run here, and other projects are neither read nor changed.',
          promptSnippet: 'Manage this project task queue',
          promptGuidelines: GUIDELINES,
          executionMode: 'sequential',
          parameters: Type.Object({
            action: TASK_ACTION_SCHEMA,
            status: Type.Optional(TASK_STATUS_SCHEMA),
            includeRuns: Type.Optional(
              Type.Boolean({ description: 'With list, include recent run history.' })
            ),
            id: Type.Optional(Type.Number({ description: 'One task id.' })),
            ids: Type.Optional(Type.Array(Type.Number(), { description: 'Several task ids.' })),
            title: Type.Optional(
              Type.String({
                description: 'An explicit label; omit it to use the description first line.'
              })
            ),
            description: Type.Optional(
              Type.String({
                description:
                  'What to do. Its first line becomes the title when title is omitted.'
              })
            ),
            verifyCommands: Type.Optional(
              Type.Union([Type.Array(Type.String()), Type.Null()], {
                description:
                  'Commands that must pass for the task to count as done. Null or omitted uses the queue default.'
              })
            ),
            direction: Type.Optional(Type.Union([Type.Literal('up'), Type.Literal('down')])),
            position: Type.Optional(
              Type.Number({ description: '1-based position among the queued tasks.' })
            ),
            completed: Type.Optional(
              Type.Boolean({ description: 'Delete every finished task in this project.' })
            ),
            confirm: Type.Optional(
              Type.Boolean({
                description:
                  'Required for delete, abort, and mark_done. Pass true only after the user agrees.'
              })
            ),
            note: Type.Optional(Type.String({ description: 'A reason stored with the change.' })),
            answer: Type.Optional(Type.String({ description: 'The answer to a task question.' })),
            cancelled: Type.Optional(
              Type.Boolean({ description: 'Dismiss the question instead of answering.' })
            ),
            afterId: Type.Optional(
              Type.Number({ description: 'Read events after this id instead of the cursor.' })
            ),
            limit: Type.Optional(Type.Number()),
            waitMs: Type.Optional(
              Type.Number({ description: 'Wait up to 50000 ms for a first event.' })
            ),
            watch: Type.Optional(
              Type.Union([Type.Literal('on'), Type.Literal('off'), Type.Literal('status')], {
                description: 'With watch: turn the queue watch on, off, or report it.'
              })
            )
          }),
          async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const tools = toolsForContext(ctx);
            let result: TaskToolResult;
            switch (params.action) {
              case 'list':
                result = await tools.list({
                  status: params.status,
                  includeRuns: params.includeRuns
                });
                break;
              case 'create':
                result = await tools.create({
                  title: params.title,
                  description: params.description ?? null,
                  verifyCommands: params.verifyCommands ?? null
                });
                break;
              case 'update':
                result = await tools.update({
                  id: params.id as number,
                  title: params.title,
                  description: params.description,
                  verifyCommands: params.verifyCommands
                });
                break;
              case 'move':
                result = await tools.move({
                  id: params.id as number,
                  direction: params.direction,
                  position: params.position
                });
                break;
              case 'delete':
                result = await tools.delete({
                  id: params.id,
                  ids: params.ids,
                  completed: params.completed,
                  confirm: params.confirm
                });
                break;
              case 'start':
              case 'pause':
              case 'resume':
              case 'abort':
              case 'retry':
              case 'mark_done':
                result = await tools.control({
                  action: params.action === 'mark_done' ? 'markDone' : params.action,
                  id: params.id,
                  note: params.note,
                  confirm: params.confirm
                });
                break;
              case 'answer':
                result = await tools.answer({
                  id: params.id as number,
                  answer: params.answer,
                  cancelled: params.cancelled
                });
                break;
              case 'events':
                result = await tools.events({
                  afterId: params.afterId,
                  limit: params.limit,
                  waitMs: params.waitMs
                });
                break;
              case 'watch': {
                const sessionId = ctx.sessionManager.getSessionId();
                let outcome: WatchOutcome;
                if (params.watch === 'on') {
                  outcome = beginWatch(ctx, tools);
                } else if (params.watch === 'off') {
                  stopWatch(sessionId);
                  outcome = { ok: true };
                } else {
                  outcome = watchFacts();
                }
                result = {
                  ok: outcome.ok,
                  ...(outcome.code ? { code: outcome.code } : {}),
                  ...(outcome.error ? { error: outcome.error } : {}),
                  projects: tools.projectsSnapshot(),
                  events: [],
                  data: {
                    watching: watch !== null,
                    watch: outcome.watch ?? null,
                    budget: { maxWakes, maxDurationMs, pollMs }
                  }
                };
                break;
              }
              default:
                result = {
                  ok: false,
                  code: 'invalid_input',
                  error: `Unknown action: ${String((params as { action?: unknown }).action)}`,
                  projects: tools.projectsSnapshot(),
                  events: []
                };
            }

            if (result.ok && params.action === 'start') {
              const outcome = beginWatch(ctx, tools);
              result.data = {
                ...(result.data ?? {}),
                watch: outcome.ok
                  ? (outcome.watch ?? { watching: true })
                  : { watching: false, error: outcome.error }
              };
            }
            return respond(result);
          }
        })
      );
    }
  };
}
