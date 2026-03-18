import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { generateUnifiedPatch, type InlineExtension } from '@earendil-works/pi-coding-agent';

/**
 * The hidden extension that gives a write the diff its card shows.
 *
 * Pi's write tool stores no old content and returns no details, so its card can
 * only show the final file. A write is often an overwrite: the useful review
 * fact is what changed. Snapshot the old text before the call and attach a
 * unified patch to its result, which the existing patch view already renders.
 */

export const WRITE_DIFF_EXTENSION_NAME = 'pie-write-diff';

/** The SDK's write tool. A custom tool that happens to write elsewhere keeps its own result. */
const WRITE_TOOL_NAME = 'write';

/** Larger files keep the plain content view: a whole-file diff is not a review aid. */
export const WRITE_DIFF_MAX_BYTES = 1_000_000;

interface WriteSnapshot {
  /** The path as the model wrote it, for the patch headers. */
  path: string;
  /** The text before the write; empty for a new file, null when it cannot be read. */
  oldContent: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The path and content a write-shaped tool input carries. */
function writeInput(input: unknown): { path: string; content: string } | null {
  if (!isRecord(input)) return null;
  const path = input.path ?? input.file_path;
  const content = input.content;
  if (typeof path !== 'string' || !path.trim() || typeof content !== 'string') return null;
  return { path, content };
}

/**
 * Resolve a write path the way the SDK's write tool does, without importing a
 * private path helper: a home-relative path expands, an absolute path stays,
 * and anything else is relative to the session directory.
 */
function resolveWritePath(filePath: string, cwd: string): string {
  let value = filePath.replace(/\u202f/g, ' ').trim();
  if (value.startsWith('@')) value = value.slice(1);
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return isAbsolute(value) ? value : resolve(cwd, value);
}

async function readOldContent(absolutePath: string): Promise<string | null> {
  try {
    const info = await stat(absolutePath);
    if (!info.isFile() || info.size > WRITE_DIFF_MAX_BYTES) return null;
    const buffer = await readFile(absolutePath);
    // A binary file has no reviewable line diff.
    if (buffer.includes(0)) return null;
    return buffer.toString('utf8');
  } catch (error) {
    // The file does not exist yet: the write creates it, so every line is new.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    return null;
  }
}

/** A unified patch for a write, or null when neither side differs or cannot be shown. */
export function buildWriteDiff(
  path: string,
  oldContent: string,
  newContent: string
): { patch: string } | null {
  if (oldContent === newContent) return null;
  return { patch: generateUnifiedPatch(path, oldContent, newContent) };
}

function mergeDetails(details: unknown, patch: string): Record<string, unknown> {
  return { ...(isRecord(details) ? details : {}), patch };
}

export function createWriteDiffExtension(): InlineExtension {
  return {
    name: WRITE_DIFF_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      const snapshots = new Map<string, WriteSnapshot>();
      const clear = () => snapshots.clear();

      pi.on('tool_call', async (event, ctx) => {
        if (event.parentToolCallId || event.toolName !== WRITE_TOOL_NAME) return;
        const input = writeInput(event.input);
        if (!input || input.content.length > WRITE_DIFF_MAX_BYTES) return;
        const oldContent = await readOldContent(resolveWritePath(input.path, ctx.cwd));
        snapshots.set(event.toolCallId, { path: input.path, oldContent });
      });

      pi.on('tool_result', (event) => {
        if (event.parentToolCallId) return;
        const snapshot = snapshots.get(event.toolCallId);
        if (!snapshot) return;
        snapshots.delete(event.toolCallId);
        if (event.isError || snapshot.oldContent === null) return;

        const input = writeInput(event.input);
        if (!input || input.content.length > WRITE_DIFF_MAX_BYTES) return;
        // A tool that already supplied its own diff keeps it.
        if (
          isRecord(event.details) &&
          (typeof event.details.patch === 'string' || typeof event.details.diff === 'string')
        ) {
          return;
        }
        const diff = buildWriteDiff(snapshot.path, snapshot.oldContent, input.content);
        if (!diff) return;
        return { details: mergeDetails(event.details, diff.patch) };
      });

      pi.on('agent_settled', clear);
      pi.on('session_shutdown', clear);
    }
  };
}
