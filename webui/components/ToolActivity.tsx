// Derive display activity from the existing client execution state.
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useI18n } from '@/hooks/useI18n';
import type { ToolState } from '@/lib/tool-card-expansion';

const EMPTY_IDS: ReadonlySet<string> = new Set<string>();
const Activity = createContext<{ live: ReadonlySet<string> }>({ live: EMPTY_IDS });

type PhaseLike = { kind: string; tools?: { id: string }[] } | null;

/**
 * The tool calls whose card is live: the ones the agent reports as running, plus
 * any that already streamed partial output. A partial result is not a result, so
 * it keeps the card open instead of ending it.
 */
export function liveToolIds(
  phase: PhaseLike,
  partialResults: ReadonlyMap<string, unknown>
): ReadonlySet<string> {
  const ids = new Set(phase?.kind === 'running_tools' ? phase.tools?.map((tool) => tool.id) : []);
  for (const id of partialResults.keys()) ids.add(id);
  return ids;
}

export function ToolActivityProvider({
  phase,
  partialResults,
  children
}: {
  phase: PhaseLike;
  partialResults: ReadonlyMap<string, unknown>;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ live: liveToolIds(phase, partialResults) }),
    [phase, partialResults]
  );
  return <Activity.Provider value={value}>{children}</Activity.Provider>;
}

/** Which tool calls are executing right now, partial output included. */
export function useToolActivity() {
  return useContext(Activity);
}

export function useToolState(id: string, hasResult: boolean, isError: boolean): ToolState {
  const { live } = useContext(Activity);
  if (live.has(id)) return 'running';
  if (hasResult) return isError ? 'error' : 'success';
  return 'pending';
}

/** Stable text plus a CSS-only terminal cursor: no timers or per-frame React work. */
export function ToolStatus({ state }: { state: ToolState }) {
  const { t } = useI18n();
  if (state === 'pending') return null;
  const label = t(
    state === 'running'
      ? 'codemode.status.running'
      : state === 'error'
        ? 'codemode.status.error'
        : 'codemode.status.ok'
  );
  return (
    <span className="tool-status" data-state={state} key={state}>
      <span className="tool-status-mark" aria-hidden="true">
        {state === 'running' ? '▍' : state === 'error' ? '×' : '✓'}
      </span>
      <span>{label}</span>
    </span>
  );
}
