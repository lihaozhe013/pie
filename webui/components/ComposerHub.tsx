import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CompactResultInfo } from '@/hooks/useAgentSession';
import { useI18n } from '@/hooks/useI18n';
import { compactSummaryText } from '@/lib/compact-summary';
import { formatCompactCount } from '@/lib/session-stats-format';
import type { GoalAction, GoalFacts } from '@/lib/goal-driver';
import { GoalSection } from './GoalSection';

/** What the composer can say about the session's context window. */
export interface ContextUsageSummary {
  percent: number | null;
  contextWindow: number;
  tokens: number | null;
}

/** The dialog's two levels: the choices, and the goal's own page. */
type HubView = 'options' | 'goal';

/**
 * One entry for the controls that act on the whole session instead of one
 * prompt: the goal the agent keeps working toward, and compaction of the
 * context. Neither is a per-turn knob, so neither takes an always-visible slot.
 *
 * The entry stays in the footer only as an opener, and the dialog holds the
 * choices in the shape the sidebar's "New" dialog uses, **Compact** and
 * **Goal**. Compaction is one action, so it happens from its card; a goal is
 * written and managed, so its card opens a second step holding the goal.
 */
export function ComposerHub({
  goal,
  running,
  onGoalCommand,
  onGoalStop,
  onCompact,
  onAbortCompaction,
  isCompacting,
  compactResult,
  contextUsage
}: {
  goal?: GoalFacts;
  /** The selected session is streaming. */
  running: boolean;
  /** Sends a goal command; without it the goal card is not offered. */
  onGoalCommand?: (action: GoalAction, objective?: string) => void;
  /** Stops the running agent, which also pauses an active goal. */
  onGoalStop?: () => void;
  onCompact?: () => void;
  onAbortCompaction?: () => void;
  isCompacting?: boolean;
  compactResult?: CompactResultInfo | null;
  contextUsage?: ContextUsageSummary | null;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<HubView>('options');
  const [mounted, setMounted] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const compactRef = useRef<HTMLButtonElement>(null);
  const goalRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const goalHintId = useId();
  const choicesId = useId();
  const compactId = useId();
  const compactStateId = useId();
  const goalChoiceId = useId();

  // A goal is the one subject that needs a second step; with nothing to compact
  // it is also the only subject, so the entry opens straight onto it.
  const goalOnly = Boolean(onGoalCommand) && !onCompact;

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open || view !== 'goal') return;
    // The section focuses its own field, so the dialog only takes focus when
    // there is no field to land on.
    if (!goal || running || goal.status === 'active') dialogRef.current?.focus();
  }, [open, view, goal, running]);

  useEffect(() => {
    if (!open || view !== 'options') return;
    // The choices are the page: focus the first one that can be used, so Tab
    // order follows what is read first and a held session never eats the focus.
    const first =
      compactRef.current && !compactRef.current.disabled ? compactRef.current : goalRef.current;
    (first ?? dialogRef.current)?.focus();
  }, [open, view]);

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      className="composer-hub-trigger"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={t('chat.hubTitle')}
      title={t('chat.hubTitle')}
      onClick={() => {
        setView(goalOnly ? 'goal' : 'options');
        setOpen(true);
      }}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="1" />
        <circle cx="5" cy="12" r="1" />
        <circle cx="19" cy="12" r="1" />
      </svg>
    </button>
  );

  if (!open || !mounted) return trigger;

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const usageText =
    contextUsage &&
    contextUsage.contextWindow > 0 &&
    contextUsage.tokens !== null &&
    contextUsage.percent !== null
      ? t('chat.hubContextUsage', {
          window: formatCompactCount(contextUsage.contextWindow),
          percent: Math.round(contextUsage.percent)
        })
      : t('chat.hubContextUnknown');

  const compactTitle = isCompacting ? t('chat.stopCompaction') : t('chat.compactContext');
  // A running session holds the context, so compaction waits for idle — except
  // that the run holding it can be the compaction itself.
  const compactBusy = running && !isCompacting;

  return (
    <>
      {trigger}
      {createPortal(
        <div
          className="composer-hub-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) close();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              // One level at a time: Escape leaves the goal first, the dialog second.
              if (view === 'goal' && !goalOnly) {
                setView('options');
                return;
              }
              close();
              return;
            }
            if (event.key !== 'Tab') return;
            const controls = Array.from(
              dialogRef.current?.querySelectorAll<HTMLElement>(
                'button:not(:disabled), textarea:not(:disabled), [href]'
              ) ?? []
            );
            const first = controls[0];
            const last = controls.at(-1);
            if (!first || !last) return;
            if (
              event.shiftKey &&
              (document.activeElement === first || document.activeElement === dialogRef.current)
            ) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }}
        >
          <div
            ref={dialogRef}
            className="composer-hub-dialog"
            data-view={view}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={view === 'goal' ? goalHintId : choicesId}
            tabIndex={-1}
          >
            {view === 'goal' ? (
              <>
                <header className="composer-hub-header">
                  <div className="composer-hub-heading">
                    {!goalOnly && (
                      <button
                        type="button"
                        className="composer-hub-back"
                        onClick={() => setView('options')}
                        aria-label={t('chat.hubBack')}
                        title={t('chat.hubBack')}
                      >
                        <svg
                          width="15"
                          height="15"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M15 5l-7 7 7 7" />
                        </svg>
                      </button>
                    )}
                    <div>
                      <h2 id={titleId}>{t('chat.goal')}</h2>
                      <p id={goalHintId}>{t('chat.goalDialogDescription')}</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="composer-hub-close"
                    onClick={close}
                    aria-label={t('i18n.close')}
                    title={t('i18n.close')}
                  >
                    ×
                  </button>
                </header>

                <div className="composer-hub-body">
                  {onGoalCommand && (
                    <div className="composer-hub-section">
                      <GoalSection
                        goal={goal}
                        running={running}
                        busy={running}
                        focusObjective={!goal || (!running && goal.status !== 'active')}
                        onCommand={onGoalCommand}
                        onStop={() => onGoalStop?.()}
                      />
                    </div>
                  )}
                </div>
              </>
            ) : (
              <>
                <header className="composer-hub-header">
                  <div className="composer-hub-heading">
                    <div>
                      <h2 id={titleId}>{t('chat.hubTitle')}</h2>
                      <p id={choicesId}>{t('chat.hubChooserDescription')}</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="composer-hub-close"
                    onClick={close}
                    aria-label={t('i18n.close')}
                    title={t('i18n.close')}
                  >
                    ×
                  </button>
                </header>

                <div className="composer-hub-body">
                  <div className="composer-hub-options">
                    {onCompact && (
                      <button
                        ref={compactRef}
                        type="button"
                        className="composer-hub-choice"
                        disabled={compactBusy}
                        title={t('chat.hubContextDescription')}
                        aria-label={compactTitle}
                        aria-describedby={`${compactId} ${compactStateId}`}
                        onClick={() => {
                          if (isCompacting) onAbortCompaction?.();
                          else onCompact();
                          close();
                        }}
                      >
                        <span className="composer-hub-choice-icon" aria-hidden="true">
                          <svg
                            width="20"
                            height="20"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.9"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M4 8h16M4 16h16" />
                            <path d="M9 4l-3 4 3 4M15 12l3 4-3 4" />
                          </svg>
                        </span>
                        <span className="composer-hub-choice-title">{compactTitle}</span>
                        <span id={compactId} className="composer-hub-choice-description">
                          {compactBusy ? t('chat.hubCompactBusy') : t('chat.hubContextDescription')}
                        </span>
                        <span id={compactStateId} className="composer-hub-choice-meta">
                          {usageText}
                          {compactResult && (
                            <span className="composer-hub-choice-note">
                              {compactSummaryText(compactResult, t)}
                            </span>
                          )}
                        </span>
                      </button>
                    )}

                    {onGoalCommand && (
                      <button
                        ref={goalRef}
                        type="button"
                        className="composer-hub-choice"
                        aria-describedby={goalChoiceId}
                        onClick={() => setView('goal')}
                      >
                        <span className="composer-hub-choice-icon" aria-hidden="true">
                          <svg
                            width="20"
                            height="20"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.9"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <circle cx="12" cy="12" r="8" />
                            <circle cx="12" cy="12" r="2.5" />
                          </svg>
                        </span>
                        <span className="composer-hub-choice-title">{t('chat.goal')}</span>
                        <span id={goalChoiceId} className="composer-hub-choice-description">
                          {goal?.objective || t('chat.goalDialogDescription')}
                        </span>
                      </button>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
