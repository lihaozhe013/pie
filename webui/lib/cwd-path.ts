import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

/**
 * One spelling for a working directory: `~`, `~/dev/x`, and relative paths all
 * become absolute. The chat shell and the task queue resolve a candidate the
 * same way, so a directory the picker offers is the directory a task records.
 */
export function normalizeCwd(cwd: string): string {
  if (cwd === '~') return homedir();
  if (cwd.startsWith('~/')) return resolve(homedir(), cwd.slice(2));
  return isAbsolute(cwd) ? cwd : resolve(cwd);
}
