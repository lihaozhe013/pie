import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useI18n } from '@/hooks/useI18n';
import type { ModelsData } from '@/lib/models-cache';
import { THINKING_LEVELS, THINKING_LEVEL_LABEL_KEYS } from '@/lib/thinking-levels';
import { ConfigField, ConfigSectionTitle } from './SettingsUi';
import { ModelSelector } from './ModelSelector';

const selectStyle: CSSProperties = {
  width: '100%',
  padding: '7px 9px',
  border: '1px solid var(--border)',
  borderRadius: 5,
  outline: 'none',
  background: 'var(--bg-panel)',
  color: 'var(--text)',
  fontSize: 12
};

type SavedField = 'model' | 'thinking';

/**
 * The model and reasoning level new chats start with.
 *
 * This is the Models panel's version of the composer selectors' "save as
 * default" star: the composer's choice is session-scoped, while this section
 * writes pi's global `defaultProvider` / `defaultModel` /
 * `defaultThinkingLevel` right away, like the enabled-model switches beside it.
 * A project settings file can still override the global value, so the server
 * names that file instead of reporting a save that would not apply.
 */
export function NewSessionDefaults({ cwd }: { cwd?: string | null }) {
  const { t } = useI18n();
  const [data, setData] = useState<ModelsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState<SavedField | null>(null);
  const [saved, setSaved] = useState<SavedField | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestKey = JSON.stringify([cwd]);
  const requestKeyRef = useRef(requestKey);
  requestKeyRef.current = requestKey;

  useEffect(
    () => () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    },
    []
  );

  const load = useCallback(
    async (quiet: boolean, signal?: AbortSignal) => {
      const key = requestKey;
      if (!quiet) setLoading(true);
      try {
        const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
        const res = await fetch(`/api/models${query}`, { signal });
        const body = (await res.json()) as ModelsData & { error?: string };
        if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
        if (signal?.aborted || requestKeyRef.current !== key) return;
        setData(body);
        setFailure(null);
      } catch (error) {
        if (signal?.aborted || requestKeyRef.current !== key) return;
        setFailure(error instanceof Error ? error.message : String(error));
      } finally {
        if (!quiet && !signal?.aborted && requestKeyRef.current === key) setLoading(false);
      }
    },
    [cwd, requestKey]
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(false, controller.signal);
    return () => controller.abort();
  }, [load]);

  const save = useCallback(
    async (edit: { provider: string; modelId: string } | { thinkingLevel: string | null }) => {
      const field: SavedField = 'provider' in edit ? 'model' : 'thinking';
      setSaving(field);
      setFailure(null);
      setSaved(null);
      try {
        const res = await fetch('/api/models/default', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...(cwd ? { cwd } : {}), ...edit })
        });
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        setSaved(field);
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
        savedTimerRef.current = setTimeout(() => setSaved(null), 2000);
        // Re-read the effective values: a saved model can resolve a different
        // reasoning level than the list had before the write.
        await load(true);
      } catch (error) {
        setFailure(error instanceof Error ? error.message : String(error));
      } finally {
        setSaving(null);
      }
    },
    [cwd, load]
  );

  const model = data?.defaultModel ?? null;
  const modelKey = model ? `${model.provider}:${model.modelId}` : null;
  const supportedLevels: readonly string[] =
    (modelKey ? data?.thinkingLevels?.[modelKey] : undefined) ?? THINKING_LEVELS;
  const savedLevel = data?.savedDefaultThinkingLevel;
  // No saved level means pi chooses: showing the first supported level instead
  // would name a level the user never picked.
  const thinkingLevel = savedLevel ?? 'auto';
  const options =
    savedLevel && !supportedLevels.includes(savedLevel)
      ? [savedLevel, ...supportedLevels]
      : supportedLevels;
  const busy = loading || saving !== null;
  const modelOptions = (data?.modelList ?? []).map((entry) => ({
    provider: entry.provider,
    modelId: entry.id,
    name: entry.name
  }));
  return (
    <>
      <div className="config-detail-heading">
        <ConfigSectionTitle>{t('models.defaults')}</ConfigSectionTitle>
      </div>
      <ConfigField label={t('chat.defaultModel')}>
        <ModelSelector
          options={modelOptions}
          value={model}
          onChange={(provider, modelId) => void save({ provider, modelId })}
          emptyLabel={t('models.defaultsAutomatic')}
          disabled={busy || !data || modelOptions.length === 0}
          busy={saving === 'model'}
          ariaLabel={t('chat.defaultModel')}
          variant="field"
          placement="auto"
        />
      </ConfigField>
      <ConfigField label={t('chat.defaultThinking')}>
        <select
          aria-label={t('chat.defaultThinking')}
          value={thinkingLevel}
          disabled={busy || !data}
          onChange={(event) =>
            void save({
              thinkingLevel: event.target.value === 'auto' ? null : event.target.value
            })
          }
          style={selectStyle}
        >
          <option value="auto">{t('models.defaultsAutomatic')}</option>
          {options.map((level) => (
            <option key={level} value={level}>
              {THINKING_LEVEL_LABEL_KEYS[level]
                ? `${level} — ${t(THINKING_LEVEL_LABEL_KEYS[level])}`
                : level}
            </option>
          ))}
        </select>
      </ConfigField>
      <p className="models-defaults-help">{t('models.defaultsHelp')}</p>
      {failure && <div className="enabled-models-error">{failure}</div>}
      {saved && (
        <div role="status" className="models-defaults-note">
          {t('i18n.saved')}
        </div>
      )}
    </>
  );
}
