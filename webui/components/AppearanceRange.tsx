import { useEffect, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { ConfigButton } from './SettingsUi';

/** A slider and editable value sharing one bounded, persisted preference. */
export function AppearanceRange({
  id,
  label,
  description,
  value,
  min,
  max,
  step = 1,
  defaultValue,
  onChange
}: {
  id: string;
  label: string;
  description?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  defaultValue: number;
  onChange: (value: number) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const number = Number(draft);
    const next =
      draft.trim() && Number.isFinite(number)
        ? Math.max(min, Math.min(max, Math.round(number / step) * step))
        : value;
    setDraft(String(next));
    onChange(next);
  };
  return (
    <div className="appearance-range" id={`${id}-row`}>
      <div className="appearance-range-heading">
        <label htmlFor={id}>{label}</label>
        <div className="appearance-number">
          <input
            id={`${id}-value`}
            type="number"
            min={min}
            max={max}
            step={step}
            aria-label={label}
            aria-describedby={description ? `${id}-description` : undefined}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commit();
              }
            }}
          />
          <span aria-hidden="true">px</span>
        </div>
        <ConfigButton
          variant="ghost"
          size="small"
          disabled={value === defaultValue}
          aria-label={`${t('settings.reset')}: ${label}`}
          onClick={() => onChange(defaultValue)}
        >
          {t('settings.reset')}
        </ConfigButton>
      </div>
      {description && (
        <p id={`${id}-description`} className="settings-general-description">
          {description}
        </p>
      )}
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-describedby={description ? `${id}-description` : undefined}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}
