import { useI18n } from '@/hooks/useI18n';
import { useFontPreferences } from '@/hooks/useFontPreferences';
import {
  FONT_FAMILY_MAX_LENGTH,
  FONT_WEIGHT_OPTIONS,
  FONT_SIZE_DEFAULTS,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  DEFAULT_FONT_PREFERENCES
} from '@/lib/font-preferences';
import { AppearanceRange } from './AppearanceRange';
import { ConfigButton } from './SettingsUi';

const FONT_FIELDS = [
  {
    kind: 'ui',
    label: 'settings.uiFontFamily',
    placeholder: 'settings.uiFontPlaceholder',
    reset: 'settings.resetUiFont',
    weightLabel: 'settings.uiFontWeight',
    sizeLabel: 'settings.uiFontSize',
    description: 'settings.uiSizeDescription'
  },
  {
    kind: 'mono',
    label: 'settings.monoFontFamily',
    placeholder: 'settings.monoFontPlaceholder',
    reset: 'settings.resetMonoFont',
    weightLabel: 'settings.monoFontWeight',
    sizeLabel: 'settings.monoFontSize',
    description: 'settings.monoSizeDescription'
  }
] as const;

export function FontSettings() {
  const { t } = useI18n();
  const fonts = useFontPreferences();
  return (
    <div className="appearance-fonts">
      {FONT_FIELDS.map(
        ({ kind, label, placeholder, reset, weightLabel, sizeLabel, description }) => (
          <div key={kind} className="appearance-font-group">
            <div className="appearance-section-heading">
              <label htmlFor={`settings-font-${kind}`}>{t(label)}</label>
              <ConfigButton
                variant="ghost"
                size="small"
                aria-label={t(reset)}
                disabled={
                  !fonts[kind] &&
                  fonts[`${kind}Weight`] === DEFAULT_FONT_PREFERENCES[`${kind}Weight`] &&
                  fonts[`${kind}Size`] === FONT_SIZE_DEFAULTS[kind]
                }
                onClick={() => fonts.resetFontPreference(kind)}
              >
                {t('settings.reset')}
              </ConfigButton>
            </div>
            <p className="settings-general-description">{t(description)}</p>
            <input
              id={`settings-font-${kind}`}
              className={`settings-font-input${kind === 'mono' ? ' is-mono' : ''}`}
              type="text"
              value={fonts[kind]}
              placeholder={t(placeholder)}
              maxLength={FONT_FAMILY_MAX_LENGTH}
              aria-describedby="settings-typography-description"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => fonts.setFontPreference(kind, event.target.value)}
            />
            <div className="appearance-weight">
              <label htmlFor={`settings-font-${kind}-weight`}>{t(weightLabel)}</label>
              <select
                id={`settings-font-${kind}-weight`}
                value={fonts[`${kind}Weight`]}
                onChange={(event) => fonts.setFontWeight(kind, Number(event.target.value))}
              >
                {FONT_WEIGHT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {t(option.label)} ({option.value})
                  </option>
                ))}
              </select>
            </div>
            <AppearanceRange
              id={`settings-font-${kind}-size`}
              label={t(sizeLabel)}
              value={fonts[`${kind}Size`]}
              min={FONT_SIZE_MIN}
              max={FONT_SIZE_MAX}
              defaultValue={FONT_SIZE_DEFAULTS[kind]}
              onChange={(value) => fonts.setFontSize(kind, value)}
            />
          </div>
        )
      )}
    </div>
  );
}
