import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '@/hooks/useI18n';

export function informationPanelOverlays(viewportWidth: number, sidebarWidth: number): boolean {
  return viewportWidth - sidebarWidth < 820;
}

/** Whether the information panel currently overlays the conversation. */
export function useInformationPanelOverlay(sidebarWidth: number): boolean {
  const [overlay, setOverlay] = useState(false);
  useLayoutEffect(() => {
    const update = () => setOverlay(informationPanelOverlays(window.innerWidth, sidebarWidth));
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [sidebarWidth]);
  return overlay;
}

/** A single information surface; never restores the retired file workspace. */
export function SessionInfoSidebar({
  title,
  sidebarWidth,
  onClose,
  focusOnMount = true,
  panelId = 'session-information',
  toggleSelector = '[data-runs-panel-toggle="true"]',
  contentClassName,
  icon,
  children
}: {
  title: string;
  sidebarWidth: number;
  onClose: () => void;
  /** False for a surface opened on the user's behalf: it must not take focus. */
  focusOnMount?: boolean;
  /** The panel's DOM id, for the toggle's `aria-controls`. */
  panelId?: string;
  /** Where focus returns when the panel closes and the opener is gone. */
  toggleSelector?: string;
  /** Extra class on the scrolling content area (e.g. to replace its scroll). */
  contentClassName?: string;
  /** The mark before the title; the Runs panel's chevron by default. */
  icon?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const overlay = useInformationPanelOverlay(sidebarWidth);
  // Mount-only: a later prop change must not pull focus out of the conversation.
  const focusOnMountRef = useRef(focusOnMount);
  focusOnMountRef.current = focusOnMount;
  useEffect(() => {
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (focusOnMountRef.current) panelRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // A panel that belongs to the page leaves the composer's Escape alone.
      const panel = panelRef.current;
      if (!panel?.contains(document.activeElement)) return;
      const otherDialog = [
        ...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')
      ].some((element) => element !== panel && !panel.contains(element));
      if (otherDialog) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onCloseRef.current();
    };
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('keydown', handleKey, true);
      // Wait until modal siblings have had their inert state restored.
      const opener = openerRef.current;
      queueMicrotask(() => {
        // A dialog that opened above the panel keeps the focus it just took.
        if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
        if (opener?.isConnected && opener.getClientRects().length > 0) opener.focus();
        else document.querySelector<HTMLElement>(toggleSelector)?.focus();
      });
    };
  }, [toggleSelector]);
  useEffect(() => {
    if (!overlay) return;
    const panel = panelRef.current;
    const siblings = [...(panel?.parentElement?.children ?? [])].filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement &&
        element !== panel &&
        !element.classList.contains('session-info-backdrop')
    );
    const previous = siblings.map((element) => element.inert);
    siblings.forEach((element) => {
      element.inert = true;
    });
    return () =>
      siblings.forEach((element, index) => {
        element.inert = previous[index];
      });
  }, [overlay]);
  return (
    <>
      {overlay && <div className="session-info-backdrop" aria-hidden="true" onClick={onClose} />}
      <aside
        ref={panelRef}
        id={panelId}
        tabIndex={-1}
        role={overlay ? 'dialog' : 'complementary'}
        aria-modal={overlay || undefined}
        aria-label={title}
        className={`session-info-sidebar${overlay ? ' is-overlay' : ''}`}
        onKeyDown={(event) => {
          if (!overlay || event.key !== 'Tab') return;
          const controls = [
            ...event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]'
            )
          ].filter((element) => element.getClientRects().length > 0);
          const first = controls[0];
          const last = controls.at(-1);
          if (
            event.shiftKey &&
            (document.activeElement === first || document.activeElement === panelRef.current)
          ) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <header className="session-info-header">
          <div className="session-info-header-title">
            {icon ?? (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ color: 'var(--accent)', flexShrink: 0 }}
                aria-hidden="true"
              >
                <path d="m4 17 6-6-6-6" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
            )}
            <span>{title}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('panel.hide', { title })}
            title={t('panel.hide', { title })}
            className="session-info-close-btn"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </header>
        <div className={`session-info-content${contentClassName ? ` ${contentClassName}` : ''}`}>
          {children}
        </div>
      </aside>
    </>
  );
}
