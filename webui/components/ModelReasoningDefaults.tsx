import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import type { ModelsData } from '@/lib/models-cache';
import { THINKING_LEVELS } from '@/lib/thinking-levels';
import { ConfigSectionTitle } from './SettingsUi';

interface ModelRow {
  provider: string;
  id: string;
  name: string;
  /** What this model accepts; `off` is the whole list for one without reasoning. */
  supported: readonly string[];
  /** The saved per-model level, or null when the model follows the chat/global default. */
  saved: string | null;
}

interface ProviderGroup {
  id: string;
  name: string;
  models: ModelRow[];
}

function matchesQuery(row: ModelRow, providerName: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [row.name, row.id, row.provider, providerName].some((value) =>
    value.toLowerCase().includes(needle)
  );
}

/**
 * Pi's per-model reasoning defaults (`modelThinkingLevels`).
 *
 * A model with a saved level uses it whenever a chat switches to that model,
 * including the first model of a new chat. Models without one use the global
 * default, or the chat's current level when none is set, so a model needs no
 * entry by default.
 * Writes go straight to the global settings file, like the enabled-model
 * switches, because the chat's own selector only changes the current session.
 */
export function ModelReasoningDefaults({
  cwd,
  providers
}: {
  cwd?: string | null;
  /** The sidebar's providers in their arranged order, so both lists read the same. */
  providers: { id: string; name: string }[];
}) {
  const { t } = useI18n();
  const [data, setData] = useState<ModelsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const requestKey = JSON.stringify([cwd]);
  const requestKeyRef = useRef(requestKey);
  requestKeyRef.current = requestKey;

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const search = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
        const res = await fetch(`/api/models${search}`, { signal });
        const body = (await res.json()) as ModelsData & { error?: string };
        if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
        if (signal?.aborted || requestKeyRef.current !== requestKey) return;
        setData(body);
        setFailure(null);
      } catch (error) {
        if (signal?.aborted || requestKeyRef.current !== requestKey) return;
        setFailure(error instanceof Error ? error.message : String(error));
      } finally {
        if (!signal?.aborted && requestKeyRef.current === requestKey) setLoading(false);
      }
    },
    [cwd, requestKey]
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const groups = useMemo<ProviderGroup[]>(() => {
    if (!data) return [];
    const byProvider = new Map<string, ModelRow[]>();
    for (const model of data.modelList) {
      const key = `${model.provider}/${model.id}`;
      const row: ModelRow = {
        provider: model.provider,
        id: model.id,
        name: model.name || model.id,
        supported: data.thinkingLevels[`${model.provider}:${model.id}`] ?? THINKING_LEVELS,
        saved: data.modelThinkingLevels[key] ?? null
      };
      const models = byProvider.get(model.provider);
      if (models) models.push(row);
      else byProvider.set(model.provider, [row]);
    }
    const groups = providers
      .map((provider) => ({ ...provider, models: byProvider.get(provider.id) ?? [] }))
      .filter((group) => group.models.length > 0);
    // A model whose provider the sidebar has not listed yet still gets a row.
    const listed = new Set(groups.map((group) => group.id));
    for (const [id, models] of byProvider) {
      if (!listed.has(id)) groups.push({ id, name: id, models });
    }
    return groups;
  }, [data, providers]);

  const total = groups.reduce((sum, group) => sum + group.models.length, 0);
  const shownGroups = groups
    .map((group) => ({
      ...group,
      models: group.models.filter((row) => matchesQuery(row, group.name, query))
    }))
    .filter((group) => group.models.length > 0);

  const save = useCallback(
    async (row: ModelRow, level: string) => {
      const key = `${row.provider}/${row.id}`;
      setPending(key);
      setFailure(null);
      try {
        const res = await fetch('/api/models/thinking', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(cwd ? { cwd } : {}),
            provider: row.provider,
            modelId: row.id,
            thinkingLevel: level === 'auto' ? null : level
          })
        });
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        setData((prev) => {
          if (!prev) return prev;
          const levels = { ...prev.modelThinkingLevels };
          if (level === 'auto') delete levels[key];
          else levels[key] = level;
          return { ...prev, modelThinkingLevels: levels };
        });
      } catch (error) {
        setFailure(error instanceof Error ? error.message : String(error));
      } finally {
        setPending(null);
      }
    },
    [cwd]
  );

  return (
    <>
      <div className="config-detail-heading">
        <ConfigSectionTitle>{t('models.modelReasoning')}</ConfigSectionTitle>
      </div>
      <p className="models-defaults-help">{t('models.modelReasoningHelp')}</p>
      {failure && <div className="enabled-models-error">{failure}</div>}
      {loading ? (
        <div className="enabled-models-empty">{t('models.loading')}</div>
      ) : total === 0 ? (
        <div className="enabled-models-empty">{t('models.modelReasoningEmpty')}</div>
      ) : (
        <>
          {total > 8 && (
            <input
              className="enabled-models-filter"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('models.enabledFilterPlaceholder', { count: total })}
              aria-label={t('models.enabledFilter')}
            />
          )}
          {shownGroups.length === 0 ? (
            <div className="enabled-models-empty">{t('models.enabledNoMatches')}</div>
          ) : (
            <div className="model-reasoning-list">
              {shownGroups.map((group) => (
                <section key={group.id} aria-label={group.name}>
                  <h3 className="model-reasoning-group-title">{group.name}</h3>
                  {group.models.map((row) => {
                    const key = `${row.provider}/${row.id}`;
                    // A saved level the model no longer lists stays selectable,
                    // rather than the select silently naming a different level.
                    const levels =
                      row.saved && !row.supported.includes(row.saved)
                        ? [row.saved, ...row.supported]
                        : row.supported;
                    return (
                      <div key={key} className="model-reasoning-row">
                        <span className="enabled-models-row-text">
                          <span className="enabled-models-row-name">{row.name}</span>
                          <code className="enabled-models-row-id">{row.id}</code>
                        </span>
                        <select
                          className="model-reasoning-select"
                          aria-label={t('models.modelReasoningFor', { model: row.name })}
                          value={row.saved ?? 'auto'}
                          disabled={pending !== null}
                          onChange={(event) => void save(row, event.target.value)}
                        >
                          <option value="auto">{t('models.defaultsAutomatic')}</option>
                          {levels.map((level) => (
                            <option key={level} value={level}>
                              {level}
                            </option>
                          ))}
                        </select>
                      </div>
                    );
                  })}
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
