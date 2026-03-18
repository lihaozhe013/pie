/**
 * A running chat starts its project's queue.
 *
 * The queue itself must still wait for that chat: starting the loop only makes
 * the project RUNNING and lets the next pending task follow the conversation.
 * A queue that a person explicitly paused is never started by this watcher.
 */
import { getTaskOrchestrator } from './orchestrator';
import { runningProjectSessions } from './session-activity';
import { getTaskStore } from './store';

export const TASK_CHAT_WATCH_MS = 1_000;

const WATCH_KEY = Symbol.for('pie:task-chat-watcher');

interface WatchHost {
  [WATCH_KEY]?: ReturnType<typeof setInterval>;
}

function tick(): void {
  const sessions = runningProjectSessions();
  if (sessions.length === 0) return;
  const projects = getTaskStore().listProjectSummaries();
  const seen = new Set<string>();
  for (const session of sessions) {
    if (seen.has(session.projectKey)) continue;
    seen.add(session.projectKey);
    const project = projects.find((candidate) => candidate.projectKey === session.projectKey);
    if (!project || project.pending === 0 || project.state === 'PAUSED') continue;
    const orchestrator = getTaskOrchestrator(project.projectKey, project.cwd);
    if (orchestrator.running) continue;
    void orchestrator.start().catch((error) => {
      // Another process may hold the project lock. The board still shows the
      // chat; the next tick retries only if that lock is free.
      if ((error as { code?: string }).code !== 'already_running') {
        console.warn('[pie] could not start a queue beside chat:', error);
      }
    });
  }
}

/** Run one process-wide poll; repeated calls (hot reload) reuse the timer. */
export function startTaskChatWatcher(): void {
  const host = globalThis as WatchHost;
  if (host[WATCH_KEY]) return;
  tick();
  const timer = setInterval(tick, TASK_CHAT_WATCH_MS);
  timer.unref?.();
  host[WATCH_KEY] = timer;
}

export function stopTaskChatWatcher(): void {
  const host = globalThis as WatchHost;
  if (!host[WATCH_KEY]) return;
  clearInterval(host[WATCH_KEY]);
  host[WATCH_KEY] = undefined;
}
