/**
 * The queue asks the chat runtime whether a project is busy without importing
 * it. The runtime registers the check when it loads; a queue used without the
 * chat runtime (a CLI probe or a unit) simply sees no running chat.
 */
export type BusySessionCheck = (cwd: string) => boolean;

const CHECK_KEY = Symbol.for('pie:busy-session-check');

interface CheckHost {
  [CHECK_KEY]?: BusySessionCheck;
}

export function setBusySessionCheck(check: BusySessionCheck): void {
  (globalThis as CheckHost)[CHECK_KEY] = check;
}

export function hasBusySessionForCwd(cwd: string): boolean {
  const check = (globalThis as CheckHost)[CHECK_KEY];
  return check ? check(cwd) : false;
}
