import { setEnterSendMode, useEnterSendMode } from '@/hooks/useEnterSendMode';
import { setDiffSideBySide, useDiffSideBySide } from '@/hooks/useDiffLayout';
import { setTranscriptToolDisplay, useTranscriptToolDisplay } from '@/hooks/useTranscriptMode';
import { useI18n } from '@/hooks/useI18n';
import { sendAgentCommand } from '@/lib/agent-client';
import type { ToolEntry } from '@/lib/tool-presets';
import type { ProjectTrustStatus, ToolSettingsResponse } from '@/lib/api-types';
import { setupPushSubscription } from '@/lib/push-client';
import {
  setLastSettingsSection,
  settingsSectionRequiresProject,
  type SettingsSection
} from '@/lib/settings-navigation';
import { focusModalPanel, listenForPanelEscape } from '@/lib/stacked-dialog';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AppearanceSettings } from './AppearanceSettings';
import { GlobalAgentsConfig } from './GlobalAgentsConfig';
import { SettingsSearch } from './SettingsSearch';
import type { SettingsSearchEntry } from '@/lib/settings-search';
import { McpConfig } from './McpConfig';
import { ModelsConfig } from './ModelsConfig';
import { PluginsConfig } from './PluginsConfig';
import { ConfigButton, ConfigSwitch } from './SettingsUi';
import { SkillsConfig } from './SkillsConfig';
import { ToolPresetsSettings } from './ToolPresetsSettings';

interface Props {
  cwd: string | null;
  sessionId: string | null;
  initialSection: SettingsSection;
  onClose: () => void;
  onSessionReloaded: () => void;
  quoteSelectionEnabled: boolean;
  onQuoteSelectionChange: (enabled: boolean) => void;
  /** The page's trust status for `cwd`; Settings › MCP reloads when it changes, as after trusting. */
  projectTrust?: ProjectTrustStatus | null;
  /** Opens the page's trust dialog for `cwd`, above Settings; Settings › MCP's trust notice offers it. */
  onOpenTrustDialog?: () => void;
  /** Settings › MCP added a project server, which changed `cwd`'s trust (and may have trusted a fresh folder). */
  onProjectTrustChanged?: (cwd: string, status: ProjectTrustStatus) => void;
  /** Settings › Tools saved the custom tool presets; the composer reloads its copy. */
  onToolPresetsChanged?: () => void;
  /** The current session's tools, including extension tools, for the preset editor. */
  availableTools?: ToolEntry[] | null;
  toolsLoading?: boolean;
}

export function SettingsSectionIcon({
  section,
  size = 16,
  strokeWidth = 1.8
}: {
  section: SettingsSection;
  size?: number;
  strokeWidth?: number;
}) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    className: 'settings-section-icon'
  };

  if (section === 'general')
    return (
      <svg {...common}>
        <path d="M20 7h-9M14 17H5" />
        <circle cx="7" cy="7" r="3" />
        <circle cx="17" cy="17" r="3" />
      </svg>
    );
  if (section === 'appearance')
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 3v18M12 8h7M12 13h8M12 18h5" />
      </svg>
    );
  if (section === 'instructions')
    return (
      <svg {...common}>
        <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" />
        <path d="M14 3v6h6M8 13h8M8 17h6" />
      </svg>
    );
  if (section === 'models')
    return (
      <svg {...common}>
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <rect x="9" y="9" width="6" height="6" />
        <path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 15h3M1 9h3M1 15h3" />
      </svg>
    );
  if (section === 'tools')
    return (
      <svg {...common}>
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
      </svg>
    );
  if (section === 'skills')
    return (
      <svg {...common}>
        <path d="m12 2-10 5 10 5 10-5-10-5Z" />
        <path d="m2 12 10 5 10-5M2 17l10 5 10-5" />
      </svg>
    );
  if (section === 'mcp')
    return (
      <svg {...common}>
        <rect x="3" y="3" width="18" height="7" rx="2" />
        <rect x="3" y="14" width="18" height="7" rx="2" />
        <path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6" />
      </svg>
    );
  return (
    <svg {...common}>
      <path d="M9 7V2M15 7V2M6 13V8a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v5a6 6 0 0 1-12 0ZM12 19v3" />
    </svg>
  );
}

function GeneralSettings({
  sessionId,
  onSessionReloaded,
  quoteSelectionEnabled,
  onQuoteSelectionChange
}: Pick<
  Props,
  'sessionId' | 'onSessionReloaded' | 'quoteSelectionEnabled' | 'onQuoteSelectionChange'
>) {
  const { locale, setLocale, supportedLocales, t } = useI18n();
  const enterSendMode = useEnterSendMode();
  const toolDisplay = useTranscriptToolDisplay();
  const diffSideBySide = useDiffSideBySide();
  const [shellSettings, setShellSettings] = useState<ToolSettingsResponse | null>(null);
  const [shellSaving, setShellSaving] = useState(false);
  const [shellError, setShellError] = useState<string | null>(null);
  const [cacheMissNotices, setCacheMissNotices] = useState<boolean | null>(null);
  const [cacheMissNoticesSaving, setCacheMissNoticesSaving] = useState(false);
  const [cacheMissNoticesError, setCacheMissNoticesError] = useState<string | null>(null);
  const [pushRegistering, setPushRegistering] = useState(false);
  const [pushStatus, setPushStatus] = useState<{ kind: 'ok' | 'error'; message: string } | null>(
    null
  );
  const [webAuthEnabled, setWebAuthEnabled] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');

  useEffect(() => {
    void fetch('/api/web-auth')
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { enabled?: boolean } | null) => setWebAuthEnabled(data?.enabled === true))
      .catch(() => {});
  }, []);

  const logOut = async () => {
    setLoggingOut(true);
    setLogoutError('');
    try {
      const response = await fetch('/api/web-auth', { method: 'DELETE' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      window.location.replace('/login');
    } catch {
      setLogoutError(t('auth.logoutFailed'));
    } finally {
      setLoggingOut(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/tools/settings')
      .then(async (response) => {
        const data = (await response.json()) as ToolSettingsResponse & { error?: string };
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        if (!cancelled) setShellSettings(data);
      })
      .catch((cause) => {
        if (!cancelled) setShellError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/cache-miss-notices')
      .then(async (response) => {
        const data = (await response.json()) as { enabled?: boolean; error?: string };
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        if (!cancelled) setCacheMissNotices(data.enabled === true);
      })
      .catch((cause) => {
        if (!cancelled)
          setCacheMissNoticesError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // pi's showCacheMissNotices (#1265); the open chat is read again to show or drop them.
  const toggleCacheMissNotices = async (enabled: boolean) => {
    setCacheMissNoticesSaving(true);
    setCacheMissNoticesError(null);
    try {
      const response = await fetch('/api/cache-miss-notices', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      });
      const data = (await response.json()) as { enabled?: boolean; error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setCacheMissNotices(data.enabled === true);
      if (sessionId) onSessionReloaded();
    } catch (cause) {
      setCacheMissNoticesError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCacheMissNoticesSaving(false);
    }
  };

  const togglePowerShell = async (enabled: boolean) => {
    setShellSaving(true);
    setShellError(null);
    try {
      const response = await fetch('/api/tools/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      });
      const data = (await response.json()) as ToolSettingsResponse & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setShellSettings(data);
      if (sessionId) {
        await sendAgentCommand(sessionId, { type: 'reload' });
        onSessionReloaded();
      }
    } catch (cause) {
      setShellError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setShellSaving(false);
    }
  };

  const registerPush = async () => {
    if (pushRegistering) return;
    setPushRegistering(true);
    setPushStatus(null);
    try {
      if (typeof window === 'undefined' || !('Notification' in window)) {
        throw new Error('unsupported or not permitted');
      }
      const permission =
        Notification.permission === 'default'
          ? await Notification.requestPermission()
          : Notification.permission;
      if (permission !== 'granted') throw new Error('unsupported or not permitted');
      const ok = await setupPushSubscription(locale);
      if (!ok) throw new Error('unsupported or not permitted');
      setPushStatus({ kind: 'ok', message: t('settings.pushRegistered') });
    } catch (cause) {
      setPushStatus({
        kind: 'error',
        message: `${t('settings.pushRegisterFailed')} ${cause instanceof Error ? cause.message : String(cause)}`
      });
    } finally {
      setPushRegistering(false);
    }
  };

  return (
    <div className="settings-general">
      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t('settings.chat')}</h3>
        <div className="settings-chat-options">
          <div
            id="settings-transcript-tool-cards"
            className="settings-chat-option settings-chat-switch-option"
          >
            <span>{t('settings.transcriptToolCards')}</span>
            <ConfigSwitch
              checked={toolDisplay === 'cards'}
              label={t('settings.transcriptToolCards')}
              describedBy="settings-transcript-tool-cards-description"
              onChange={(enabled) => setTranscriptToolDisplay(enabled ? 'cards' : 'conversation')}
            />
          </div>
          <div
            id="settings-quote-selection"
            className="settings-chat-option settings-chat-switch-option"
          >
            <span>{t('settings.quoteSelection')}</span>
            <ConfigSwitch
              checked={quoteSelectionEnabled}
              label={t('settings.quoteSelection')}
              onChange={onQuoteSelectionChange}
            />
          </div>
          <div
            id="settings-diff-layout"
            className="settings-chat-option settings-chat-switch-option"
          >
            <span>{t('settings.diffSideBySide')}</span>
            <ConfigSwitch
              checked={diffSideBySide}
              label={t('settings.diffSideBySide')}
              describedBy="settings-diff-layout-description"
              onChange={setDiffSideBySide}
            />
          </div>
          <div
            className="settings-chat-option settings-chat-switch-option"
            id="settings-send-key"
            role="radiogroup"
            aria-label={t('settings.enterSendMode')}
          >
            <span>{t('settings.enterSendMode')}</span>
            <div className="settings-send-mode-options">
              <label className="settings-send-mode-option">
                <input
                  type="radio"
                  name="enter-send-mode"
                  value="enter"
                  checked={enterSendMode === 'enter'}
                  onChange={() => setEnterSendMode('enter')}
                  className="sr-only"
                />
                <span className="settings-send-mode-label">{t('settings.enterSendModeEnter')}</span>
              </label>
              <label className="settings-send-mode-option">
                <input
                  type="radio"
                  name="enter-send-mode"
                  value="ctrlEnter"
                  checked={enterSendMode === 'ctrlEnter'}
                  onChange={() => setEnterSendMode('ctrlEnter')}
                  className="sr-only"
                />
                <span className="settings-send-mode-label">
                  {t('settings.enterSendModeCtrlEnter')}
                </span>
              </label>
            </div>
          </div>
          <div
            id="settings-cache-notices"
            className="settings-chat-option settings-chat-switch-option"
          >
            <span>{t('settings.cacheMissNotices')}</span>
            <ConfigSwitch
              checked={cacheMissNotices === true}
              loading={
                (cacheMissNotices === null && !cacheMissNoticesError) || cacheMissNoticesSaving
              }
              label={t('settings.cacheMissNotices')}
              describedBy="settings-cache-miss-notices-description"
              onChange={(enabled) => void toggleCacheMissNotices(enabled)}
            />
          </div>
        </div>
        <p id="settings-transcript-tool-cards-description" className="settings-general-description">
          {t('settings.transcriptToolCardsDescription')}
        </p>
        <p id="settings-diff-layout-description" className="settings-general-description">
          {t('settings.diffSideBySideDescription')}
        </p>
        <p id="settings-cache-miss-notices-description" className="settings-general-description">
          {t('settings.cacheMissNoticesDescription')}
        </p>
        {cacheMissNoticesError && (
          <p role="alert" className="settings-general-error">
            {cacheMissNoticesError}
          </p>
        )}
      </section>

      {shellSettings?.isWindows && (
        <section className="settings-general-section">
          <h3 className="settings-general-heading">{t('settings.shellTool')}</h3>
          <p className="settings-general-description">{t('settings.shellToolDescription')}</p>
          <div id="settings-shell" className="settings-shell-option">
            <span>{t('settings.usePowerShell')}</span>
            <ConfigSwitch
              checked={shellSettings.powerShellEnabled}
              loading={shellSaving}
              label={t('settings.usePowerShell')}
              onChange={(enabled) => void togglePowerShell(enabled)}
            />
          </div>
          {shellError && (
            <p role="alert" className="settings-general-error">
              {shellError}
            </p>
          )}
        </section>
      )}

      <section id="settings-push" className="settings-general-section">
        <h3 className="settings-general-heading">{t('settings.pushPermission')}</h3>
        <p className="settings-general-description">{t('settings.pushPermissionDescription')}</p>
        <div className="settings-shell-option">
          <span>{t('settings.pushPermission')}</span>
          <button
            type="button"
            className="config-button config-button-small config-button-secondary"
            disabled={pushRegistering}
            onClick={() => void registerPush()}
          >
            {pushRegistering ? t('settings.pushRegisterLoading') : t('settings.pushRegister')}
          </button>
        </div>
        {pushStatus && (
          <p
            role="status"
            className="settings-general-error"
            style={pushStatus.kind === 'ok' ? { color: 'var(--accent)' } : undefined}
          >
            {pushStatus.message}
          </p>
        )}
      </section>

      <section id="settings-language" className="settings-general-section">
        <h3 className="settings-general-heading">{t('common.language')}</h3>
        <div
          role="radiogroup"
          aria-label={t('common.language')}
          className="settings-language-options"
        >
          {supportedLocales.map((plugin) => {
            const selected = locale === plugin.id;
            return (
              <button
                key={plugin.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setLocale(plugin.id as typeof locale)}
                className="settings-language-option"
              >
                <span className="settings-language-radio">
                  {selected && <span className="settings-language-radio-dot" />}
                </span>
                <span className="settings-language-label">{plugin.label}</span>
                <span className="settings-language-code">{plugin.id}</span>
              </button>
            );
          })}
        </div>
      </section>

      {webAuthEnabled && (
        <section className="settings-general-section">
          <ConfigButton
            id="settings-logout"
            variant="secondary"
            disabled={loggingOut}
            onClick={() => void logOut()}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M10 17l5-5-5-5M15 12H3M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
            </svg>
            {loggingOut ? t('auth.loggingOut') : t('auth.logOut')}
          </ConfigButton>
          {logoutError && (
            <p role="alert" className="settings-general-error">
              {logoutError}
            </p>
          )}
        </section>
      )}
    </div>
  );
}

export function SettingsPanel({
  cwd,
  sessionId,
  initialSection,
  onClose,
  onSessionReloaded,
  quoteSelectionEnabled,
  onQuoteSelectionChange,
  projectTrust,
  onOpenTrustDialog,
  onProjectTrustChanged,
  onToolPresetsChanged,
  availableTools,
  toolsLoading
}: Props) {
  const { t } = useI18n();
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [searchTarget, setSearchTarget] = useState<SettingsSearchEntry | null>(null);
  const [mountedSections, setMountedSections] = useState<ReadonlySet<SettingsSection>>(
    () => new Set([section])
  );
  // Which sections need a project is decided once, in lib/settings-navigation.ts.
  const sections: { id: SettingsSection; label: string; requiresProject: boolean }[] = (
    [
      { id: 'general', label: t('settings.general') },
      { id: 'instructions', label: t('settings.globalInstructions') },
      { id: 'appearance', label: t('settings.appearance') },
      { id: 'models', label: t('common.models') },
      { id: 'tools', label: t('settings.tools') },
      { id: 'skills', label: t('common.skills') },
      { id: 'plugins', label: t('common.plugins') },
      { id: 'mcp', label: t('settings.mcp') }
    ] as const
  ).map((item) => ({ ...item, requiresProject: settingsSectionRequiresProject(item.id) }));
  const sectionRequiresProject = settingsSectionRequiresProject(section);

  useEffect(() => setLastSettingsSection(initialSection), [initialSection]);

  // Bubble phase, unless something nearer handled the key. The trust dialog,
  // which opens above Settings, takes Escape in the capture phase and stops it,
  // so one Escape closes that dialog and leaves Settings open.
  useEffect(() => listenForPanelEscape(document, onClose), [onClose]);

  // Focus moves into Settings as it opens and back to what had it once it closes. Left
  // on the chat composer (a bare /mcp opens Settings from there), Escape would reach the
  // composer first and stop a running agent, which also kept Settings open. A layout
  // effect, so the opener is read before a section focuses its own search box.
  const dialogRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(
    () =>
      focusModalPanel(document, dialogRef.current, {
        restoreTextEntry: !window.matchMedia?.('(pointer: coarse)').matches
      }),
    []
  );

  useEffect(() => {
    if (cwd || !sectionRequiresProject) return;
    setSection('general');
    setMountedSections((current) => new Set(current).add('general'));
    setLastSettingsSection('general');
  }, [cwd, sectionRequiresProject]);

  const activateSection = (nextSection: SettingsSection) => {
    setMountedSections((current) => new Set(current).add(nextSection));
    setSection(nextSection);
    setLastSettingsSection(nextSection);
  };

  useLayoutEffect(() => {
    if (!searchTarget || searchTarget.section !== section) return;
    const host = dialogRef.current?.querySelector<HTMLElement>(
      '[data-settings-section="' + searchTarget.section + '"]'
    );
    if (!host) return;
    let highlighted: HTMLElement | null = null;
    let highlightTimeout: number | undefined;
    const reveal = () => {
      const target = searchTarget.target ? document.getElementById(searchTarget.target) : host;
      if (!target || !host.contains(target)) return false;
      const disclosure = target.closest('details') ?? target.querySelector('details');
      if (disclosure) disclosure.open = true;
      const focusTarget = target.matches('input, select, button, [tabindex]')
        ? target
        : (target.querySelector<HTMLElement>('input, select, button') ?? target);
      if (focusTarget.matches(':disabled')) return false;
      if (!focusTarget.hasAttribute('tabindex') && !focusTarget.matches('input, select, button'))
        focusTarget.tabIndex = -1;
      target.scrollIntoView({ block: 'center', behavior: 'instant' });
      focusTarget.focus({ preventScroll: true });
      highlighted =
        target.closest<HTMLElement>(
          '.appearance-range, .appearance-font-group, .settings-general-section, .settings-chat-option'
        ) ?? target;
      highlighted.classList.add('settings-search-highlight');
      highlightTimeout = window.setTimeout(
        () => highlighted?.classList.remove('settings-search-highlight'),
        2400
      );
      return true;
    };
    // Conditional general controls can arrive after their availability request.
    const observer = new MutationObserver(() => {
      if (reveal()) observer.disconnect();
    });
    if (!reveal())
      observer.observe(host, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['disabled']
      });
    const timeout = window.setTimeout(() => {
      observer.disconnect();
      highlighted?.classList.remove('settings-search-highlight');
    }, 10000);
    return () => {
      observer.disconnect();
      window.clearTimeout(timeout);
      window.clearTimeout(highlightTimeout);
      highlighted?.classList.remove('settings-search-highlight');
    };
  }, [searchTarget, section]);

  const selectSearchResult = (entry: SettingsSearchEntry) => {
    activateSection(entry.section);
    setSearchTarget({ ...entry });
  };

  const sectionHost = (id: SettingsSection, content: ReactNode) =>
    mountedSections.has(id) ? (
      <div
        key={id}
        hidden={section !== id}
        data-settings-section={id}
        className="settings-section-host"
      >
        {content}
      </div>
    ) : null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t('settings.title')}
      tabIndex={-1}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="settings-dialog-backdrop"
    >
      <div className="settings-dialog-surface">
        <div className="settings-dialog-header">
          <strong className="settings-dialog-title">{t('settings.title')}</strong>
          <select
            aria-label={t('settings.title')}
            value={section}
            onChange={(event) => activateSection(event.target.value as SettingsSection)}
            className="settings-mobile-section-picker"
          >
            {sections.map((item) => (
              <option key={item.id} value={item.id} disabled={item.requiresProject && !cwd}>
                {item.label}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={onClose}
            title={t('i18n.close')}
            aria-label={t('i18n.close')}
            className="config-close-button settings-dialog-close"
          >
            ×
          </button>
        </div>

        <SettingsSearch cwd={cwd} onSelect={selectSearchResult} />
        <div className="settings-dialog-body">
          <nav aria-label={t('settings.title')} className="settings-section-tabs">
            {sections.map((item) => {
              const selected = section === item.id;
              const disabled = item.requiresProject && !cwd;
              return (
                <button
                  key={item.id}
                  type="button"
                  className="settings-section-tab"
                  disabled={disabled}
                  title={disabled ? t('settings.projectRequired') : item.label}
                  aria-current={selected ? 'page' : undefined}
                  onClick={() => activateSection(item.id)}
                >
                  <SettingsSectionIcon section={item.id} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
          <main className="settings-dialog-main">
            {sectionHost(
              'general',
              <GeneralSettings
                sessionId={sessionId}
                onSessionReloaded={onSessionReloaded}
                quoteSelectionEnabled={quoteSelectionEnabled}
                onQuoteSelectionChange={onQuoteSelectionChange}
              />
            )}
            {sectionHost('appearance', <AppearanceSettings />)}
            {sectionHost(
              'instructions',
              <GlobalAgentsConfig
                embedded
                sessionId={sessionId}
                onClose={onClose}
                onReloaded={onSessionReloaded}
              />
            )}
            {sectionHost('models', <ModelsConfig embedded cwd={cwd} onClose={onClose} />)}
            {/* No project needed: the custom presets are global, like the composer's other presets. */}
            {sectionHost(
              'tools',
              <ToolPresetsSettings
                embedded
                onClose={onClose}
                onSaved={() => onToolPresetsChanged?.()}
                availableTools={availableTools}
                toolsLoading={toolsLoading}
              />
            )}
            {/* Visited sections stay mounted, so the ones whose answer depends on trust take the page's
              status and load again in place when trusting from Settings › MCP changes it. */}
            {cwd &&
              sectionHost(
                'skills',
                <SkillsConfig embedded key={cwd} cwd={cwd} trust={projectTrust} onClose={onClose} />
              )}
            {cwd &&
              sectionHost(
                'plugins',
                <PluginsConfig
                  embedded
                  key={cwd}
                  cwd={cwd}
                  sessionId={sessionId}
                  trust={projectTrust}
                  onClose={onClose}
                  onReloaded={onSessionReloaded}
                />
              )}
            {/* No project needed: the global mcp.json is listed alone, and a project adds its group. */}
            {sectionHost(
              'mcp',
              <McpConfig
                embedded
                key={cwd ?? ''}
                cwd={cwd}
                trust={projectTrust}
                onTrustProject={onOpenTrustDialog}
                onProjectTrustChanged={onProjectTrustChanged}
                onClose={onClose}
              />
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
