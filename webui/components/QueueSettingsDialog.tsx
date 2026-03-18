import { useState, type FormEvent } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { TASK_CONFIG_DEFAULTS, TASK_INSTRUCTIONS_MAX_LENGTH } from '@/lib/tasks/defaults';
import type { TaskConfig } from '@/lib/tasks/types';
import { ModelSelector, type ModelSelectorOption } from './ModelSelector';
import { SessionModal } from './SessionModal';

export interface QueueSettingsDialogProps {
  config: TaskConfig;
  modelOptions: ModelSelectorOption[];
  /** The CLI's own model, shown on the "default" row of the selector. */
  defaultModelLabel: string | null;
  onClose: () => void;
  /** Reload the board so the queue's chip and next run read the new value. */
  onSaved: () => void;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

type TimeoutUnit = 'minutes' | 'hours';

interface TimeoutDraft {
  amount: string;
  unit: TimeoutUnit;
  unlimited: boolean;
}

/** A stored millisecond value as the person last saw it: the largest unit that divides it. */
export function timeoutDraftFrom(ms: number | null, fallbackMs: number | null): TimeoutDraft {
  if (ms === null) {
    // No stored limit and no numeric fallback: the draft is unlimited, and the
    // number field stays empty until a limit is typed.
    if (fallbackMs === null) return { amount: '', unit: 'minutes', unlimited: true };
    const fallback = timeoutDraftFrom(fallbackMs, fallbackMs);
    return { ...fallback, unlimited: true };
  }
  const unit: TimeoutUnit = ms % HOUR_MS === 0 ? 'hours' : 'minutes';
  const divisor = unit === 'hours' ? HOUR_MS : MINUTE_MS;
  const amount = ms / divisor;
  return {
    amount: String(Number.isInteger(amount) ? amount : Number(amount.toFixed(2))),
    unit,
    unlimited: false
  };
}

/** The draft as milliseconds, or null when the person asked for no limit. */
export function timeoutMsFrom(draft: TimeoutDraft): number | null {
  if (draft.unlimited) return null;
  const amount = Number(draft.amount.trim());
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.round(amount * (draft.unit === 'hours' ? HOUR_MS : MINUTE_MS));
}

/**
 * One page for the global task defaults: the model, the two timeouts, the
 * verification commands, the autonomous switch, and the standing instructions
 * every task session carries. These are global on purpose: the useful choice is
 * whether the person is at the computer, not a different policy per project.
 */
export function QueueSettingsDialog({
  config,
  modelOptions,
  defaultModelLabel,
  onClose,
  onSaved
}: QueueSettingsDialogProps) {
  const { t } = useI18n();
  const [model, setModel] = useState<{ provider: string; modelId: string } | null>(config.model);
  const [taskTimeout, setTaskTimeout] = useState(() =>
    timeoutDraftFrom(config.taskTimeoutMs, TASK_CONFIG_DEFAULTS.taskTimeoutMs)
  );
  const [verifyTimeout, setVerifyTimeout] = useState(() =>
    timeoutDraftFrom(config.verifyTimeoutMs, TASK_CONFIG_DEFAULTS.verifyTimeoutMs)
  );
  const [commands, setCommands] = useState(() => config.verifyCommands.join('\n'));
  const [autonomous, setAutonomous] = useState(config.autonomous);
  const [instructions, setInstructions] = useState(config.instructions);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const timeoutValid = (draft: TimeoutDraft) => draft.unlimited || timeoutMsFrom(draft) !== null;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const taskTimeoutMs = timeoutMsFrom(taskTimeout);
    const verifyTimeoutMs = timeoutMsFrom(verifyTimeout);
    if (!timeoutValid(taskTimeout) || !timeoutValid(verifyTimeout)) {
      setProblem(t('tasks.timeoutInvalid'));
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      const response = await fetch('/api/tasks/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          taskTimeoutMs,
          verifyTimeoutMs,
          verifyCommands: commands
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean),
          autonomous,
          instructions: instructions.trim()
        })
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      onSaved();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      setSaving(false);
    }
  };

  /** Only fills the form: Save still decides, and Cancel leaves the stored defaults alone. */
  const restoreDefaults = () => {
    setModel(TASK_CONFIG_DEFAULTS.model);
    setTaskTimeout(
      timeoutDraftFrom(TASK_CONFIG_DEFAULTS.taskTimeoutMs, TASK_CONFIG_DEFAULTS.taskTimeoutMs)
    );
    setVerifyTimeout(
      timeoutDraftFrom(TASK_CONFIG_DEFAULTS.verifyTimeoutMs, TASK_CONFIG_DEFAULTS.verifyTimeoutMs)
    );
    setCommands(TASK_CONFIG_DEFAULTS.verifyCommands.join('\n'));
    setAutonomous(TASK_CONFIG_DEFAULTS.autonomous);
    setInstructions(TASK_CONFIG_DEFAULTS.instructions);
    setProblem(null);
  };

  const renderTimeout = (
    id: string,
    draft: TimeoutDraft,
    onChange: (next: TimeoutDraft) => void,
    label: string,
    hint: string
  ) => (
    <div className="task-field">
      <span id={`${id}-label`}>{label}</span>
      <div className="queue-settings-timeout" role="group" aria-labelledby={`${id}-label`}>
        {draft.unlimited ? (
          // The number is meaningless without a limit; showing the symbol where
          // the value lives makes the choice visible without reading the chip.
          <span className="queue-settings-infinity" aria-hidden="true">
            ∞
          </span>
        ) : (
          <input
            type="number"
            min="1"
            step="1"
            inputMode="decimal"
            aria-label={label}
            value={draft.amount}
            onChange={(event) => onChange({ ...draft, amount: event.target.value })}
          />
        )}
        <select
          aria-label={t('tasks.timeoutUnit')}
          value={draft.unit}
          disabled={draft.unlimited}
          onChange={(event) => {
            // Switching the unit converts the number, so the duration survives.
            const unit = event.target.value as TimeoutUnit;
            const amount = Number(draft.amount.trim());
            const converted =
              Number.isFinite(amount) && amount > 0
                ? unit === 'hours'
                  ? amount / 60
                  : amount * 60
                : amount;
            onChange({
              ...draft,
              unit,
              amount: Number.isFinite(converted)
                ? String(Number.isInteger(converted) ? converted : Number(converted.toFixed(2)))
                : draft.amount
            });
          }}
        >
          <option value="minutes">{t('tasks.minutes')}</option>
          <option value="hours">{t('tasks.hours')}</option>
        </select>
        <label className={`queue-settings-unlimited${draft.unlimited ? ' is-active' : ''}`}>
          <input
            type="checkbox"
            checked={draft.unlimited}
            onChange={(event) => onChange({ ...draft, unlimited: event.target.checked })}
          />
          <span>{t('tasks.noLimit')}</span>
        </label>
      </div>
      <span className="task-hint">{hint}</span>
    </div>
  );

  return (
    <SessionModal
      title={t('tasks.queueDefaults')}
      maxWidth={520}
      icon={
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h8M16 18h4" />
          <circle cx="16" cy="6" r="2" />
          <circle cx="10" cy="12" r="2" />
          <circle cx="14" cy="18" r="2" />
        </svg>
      }
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      {/* The form states its own problems under the field, not in a browser tooltip. */}
      <form className="queue-settings" noValidate onSubmit={(event) => void save(event)}>
        <p className="queue-settings-intro">{t('tasks.queueDefaultsHint')}</p>

        <section className="queue-settings-section">
          <h3>{t('tasks.model')}</h3>
          {modelOptions.length > 0 ? (
            <div className="queue-settings-field">
              <ModelSelector
                options={modelOptions}
                value={model}
                onChange={(provider, modelId) => setModel({ provider, modelId })}
                onClear={() => setModel(null)}
                emptyLabel={
                  defaultModelLabel
                    ? `${t('tasks.modelDefault')}: ${defaultModelLabel}`
                    : t('tasks.modelDefault')
                }
                ariaLabel={t('tasks.model')}
                variant="field"
                placement="auto"
              />
              <span className="task-hint">{t('tasks.modelHint')}</span>
            </div>
          ) : (
            <p className="task-hint">{t('tasks.modelUnavailable')}</p>
          )}
        </section>

        <section className="queue-settings-section">
          <h3>{t('tasks.limits')}</h3>
          {renderTimeout(
            'task-timeout',
            taskTimeout,
            setTaskTimeout,
            t('tasks.taskTimeout'),
            t('tasks.taskTimeoutHint')
          )}
          {renderTimeout(
            'verify-timeout',
            verifyTimeout,
            setVerifyTimeout,
            t('tasks.verifyTimeout'),
            t('tasks.verifyTimeoutHint')
          )}
        </section>

        <section className="queue-settings-section">
          <h3>{t('tasks.instructions')}</h3>
          <label className="task-field">
            <span className="sr-only">{t('tasks.instructions')}</span>
            <textarea
              rows={7}
              maxLength={TASK_INSTRUCTIONS_MAX_LENGTH}
              placeholder={t('tasks.instructionsPlaceholder')}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
            />
            <span className="task-hint">{t('tasks.instructionsHint')}</span>
          </label>
        </section>

        <section className="queue-settings-section">
          <h3>{t('tasks.verificationDefaults')}</h3>
          <label className="task-field">
            <span className="sr-only">{t('tasks.verifyCommandsLabel')}</span>
            <textarea
              className="task-mono"
              rows={3}
              placeholder={t('tasks.verifyCommandsHint')}
              value={commands}
              onChange={(event) => setCommands(event.target.value)}
            />
            <span className="task-hint">{t('tasks.verificationDefaultsHint')}</span>
          </label>
        </section>

        <section className="queue-settings-section">
          <h3>{t('tasks.mode')}</h3>
          <label className={`queue-settings-mode${autonomous ? ' is-active' : ''}`}>
            <span>
              <strong>{t('tasks.autonomous')}</strong>
              <span className="task-hint">{t('tasks.autonomousHint')}</span>
            </span>
            <input
              type="checkbox"
              aria-label={t('tasks.autonomous')}
              checked={autonomous}
              onChange={(event) => setAutonomous(event.target.checked)}
            />
          </label>
        </section>

        {problem && (
          <p className="task-field-error" role="alert">
            {problem}
          </p>
        )}

        <div className="queue-settings-actions">
          <button
            type="button"
            className="task-control queue-settings-restore"
            onClick={restoreDefaults}
            disabled={saving}
          >
            {t('tasks.restoreDefaults')}
          </button>
          <button type="submit" className="task-control is-primary" disabled={saving}>
            {saving ? t('tasks.saving') : t('tasks.save')}
          </button>
          <button type="button" className="task-control" onClick={onClose} disabled={saving}>
            {t('tasks.cancel')}
          </button>
        </div>
      </form>
    </SessionModal>
  );
}
