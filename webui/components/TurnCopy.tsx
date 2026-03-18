import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '@/hooks/useI18n';
import { copyText } from '@/lib/clipboard';
import { buildTurnCopy, type TurnCopyMode } from '@/lib/turn-copy';
import { focusModalPanel, listenForStackedDialogEscape } from '@/lib/stacked-dialog';
import type { AgentMessage, ToolResultMessage } from '@/lib/types';
import { MessageIcon, TerminalIcon } from './SidebarIcons';

/** What the footer button hands the dialog: the turn as it stands on the page. */
interface TurnCopyTarget {
  messages: readonly AgentMessage[];
  toolResults?: ReadonlyMap<string, ToolResultMessage>;
}

interface TurnCopyChoice {
  mode: TurnCopyMode;
  titleKey: string;
  descriptionKey: string;
  icon: ReactNode;
}

/**
 * The three choices, in the order the dialog shows them: the conversation
 * alone, the record the transcript keeps, and the full execution record.
 */
const CHOICES: TurnCopyChoice[] = [
  {
    mode: 'answers',
    titleKey: 'chat.copyTurnAnswers',
    descriptionKey: 'chat.copyTurnAnswersDescription',
    icon: <MessageIcon size={22} />
  },
  {
    mode: 'transcript',
    titleKey: 'chat.copyTurnRecord',
    descriptionKey: 'chat.copyTurnRecordDescription',
    icon: (
      <svg
        width={22}
        height={22}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M9 6h11M9 12h11M9 18h11" />
        <circle cx="4.5" cy="6" r="1.1" fill="currentColor" stroke="none" />
        <circle cx="4.5" cy="12" r="1.1" fill="currentColor" stroke="none" />
        <circle cx="4.5" cy="18" r="1.1" fill="currentColor" stroke="none" />
      </svg>
    )
  },
  {
    mode: 'execution',
    titleKey: 'chat.copyTurnExecution',
    descriptionKey: 'chat.copyTurnExecutionDescription',
    icon: <TerminalIcon size={22} />
  }
];

interface DialogProps {
  /** The dialog element itself: what the page focuses when it opens. */
  panelRef?: Ref<HTMLDivElement>;
  /** Close without copying: Escape, the backdrop, or the close button. */
  onClose(): void;
  /** Copy the turn with one of the three scopes. */
  onCopy(mode: TurnCopyMode): void;
  /** A copy is in flight; every choice waits. */
  busy?: boolean;
  /** Why the last copy failed, in the dialog's own voice. */
  error?: string | null;
}

/**
 * The dialog's content, without the page it opens over: three scopes and their
 * copy, in the shape the sidebar's "New" dialog already uses. Exported for a
 * markup test; the page belongs to `TurnCopyDialog`.
 */
export function TurnCopyDialogContent({
  panelRef,
  onClose,
  onCopy,
  busy = false,
  error
}: DialogProps) {
  const { t } = useI18n();
  return (
    <div
      ref={panelRef}
      className="turn-copy-chooser"
      role="dialog"
      aria-modal="true"
      aria-labelledby="turn-copy-title"
      aria-describedby="turn-copy-description"
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
      <header className="turn-copy-chooser-header">
        <div>
          <h2 id="turn-copy-title">{t('chat.copyTurnTitle')}</h2>
          <p id="turn-copy-description">{t('chat.copyTurnDescription')}</p>
        </div>
        <button
          type="button"
          className="turn-copy-chooser-close"
          onClick={onClose}
          disabled={busy}
          aria-label={t('i18n.close')}
        >
          ×
        </button>
      </header>

      <div className="turn-copy-options">
        {CHOICES.map(({ mode, titleKey, descriptionKey, icon }) => (
          <button
            key={mode}
            type="button"
            className="turn-copy-choice"
            onClick={() => onCopy(mode)}
            disabled={busy}
            aria-label={t(titleKey)}
            aria-describedby={`turn-copy-${mode}-description`}
          >
            <span className="turn-copy-choice-icon">{icon}</span>
            <span className="turn-copy-choice-title">{t(titleKey)}</span>
            <span id={`turn-copy-${mode}-description`} className="turn-copy-choice-description">
              {t(descriptionKey)}
            </span>
          </button>
        ))}
      </div>

      {error && (
        <p className="turn-copy-chooser-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function TurnCopyDialog({ onClose, onCopy, busy, error }: Omit<DialogProps, 'panelRef'>) {
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
    if (!busy) onClose();
  };
  useEffect(() => {
    if (!portalTarget) return;
    return listenForStackedDialogEscape(document, () => escapeRef.current());
  }, [portalTarget]);

  if (!portalTarget) return null;
  return createPortal(
    <div
      className="turn-copy-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <TurnCopyDialogContent
        panelRef={panelRef}
        onClose={onClose}
        onCopy={onCopy}
        busy={busy}
        error={error}
      />
    </div>,
    portalTarget
  );
}

/**
 * One turn's copy control: a single, always visible entry under the turn, and
 * the scope dialog it opens. Per-message copy buttons are gone; what a reader
 * wants to keep is the whole exchange, not a fragment of it.
 */
export function TurnCopy({
  messages,
  toolResults
}: {
  messages: readonly AgentMessage[];
  toolResults?: ReadonlyMap<string, ToolResultMessage>;
}) {
  const { t } = useI18n();
  const [target, setTarget] = useState<TurnCopyTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The turn grows while it runs; the dialog reads it when the button is pressed.
  const currentRef = useRef<TurnCopyTarget>({ messages, toolResults });
  currentRef.current = { messages, toolResults };
  const triggerRef = useRef<HTMLButtonElement>(null);

  const copy = async (mode: TurnCopyMode) => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const text = buildTurnCopy({
        mode,
        messages: target.messages,
        toolResults: target.toolResults
      });
      if (!text.trim()) throw new Error(t('chat.copyTurnEmpty'));
      await copyText(text);
      setTarget(null);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
      triggerRef.current?.focus({ preventScroll: true });
    } catch (reason) {
      setError(
        reason instanceof Error && reason.message ? reason.message : t('chat.copyTurnFailed')
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="turn-copy-row">
        <button
          ref={triggerRef}
          type="button"
          className="turn-copy-trigger"
          onClick={() => {
            setError(null);
            setTarget(currentRef.current);
          }}
          aria-haspopup="dialog"
          aria-expanded={target !== null}
          title={t('chat.copyTurn')}
        >
          {copied ? (
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
          {copied ? t('chat.copyTurnDone') : t('chat.copyTurn')}
        </button>
      </div>
      {target && (
        <TurnCopyDialog
          onClose={() => {
            if (!busy) setTarget(null);
          }}
          onCopy={copy}
          busy={busy}
          error={error}
        />
      )}
    </>
  );
}
