import { useEffect, useId, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { sendAgentCommand } from '@/lib/agent-client';
import { shortenPath } from '@/lib/display-path';
import {
  ConfigButton,
  ConfigDetail,
  ConfigDetailHeader,
  ConfigDetailHeaderInfo,
  ConfigFooter,
  ConfigPanelShell,
  ConfigScopeTag
} from './SettingsUi';

interface GlobalAgentsResponse {
  path?: string;
  content?: string;
  exists?: boolean;
  error?: string;
}

export function GlobalAgentsConfig({
  sessionId = null,
  onClose,
  onReloaded,
  embedded = false
}: {
  sessionId?: string | null;
  onClose: () => void;
  onReloaded?: () => void;
  embedded?: boolean;
}) {
  const { t } = useI18n();
  const descriptionId = useId();
  const [path, setPath] = useState('');
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [exists, setExists] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [reloadNeeded, setReloadNeeded] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/global-agents', {
          cache: 'no-store',
          signal: controller.signal
        });
        const data = (await response.json()) as GlobalAgentsResponse;
        if (!response.ok || data.error || typeof data.content !== 'string') {
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }
        if (controller.signal.aborted) return;
        setPath(data.path ?? '');
        setContent(data.content);
        setSavedContent(data.content);
        setExists(data.exists === true);
        setLoaded(true);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  const dirty = loaded && content !== savedContent;

  const save = async () => {
    setSaving(true);
    setError(null);
    setSavedOk(false);
    setReloadNeeded(false);
    try {
      const response = await fetch('/api/global-agents', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      });
      const data = (await response.json()) as GlobalAgentsResponse;
      if (!response.ok || data.error || typeof data.content !== 'string') {
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }
      setPath((current) => data.path ?? current);
      setContent(data.content);
      setSavedContent(data.content);
      setExists(data.exists === true);
      setSavedOk(true);
      setReloadNeeded(Boolean(sessionId));
      window.setTimeout(() => setSavedOk(false), 2000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const reloadSession = async () => {
    if (!sessionId) return;
    setReloading(true);
    setError(null);
    try {
      await sendAgentCommand(sessionId, { type: 'reload' });
      setReloadNeeded(false);
      onReloaded?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setReloading(false);
    }
  };

  return (
    <ConfigPanelShell
      embedded={embedded}
      title={t('globalAgents.title')}
      subtitle={path ? shortenPath(path) : undefined}
      closeLabel={t('i18n.close')}
      onClose={onClose}
    >
      <ConfigDetail style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <ConfigDetailHeader>
          <ConfigDetailHeaderInfo>
            <ConfigScopeTag scope="global">{t('globalAgents.scope')}</ConfigScopeTag>
            <span className="config-detail-path" title={path}>
              {path ? shortenPath(path) : ''}
            </span>
          </ConfigDetailHeaderInfo>
        </ConfigDetailHeader>
        <p id={descriptionId} className="global-agents-description">
          {t('globalAgents.description')}
        </p>
        {loading ? (
          <div className="config-sidebar-message">{t('i18n.loading')}</div>
        ) : !loaded ? (
          <div role="alert" className="config-sidebar-message is-error">
            {error}
          </div>
        ) : (
          <textarea
            className="global-agents-editor"
            aria-label={t('globalAgents.editorLabel')}
            aria-describedby={descriptionId}
            value={content}
            placeholder={exists ? undefined : t('globalAgents.placeholder')}
            disabled={saving}
            spellCheck={false}
            wrap="off"
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(event) => {
              setContent(event.target.value);
              setSavedOk(false);
            }}
          />
        )}
      </ConfigDetail>
      <ConfigFooter
        status={
          error && loaded ? (
            <span role="alert" style={{ color: '#ef4444' }}>
              {error}
            </span>
          ) : reloadNeeded ? (
            <span role="status">{t('globalAgents.reloadRequired')}</span>
          ) : loaded && !exists ? (
            <span>{t('globalAgents.missing')}</span>
          ) : null
        }
      >
        {reloadNeeded && sessionId && (
          <ConfigButton
            size="small"
            onClick={() => void reloadSession()}
            disabled={reloading || saving}
          >
            {reloading ? t('globalAgents.reloading') : t('globalAgents.reloadSession')}
          </ConfigButton>
        )}
        <ConfigButton
          variant="primary"
          onClick={() => void save()}
          disabled={!dirty || saving || reloading}
          className={savedOk && !dirty ? 'is-success' : undefined}
        >
          {savedOk && !dirty
            ? t('i18n.saved')
            : saving
              ? t('globalAgents.saving')
              : !exists
                ? t('globalAgents.create')
                : t('globalAgents.save')}
        </ConfigButton>
      </ConfigFooter>
    </ConfigPanelShell>
  );
}
