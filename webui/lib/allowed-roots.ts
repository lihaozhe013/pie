import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toSlashPath } from './paths';
import { getAgentDir } from './session-reader';

// Roots the person approved, kept beside Pie's other state so an approval made
// by the task board or a file link is still valid after a restart. Stored on
// globalThis as well, so a module reload in development does not drop the cache
// and re-read the file on every request.
declare global {
  var __piAllowedRootsCache: { roots: Set<string>; expiresAt: number } | undefined;
  var __piAdditionalAllowedRoots: Set<string> | undefined;
}

export const ALLOWED_ROOTS_FILE = 'pie-allowed-roots.json';

/**
 * Allowed roots are internal bookkeeping keys that are never displayed, so they
 * are stored slash-normalized for consistent Set membership. Correctness does
 * not depend on it — isPathWithinRoots() re-normalizes whatever it is given.
 */
export function normalizeSlashes(filePath: string): string {
  return toSlashPath(filePath);
}

export function allowedRootsPath(): string {
  return join(getAgentDir(), ALLOWED_ROOTS_FILE);
}

/**
 * An absent, unreadable, or malformed file means "no approvals yet": a damaged
 * file must narrow access, never widen it or break a request.
 */
function readApprovedRoots(): Set<string> {
  const roots = new Set<string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(allowedRootsPath(), 'utf8'));
  } catch {
    return roots;
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { roots?: unknown } | null)?.roots;
  if (!Array.isArray(list)) return roots;
  for (const root of list) {
    if (typeof root === 'string' && root.trim()) roots.add(normalizeSlashes(root));
  }
  return roots;
}

/**
 * The file is a convenience for the next process, not the source of truth for
 * this one, so a failure to write it is not worth failing the request over.
 */
function persistApprovedRoots(roots: Set<string>): void {
  const path = allowedRootsPath();
  try {
    mkdirSync(getAgentDir(), { recursive: true });
    const body = { version: 1, roots: [...roots].sort() };
    writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  } catch {}
}

export function getAdditionalAllowedRoots(): Set<string> {
  if (!globalThis.__piAdditionalAllowedRoots) {
    globalThis.__piAdditionalAllowedRoots = readApprovedRoots();
  }
  return globalThis.__piAdditionalAllowedRoots;
}

export function allowFileRoot(root: string): void {
  if (!root) return;
  const normalizedRoot = normalizeSlashes(root);
  const roots = getAdditionalAllowedRoots();
  const isNew = !roots.has(normalizedRoot);
  roots.add(normalizedRoot);
  globalThis.__piAllowedRootsCache?.roots.add(normalizedRoot);
  if (isNew) persistApprovedRoots(roots);
}

/** Drop both caches so the next read sees what a fresh process would see. */
export function resetAllowedRootsForTests(): void {
  delete globalThis.__piAdditionalAllowedRoots;
  delete globalThis.__piAllowedRootsCache;
}
