/**
 * Selecting the project a task-board request is about.
 *
 * The browser names a project by its cwd (`?cwd=...`), the same path the chat
 * sidebar groups by. A project that has no tasks yet is still selectable, so
 * the returned summary is synthesized when the store has never seen it.
 */
import { normalizeCwd } from '../cwd-path';
import { projectKeyOfCwd } from './queue';
import type { TaskProjectSummary } from './types';

export function emptyProjectSummary(cwd: string): TaskProjectSummary {
  return {
    projectKey: projectKeyOfCwd(cwd),
    cwd,
    state: 'IDLE',
    pausedReason: null,
    activeTaskId: null,
    activeTaskTitle: null,
    activeSessions: [],
    running: false,
    pending: 0,
    blocked: 0,
    failed: 0,
    done: 0,
    total: 0,
    updatedAt: null
  };
}

/**
 * The requested project, or the one a fresh task board should open: a running
 * project first, then the most recently touched one. Null only when there is no
 * project and no request.
 */
export function resolveTaskProject(
  projects: TaskProjectSummary[],
  requestedCwd: string | null | undefined
): TaskProjectSummary | null {
  if (requestedCwd && requestedCwd.trim()) {
    const cwd = normalizeCwd(requestedCwd.trim());
    const key = projectKeyOfCwd(cwd);
    const existing = projects.find((project) => project.projectKey === key);
    return existing ? { ...existing, cwd: existing.cwd || cwd } : emptyProjectSummary(cwd);
  }
  // A state row can outlive the tasks that created it, so an empty project is
  // not a default: the board opens a project that still has work to show.
  const populated = projects.filter(
    (project) =>
      project.total > 0 ||
      project.activeTaskId !== null ||
      project.activeSessions.length > 0
  );
  const running = populated.find(
    (project) =>
      project.activeTaskId !== null ||
      project.state === 'RUNNING' ||
      project.activeSessions.length > 0
  );
  if (running) return running;
  return [...populated].sort((a, b) =>
    String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''))
  )[0] ?? null;
}
