/**
 * Live chat sessions are project work, just like queued tasks.
 *
 * The queue database cannot see a conversation the person starts by hand, so
 * this module overlays the runtime session registry onto the queue summaries.
 * A running chat makes its project active in the board without pretending the
 * stored queue state changed: pausing a queue is still a queue decision, while
 * chat work remains live beside it.
 */
import { projectIdentityKey } from '../project-identity';
import {
  getAwaitingInputRpcSessionIds,
  getRpcSessionInfos,
  getRunningRpcSessionIds
} from '../rpc-manager';
import { activeTaskSessionIds } from './active-sessions';
import { isQueuedTaskPrompt } from './prompt';
import type { SessionInfo } from '../types';
import { emptyProjectSummary } from './projects';
import type { TaskActiveSession, TaskProjectSummary } from './types';

export interface RunningProjectSession extends TaskActiveSession {
  projectKey: string;
  cwd: string;
  modified: string;
}

function sessionTitle(session: SessionInfo): string {
  return (
    session.name?.trim() ||
    (session.messageCount > 0 ? session.firstMessage?.trim() : '') ||
    'Chat'
  );
}

/** Every chat session currently executing, grouped by its project key. */
export function runningProjectSessions(): RunningProjectSession[] {
  const running = new Set(getRunningRpcSessionIds());
  if (running.size === 0) return [];
  const taskSessions = new Set(activeTaskSessionIds());
  const awaiting = new Set(getAwaitingInputRpcSessionIds());
  return getRpcSessionInfos({ includeTransient: true })
    .filter(
      (session) =>
        running.has(session.id) &&
        !taskSessions.has(session.id) &&
        !isQueuedTaskPrompt(session.firstMessage)
    )
    .map((session) => ({
      sessionId: session.id,
      title: sessionTitle(session),
      awaiting: awaiting.has(session.id),
      projectKey: projectIdentityKey(session.cwd),
      cwd: session.cwd,
      modified: session.modified
    }))
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

/**
 * Add the live chat work to every project. A project that only exists because a
 * conversation is running is included, so the board can open it by default.
 */
export function withSessionActivity(
  projects: TaskProjectSummary[],
  sessions: RunningProjectSession[]
): TaskProjectSummary[] {
  const byKey = new Map(projects.map((project) => [project.projectKey, { ...project }]));
  for (const session of sessions) {
    let project = byKey.get(session.projectKey);
    if (!project) {
      project = emptyProjectSummary(session.cwd);
      byKey.set(session.projectKey, project);
    }
    project.activeSessions.push({
      sessionId: session.sessionId,
      title: session.title,
      awaiting: session.awaiting
    });
    if (!project.updatedAt || session.modified > project.updatedAt) {
      project.updatedAt = session.modified;
    }
  }
  return [...byKey.values()];
}
