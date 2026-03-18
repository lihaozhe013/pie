/**
 * Session ids the queue is currently driving.
 *
 * The board uses this set to keep a running task's session in its task row
 * instead of listing it as chat work. It is informational: the session is an
 * ordinary SDK session and accepts prompts or steering while the task runs.
 */

const KEY: symbol = Symbol.for('pie:task-active-sessions');

function registry(): Set<string> {
  const host = globalThis as typeof globalThis & { [KEY]?: Set<string> };
  return (host[KEY] ??= new Set());
}

export function markTaskSessionActive(sessionId: string): void {
  if (sessionId) registry().add(sessionId);
}

export function clearTaskSessionActive(sessionId: string): void {
  registry().delete(sessionId);
}

export function activeTaskSessionIds(): string[] {
  return [...registry()];
}
