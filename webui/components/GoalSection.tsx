import { useId, useRef, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import {
  MAX_GOAL_OBJECTIVE_CHARS,
  goalPhase,
  type GoalAction,
  type GoalFacts
} from '@/lib/goal-driver';

/** The package's own status words, and the label each one reads as. */
const STATUS_LABELS: Record<string, string> = {
  active: 'chat.goalStatus.active',
  paused: 'chat.goalStatus.paused',
  complete: 'chat.goalStatus.done',
  budgetLimited: 'chat.goalStatus.budgetLimited'
};

/**
 * The goal inside the composer hub: where a goal is written, and where the
 * package's goal is paused, resumed, finished or cleared.
 *
 * The loop belongs to the installed package, so this section only sends its
 * `/goal` commands and reports what the package wrote. It owns no dialog
 * chrome — the hub does — and it mounts fresh each time the hub opens, so a
 * draft never outlives a visit.
 */
export function GoalSection({
  goal,
  running,
  busy,
  focusObjective,
  onCommand,
  onStop
}: {
  goal?: GoalFacts;
  /** The selected session is streaming: the run can be stopped, changes wait. */
  running: boolean;
  /** Any work is in flight, including shell commands; goal changes wait for idle. */
  busy: boolean;
  /** The hub opened with the goal section as its subject. */
  focusObjective: boolean;
  onCommand: (action: GoalAction, objective?: string) => void;
  onStop: () => void;
}) {
  const { t } = useI18n();
  const [objective, setObjective] = useState(() => goal?.objective ?? '');
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const objectiveId = useId();
  const hintId = useId();
  const errorId = useId();

  const phase = goalPhase(goal);
  // A running goal is the package's to steer: its objective changes once the
  // person pauses it, so an edit cannot move the target under the run.
  const editable = !busy && phase !== 'running';
  // A word this code does not know is shown as the package wrote it, because a
  // goal that exists must still read as one.
  const status = goal
    ? STATUS_LABELS[goal.status]
      ? t(STATUS_LABELS[goal.status])
      : goal.status
    : null;
  const tokens =
    goal?.tokensUsed !== undefined
      ? goal.tokenBudget
        ? t('chat.goalTokensOfBudget', {
            used: goal.tokensUsed.toLocaleString('en-US'),
            budget: goal.tokenBudget.toLocaleString('en-US')
          })
        : t('chat.goalTokens', { used: goal.tokensUsed.toLocaleString('en-US') })
      : null;

  const start = () => {
    if (!objective.trim()) {
      setError(t('chat.goalObjectiveRequired'));
      textareaRef.current?.focus();
      return;
    }
    onCommand('start', objective.trim());
  };

  return (
    <>
      {goal && (
        <div className="goal-current" data-state={goal.status}>
          <span className="goal-current-status">{status}</span>
          {tokens && <span className="goal-current-meta">{tokens}</span>}
        </div>
      )}

      <div className="goal-field">
        <label htmlFor={objectiveId}>{t('chat.goalObjective')}</label>
        <textarea
          id={objectiveId}
          ref={textareaRef}
          value={objective}
          disabled={!editable}
          autoFocus={focusObjective}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${hintId} ${errorId}` : hintId}
          maxLength={MAX_GOAL_OBJECTIVE_CHARS}
          rows={3}
          onChange={(event) => {
            setObjective(event.target.value);
            if (error) setError(null);
          }}
          onBlur={() => {
            if (!objective.trim()) setError(t('chat.goalObjectiveRequired'));
          }}
        />
        <p className="goal-hint" id={hintId}>
          {!editable && goal ? t('chat.goalLocked') : t('chat.goalObjectiveHint')}
        </p>
        {error && (
          <p className="goal-error" id={errorId} role="alert">
            {error}
          </p>
        )}
      </div>

      {busy && <p className="goal-hint">{t('chat.goalBusy')}</p>}

      <div className="composer-hub-actions">
        {running && phase === 'running' && (
          <button type="button" className="hub-button hub-button-quiet" onClick={onStop}>
            {t('chat.goalStopRun')}
          </button>
        )}
        {goal && (
          <>
            {phase === 'running' && !running && (
              <button
                type="button"
                className="hub-button hub-button-quiet"
                onClick={() => onCommand('pause')}
              >
                {t('chat.goalPause')}
              </button>
            )}
            {phase === 'waiting' && (
              <button type="button" className="hub-button" onClick={() => onCommand('resume')}>
                {t('chat.goalResume')}
              </button>
            )}
            {phase !== 'done' && (
              <button
                type="button"
                className="hub-button hub-button-quiet"
                onClick={() => onCommand('complete')}
              >
                {t('chat.goalComplete')}
              </button>
            )}
            <button
              type="button"
              className="hub-button hub-button-quiet"
              onClick={() => onCommand('clear')}
            >
              {t('chat.goalClear')}
            </button>
          </>
        )}
        <span className="composer-hub-actions-spacer" />
        <button
          type="button"
          className="hub-button hub-button-primary"
          disabled={!editable}
          onClick={start}
        >
          {goal ? t('chat.goalUpdate') : t('chat.goalStart')}
        </button>
      </div>
    </>
  );
}
