import { useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import {
  codemodeTotalCost,
  formatCodemodeCost,
  formatCodemodeDuration,
  type CodemodeCallStatus,
  type CodemodeCallView
} from '@/lib/codemode-view';

// The tool calls a codemode script made, listed under the script in its card.
// Those calls never reach the model as tool calls of their own, so they are
// rows inside this card, not separate cards (as in pi's TUI).

/** Calls shown before the rest are folded behind a button; the newest stay visible. */
export const CODEMODE_VISIBLE_CALLS = 20;

const STATUS_STYLE: Record<CodemodeCallStatus, { icon: string; color: string }> = {
  running: { icon: '…', color: 'var(--run-status-running, var(--accent))' },
  ok: { icon: '✓', color: 'var(--run-status-success, var(--text-muted))' },
  error: { icon: '✗', color: 'var(--run-status-error, var(--error, #f87171))' },
  cancelled: { icon: '⊘', color: 'var(--text-muted)' }
};

function CallRow({ call }: { call: CodemodeCallView }) {
  const { t } = useI18n();
  const status = STATUS_STYLE[call.status];
  const duration = formatCodemodeDuration(call.durationMs);
  return (
    <li
      className="codemode-call"
      data-status={call.status}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        minWidth: 0,
        padding: '7px 9px',
        borderRadius: 6,
        background: 'var(--codemode-call-surface, var(--tool-card-pane))'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
        <span
          role="img"
          aria-label={t(`codemode.status.${call.status}`)}
          title={t(`codemode.status.${call.status}`)}
          style={{ color: status.color, width: 12, flexShrink: 0, textAlign: 'center' }}
        >
          {status.icon}
        </span>
        <span style={{ color: 'var(--text-muted)', fontWeight: 600, flexShrink: 0 }}>
          {call.name}
        </span>
        {call.args && (
          <span
            style={{
              color: 'var(--text-dim)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
              minWidth: 0
            }}
          >
            {call.args}
          </span>
        )}
        {duration && (
          <span
            style={{
              color: 'var(--text-dim)',
              flexShrink: 0,
              marginLeft: 'auto',
              fontVariantNumeric: 'tabular-nums'
            }}
          >
            {duration}
          </span>
        )}
        {call.cost !== undefined && (
          <span
            style={{ color: 'var(--text-dim)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}
          >
            {formatCodemodeCost(call.cost)}
          </span>
        )}
      </div>
      {call.error && (
        <div
          style={{
            color: 'var(--run-status-error, var(--error, #f87171))',
            paddingLeft: 18,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere'
          }}
        >
          {call.error}
        </div>
      )}
    </li>
  );
}

export function CodemodeCallList({
  calls,
  omitted
}: {
  calls: readonly CodemodeCallView[];
  /** Earlier calls a progress snapshot did not include. */
  omitted: number;
}) {
  const { t } = useI18n();
  const [showAll, setShowAll] = useState(false);
  if (calls.length === 0 && omitted === 0) return null;
  const hidden = showAll ? 0 : Math.max(0, calls.length - CODEMODE_VISIBLE_CALLS);
  const shown = hidden > 0 ? calls.slice(hidden) : calls;
  // Folded rows still count: the total covers every call the result lists.
  const totalCost = codemodeTotalCost(calls);
  return (
    <div
      className="tool-card-pane"
      style={{
        // the quiet card's whisper divider, matching every other pane
        // inside a tool card (CARD_RULE in components/card-style.ts).
        borderTop: '1px solid color-mix(in srgb, var(--border) 45%, transparent)',
        padding: '6px 10px',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--font-mono-size, 15px)',
        lineHeight: 1.5,
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        minWidth: 0
      }}
    >
      <div style={{ color: 'var(--text-dim)', fontFamily: 'inherit', fontSize: 11 }}>
        {t('codemode.calls')}
      </div>
      {omitted > 0 && (
        <div style={{ color: 'var(--text-dim)' }}>
          {t('codemode.omittedCalls', { count: omitted })}
        </div>
      )}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          style={{
            alignSelf: 'flex-start',
            padding: 0,
            border: 'none',
            background: 'none',
            color: 'var(--accent)',
            cursor: 'pointer',
            font: 'inherit'
          }}
        >
          {t('codemode.showEarlierCalls', { count: hidden })}
        </button>
      )}
      <ul
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          minWidth: 0
        }}
      >
        {shown.map((call, index) => (
          <CallRow key={call.id || `${hidden + index}`} call={call} />
        ))}
      </ul>
      {totalCost !== null && (
        <div style={{ color: 'var(--text-dim)' }}>
          {t('codemode.modelCost', { cost: formatCodemodeCost(totalCost) })}
        </div>
      )}
    </div>
  );
}
