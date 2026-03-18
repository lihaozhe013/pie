import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { parseContextWindow } from '@/lib/model-context';
import { ConfigButton, ConfigField, ConfigSectionTitle } from './SettingsUi';

/**
 * Models › General: the global context window limit.
 *
 * Like the enabled-model switches beside it in the Models panel, a save writes
 * through its API right away instead of waiting for the panel's Save button.
 * The draft is the input's text; blank saves an explicit no cap. Until a value
 * is saved the field shows the first-install default (350,000 tokens); every
 * model then runs with `min(native, limit)` as its default context window, so
 * pi compacts earlier; a smaller native window keeps itself and an explicit
 * per-model value (the same panel's enabled rows) always wins.
 */
export function ModelGeneralSettings() {
  const { t } = useI18n();
  const [savedLimit, setSavedLimit] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [draft, setDraft] = useState('');
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    },
    []
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch('/api/models/context-limit', { signal: controller.signal })
      .then(async (res) => {
        const body = (await res.json()) as { limit?: number | null; error?: string };
        if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
        const limit = body.limit ?? null;
        setSavedLimit(limit);
        setDraft(limit === null ? '' : String(limit));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setFailure(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  const parsed = draft.trim() === '' ? null : parseContextWindow(draft);
  const invalid = draft.trim() !== '' && parsed === undefined;
  const dirty = !invalid && parsed !== savedLimit;
  const busy = saving || loading;

  const save = useCallback(async () => {
    if (saving || invalid || !dirty) return;
    setSaving(true);
    setFailure(null);
    setSaved(false);
    try {
      const res = await fetch('/api/models/context-limit', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: parsed })
      });
      const body = (await res.json().catch(() => ({}))) as {
        limit?: number | null;
        error?: string;
      };
      if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
      const limit = body.limit ?? null;
      setSavedLimit(limit);
      setDraft(limit === null ? '' : String(limit));
      setSaved(true);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }, [saving, invalid, dirty, parsed]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void save();
  };

  return (
    <>
      <div className="config-detail-heading">
        <ConfigSectionTitle>{t('models.general')}</ConfigSectionTitle>
      </div>
      <form onSubmit={submit}>
        <ConfigField label={t('models.contextLimit')}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              id="models-context-limit"
              className="model-context-input"
              type="text"
              inputMode="numeric"
              value={draft}
              title={t('models.contextLimit')}
              aria-label={t('models.contextLimit')}
              aria-invalid={invalid || undefined}
              aria-describedby={invalid ? 'models-context-limit-error' : undefined}
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
              style={{ width: 'calc(10ch + 16px)', height: 'auto' }}
            />
            <ConfigButton size="small" type="submit" disabled={busy || invalid || !dirty}>
              {saving ? t('i18n.saving') : t('i18n.save')}
            </ConfigButton>
          </div>
        </ConfigField>
        {invalid && (
          <div id="models-context-limit-error" className="enabled-models-error">
            {t('models.contextLimitInvalid')}
          </div>
        )}
      </form>
      <p className="models-defaults-help">{t('models.contextLimitHelp')}</p>
      <p className="models-defaults-help">{t('models.applyHelp')}</p>
      {failure && <div className="enabled-models-error">{failure}</div>}
      {saved && (
        <div role="status" className="models-defaults-note">
          {t('i18n.saved')}
        </div>
      )}
    </>
  );
}
