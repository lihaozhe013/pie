import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { settingsSectionRequiresProject } from '@/lib/settings-navigation';
import {
  searchSettings,
  SETTINGS_SECTION_LABELS,
  type SettingsSearchEntry
} from '@/lib/settings-search';

export function SettingsSearch({
  cwd,
  onSelect
}: {
  cwd: string | null;
  onSelect: (entry: SettingsSearchEntry) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [availability, setAvailability] = useState<{ windows?: boolean; auth?: boolean }>({});
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([
      fetch('/api/tools/settings').then((r) => (r.ok ? r.json() : null)),
      fetch('/api/web-auth').then((r) => (r.ok ? r.json() : null))
    ]).then(([shell, auth]) => {
      if (!cancelled)
        setAvailability({
          windows: shell.status === 'fulfilled' ? shell.value?.isWindows === true : false,
          auth: auth.status === 'fulfilled' ? auth.value?.enabled === true : false
        });
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const results = searchSettings(query, t);
  const choose = (entry: SettingsSearchEntry) => {
    setQuery('');
    onSelect(entry);
  };
  return (
    <div
      ref={ref}
      className="settings-search"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && query) {
          event.preventDefault();
          event.stopPropagation();
          setQuery('');
          ref.current?.querySelector('input')?.focus();
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          const buttons = Array.from(
            ref.current?.querySelectorAll<HTMLButtonElement>(
              '.settings-search-result:not(:disabled)'
            ) ?? []
          );
          if (!buttons.length) return;
          event.preventDefault();
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          buttons[
            (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1) + buttons.length) %
              buttons.length
          ]?.focus();
        }
      }}
    >
      <label className="sr-only" htmlFor="settings-search">
        {t('settings.search')}
      </label>
      <input
        id="settings-search"
        type="search"
        value={query}
        placeholder={t('settings.search')}
        autoComplete="off"
        aria-controls={query.trim() ? 'settings-search-results' : undefined}
        onChange={(event) => setQuery(event.target.value)}
      />
      {query.trim() && (
        <div id="settings-search-results" className="settings-search-results">
          <p role="status" className="settings-search-status">
            {results.length
              ? t('settings.searchCount', { count: results.length })
              : t('settings.searchEmpty')}
          </p>
          {results.map((entry) => {
            const reason =
              settingsSectionRequiresProject(entry.section) && !cwd
                ? t('settings.projectRequired')
                : entry.availability && availability[entry.availability] !== true
                  ? t(
                      availability[entry.availability] === undefined
                        ? 'settings.checkingAvailability'
                        : entry.availability === 'windows'
                          ? 'settings.windowsOnly'
                          : 'settings.authOnly'
                    )
                  : '';
            return (
              <button
                key={`${entry.section}:${entry.label}`}
                type="button"
                className="settings-search-result"
                disabled={!!reason}
                onClick={() => choose(entry)}
              >
                <span>{t(entry.label)}</span>
                <small>
                  {t(SETTINGS_SECTION_LABELS[entry.section])}
                  {reason ? ` — ${reason}` : entry.description ? ` — ${t(entry.description)}` : ''}
                </small>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
