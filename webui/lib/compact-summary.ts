import type { Translate } from './composer-activity';

/**
 * A frozen token count, written the way a result reads: whole thousands and one
 * decimal for millions. The live counters keep a decimal because they tick; a
 * finished compaction is read once, so 128k beats 128.4k.
 */
export function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return tokens.toLocaleString('en-US');
}

/** The parts of a finished compaction the composer reports. */
export interface CompactSummary {
  reason: string;
  tokensBefore: number;
  estimatedTokensAfter: number;
}

/**
 * One line describing a finished compaction: what triggered it, the context size
 * before and after, and how much room it freed. The run status row fades out
 * with this line, and the composer hub keeps it beside the compact action, so
 * the two never word the same result differently.
 */
export function compactSummaryText(result: CompactSummary, t: Translate): string {
  const saved = Math.max(0, result.tokensBefore - result.estimatedTokensAfter);
  const reason =
    result.reason && result.reason !== 'manual'
      ? `${result.reason[0].toUpperCase()}${result.reason.slice(1)} `
      : `${t('chat.compacted')} `;
  return `${reason}${formatCompactTokens(result.tokensBefore)} → ${formatCompactTokens(
    result.estimatedTokensAfter
  )} tokens (${t('chat.tokensSaved', { saved: formatCompactTokens(saved) })})`;
}
