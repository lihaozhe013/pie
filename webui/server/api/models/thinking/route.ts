import { stat } from 'fs/promises';
import { resolve } from 'path';
import { createAgentSessionServices, getAgentDir } from '@earendil-works/pi-coding-agent';
import {
  isThinkingLevel,
  projectSettingsPath,
  shadowingProjectModelThinkingLevel,
  writeModelThinkingLevel
} from '@/lib/default-preferences';
import { withDeferredProviderModels } from '@/lib/deferred-provider-models';
import { getAllowedFileRoots, isExistingFilePathAllowed } from '@/lib/file-access';
import { invalidateModelsCache } from '@/lib/models-cache';
import { resolveVisibleModels } from '@/lib/model-scope';
import { projectTrustReloadOptions } from '@/lib/project-trust';
import { createGlobalModelSettings, getModelRuntimeWithExtensions } from '@/lib/model-runtime';

interface ModelThinkingRequest {
  cwd?: unknown;
  provider?: unknown;
  modelId?: unknown;
  thinkingLevel?: unknown;
}

/**
 * Save the reasoning level a model uses when a chat switches to it.
 *
 * Pi already applies `modelThinkingLevels` on a switch and for a new session's
 * initial model, so this route only edits that setting. Unlike the global
 * default, it is per model: another model keeps the chat's level or Pi's
 * default. `thinkingLevel: null` removes the entry.
 */
export async function PUT(req: Request) {
  let body: ModelThinkingRequest;
  try {
    body = (await req.json()) as ModelThinkingRequest;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof body.provider !== 'string' || !body.provider) {
    return Response.json({ error: 'Expected a provider id' }, { status: 400 });
  }
  if (typeof body.modelId !== 'string' || !body.modelId) {
    return Response.json({ error: 'Expected a model id' }, { status: 400 });
  }
  if (body.thinkingLevel !== null && !isThinkingLevel(body.thinkingLevel)) {
    return Response.json({ error: 'Expected a valid thinkingLevel or null' }, { status: 400 });
  }
  const { provider, modelId } = body;

  const cwd = typeof body.cwd === 'string' && body.cwd ? resolve(body.cwd) : null;
  if (cwd) {
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
  }

  try {
    const agentDir = getAgentDir();
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
    const { settingsManager } = services;

    const shadowed = shadowingProjectModelThinkingLevel(settingsManager, provider, modelId);
    if (cwd && shadowed !== undefined) {
      const settingsPath = projectSettingsPath(cwd);
      return Response.json(
        {
          error: `${settingsPath} sets modelThinkingLevels for ${provider}/${modelId} in this project, so a global default would not apply here.`,
          reason: 'project-scope',
          settingsPath,
          keys: ['modelThinkingLevels']
        },
        { status: 409 }
      );
    }

    // Only a model the selector can offer is one a chat can switch to.
    const scope = await resolveVisibleModels(
      withDeferredProviderModels(services.modelRuntime),
      settingsManager.getEnabledModels()
    );
    if (!scope.visible.some((model) => model.provider === provider && model.id === modelId)) {
      return Response.json(
        { error: `Model not available: ${provider}/${modelId}` },
        { status: 404 }
      );
    }

    await writeModelThinkingLevel(settingsManager, {
      provider,
      modelId,
      ...(body.thinkingLevel === null ? { clear: true } : { thinkingLevel: body.thinkingLevel })
    });
    invalidateModelsCache();
    return Response.json({ ok: true, thinkingLevel: body.thinkingLevel });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
