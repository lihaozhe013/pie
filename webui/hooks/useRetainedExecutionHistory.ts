import { useEffect, useRef, useState } from 'react';
import {
  PENDING_BASH_ID,
  retainExecutionHistory,
  type ExecutionHistoryEntry
} from '@/lib/execution-history';

/** How long a vanished run waits for its stored result before it is dropped. */
export const EXECUTION_HISTORY_HOLD_MS = 2_000;

/**
 * The run list with a short memory.
 *
 * `buildExecutionHistory` reads stored messages and the live phase. Between
 * `tool_execution_end` and the stored `toolResult`, neither reports the call, so
 * the list would blink. A run that just left stays where it stood for
 * `holdMs`, and disappears if no result follows (an aborted call, a branch
 * switch). A pending `!` command is replaced by its stored message rather than
 * retained, so it never appears twice.
 */
export function useRetainedExecutionHistory(
  entries: ExecutionHistoryEntry[],
  holdMs = EXECUTION_HISTORY_HOLD_MS
): ExecutionHistoryEntry[] {
  const [displayed, setDisplayed] = useState<ExecutionHistoryEntry[]>(entries);
  const displayedRef = useRef<ExecutionHistoryEntry[]>(displayed);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const present = new Set(entries.map((entry) => entry.id));
    for (const [id, timer] of timers.current) {
      if (!present.has(id)) continue;
      clearTimeout(timer);
      timers.current.delete(id);
    }

    const next = retainExecutionHistory(displayedRef.current, entries).filter(
      (entry) => present.has(entry.id) || entry.id !== PENDING_BASH_ID
    );
    displayedRef.current = next;
    setDisplayed(next);

    for (const entry of next) {
      if (present.has(entry.id) || timers.current.has(entry.id)) continue;
      timers.current.set(
        entry.id,
        setTimeout(() => {
          timers.current.delete(entry.id);
          const remaining = displayedRef.current.filter((item) => item.id !== entry.id);
          displayedRef.current = remaining;
          setDisplayed(remaining);
        }, holdMs)
      );
    }
  }, [entries, holdMs]);

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    },
    []
  );

  return displayed;
}
