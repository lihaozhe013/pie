import { mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import lockfile from 'proper-lockfile';
import { writePrivateFileAtomicSync } from './atomic-file';
import { serializeByKey } from './key-serializer';
import { readRegularFileText } from './regular-file';
import {
  CUSTOM_TOOL_PRESETS_VERSION,
  parseCustomToolPresetDocument,
  validateCustomToolPresetDocument,
  type CustomToolPreset,
  type CustomToolPresetDocument
} from './custom-tool-presets-shared';

/**
 * The user's custom tool presets (`lib/custom-tool-presets-shared.ts` has the rules)
 * in `pie-tool-presets.json` beside pi's own files. It holds what the user chose,
 * so like the session UI state it is never rebuilt: writes are serialized in-process,
 * locked against other processes, replaced atomically, and a file that cannot be
 * parsed is set aside, never overwritten.
 */

const MAX_BYTES = 1024 * 1024;

// Route handlers are bundled separately and hot reload re-evaluates modules; globalThis keeps one queue per process.
const QUEUE_KEY: symbol = Symbol.for('pie:custom-tool-presets-write-queue');

const LOCK_OPTIONS = {
  realpath: false,
  stale: 10_000,
  retries: { retries: 10, factor: 2, minTimeout: 25, maxTimeout: 500 },
  onCompromised: (error: Error) => {
    console.warn(`[pie] the tool preset file lock was compromised: ${error.message}`);
  }
};

/** Another process held the file's lock for longer than the retries wait. */
export class CustomToolPresetsLockedError extends Error {
  constructor(message = 'Another process holds the tool preset file lock') {
    super(message);
    this.name = 'CustomToolPresetsLockedError';
  }
}

interface CachedRead {
  mtimeMs: number;
  size: number;
  ino: number;
  presets: CustomToolPreset[];
}

declare global {
  var __pieCustomToolPresetsCache: Map<string, CachedRead> | undefined;
}

function cache(): Map<string, CachedRead> {
  return (globalThis.__pieCustomToolPresetsCache ??= new Map());
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

export function getCustomToolPresetsPath(agentDir = getAgentDir()): string {
  return join(agentDir, 'pie-tool-presets.json');
}

function copyPresets(presets: CustomToolPreset[]): CustomToolPreset[] {
  return presets.map((preset) => ({
    ...preset,
    includeExtensions: preset.includeExtensions,
    tools: [...preset.tools]
  }));
}

function parsePresetsText(path: string, text: string): CustomToolPreset[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const presets = parsed !== null ? parseCustomToolPresetDocument(parsed) : undefined;
  if (presets === undefined) {
    console.warn(
      `[pie] ${path} is not valid custom tool presets; reading it as empty until the next change sets it aside`
    );
    return [];
  }
  return presets;
}

/**
 * The file's presets through the stat-keyed cache. Missing and unparsable read as
 * empty (warned); anything else, such as a file that is not a regular one or is
 * too large, throws.
 */
function loadPresets(path: string): CustomToolPreset[] {
  let stats;
  try {
    stats = statSync(path);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      cache().delete(path);
      return [];
    }
    throw error;
  }
  const cached = cache().get(path);
  // An atomic replace gives the file a new inode, so a write within the mtime's granularity is still seen.
  if (
    cached &&
    cached.mtimeMs === stats.mtimeMs &&
    cached.size === stats.size &&
    cached.ino === stats.ino
  ) {
    return cached.presets;
  }
  // Read after the stat: a write in between leaves a fingerprint older than the text, which only costs one more read.
  const text = readRegularFileText(path, MAX_BYTES);
  if (text === undefined) {
    cache().delete(path);
    return [];
  }
  const presets = parsePresetsText(path, text);
  cache().set(path, { mtimeMs: stats.mtimeMs, size: stats.size, ino: stats.ino, presets });
  return presets;
}

/** Never throws; missing/corrupt read as empty (does not rewrite on read). */
export function readCustomToolPresets(path?: string): CustomToolPreset[] {
  try {
    return copyPresets(loadPresets(path ?? getCustomToolPresetsPath()));
  } catch (error) {
    console.warn(
      `[pie] could not read the custom tool presets: ${error instanceof Error ? error.message : String(error)}`
    );
    return [];
  }
}

/** Sets an unparsable file aside beside itself; best effort. */
function backUpCorruptFile(path: string): void {
  const backup = `${path}.corrupt-${Date.now()}`;
  try {
    renameSync(path, backup);
    console.warn(
      `[pie] ${path} could not be parsed; moved it to ${backup} and started from an empty tool preset list`
    );
  } catch (error) {
    console.warn(
      `[pie] ${path} could not be parsed and could not be moved aside (${error instanceof Error ? error.message : String(error)}); starting from an empty tool preset list`
    );
  }
}

/**
 * Validates `document` (an unknown JSON body) and replaces the file's presets with
 * it. The editor sends the whole list, so this is a whole-document replace: the
 * last writer wins, and the write is locked against other processes but not
 * against another tab's edit.
 */
export async function writeCustomToolPresets(
  document: unknown,
  path?: string
): Promise<CustomToolPreset[]> {
  const presets = validateCustomToolPresetDocument(document);
  const target = path ?? getCustomToolPresetsPath();
  await serializeByKey(QUEUE_KEY, target, async () => {
    mkdirSync(dirname(target), { recursive: true });
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(target, LOCK_OPTIONS);
    } catch (error) {
      if (errorCode(error) === 'ELOCKED') throw new CustomToolPresetsLockedError();
      throw error;
    }
    try {
      // A file that cannot be parsed is set aside before it is overwritten.
      const text = readRegularFileText(target, MAX_BYTES);
      if (text !== undefined) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
        if (parsed === null || parseCustomToolPresetDocument(parsed) === undefined) {
          backUpCorruptFile(target);
        }
      }
      writePrivateFileAtomicSync(
        target,
        JSON.stringify(
          { version: CUSTOM_TOOL_PRESETS_VERSION, presets } satisfies CustomToolPresetDocument,
          null,
          2
        ) + '\n'
      );
      try {
        const stats = statSync(target);
        cache().set(target, {
          mtimeMs: stats.mtimeMs,
          size: stats.size,
          ino: stats.ino,
          presets
        });
      } catch {
        cache().delete(target);
      }
    } finally {
      try {
        await release();
      } catch {
        // A compromised lock was already reported through onCompromised.
      }
    }
  });
  return copyPresets(presets);
}

export function resetCustomToolPresetsCacheForTests(): void {
  globalThis.__pieCustomToolPresetsCache = undefined;
}
