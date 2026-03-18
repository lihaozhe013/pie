import { useId, useRef, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import type { ExtensionUiRequest } from '@/lib/types';

type QuestionRequest = Extract<ExtensionUiRequest, { method: 'select' | 'input' }> & {
  question: { options: string[] };
};

export function isAskUserRequest(request: ExtensionUiRequest): request is QuestionRequest {
  return (request.method === 'select' || request.method === 'input') && !!request.question;
}

export function AskUserPanel({
  request,
  waitingCount,
  onRespond,
  onReturnFocus
}: {
  request: QuestionRequest;
  waitingCount: number;
  onRespond: (
    request: QuestionRequest,
    response: { value: string } | { cancelled: true }
  ) => Promise<void>;
  onReturnFocus: () => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [collapsed, setCollapsed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const [failed, setFailed] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const answer = selected ?? typed.trim();

  async function respond(response: { value: string } | { cancelled: true }) {
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    setFailed(false);
    const hadFocus = panel.current?.contains(document.activeElement);
    try {
      await onRespond(request, response);
      if (
        hadFocus &&
        (panel.current?.contains(document.activeElement) ||
          document.activeElement === document.body)
      ) {
        onReturnFocus();
      }
    } catch {
      setFailed(true);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <div className="ask-user-shell">
      <section
        ref={panel}
        className="ask-user-panel"
        aria-labelledby={`${id}-title`}
        aria-busy={pending}
        data-collapsed={collapsed}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setCollapsed(true);
            trigger.current?.focus();
          }
        }}
      >
        <span className="sr-only" role="status">
          {t('chat.questionPending')}
        </span>
        <div className="ask-user-heading">
          <h3 id={`${id}-title`}>{request.title}</h3>
          <button
            ref={trigger}
            type="button"
            className="ask-user-quiet"
            aria-expanded={!collapsed}
            aria-controls={`${id}-body`}
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? t('chat.extensionExpand') : t('chat.extensionCollapse')}
          </button>
        </div>
        {collapsed ? (
          <p className="ask-user-pending">{t('chat.questionPending')}</p>
        ) : (
          <form
            id={`${id}-body`}
            onSubmit={(event) => {
              event.preventDefault();
              if (answer) void respond({ value: answer });
            }}
          >
            <fieldset disabled={pending} className="ask-user-body">
              {request.question.options.length > 0 && (
                <div className="ask-user-options" role="radiogroup" aria-labelledby={`${id}-title`}>
                  {request.question.options.map((option) => (
                    <label
                      key={option}
                      className="ask-user-option"
                      data-selected={selected === option}
                    >
                      <input
                        type="radio"
                        name={`${id}-option`}
                        value={option}
                        checked={selected === option}
                        onChange={() => setSelected(option)}
                      />
                      <span>{option}</span>
                    </label>
                  ))}
                </div>
              )}
              <label className="ask-user-answer-label" htmlFor={`${id}-answer`}>
                {t(
                  request.question.options.length
                    ? 'chat.questionCustomAnswer'
                    : 'chat.questionAnswer'
                )}
              </label>
              <textarea
                id={`${id}-answer`}
                rows={2}
                value={typed}
                placeholder={t('chat.questionPlaceholder')}
                onChange={(event) => {
                  setSelected(null);
                  setTyped(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    (event.metaKey || event.ctrlKey) &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    if (answer) void respond({ value: answer });
                  }
                }}
              />
            </fieldset>
            <div className="ask-user-footer">
              <button
                type="button"
                className="ask-user-quiet"
                disabled={pending}
                onClick={() => void respond({ cancelled: true })}
              >
                {t('chat.questionSkip')}
              </button>
              {waitingCount > 0 && (
                <span className="ask-user-pending">
                  {t('chat.extensionMoreWaiting', { count: waitingCount })}
                </span>
              )}
              <button type="submit" className="ask-user-send" disabled={pending || !answer}>
                {t(pending ? 'chat.questionSending' : 'chat.questionSend')}
              </button>
            </div>
            {failed && (
              <p className="ask-user-error" role="alert">
                {t('chat.questionFailed')}
              </p>
            )}
          </form>
        )}
      </section>
    </div>
  );
}
