import type { SessionEntry } from './types';

export const STREAM_SPEED_ENTRY = 'pie:stream-speed';
export const MIN_STREAM_MS = 500;

export interface StreamSpeed {
  outputTokens: number;
  streamMs: number;
  responses: number;
}

/** Observe server-side stream events; starts and empty deltas are not output. */
export class StreamSpeedTracker {
  private first: number | null = null;

  reset(): void {
    this.first = null;
  }

  update(event: { type?: unknown; delta?: unknown }, now: number): void {
    if (this.first !== null) return;
    if (
      (event.type === 'text_delta' ||
        event.type === 'thinking_delta' ||
        event.type === 'toolcall_delta') &&
      typeof event.delta === 'string' &&
      event.delta.length > 0
    )
      this.first = now;
  }

  finish(outputTokens: number, now: number): StreamSpeed | undefined {
    const streamMs = this.first === null ? 0 : now - this.first;
    this.reset();
    if (
      !Number.isFinite(outputTokens) ||
      outputTokens <= 0 ||
      !Number.isFinite(streamMs) ||
      streamMs < MIN_STREAM_MS
    )
      return undefined;
    return { outputTokens, streamMs, responses: 1 };
  }
}

export function validStreamSpeed(value: unknown): value is StreamSpeed {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<StreamSpeed>;
  return (
    typeof data.outputTokens === 'number' &&
    Number.isFinite(data.outputTokens) &&
    data.outputTokens > 0 &&
    typeof data.streamMs === 'number' &&
    Number.isFinite(data.streamMs) &&
    data.streamMs >= MIN_STREAM_MS &&
    data.responses === 1
  );
}

/** A custom entry is counted only if its child is the matching assistant message. */
export function recordedStreamSpeeds(entries: SessionEntry[]): StreamSpeed | undefined {
  const records = new Map(
    entries
      .filter(
        (entry) =>
          entry.type === 'custom' &&
          entry.customType === STREAM_SPEED_ENTRY &&
          validStreamSpeed(entry.data)
      )
      .map((entry) => [
        entry.id,
        (entry as Extract<SessionEntry, { type: 'custom' }>).data as StreamSpeed
      ])
  );
  let result: StreamSpeed | undefined;
  for (const entry of entries) {
    if (entry.type !== 'message' || entry.message.role !== 'assistant' || !entry.parentId) continue;
    const speed = records.get(entry.parentId);
    if (!speed || entry.message.usage?.output !== speed.outputTokens) continue;
    result ??= { outputTokens: 0, streamMs: 0, responses: 0 };
    result.outputTokens += speed.outputTokens;
    result.streamMs += speed.streamMs;
    result.responses++;
    records.delete(entry.parentId);
  }
  return result;
}
