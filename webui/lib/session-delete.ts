/** Deletes only requested sessions, closes their runtimes, and preserves surviving forks. */
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { getRpcSession, getRunningRpcSessionIds } from './rpc-manager';
import {
  invalidateSessionListCache,
  invalidateSessionManagerCache,
  invalidateSessionPathCache,
  readSessionHeader,
  resolveSessionPath
} from './session-reader';
import { sessionPathKey } from './session-path';
import { forgetSessionUiState } from './session-ui-state';

/** Most ids one POST /api/sessions/delete takes; the sidebar sends a bigger project in parts. */
export const MAX_SESSION_DELETE_IDS = 500;

export interface SessionDeleteResult {
  /** The requested sessions successfully removed. */
  deleted: string[];
  /** Named ids with neither a file nor a cached path. */
  missing: string[];
  /** Named ids kept because a session of theirs runs (`keepRunning` only). */
  running: string[];
}

export async function deleteSessions(
  ids: readonly string[],
  options: { keepRunning?: boolean } = {}
): Promise<SessionDeleteResult> {
  const targets = new Map<string, string>();
  const missing: string[] = [];
  for (const id of new Set(ids)) {
    const filePath = await resolveSessionPath(id);
    if (filePath) targets.set(id, filePath);
    else missing.push(id);
  }
  if (targets.size === 0) return { deleted: [], missing, running: [] };

  // Read only the bounded headers before deleting.
  const parentPathByKey = new Map<string, string | undefined>();
  for (const filePath of targets.values()) {
    let parentSessionPath: string | undefined;
    try {
      parentSessionPath = readSessionHeader(filePath)?.parentSession;
    } catch (error) {
      // Empty runtime sessions have a cached path before their first disk write.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    parentPathByKey.set(sessionPathKey(filePath), parentSessionPath);
  }

  const runningIds = options.keepRunning ? new Set(getRunningRpcSessionIds()) : new Set<string>();
  const deletedSessionIds = new Set<string>();
  const running: string[] = [];
  for (const id of targets.keys()) {
    if (runningIds.has(id)) {
      running.push(id);
      continue;
    }
    deletedSessionIds.add(id);
  }

  const deletedPaths = new Map<string, string>();
  for (const deletedId of deletedSessionIds) {
    const sessionPath =
      targets.get(deletedId) ??
      getRpcSession(deletedId)?.sessionFile ??
      (await resolveSessionPath(deletedId));
    if (sessionPath) deletedPaths.set(deletedId, sessionPath);
  }
  const deletedPathKeys = new Map(
    [...deletedPaths.values()].map((path) => [sessionPathKey(path), path])
  );

  // A session left behind whose parent goes is re-attached to the nearest
  // ancestor that stays (cascade re-parent).
  const survivingParent = (parentSessionPath: string | undefined): string | undefined => {
    const seen = new Set<string>();
    let current = parentSessionPath;
    while (current) {
      const key = sessionPathKey(current);
      const deletedPath = deletedPathKeys.get(key);
      if (deletedPath === undefined) return current;
      if (seen.has(key)) return undefined;
      seen.add(key);
      if (!parentPathByKey.has(key)) {
        let parent: string | undefined;
        try {
          parent = readSessionHeader(deletedPath)?.parentSession;
        } catch {
          parent = undefined;
        }
        parentPathByKey.set(key, parent);
      }
      current = parentPathByKey.get(key);
    }
    return undefined;
  };
  if (deletedPaths.size > 0) {
    const scanDirs = new Set([...deletedPaths.values()].map((path) => dirname(path)));
    for (const dir of scanDirs) {
      try {
        const files = readdirSync(dir).filter(
          (file) => file.endsWith('.jsonl') && !deletedPathKeys.has(sessionPathKey(join(dir, file)))
        );
        for (const file of files) {
          const childPath = join(dir, file);
          try {
            // The bounded header says whether it needs a rewrite at all.
            const childParent = readSessionHeader(childPath)?.parentSession;
            if (!childParent || !deletedPathKeys.has(sessionPathKey(childParent))) continue;
            const parentSessionPath = survivingParent(childParent);
            const lines = readFileSync(childPath, 'utf8').split('\n');
            const header = JSON.parse(lines[0]) as { type?: string; parentSession?: string };
            if (header.type !== 'session') continue;
            // Rewrite header with new parentSession
            header.parentSession = parentSessionPath;
            lines[0] = JSON.stringify(header);
            writeFileSync(childPath, lines.join('\n'));
          } catch {
            /* skip malformed */
          }
        }
      } catch {
        /* skip if dir unreadable */
      }
    }
  }

  for (const deletedId of deletedSessionIds) {
    await getRpcSession(deletedId)?.shutdown();
  }
  for (const [deletedId, deletedPath] of deletedPaths) {
    try {
      unlinkSync(deletedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    invalidateSessionPathCache(deletedId);
    invalidateSessionManagerCache(deletedPath);
  }
  // Drop their pins and archive times; best effort, the files are already gone.
  try {
    await forgetSessionUiState(deletedSessionIds);
  } catch (error) {
    console.warn(
      `[pie] could not clear the sidebar state of deleted sessions: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  invalidateSessionListCache();
  return { deleted: [...deletedSessionIds], missing, running };
}
