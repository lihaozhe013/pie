import {
  CHAT_CONTENT_FONT_SIZE_DEFAULT,
  CHAT_CONTENT_FONT_SIZE_MIN,
  CHAT_CONTENT_FONT_SIZE_MAX,
  CHAT_CONTENT_WIDTH_DEFAULT,
  CHAT_CONTENT_WIDTH_MIN,
  CHAT_CONTENT_WIDTH_MAX,
  useChatAppearance
} from '@/hooks/useChatAppearance';
import { useFontPreferences } from '@/hooks/useFontPreferences';
import { useI18n } from '@/hooks/useI18n';
import { useTheme } from '@/hooks/useTheme';
import { THEME_OPTIONS } from '@/lib/theme.mts';
import { AppearanceRange } from './AppearanceRange';
import { FontSettings } from './FontSettings';
import { MarkdownBody } from './MarkdownBody';
import { ConfigButton } from './SettingsUi';

export function AppearanceSettings() {
  const { t } = useI18n();
  const { preference, setThemePreference } = useTheme();
  const { width, setWidth, fontSize, setFontSize } = useChatAppearance();
  const fonts = useFontPreferences();
  const selectedTheme = THEME_OPTIONS.find((option) => option.id === preference)!;
  return (
    <div className="settings-general settings-appearance">
      <header className="appearance-page-heading">
        <h2>{t('settings.appearance')}</h2>
        <p className="settings-general-description">{t('settings.appearanceIntro')}</p>
      </header>
      <section id="settings-theme" tabIndex={-1} className="settings-general-section">
        <details className="appearance-theme-picker">
          <summary>
            <span>{t('settings.theme')}</span>
            <span className="appearance-current-theme">
              <span
                data-theme={preference === 'auto' ? undefined : preference}
                className="settings-theme-chip"
                aria-hidden="true"
              />
              {t(selectedTheme.label)}
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                aria-hidden="true"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </span>
          </summary>
          <div
            role="radiogroup"
            aria-label={t('settings.theme')}
            className="settings-theme-options"
          >
            {THEME_OPTIONS.map((option) => {
              const selected = preference === option.id;
              return (
                <label
                  key={option.id}
                  className="settings-theme-option"
                  data-system={option.id === 'auto' || undefined}
                  data-wide={
                    option.id === 'contrast-light' ||
                    option.id === 'contrast-dark' ||
                    option.id === 'zenburn' ||
                    undefined
                  }
                >
                  <input
                    id={`settings-theme-${option.id}`}
                    type="radio"
                    name="theme"
                    value={option.id}
                    checked={selected}
                    onChange={() => setThemePreference(option.id)}
                    className="sr-only"
                  />
                  {/* A data-theme span paints with that theme's own variables. System is a switch, not a
                    palette: a neutral tile with a light and a dark chip beside its name. */}
                  {option.id === 'auto' ? (
                    <span
                      className="settings-theme-swatch settings-theme-system"
                      aria-hidden="true"
                    >
                      <span data-theme="light" className="settings-theme-chip" />
                      <span data-theme="dark" className="settings-theme-chip" />
                      <span className="settings-theme-system-name">{t(option.label)}</span>
                    </span>
                  ) : (
                    <span className="settings-theme-swatch" aria-hidden="true">
                      <span data-theme={option.id} className="settings-theme-fill">
                        <span className="settings-theme-name">{t(option.label)}</span>
                      </span>
                    </span>
                  )}
                  <span className="sr-only">{t(option.label)}</span>
                </label>
              );
            })}
          </div>
        </details>
      </section>
      <section className="settings-general-section">
        <div className="appearance-section-heading">
          <h3 className="settings-general-heading">{t('settings.typography')}</h3>
          <ConfigButton
            variant="ghost"
            size="small"
            onClick={() => {
              fonts.resetFontPreference('ui');
              fonts.resetFontPreference('mono');
              setFontSize(CHAT_CONTENT_FONT_SIZE_DEFAULT);
            }}
          >
            {t('settings.resetTypography')}
          </ConfigButton>
        </div>
        <p id="settings-typography-description" className="settings-general-description">
          {t('settings.fontDescription')}
        </p>
        <FontSettings />
        <AppearanceRange
          id="settings-chat-content-font-size"
          label={t('settings.chatContentFontSize')}
          description={t('settings.chatSizeDescription')}
          value={fontSize}
          min={CHAT_CONTENT_FONT_SIZE_MIN}
          max={CHAT_CONTENT_FONT_SIZE_MAX}
          defaultValue={CHAT_CONTENT_FONT_SIZE_DEFAULT}
          onChange={setFontSize}
        />
      </section>
      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t('settings.layout')}</h3>
        <AppearanceRange
          id="settings-chat-content-width"
          label={t('settings.chatContentWidth')}
          description={t('settings.chatContentWidthDescription')}
          value={width}
          min={CHAT_CONTENT_WIDTH_MIN}
          max={CHAT_CONTENT_WIDTH_MAX}
          step={10}
          defaultValue={CHAT_CONTENT_WIDTH_DEFAULT}
          onChange={setWidth}
        />
      </section>
      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t('settings.preview')}</h3>
        <div className="appearance-preview">
          <div className="appearance-preview-ui">{t('settings.previewUi')}</div>
          <div className="chat-content">
            <MarkdownBody>{t('settings.previewMarkdown')}</MarkdownBody>
          </div>
          <div className="tool-card">
            <div className="tool-card-header">{t('settings.previewOutput')}</div>
            <pre className="appearance-preview-output">{t('settings.previewOutputText')}</pre>
          </div>
        </div>
      </section>
    </div>
  );
}
