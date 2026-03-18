import { useEffect, useMemo, useRef, useState } from 'react';
import { updateActiveRunHolds, type ExecutionHistoryEntry } from '@/lib/execution-history';

/** Keep a completed live run in the active section for a short reading hold. */
export function useActiveExecutionHistory(
  entries: ExecutionHistoryEntry[],
  holdMs = 2_000
): ExecutionHistoryEntry[] {
  const previous = useRef(entries);
  const holds = useRef(new Map<string, number>());
  const [activeHolds, setActiveHolds] = useState<ReadonlyMap<string, number>>(holds.current);

  useEffect(() => {
    const now = Date.now();
    const next = updateActiveRunHolds(previous.current, entries, holds.current, now, holdMs);
    previous.current = entries;
    holds.current = next;
    setActiveHolds(next);
  }, [entries, holdMs]);

  useEffect(() => {
    if (!activeHolds.size) return;
    const timeout = setTimeout(
      () => {
        const remaining = new Map([...holds.current].filter(([, until]) => until > Date.now()));
        holds.current = remaining;
        setActiveHolds(remaining);
      },
      Math.max(0, Math.min(...activeHolds.values()) - Date.now())
    );
    return () => clearTimeout(timeout);
  }, [activeHolds]);

  return useMemo(
    () =>
      entries.map((entry) => ({
        ...entry,
        active:
          entry.status === 'running' ||
          activeHolds.has(entry.id) ||
          previous.current.some(
            (item) =>
              item.status === 'running' &&
              (item.id === entry.id ||
                (item.id === 'bash-pending' &&
                  entry.userInitiated &&
                  item.command === entry.command))
          )
      })),
    [entries, activeHolds]
  );
}
