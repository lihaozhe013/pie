import { mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getAgentDir, type ModelRuntime } from '@earendil-works/pi-coding-agent';
import { writePrivateFileAtomicSync } from './atomic-file';
import { parseContextWindow } from './model-context';
import { getModelsConfigPath, readModelsConfig } from './models-config-store';
import { invalidateModelsCache } from './models-cache';
import { readRegularFileText } from './regular-file';
import { serializeByKey } from './key-serializer';

/** Largest `pie-model-settings.json` that is parsed; a larger file is ignored. */
const SETTINGS_MAX_BYTES = 1024 * 1024;

/**
 * The cap applied when `pie-model-settings.json` never configured one, shown
 * pre-filled in Models › General: models with a larger native window run as if
 * they were this size.
 */
export const DEFAULT_CONTEXT_WINDOW_LIMIT = 350_000;

/** General pie model settings, beside pi's own files in the agent directory. */
export function getModelsSettingsPath(agentDir = getAgentDir()): string {
  return join(agentDir, 'pie-model-settings.json');
}

interface CachedFile {
  mtimeMs: number;
  size: number;
  ino: number;
  value: unknown;
}

declare global {
  var __pieContextLimitFileCache: Map<string, CachedFile> | undefined;
}

function fileCache(): Map<string, CachedFile> {
  globalThis.__pieContextLimitFileCache ??= new Map();
  return globalThis.__pieContextLimitFileCache;
}

function cachedValue<T>(
  path: string,
  stats: { mtimeMs: number; size: number; ino: number }
): T | undefined {
  const cached = fileCache().get(path);
  // An atomic replace gives the file a new inode, so a write within the mtime's
  // granularity is still seen.
  if (
    cached &&
    cached.mtimeMs === stats.mtimeMs &&
    cached.size === stats.size &&
    cached.ino === stats.ino
  ) {
    return cached.value as T;
  }
  return undefined;
}

function storeCachedValue(
  path: string,
  stats: { mtimeMs: number; size: number; ino: number },
  value: unknown
): void {
  fileCache().set(path, { mtimeMs: stats.mtimeMs, size: stats.size, ino: stats.ino, value });
}

/**
 * The saved value: a positive number, `null` for an explicit "no cap" (a blank
 * save stores a literal `null` key), or `undefined` when the file does not
 * configure the key at all, which reads as the first-install default.
 */
function parseSettingsText(path: string, text: string): number | null | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.warn(`[pie] ${path} is not valid JSON; reading the context window limit as unset`);
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.warn(
      `[pie] ${path} is not a settings object; reading the context window limit as unset`
    );
    return undefined;
  }
  const value = (parsed as { contextWindowLimit?: unknown }).contextWindowLimit;
  // Only a missing key means "never configured"; a present `null` is the
  // explicit no-cap a blank save writes.
  if (value === null) return null;
  if (value === undefined) return undefined;
  const limit = parseContextWindow(value);
  if (limit === undefined) {
    console.warn(`[pie] ${path} has an invalid contextWindowLimit; reading it as unset`);
    return undefined;
  }
  return limit;
}

/**
 * The saved cap, the first-install default of 350,000 tokens when never
 * configured, or `null` for an explicit "no cap" saved as a blank field. A
 * missing, unparsable or unreadable file reads as the default: a broken file
 * must never become a model-listing failure.
 */
export function readContextWindowLimit(path = getModelsSettingsPath()): number | null {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    fileCache().delete(path);
    return DEFAULT_CONTEXT_WINDOW_LIMIT;
  }
  const cached = cachedValue<number>(path, stats);
  if (cached !== undefined) return cached;
  // Read after the stat: a write in between leaves a fingerprint older than
  // the text, which only costs one more read.
  let text: string | undefined;
  try {
    text = readRegularFileText(path, SETTINGS_MAX_BYTES);
  } catch {
    // Unreadable (not a regular file, too large): the cap reads as the default.
    fileCache().delete(path);
    return DEFAULT_CONTEXT_WINDOW_LIMIT;
  }
  if (text === undefined) {
    fileCache().delete(path);
    return DEFAULT_CONTEXT_WINDOW_LIMIT;
  }
  const parsed = parseSettingsText(path, text);
  const limit = parsed === undefined ? DEFAULT_CONTEXT_WINDOW_LIMIT : parsed;
  storeCachedValue(path, stats, limit);
  return limit;
}

/**
 * Models exempt from the cap, by models.json's own precedence: for each
 * provider, the model ids whose `modelOverrides` entry sets an explicit
 * `contextWindow`. A file pi could not load contributes nothing, since its
 * providers are absent from the runtime anyway.
 */
export function readModelOverrideWindows(
  modelsPath = getModelsConfigPath()
): ReadonlyMap<string, ReadonlySet<string>> {
  let stats;
  try {
    stats = statSync(modelsPath);
  } catch {
    fileCache().delete(modelsPath);
    return new Map();
  }
  const cached = cachedValue<ReadonlyMap<string, ReadonlySet<string>>>(modelsPath, stats);
  if (cached !== undefined) return cached;

  const EMPTY: ReadonlyMap<string, ReadonlySet<string>> = new Map();
  let config: Record<string, unknown>;
  try {
    config = readModelsConfig(modelsPath);
  } catch {
    storeCachedValue(modelsPath, stats, EMPTY);
    return EMPTY;
  }
  const windows = new Map<string, Set<string>>();
  const providers = config.providers;
  if (typeof providers === 'object' && providers !== null) {
    for (const [providerId, provider] of Object.entries(providers)) {
      if (typeof provider !== 'object' || provider === null) continue;
      const overrides = (provider as { modelOverrides?: unknown }).modelOverrides;
      if (typeof overrides !== 'object' || overrides === null) continue;
      for (const [modelId, override] of Object.entries(overrides)) {
        if (typeof override !== 'object' || override === null) continue;
        if (
          parseContextWindow((override as { contextWindow?: unknown }).contextWindow) === undefined
        )
          continue;
        let ids = windows.get(providerId);
        if (!ids) windows.set(providerId, (ids = new Set()));
        ids.add(modelId);
      }
    }
  }
  storeCachedValue(modelsPath, stats, windows);
  return windows;
}

const WRITE_QUEUE: symbol = Symbol.for('pie:context-window-limit-write');

/**
 * Validate and save the cap (`null` saves the explicit "no cap" a blank field
 * means), returning the saved value.
 *
 * The write merges into the file's current object, so other pie settings
 * added beside `contextWindowLimit` survive; an unparsable file is set aside
 * first, never silently discarded.
 */
export async function writeContextWindowLimit(
  limit: number | string | null,
  path = getModelsSettingsPath()
): Promise<number | null> {
  const saved = limit === null ? null : parseContextWindow(limit);
  if (saved === undefined) {
    throw new Error('Context window limit must be a positive whole number of tokens');
  }
  await serializeByKey(WRITE_QUEUE, path, async () => {
    mkdirSync(dirname(path), { recursive: true });
    let doc: Record<string, unknown> = {};
    const text = readRegularFileText(path, SETTINGS_MAX_BYTES);
    if (text !== undefined) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          doc = { ...(parsed as Record<string, unknown>) };
        }
      } catch {
        const backup = `${path}.corrupt-${Date.now()}`;
        try {
          renameSync(path, backup);
          console.warn(`[pie] ${path} could not be parsed; moved it to ${backup}`);
        } catch (error) {
          console.warn(
            `[pie] ${path} could not be parsed and could not be moved aside (${error instanceof Error ? error.message : String(error)})`
          );
        }
      }
    }
    // A blank save stores a literal `null`, not a missing key: an explicit no
    // cap must survive reads that treat an unconfigured file as the default.
    doc.contextWindowLimit = saved;
    writePrivateFileAtomicSync(path, `${JSON.stringify(doc, null, 2)}\n`);
    try {
      storeCachedValue(path, statSync(path), saved);
    } catch {
      fileCache().delete(path);
    }
  });
  // Listings and panels cache the windows they served; the next load re-clamps.
  invalidateModelsCache();
  return saved;
}

/** Restore the module's caches between tests. */
export function resetContextWindowLimitCacheForTests(): void {
  globalThis.__pieContextLimitFileCache = undefined;
}

export interface ContextWindowLimitOptions {
  /** The cap to apply; defaults to the saved value, re-read per call. */
  readLimit?: () => number | null;
  /** Models exempt via an explicit models.json window; defaults to the file. */
  readOverrideWindows?: () => ReadonlyMap<string, ReadonlySet<string>>;
}

interface WindowedModel {
  provider: string;
  id: string;
  contextWindow?: number;
}

/**
 * The runtime as the effective context windows: `min(native, limit)` for every
 * model, leaving smaller windows, unknown windows and explicitly overridden
 * models untouched. Unchanged models keep object identity, so a reselect of an
 * unchanged model is still recognized as unchanged by session code.
 *
 * The limit is read per call, so saving a new value applies to the next
 * resolution without rebuilding the runtime; open sessions keep their model
 * object (and their compaction threshold) until the model is selected again.
 */
export function withContextWindowLimit(
  runtime: ModelRuntime,
  options: ContextWindowLimitOptions = {}
): ModelRuntime {
  const readLimit = options.readLimit ?? (() => readContextWindowLimit());
  const readOverrides = options.readOverrideWindows ?? (() => readModelOverrideWindows());

  function clampModel<M extends WindowedModel>(model: M, limit: number): M {
    const native = model.contextWindow;
    if (typeof native !== 'number' || !Number.isFinite(native) || native <= 0 || native <= limit) {
      return model;
    }
    if (readOverrides().get(model.provider)?.has(model.id)) return model;
    return { ...model, contextWindow: limit };
  }

  function clampArray<M extends WindowedModel>(models: readonly M[]): M[] {
    const limit = readLimit();
    if (limit === null) return models as M[];
    let changed = false;
    const next = models.map((model) => {
      const clamped = clampModel(model, limit);
      if (clamped !== model) changed = true;
      return clamped;
    });
    return changed ? next : (models as M[]);
  }

  function clampSingle<M extends WindowedModel>(model: M | undefined): M | undefined {
    const limit = readLimit();
    if (model === undefined || limit === null) return model;
    return clampModel(model, limit);
  }

  return new Proxy(runtime, {
    get(target, property, receiver) {
      switch (property) {
        case 'getModel':
          return (providerId: string, modelId: string) =>
            clampSingle(target.getModel(providerId, modelId));
        case 'getModels':
          return (providerId?: string) => clampArray(target.getModels(providerId));
        case 'getModelOfType':
          return (
            type: Parameters<ModelRuntime['getModelOfType']>[0],
            providerId: string,
            modelId: string
          ) => clampSingle(target.getModelOfType(type, providerId, modelId));
        case 'getModelsOfType':
          return (type: Parameters<ModelRuntime['getModelsOfType']>[0], providerId?: string) =>
            clampArray(target.getModelsOfType(type, providerId) as unknown as WindowedModel[]);
        case 'getAllModels':
          return (providerId?: string) =>
            clampArray(target.getAllModels(providerId) as unknown as WindowedModel[]);
        case 'getAvailable':
          return async (...args: Parameters<ModelRuntime['getAvailable']>) =>
            clampArray(await target.getAvailable(...args));
        case 'getAvailableOfType':
          return async (...args: Parameters<ModelRuntime['getAvailableOfType']>) =>
            clampArray(await target.getAvailableOfType(...args));
        case 'getAllAvailable':
          return async (...args: Parameters<ModelRuntime['getAllAvailable']>) =>
            clampArray(await target.getAllAvailable(...args));
        case 'getAvailableSnapshot':
          return () => clampArray(target.getAvailableSnapshot());
        default: {
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      }
    }
  });
}
