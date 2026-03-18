import { useEffect, useRef, type ReactNode } from 'react';
import { openStackedDialog } from '@/lib/stacked-dialog';
import { useI18n } from '@/hooks/useI18n';

interface SessionModalProps {
  title: string;
  icon?: ReactNode;
  onClose: () => void;
  maxWidth?: number | string;
  children: ReactNode;
}

export function SessionModal({
  title,
  icon,
  onClose,
  maxWidth = 840,
  children
}: SessionModalProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(
    () =>
      openStackedDialog(document, dialogRef.current, () => {
        onCloseRef.current();
      }),
    []
  );

  return (
    <div
      role="presentation"
      className="session-modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="session-modal-surface"
        style={{
          maxWidth: typeof maxWidth === 'number' ? `${maxWidth}px` : maxWidth
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return;
          const controls = [
            ...event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]'
            )
          ].filter((element) => element.getClientRects().length > 0);
          const first = controls[0];
          const last = controls.at(-1);
          if (
            event.shiftKey &&
            (document.activeElement === first || document.activeElement === dialogRef.current)
          ) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <header className="session-modal-header">
          <div className="session-modal-title-group">
            {icon}
            <h2 className="session-modal-title">{title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="session-modal-close-btn"
            title={t('chat.close')}
            aria-label={t('chat.close')}
          >
            ×
          </button>
        </header>
        <div className="session-modal-body">{children}</div>
      </div>
    </div>
  );
}
