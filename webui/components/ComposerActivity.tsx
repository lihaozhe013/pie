import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import type { AgentPhase } from '@/hooks/useAgentSession';
import { selectStreamingMessage, useStreamingSelector } from '@/hooks/useStreamingSelector';
import { useExitHold } from '@/hooks/useToolCardMotion';
import {
  composerActivityLabel,
  composerActivityTokens,
  createReplyRateEstimator,
  nextCompactHold,
  runStartHint,
  type ReplyRateEstimator
} from '@/lib/composer-activity';
import { formatCompactCount } from '@/lib/session-stats-format';
import { formatTurnDuration } from '@/lib/turn-duration';
import { createBlockEstimator, type BlockEstimator } from '@/lib/token-estimate';
import type { StreamingStore } from '@/lib/streaming-message';
import type { AgentMessage } from '@/lib/types';

/**
 * The live run status, locked in one row directly above the composer.
 *
 * It lives outside the transcript so a long run stays visible while the user
 * reads history, and its single fixed-height row keeps the composer from moving
 * as tools start and finish. The row is always mounted: it opens when a run
 * starts, folds away when the run ends, and only its text changes in between, so
 * the composer never jumps under the user's cursor.
 */
export function ComposerActivity({
  store,
  phase,
  messages,
  compacting,
  compactResult,
  running
}: {
  store: StreamingStore;
  phase: AgentPhase;
  messages: AgentMessage[];
  /** The context is being compacted right now. */
  compacting: boolean;
  /** The last finished compaction, so the row can leave saying what it achieved. */
  compactResult?: { reason: string; tokensBefore: number; estimatedTokensAfter: number } | null;
  /**
   * The agent is working: compaction included, because a manual compaction runs
   * without a prompt and would otherwise report nowhere. The row is open and
   * says what it is doing.
   */
  running: boolean;
}) {
  const { t } = useI18n();
  const streaming = useStreamingSelector(store, selectStreamingMessage);
  // Reading the label walks the transcript's tool inputs, so it is derived only
  // while a run needs it.
  const label = running ? composerActivityLabel(phase, messages, streaming, compacting, t) : null;
  // The estimate continues from the previous render's count instead of rescanning
  // a block that may have grown for minutes, and lives only as long as a run.
  const estimatorRef = useRef<BlockEstimator | null>(null);
  estimatorRef.current ??= createBlockEstimator();
  const estimate = running
    ? composerActivityTokens(phase, messages, streaming, compacting, estimatorRef.current)
    : null;
  const tokens =
    estimate !== null && Math.round(estimate) >= 1
      ? t('activity.tokenEstimate', { tokens: formatCompactCount(Math.round(estimate)) })
      : null;
  // The rate names the streaming reply's speed. Between streamed chunks nothing
  // re-renders, so a light tick keeps the number falling during a stall, the
  // same way the message header's badge does. Reading the clock is a tick-time
  // job, never render's: the number must not drift on re-render.
  const rateEstimatorRef = useRef<ReplyRateEstimator | null>(null);
  rateEstimatorRef.current ??= createReplyRateEstimator();
  const rateEstimator = rateEstimatorRef.current;
  const [rate, setRate] = useState<number | null>(null);
  useEffect(() => {
    if (!running) {
      setRate(null);
      return;
    }
    const update = () => setRate(rateEstimator.rate(phase, streaming, compacting, Date.now()));
    update();
    const id = setInterval(update, 300);
    return () => clearInterval(id);
  }, [running, phase, streaming, compacting, rateEstimator]);
  // The run's clock, one more tick-time job beside the rate: a fixed start and
  // a one-second tick, so re-renders never move it. A browser that attached to
  // a run already in flight — a reload, a reconnect, another tab's prompt —
  // counts from the prompt that began it. `running` only opens for a run (pi
  // holds it through retries and auto-compaction), so each rise is a new run.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const startedAtRef = useRef<number | null>(null);
  const wasRunningRef = useRef(false);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  useEffect(() => {
    if (!running) {
      wasRunningRef.current = false;
      // The last measured time stays for the fading row; the next run sets its own.
      return;
    }
    if (!wasRunningRef.current) {
      wasRunningRef.current = true;
      startedAtRef.current = runStartHint(messagesRef.current) ?? Date.now();
    }
    const update = () => {
      const startedAt = startedAtRef.current;
      if (startedAt !== null) setElapsedMs(Date.now() - startedAt);
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [running]);
  // The run's last words, so the row can fade out saying them.
  const lastLabel = useRef('');
  if (label) lastLabel.current = label;
  // A finished compaction replaces the last words with its own result, in the
  // same place the composer used to print a banner. It is only read while the
  // row leaves, so the next run starts from its own label again.
  const wasCompacting = useRef(false);
  const compactHold = useRef<string | null>(null);
  compactHold.current = nextCompactHold(
    compactHold.current,
    running,
    compacting,
    wasCompacting.current,
    compactResult,
    t
  );
  wasCompacting.current = compacting;
  const { open, exiting } = useExitHold(running);
  // A visible answer drops the text but keeps the row's height, as before; once
  // the run is over only the row on its way out still says the last thing.
  const text = running ? label : open ? (compactHold.current ?? lastLabel.current) : '';
  // The clock runs for the whole run and keeps its last reading through the fade.
  const elapsed = running || open ? elapsedMs : null;
  return (
    <div
      className="composer-activity-slot"
      data-open={running ? 'true' : undefined}
      data-fading={exiting ? 'true' : undefined}
    >
      <div className="composer-activity-row">
        <div
          className="composer-activity"
          data-visible={text ? 'true' : undefined}
          role="status"
          aria-live="polite"
          aria-hidden={text ? undefined : true}
          title={text || undefined}
        >
          <span className="composer-activity-dot" aria-hidden="true" />
          <span className="composer-activity-label" key={text}>
            {text}
          </span>
          {elapsed !== null && (
            <span className="composer-activity-elapsed">
              {t('activity.elapsed', { time: formatTurnDuration(elapsed) })}
            </span>
          )}
          {tokens && (
            <span className="composer-activity-tokens" title={t('i18n.estimatedTokens')}>
              {tokens}
            </span>
          )}
          {running && rate !== null && (
            <span className="composer-activity-rate" title={t('i18n.streamingTokensPerSecond')}>
              {t('activity.tokenRate', { tps: rate.toFixed(1) })}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
