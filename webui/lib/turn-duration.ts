import type { AgentMessage } from './types';

function recordedMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** When a response ended: its request start plus the time pi recorded for it (pi 1.1). */
function responseEnd(message: AgentMessage): number | undefined {
  if (message.role !== 'assistant') return undefined;
  const start = recordedMs(message.timestamp);
  const duration = recordedMs(message.durationMs);
  return start !== undefined && duration !== undefined ? start + duration : undefined;
}

/** A reply that answered the turn: a run that follows it was started later, e.g. by an extension's message. */
function answersTurn(message: AgentMessage): boolean {
  return (
    message.role === 'assistant' &&
    (message.stopReason === 'stop' || message.stopReason === 'length')
  );
}

export function getTurnDurationMs(
  messages: AgentMessage[],
  anchorIdx: number,
  endIdx: number
): number | undefined {
  const start = recordedMs(messages[anchorIdx]?.timestamp);
  if (start === undefined) return undefined;
  let end: number | undefined;
  let lastResponseTimed = false;
  let idle = 0;
  let answeredAt: number | undefined;
  let nextRunAt: number | undefined;
  for (let idx = anchorIdx + 1; idx < endIdx; idx++) {
    const message = messages[idx];
    if (message.role === 'assistant') {
      if (answeredAt !== undefined && nextRunAt !== undefined)
        idle += Math.max(0, nextRunAt - answeredAt);
      answeredAt = nextRunAt = undefined;
      const ended = responseEnd(message);
      lastResponseTimed = ended !== undefined;
      if (ended !== undefined) end = Math.max(end ?? ended, ended);
      if (ended !== undefined && answersTurn(message)) answeredAt = end;
    } else if (message.role === 'toolResult') {
      const ended = recordedMs(message.timestamp);
      if (ended !== undefined) end = Math.max(end ?? ended, ended);
    } else if (answeredAt !== undefined) {
      const at = recordedMs(message.timestamp);
      if (at !== undefined) nextRunAt = Math.max(nextRunAt ?? at, at);
    }
  }
  if (!lastResponseTimed || end === undefined) return undefined;
  return Math.max(0, end - start - idle);
}

/** A finished turn's billed totals: the same accounting the session statistics use. */
export interface TurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** input + output + cacheRead + cacheWrite. */
  total: number;
  cost: number;
}

/**
 * The tokens and cost a turn billed, summed over every assistant response and
 * tool result in `messages[anchorIdx + 1, endIdx)` — the session statistics'
 * accounting, so the turn's line and the sidebar's totals agree. Undefined when
 * nothing in the turn recorded usage (older pi sessions).
 */
export function getTurnUsage(
  messages: AgentMessage[],
  anchorIdx: number,
  endIdx: number
): TurnUsage | undefined {
  let usage: TurnUsage | undefined;
  for (let idx = anchorIdx + 1; idx < endIdx; idx++) {
    const message = messages[idx];
    if (message.role !== 'assistant' && message.role !== 'toolResult') continue;
    const recorded = message.usage;
    if (!recorded) continue;
    usage ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
    usage.input += recorded.input ?? 0;
    usage.output += recorded.output ?? 0;
    usage.cacheRead += recorded.cacheRead ?? 0;
    usage.cacheWrite += recorded.cacheWrite ?? 0;
    usage.cost += recorded.cost?.total ?? 0;
  }
  if (!usage) return undefined;
  usage.total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return usage;
}

/** A turn's length as the chat shows it, in whole seconds: 14s, then 3m 5s, then 1h 2m 5s. */
export function formatTurnDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds}s`;
}
