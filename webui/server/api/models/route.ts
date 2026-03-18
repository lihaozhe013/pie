import { stat } from 'fs/promises';
import { resolve } from 'path';
import {
  createAgentSessionServices,
  getAgentDir,
  type SettingsManager
} from '@earendil-works/pi-coding-agent';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import {
  loadModelsWithCache,
  withModelRuntimeError,
  withSafeModelLoadFailure,
  type ModelsData
} from '@/lib/models-cache';
import {
  orderSelectorModels,
  resolveVisibleModels,
  selectInitialModelScope
} from '@/lib/model-scope';
import { getAllowedFileRoots, isExistingFilePathAllowed } from '@/lib/file-access';
import { projectTrustReloadOptions } from '@/lib/project-trust';
import { rememberProviderModels, withDeferredProviderModels } from '@/lib/deferred-provider-models';
import { createGlobalModelSettings, getModelRuntimeWithExtensions } from '@/lib/model-runtime';
import { withContextWindowLimit } from '@/lib/model-context-limit';

async function loadModels(cwd: string | null): Promise<ModelsData> {
  const nameMap = new Map<string, string>();
  let modelList: { id: string; name: string; provider: string }[] = [];
  let defaultModel: { provider: string; modelId: string } | null = null;
  const thinkingLevels: Record<string, string[]> = {};
  const thinkingLevelMaps: Record<string, Record<string, string | null>> = {};

  const agentDir = getAgentDir();
  // Gate untrusted project extensions: enumerating models still imports and
  // runs a repository's .pi/extensions factories, so honor project trust here
  // too (see lib/project-trust.ts, #236).
  const trustReloadOptions = cwd ? projectTrustReloadOptions(cwd, agentDir) : undefined;
  const services = cwd
    ? await createAgentSessionServices({
        cwd,
        agentDir,
        ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {})
      })
    : {
        settingsManager: createGlobalModelSettings(agentDir),
        modelRuntime: await getModelRuntimeWithExtensions()
      };
  const modelError = services.modelRuntime.getError();
  const settings: SettingsManager = services.settingsManager;
  await rememberProviderModels(services.modelRuntime);
  // `enabledModels` supports globs and fuzzy patterns, so resolve it the same
  // way the CLI does instead of comparing pattern strings literally (#307).
  // The context window limit wraps last, so the deferred models are capped too.
  const scope = await resolveVisibleModels(
    withContextWindowLimit(withDeferredProviderModels(services.modelRuntime)),
    settings.getEnabledModels()
  );
  const { visible, thinkingLevelPins, warnings } = scope;
  modelList = orderSelectorModels(scope).map((m) => ({
    id: m.id,
    name: m.name,
    provider: m.provider,
    input: m.input
  }));
  for (const m of visible) {
    const key = `${m.provider}:${m.id}`;
    nameMap.set(key, m.name);
    thinkingLevels[key] = getSupportedThinkingLevels(m);
    if (m.thinkingLevelMap) thinkingLevelMaps[key] = m.thinkingLevelMap;
  }

  const defaultProvider = settings.getDefaultProvider();
  const defaultModelId = settings.getDefaultModel();
  const initial = selectInitialModelScope(scope, {
    ...(defaultProvider && defaultModelId
      ? { defaultModel: { provider: defaultProvider, modelId: defaultModelId } }
      : {})
  });
  if (initial.model) {
    defaultModel = { provider: initial.model.provider, modelId: initial.model.id };
  }
  const defaultThinkingLevel =
    initial.thinkingLevel ??
    (initial.model
      ? settings.getModelThinkingLevel(initial.model.provider, initial.model.id)
      : undefined) ??
    settings.getDefaultThinkingLevel() ??
    null;

  return withModelRuntimeError(
    {
      models: Object.fromEntries(nameMap),
      modelList,
      defaultModel,
      defaultThinkingLevel,
      savedDefaultThinkingLevel: settings.getDefaultThinkingLevel() ?? null,
      thinkingLevels,
      thinkingLevelMaps,
      modelThinkingLevels: settings.getAllModelThinkingLevels(),
      thinkingLevelPins,
      ...(warnings.length > 0 ? { modelScopeWarnings: warnings } : {})
    },
    modelError
  );
}

const EMPTY_MODELS: ModelsData = {
  models: {},
  modelList: [],
  defaultModel: null,
  defaultThinkingLevel: null,
  savedDefaultThinkingLevel: null,
  thinkingLevels: {},
  thinkingLevelMaps: {},
  modelThinkingLevels: {},
  thinkingLevelPins: {}
};

export async function GET(req: Request) {
  const rawCwd = new URL(req.url).searchParams.get('cwd');
  if (!rawCwd) {
    try {
      return Response.json(
        await loadModelsWithCache(`\0global:${getAgentDir()}`, () => loadModels(null))
      );
    } catch {
      return Response.json(withSafeModelLoadFailure(EMPTY_MODELS));
    }
  }
  const cwd = resolve(rawCwd);

  let cwdStat;
  try {
    cwdStat = await stat(cwd);
  } catch {
    return Response.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
  }
  if (!cwdStat.isDirectory()) {
    return Response.json({ error: `Not a directory: ${cwd}` }, { status: 400 });
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return Response.json({ error: 'Access denied' }, { status: 403 });
  }

  try {
    return Response.json(await loadModelsWithCache(cwd, () => loadModels(cwd)));
  } catch {
    return Response.json(withSafeModelLoadFailure(EMPTY_MODELS));
  }
}
