import { useI18n } from '@/hooks/useI18n';
import { formatCompactCount, formatCostShort } from '@/lib/session-stats-format';

/** The generate-title control reports its own progress in place. */
export interface SessionPanelNameAction {
  label: string;
  title: string;
  disabled: boolean;
  busy: boolean;
  tone: 'default' | 'success' | 'error';
}

export interface SessionPanelStats {
  tokens: { input: number; output: number; cacheRead: number } | null;
  cost: number;
  contextPercent: number | null;
  contextWindow: number | null;
  contextTokens?: number | null;
  /** The full breakdown, kept in the tooltip so the panel stays quiet. */
  tooltip: string;
}

export interface SessionPanelActionsProps {
  onOpenHistory: () => void;
  /** True when the session is not saved yet, so there is nothing to export. */
  historyDisabled: boolean;
  historyTitle: string;
  onGenerateTitle: () => void;
  name: SessionPanelNameAction;
  onOpenSystem: () => void;
  /** True once the prompt has loaded: the dialog opens with content. */
  systemLoaded: boolean;
  onOpenTools: () => void;
  /** True while at least one tool is active. */
  toolsActive: boolean;
  /** Null when the session has no branches to navigate. */
  onOpenBranches: (() => void) | null;
  stats: SessionPanelStats | null;
  onOpenStats: () => void;
}

function ActionButton({
  action,
  icon,
  label,
  title,
  disabled,
  loaded,
  opensDialog,
  tone,
  onClick
}: {
  action: string;
  icon: React.ReactNode;
  label: string;
  title: string;
  disabled?: boolean;
  /** The dialog has content to show; the icon takes the accent. */
  loaded?: boolean;
  /** True for the actions that open a modal; history opens its own window. */
  opensDialog?: boolean;
  tone?: 'default' | 'success' | 'error';
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="panel-action"
      data-panel-action={action}
      data-tone={tone && tone !== 'default' ? tone : undefined}
      disabled={disabled}
      title={title}
      aria-label={label}
      aria-haspopup={opensDialog ? 'dialog' : undefined}
      data-loaded={loaded ? 'true' : undefined}
      onClick={onClick}
    >
      {icon}
      <span className="panel-action-label">{label}</span>
    </button>
  );
}

function PenIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m15 4 5 5L7 22l-5-5Z" />
      <path d="m14 5 5 5" />
      <path d="M6 4V2M5 3H3M19 19v3M17.5 20.5h3" />
    </svg>
  );
}

/**
 * The session controls that used to sit in the page toolbar.
 *
 * They live in the Runs panel now because they describe the session rather than
 * the next message: what it printed, what it is called, what it was told, what
 * it can call, and what it has spent. The panel is part of the default page, so
 * none of this is buried behind an extra click on a wide screen; on a phone the
 * panel is one toggle away.
 */
export function SessionPanelActions({
  onOpenHistory,
  historyDisabled,
  historyTitle,
  onGenerateTitle,
  name,
  onOpenSystem,
  systemLoaded,
  onOpenTools,
  toolsActive,
  onOpenBranches,
  stats,
  onOpenStats
}: SessionPanelActionsProps) {
  const { t } = useI18n();

  const contextTokens =
    stats?.contextTokens ??
    (stats?.contextPercent !== null && stats?.contextPercent !== undefined && stats?.contextWindow
      ? Math.round((stats.contextPercent / 100) * stats.contextWindow)
      : null);
  const contextPercent =
    stats?.contextPercent ??
    (stats?.contextTokens !== null && stats?.contextTokens !== undefined && stats?.contextWindow
      ? (stats.contextTokens / stats.contextWindow) * 100
      : null);

  const contextLevel =
    contextPercent === null || contextPercent === undefined
      ? null
      : contextPercent > 90
        ? 'danger'
        : contextPercent > 70
          ? 'warn'
          : 'ok';
  const costText = stats ? formatCostShort(stats.cost) : null;

  return (
    <section className="panel-actions" aria-label={t('panel.sessionActions')}>
      <div className="panel-actions-grid">
        <ActionButton
          action="history"
          icon={
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
              <path d="M3 3v5h5" />
              <path d="M12 7v5l3 2" />
            </svg>
          }
          label={t('history.label')}
          title={historyTitle}
          disabled={historyDisabled}
          onClick={onOpenHistory}
        />
        <ActionButton
          action="name"
          icon={
            name.busy ? (
              <svg
                className="animate-spin"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r="9"
                  stroke="currentColor"
                  strokeWidth="2"
                  opacity="0.25"
                />
                <path
                  d="M21 12a9 9 0 0 0-9-9"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            ) : name.tone === 'success' ? (
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <PenIcon />
            )
          }
          label={name.label}
          title={name.title}
          disabled={name.disabled}
          tone={name.tone}
          onClick={onGenerateTitle}
        />
        <ActionButton
          action="system"
          icon={
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="8" y1="13" x2="16" y2="13" />
              <line x1="8" y1="17" x2="13" y2="17" />
            </svg>
          }
          label={t('system.label')}
          title={systemLoaded ? t('system.prompt') : t('system.load')}
          loaded={systemLoaded}
          opensDialog
          onClick={onOpenSystem}
        />
        <ActionButton
          action="tools"
          icon={
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z" />
            </svg>
          }
          label={t('tools.label')}
          title={t('tools.title')}
          loaded={toolsActive}
          opensDialog
          onClick={onOpenTools}
        />
        {onOpenBranches && (
          <ActionButton
            action="branches"
            icon={
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="6" y1="3" x2="6" y2="15" />
                <circle cx="18" cy="6" r="3" />
                <circle cx="6" cy="18" r="3" />
                <path d="M18 9a9 9 0 0 1-9 9" />
              </svg>
            }
            label={t('i18n.branches')}
            title={t('i18n.branches')}
            opensDialog
            onClick={onOpenBranches}
          />
        )}
      </div>

      {stats && (
        <button
          type="button"
          className="panel-stats"
          data-panel-action="stats"
          title={stats.tooltip || t('session.title')}
          aria-label={t('session.title')}
          aria-haspopup="dialog"
          onClick={onOpenStats}
        >
          <span className="panel-stats-grid">
            {stats.tokens && (
              <>
                <span className="panel-stats-cell">
                  <span className="panel-stats-label">{t('session.input')}</span>
                  <span className="panel-stats-value">
                    {formatCompactCount(stats.tokens.input)}
                  </span>
                </span>
                <span className="panel-stats-cell">
                  <span className="panel-stats-label">{t('session.output')}</span>
                  <span className="panel-stats-value">
                    {formatCompactCount(stats.tokens.output)}
                  </span>
                </span>
                <span className="panel-stats-cell">
                  <span className="panel-stats-label">{t('session.cacheRead')}</span>
                  <span className="panel-stats-value">
                    {formatCompactCount(stats.tokens.cacheRead)}
                  </span>
                </span>
              </>
            )}
            <span className="panel-stats-cell">
              <span className="panel-stats-label">{t('session.cost')}</span>
              <span className="panel-stats-value" data-emphasis={costText ? 'true' : undefined}>
                {costText ?? '—'}
              </span>
            </span>
          </span>
          {contextTokens !== null && stats.contextWindow !== null && (
            <span className="panel-stats-context">
              <span className="panel-stats-context-row">
                <span className="panel-stats-label">{t('session.context')}</span>
                <span className="panel-stats-value" data-tone={contextLevel ?? undefined}>
                  {formatCompactCount(contextTokens)} / {formatCompactCount(stats.contextWindow)}
                </span>
              </span>
              <span className="panel-stats-bar" aria-hidden="true">
                <span
                  className="panel-stats-bar-fill"
                  data-tone={contextLevel ?? undefined}
                  style={{ width: `${Math.min(100, Math.max(0, contextPercent ?? 0))}%` }}
                />
              </span>
            </span>
          )}
        </button>
      )}
    </section>
  );
}
