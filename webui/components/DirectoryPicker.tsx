import { type FormEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '@/hooks/useI18n';
import { focusModalPanel, listenForStackedDialogEscape } from '@/lib/stacked-dialog';

interface DirectoryEntry {
  name: string;
  path: string;
}
interface BrowseResponse {
  path?: string | null;
  parentPath?: string | null;
  directories?: DirectoryEntry[];
  drives?: DirectoryEntry[];
  error?: string;
}
interface Props {
  onCancel: () => void;
  onSelect: (path: string) => void;
  /** A caller that is not adding a project says what the folder is for. */
  title?: string;
  description?: string;
  /** Back to the choices this picker is one step of; no button is shown without it. */
  onBack?: () => void;
  initialPath?: string;
  busy?: boolean;
  error?: string | null;
}

function FolderIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <path d="M3 7V5a1 1 0 0 1 1-1h6l2 3h8a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z" />
      <path d="M3 8h18" />
    </svg>
  );
}

export function DirectoryPicker({
  onCancel,
  onSelect,
  onBack,
  title,
  description,
  initialPath,
  busy = false,
  error
}: Props) {
  const { t } = useI18n();
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const requestRef = useRef(0);
  const completionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [verifiedInput, setVerifiedInput] = useState('');
  const [activeEntry, setActiveEntry] = useState(-1);
  const [currentPath, setCurrentPath] = useState('');
  const [parentDirectory, setParentDirectory] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState(initialPath ?? '');
  const [directories, setDirectories] = useState<DirectoryEntry[]>([]);
  const [drives, setDrives] = useState<DirectoryEntry[] | null>(null);
  const [filter, setFilter] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [directoryName, setDirectoryName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const locked = busy || creating;

  const navigateTo = useCallback(async (directory?: string) => {
    if (completionTimer.current) clearTimeout(completionTimer.current);
    const request = ++requestRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const query = directory ? `?path=${encodeURIComponent(directory)}` : '';
      const response = await fetch(`/api/cwd/browse${query}`);
      const data = (await response.json()) as BrowseResponse;
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      if (request !== requestRef.current) return;
      const nextPath = data.path ?? directory ?? '/';
      setCurrentPath(nextPath);
      setParentDirectory(data.parentPath ?? null);
      setPathInput(nextPath);
      setVerifiedInput(nextPath);
      setActiveEntry(-1);
      setDirectories(data.directories ?? []);
      setDrives(data.drives ?? null);
      setFilter('');
    } catch (cause) {
      if (request === requestRef.current)
        setLoadError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, []);

  const completePath = useCallback((value: string) => {
    if (completionTimer.current) clearTimeout(completionTimer.current);
    const request = ++requestRef.current;
    setPathInput(value);
    setVerifiedInput('');
    setActiveEntry(-1);
    setLoadError(null);
    setFilter('');
    setLoading(Boolean(value.trim()));
    if (!value.trim()) {
      setDirectories([]);
      setDrives(null);
      return;
    }
    completionTimer.current = setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/cwd/browse?complete=1&path=${encodeURIComponent(value.trim())}`
        );
        const data = (await response.json()) as BrowseResponse;
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        if (request !== requestRef.current) return;
        if (data.path) {
          setCurrentPath(data.path);
          setVerifiedInput(value.trim());
        }
        setParentDirectory(data.parentPath ?? null);
        setDirectories(data.directories ?? []);
        setDrives(null);
      } catch (cause) {
        if (request === requestRef.current)
          setLoadError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (request === requestRef.current) setLoading(false);
      }
    }, 200);
  }, []);

  useEffect(() => {
    setPortalTarget(document.body);
    void navigateTo(initialPath || undefined);
    // Capture the sequence object, not a DOM node; invalidate outstanding requests on cleanup.
    const sequence = requestRef;
    return () => {
      sequence.current++;
      if (completionTimer.current) clearTimeout(completionTimer.current);
    };
  }, [initialPath, navigateTo]);

  useLayoutEffect(() => {
    if (!portalTarget) return;
    return focusModalPanel(document, panelRef.current);
  }, [portalTarget]);

  const closeCreate = () => {
    if (creating) return;
    setCreateOpen(false);
    setDirectoryName('');
    setCreateError(null);
    createButtonRef.current?.focus();
  };
  const escapeRef = useRef(() => {});
  escapeRef.current = () => {
    if (locked) return;
    if (createOpen) closeCreate();
    else onCancel();
  };
  useEffect(() => {
    if (!portalTarget) return;
    return listenForStackedDialogEscape(document, () => escapeRef.current());
  }, [portalTarget]);

  const handleCreateDirectory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = directoryName.trim();
    if (!currentPath || !name || !canSelect) return;
    setCreating(true);
    setCreateError(null);
    try {
      const response = await fetch('/api/cwd/browse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: currentPath, name })
      });
      const data = (await response.json()) as { path?: string; error?: string };
      if (!response.ok || data.error || !data.path)
        throw new Error(data.error ?? `HTTP ${response.status}`);
      setCreateOpen(false);
      setDirectoryName('');
      panelRef.current?.focus();
      await navigateTo(data.path);
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  };

  const hasUncommittedPath = !verifiedInput || pathInput.trim() !== verifiedInput;
  const canSelect =
    Boolean(currentPath) && !hasUncommittedPath && !locked && !loading && !loadError;
  const canNavigateUp = Boolean(parentDirectory) || /^[a-zA-Z]:[\\/]?$/.test(currentPath);
  const entries = (drives ?? directories).filter((entry) =>
    entry.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())
  );

  useEffect(() => {
    if (activeEntry >= 0)
      document
        .getElementById(`directory-suggestion-${activeEntry}`)
        ?.scrollIntoView({ block: 'nearest' });
  }, [activeEntry]);

  if (!portalTarget) return null;
  return createPortal(
    <div
      className="directory-picker-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !locked) onCancel();
      }}
    >
      <div
        ref={panelRef}
        className="directory-picker-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="directory-picker-title"
        aria-describedby="directory-picker-description"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return;
          const controls = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled)'
            )
          );
          const first = controls[0];
          const last = controls.at(-1);
          if (
            event.shiftKey &&
            (document.activeElement === first || document.activeElement === panelRef.current)
          ) {
            event.preventDefault();
            last?.focus();
          } else if (
            !event.shiftKey &&
            (document.activeElement === last || document.activeElement === panelRef.current)
          ) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <header className="directory-picker-header">
          <div className="directory-picker-heading">
            {onBack && (
              <button
                type="button"
                className="directory-picker-back-link"
                onClick={onBack}
                disabled={locked}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="m15 6-6 6 6 6" />
                </svg>
                <span>{t('directoryPicker.back')}</span>
              </button>
            )}
            <div>
              <h2 id="directory-picker-title">{title ?? t('directoryPicker.openProject')}</h2>
              <p id="directory-picker-description">
                {description ?? t('directoryPicker.description')}
              </p>
            </div>
          </div>
          <button
            type="button"
            className="directory-picker-close"
            onClick={onCancel}
            disabled={locked}
            aria-label={t('i18n.close')}
          >
            ×
          </button>
        </header>

        <section className="directory-picker-browser" aria-label={t('directoryPicker.browseOther')}>
          <div className="directory-picker-section-title">{t('directoryPicker.browseOther')}</div>
          <form
            className="directory-picker-location"
            onSubmit={(event) => {
              event.preventDefault();
              if (activeEntry >= 0 && entries[activeEntry])
                void navigateTo(entries[activeEntry].path);
              else if (pathInput.trim() && !locked) void navigateTo(pathInput.trim());
            }}
          >
            <button
              type="button"
              className="directory-picker-back"
              onClick={() => void navigateTo(parentDirectory ?? undefined)}
              disabled={locked || loading || !canNavigateUp}
              aria-label={t('directoryPicker.goToParent')}
              title={t('directoryPicker.goToParent')}
            >
              ↑
            </button>
            <button type="button" onClick={() => void navigateTo('~')} disabled={locked || loading}>
              {t('directoryPicker.home')}
            </button>
            <label className="sr-only" htmlFor="directory-path">
              {t('directoryPicker.directoryPath')}
            </label>
            <input
              id="directory-path"
              className="directory-picker-path"
              value={pathInput}
              placeholder="/path/to/project"
              autoComplete="off"
              spellCheck={false}
              disabled={locked}
              role="combobox"
              aria-expanded={entries.length > 0}
              aria-controls="directory-suggestions"
              aria-activedescendant={
                activeEntry >= 0 && entries[activeEntry]
                  ? `directory-suggestion-${activeEntry}`
                  : undefined
              }
              aria-autocomplete="list"
              onChange={(event) => completePath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' && entries.length) {
                  event.preventDefault();
                  setActiveEntry((index) => (index + 1) % entries.length);
                } else if (event.key === 'ArrowUp' && entries.length) {
                  event.preventDefault();
                  setActiveEntry((index) => (index <= 0 ? entries.length - 1 : index - 1));
                } else if (
                  event.key === 'Tab' &&
                  !event.shiftKey &&
                  activeEntry >= 0 &&
                  entries[activeEntry]
                ) {
                  event.preventDefault();
                  void navigateTo(entries[activeEntry].path);
                }
              }}
            />
            <button type="submit" disabled={locked || !pathInput.trim()}>
              {t('directoryPicker.go')}
            </button>
          </form>
          <div className="directory-picker-tools">
            <input
              type="search"
              aria-label={t('directoryPicker.filter')}
              placeholder={t('directoryPicker.filter')}
              value={filter}
              disabled={locked || loading}
              onChange={(event) => setFilter(event.target.value)}
            />
            <button
              ref={createButtonRef}
              type="button"
              onClick={() => {
                setCreateOpen(true);
                setCreateError(null);
              }}
              disabled={!canSelect || createOpen}
            >
              {t('directoryPicker.newDirectory')}
            </button>
          </div>
          {createOpen && (
            <form className="directory-picker-create" onSubmit={handleCreateDirectory}>
              <label htmlFor="new-directory-name">{t('directoryPicker.directoryName')}</label>
              <div>
                <input
                  id="new-directory-name"
                  value={directoryName}
                  autoFocus
                  autoComplete="off"
                  disabled={creating}
                  onChange={(event) => {
                    setDirectoryName(event.target.value);
                    setCreateError(null);
                  }}
                />
                <button type="submit" disabled={!canSelect || !directoryName.trim()}>
                  {creating ? t('directoryPicker.creating') : t('directoryPicker.create')}
                </button>
                <button type="button" disabled={creating} onClick={closeCreate}>
                  {t('i18n.cancel')}
                </button>
              </div>
              {createError && (
                <p className="directory-picker-error" role="alert">
                  {createError}
                </p>
              )}
            </form>
          )}
          <div
            className="directory-picker-list"
            id="directory-suggestions"
            role="listbox"
            aria-label={t('directoryPicker.browseOther')}
            aria-busy={loading}
          >
            {loading ? (
              <p className="directory-picker-empty" role="status">
                {t('directoryPicker.loadingDirectories')}
              </p>
            ) : loadError ? (
              <div className="directory-picker-empty">
                <p className="directory-picker-error" role="alert">
                  {loadError}
                </p>
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => void navigateTo(pathInput.trim() || undefined)}
                >
                  {t('directoryPicker.retry')}
                </button>
              </div>
            ) : entries.length ? (
              entries.map((entry, index) => (
                <button
                  key={entry.path}
                  id={`directory-suggestion-${index}`}
                  role="option"
                  aria-selected={activeEntry === index}
                  className="directory-picker-entry"
                  type="button"
                  disabled={locked}
                  onClick={() => void navigateTo(entry.path)}
                  title={entry.path}
                >
                  <FolderIcon />
                  <span>{entry.name}</span>
                  <span className="directory-picker-chevron" aria-hidden="true">
                    ›
                  </span>
                </button>
              ))
            ) : (
              <p className="directory-picker-empty" role="status">
                {filter || hasUncommittedPath
                  ? t('directoryPicker.noMatches')
                  : drives !== null
                    ? t('directoryPicker.noDrives')
                    : t('directoryPicker.noSubdirectories')}
              </p>
            )}
          </div>
        </section>
        {error && (
          <p className="directory-picker-error directory-picker-validation" role="alert">
            {error}
          </p>
        )}
        <footer className="directory-picker-footer">
          <div className="directory-picker-selection">
            <span>
              {hasUncommittedPath
                ? t('directoryPicker.enterValidFolder')
                : t('directoryPicker.selectedLocation')}
            </span>
            <strong title={hasUncommittedPath ? pathInput : currentPath}>
              {(hasUncommittedPath ? pathInput : currentPath) || '—'}
            </strong>
          </div>
          <div className="directory-picker-footer-actions">
            <button type="button" onClick={onCancel} disabled={locked}>
              {t('i18n.cancel')}
            </button>
            <button
              className="directory-picker-primary"
              type="button"
              onClick={() => onSelect(currentPath)}
              disabled={!canSelect}
            >
              {busy ? t('i18n.checking') : t('directoryPicker.openFolder')}
            </button>
          </div>
        </footer>
      </div>
    </div>,
    portalTarget
  );
}
