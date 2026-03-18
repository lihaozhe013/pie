import { buildFileAtMentionsText } from './file-fuzzy';

/**
 * One file the composer references by chip. The file already sits in the
 * working directory; only its `@path` mention travels with the prompt.
 */
export interface AttachedFile {
  /** Path relative to the working directory, as the prompt spells the mention. */
  path: string;
  /** Base name, shown on the chip. */
  name: string;
}

/** The chip for one working-directory path. */
export function attachedFileFromPath(path: string): AttachedFile {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? path;
  return { path, name };
}

/**
 * Adds dropped or picked files to the composer's attachments, keeping drop
 * order. A path already attached is skipped, because the prompt would reference
 * the same file twice.
 * @param current The attachments already in the composer
 * @param paths Working-directory paths, in drop order
 * @returns The next list; the same array when nothing was added
 */
export function addAttachedFiles(current: AttachedFile[], paths: string[]): AttachedFile[] {
  const seen = new Set(current.map((file) => file.path));
  const added: AttachedFile[] = [];
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    added.push(attachedFileFromPath(path));
  }
  return added.length === 0 ? current : [...current, ...added];
}

/**
 * The prompt a send produces: what the user typed, then the `@path` mentions the
 * chips stand for. The mention order is the chip order, and paths with spaces
 * are quoted as pi expects them.
 * @param text The composer's text
 * @param paths The attached files' paths
 * @returns The message text, with no trailing space
 */
export function composeMessageWithFiles(text: string, paths: string[]): string {
  const typed = text.trim();
  const mentions = buildFileAtMentionsText(paths).trim();
  if (!mentions) return typed;
  return typed ? `${typed}\n\n${mentions}` : mentions;
}
