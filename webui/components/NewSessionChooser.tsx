import { useEffect, useLayoutEffect, useRef, useState, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '@/hooks/useI18n';
import { focusModalPanel, listenForStackedDialogEscape } from '@/lib/stacked-dialog';
import { FolderPlusIcon, MessageIcon } from './SidebarIcons';

interface Props {
  /** The dialog element itself: what `NewSessionChooser` focuses when it opens. */
  panelRef?: Ref<HTMLDivElement>;
  /** Close without choosing: Escape, the backdrop, or the close button. */
  onClose(): void;
  /** "Add a project": pick a folder and start there. */
  onAddProject(): void;
  /** "Start without a project": today's scratch folder, at once. */
  onStartWithoutProject(): void;
  /** The scratch folder is being prepared; both choices wait. */
  busy?: boolean;
  /** Preparing the scratch folder failed, in the dialog's own voice. */
  error?: string | null;
}

/**
 * The dialog's content, without the page it opens over: the two destinations
 * and their copy. Exported for a markup test; the page belongs to
 * `NewSessionChooser`.
 */
export function NewSessionChooserDialog({
  panelRef,
  onClose,
  onAddProject,
  onStartWithoutProject,
  busy = false,
  error
}: Props) {
  const { t } = useI18n();
  return (
    <div
      ref={panelRef}
      className="new-session-chooser"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-session-chooser-title"
      aria-describedby="new-session-chooser-description"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled)')
        );
        const first = controls[0];
        const last = controls.at(-1);
        if (
          event.shiftKey &&
          (document.activeElement === first || document.activeElement === event.currentTarget)
        ) {
          event.preventDefault();
          last?.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || document.activeElement === event.currentTarget)
        ) {
          event.preventDefault();
          first?.focus();
        }
      }}
    >
      <header className="new-session-chooser-header">
        <div>
          <h2 id="new-session-chooser-title">{t('newSessionChooser.title')}</h2>
          <p id="new-session-chooser-description">{t('newSessionChooser.description')}</p>
        </div>
        <button
          type="button"
          className="new-session-chooser-close"
          onClick={onClose}
          disabled={busy}
          aria-label={t('i18n.close')}
        >
          ×
        </button>
      </header>

      <div className="new-session-chooser-options">
        <button
          type="button"
          className="new-session-choice"
          onClick={onAddProject}
          disabled={busy}
          aria-label={t('newSessionChooser.addProject')}
          aria-describedby="new-session-choice-project-description"
        >
          <span className="new-session-choice-icon">
            <FolderPlusIcon size={22} />
          </span>
          <span className="new-session-choice-title">{t('newSessionChooser.addProject')}</span>
          <span
            id="new-session-choice-project-description"
            className="new-session-choice-description"
          >
            {t('newSessionChooser.addProjectDescription')}
          </span>
        </button>
        <button
          type="button"
          className="new-session-choice"
          onClick={onStartWithoutProject}
          disabled={busy}
          aria-busy={busy}
          aria-label={t('newSessionChooser.startWithoutProject')}
          aria-describedby="new-session-choice-scratch-description"
        >
          <span className="new-session-choice-icon">
            <MessageIcon size={22} />
          </span>
          <span className="new-session-choice-title">
            {t('newSessionChooser.startWithoutProject')}
          </span>
          <span
            id="new-session-choice-scratch-description"
            className="new-session-choice-description"
          >
            {busy
              ? t('newSessionChooser.preparing')
              : t('newSessionChooser.startWithoutProjectDescription')}
          </span>
        </button>
      </div>

      {/* The scratch folder takes a moment: say so where a screen reader
          hears the change, not only in the card's description. */}
      <p className="sr-only" role="status">
        {busy ? t('newSessionChooser.preparing') : ''}
      </p>

      {error && (
        <p className="new-session-chooser-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The sidebar's one "New": two big choices over the page, a project to add or
 * a scratch conversation. The folder picker is the first choice's own step, so
 * choosing a project never competes with another "open" entry point.
 */
export function NewSessionChooser(props: Props) {
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setPortalTarget(document.body);
  }, []);

  // Focus enters the dialog, leaves with it, and Escape closes only this one.
  useLayoutEffect(() => {
    if (!portalTarget) return;
    return focusModalPanel(document, panelRef.current);
  }, [portalTarget]);

  const escapeRef = useRef(() => {});
  escapeRef.current = () => {
    if (!props.busy) props.onClose();
  };
  useEffect(() => {
    if (!portalTarget) return;
    return listenForStackedDialogEscape(document, () => escapeRef.current());
  }, [portalTarget]);

  if (!portalTarget) return null;
  return createPortal(
    <div
      className="new-session-chooser-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !props.busy) props.onClose();
      }}
    >
      <NewSessionChooserDialog {...props} panelRef={panelRef} />
    </div>,
    portalTarget
  );
}
