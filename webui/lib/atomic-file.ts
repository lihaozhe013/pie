import { randomUUID } from 'crypto';
import { renameSync, unlinkSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';

/**
 * Replace a file atomically without exposing credentials through default
 * process permissions. The caller must create the parent directory first.
 */
export function writePrivateFileAtomicSync(path: string, contents: string): void {
  const dir = dirname(path);
  const tempPath = join(dir, `.${basename(path)}-${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, contents, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
      flush: true
    });
    renameSync(tempPath, path);
  } catch (error) {
    // The error above is the one that matters; a failure to remove the temp
    // file must not mask it, so cleanup here is best-effort.
    try {
      unlinkSync(tempPath);
    } catch {
      // Leave the temp file behind when it cannot be removed.
    }
    throw error;
  }
}
