import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useBodyContent, useExitingItems } from '@/hooks/useToolCardMotion';
import { useI18n } from '@/hooks/useI18n';
import { useResizablePanel } from '@/hooks/useResizablePanel';
import {
  executionOutputTail,
  formatExecutionDuration,
  type ExecutionHistoryEntry,
  type ExecutionHistoryStatus
} from '@/lib/execution-history';
import { ToolCodeLanguageProvider, ToolCodeTokens } from './ToolCode';
import { CodemodeCallList } from './CodemodeToolView';
import { PatchDiffFiles } from './PatchDiffView';
import type { GoalFacts } from '@/lib/goal-driver';
import type { CompactResultInfo } from '@/hooks/useAgentSession';

const STATUS_MARK: Record<ExecutionHistoryStatus, string> = {
  running: '▍',
  success: '✓',
  error: '×',
  cancelled: '⊘'
};

const STATUS_KEY: Record<ExecutionHistoryStatus, string> = {
  running: 'codemode.status.running',
  success: 'codemode.status.ok',
  error: 'codemode.status.error',
  cancelled: 'codemode.status.cancelled'
};

function RunOutput({ entry, sessionId }: { entry: ExecutionHistoryEntry; sessionId?: string }) {
  const { t } = useI18n();
  const [showAll, setShowAll] = useState(false);
  const [fullOutput, setFullOutput] = useState<string | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [fullError, setFullError] = useState<string | null>(null);
  const fullOutputUrl =
    sessionId && entry.fullOutputPath
      ? `/api/agent/${encodeURIComponent(sessionId)}/bash-output?path=${encodeURIComponent(entry.fullOutputPath)}`
      : null;
  const output = fullOutput ?? entry.output;
  const tail = executionOutputTail(output);

  async function loadFullOutput() {
    if (!fullOutputUrl) return;
    setLoadingFull(true);
    setFullError(null);
    try {
      const response = await fetch(fullOutputUrl);
      const data = (await response.json()) as {
        success?: boolean;
        data?: { output?: string };
        error?: string;
      };
      if (data.success) {
        setFullOutput(data.data?.output ?? '');
        setShowAll(true);
      } else setFullError(data.error ?? 'unavailable');
    } catch (error) {
      setFullError(String(error));
    } finally {
      setLoadingFull(false);
    }
  }

  if (!output && !entry.fullOutputPath) {
    return (
      <div className="run-history-waiting">
        {entry.status === 'running' ? t('runs.waiting') : t('runs.noOutput')}
      </div>
    );
  }
  return (
    <div className="run-history-output-block">
      {output && (
        <>
          <div className="run-history-label">{t('runs.output')}</div>
          <pre
            className="run-history-output"
            data-error={
              entry.status === 'error' || entry.status === 'cancelled' ? 'true' : undefined
            }
          >
            {tail && !showAll ? tail.tail : output}
          </pre>
          {tail && (
            <button
              type="button"
              className="run-history-text-button"
              onClick={() => setShowAll((value) => !value)}
            >
              {showAll ? t('runs.showLess') : t('runs.showAllLines', { count: tail.hiddenLines })}
            </button>
          )}
        </>
      )}
      {entry.truncated && (
        <div className="run-history-note">
          <span>{t('runs.truncated')}</span>
          {fullOutputUrl && fullOutput === null && (
            <button
              type="button"
              className="run-history-text-button"
              onClick={loadFullOutput}
              disabled={loadingFull}
            >
              {loadingFull ? t('runs.loadingFull') : t('runs.showFull')}
            </button>
          )}
          {fullOutputUrl && (
            <a className="run-history-text-link" href={`${fullOutputUrl}&download=1`}>
              {t('runs.downloadFull')}
            </a>
          )}
          {fullError && <span className="run-history-note-error">({fullError})</span>}
        </div>
      )}
    </div>
  );
}

function RunEntry({
  entry,
  sessionId,
  entering = false,
  exiting = false,
  fading = false
}: {
  entry: ExecutionHistoryEntry;
  sessionId?: string;
  entering?: boolean;
  exiting?: boolean;
  fading?: boolean;
}) {
  const { t } = useI18n();
  // The section owns the default: live runs open, historical runs fold.
  const [expanded, setExpanded] = useState(() => entry.active ?? entry.status === 'running');
  const [animateIn] = useState(entering);
  const showBody = useBodyContent(expanded);
  const slotRef = useRef<HTMLLIElement>(null);
  useLayoutEffect(() => {
    if (!exiting || !slotRef.current?.contains(document.activeElement)) return;
    const panel = slotRef.current.closest('.run-history');
    const replacement = [
      ...(panel?.querySelectorAll<HTMLElement>('.run-history-past [data-run-id]') ?? [])
    ].find((node) => node.dataset.runId === entry.id);
    const target = replacement?.closest('[inert]')
      ? panel?.querySelector<HTMLButtonElement>('.run-history-toggle')
      : replacement?.querySelector<HTMLButtonElement>('.run-history-entry-header');
    target?.focus();
  }, [entry.id, exiting]);
  const duration = formatExecutionDuration(entry.durationMs);
  const callCount = entry.calls ? entry.calls.length + (entry.omittedCalls ?? 0) : 0;

  return (
    <li
      ref={slotRef}
      className={`run-history-slot${fading ? ' tool-card-exit' : ''}`}
      aria-hidden={exiting || undefined}
      inert={exiting || undefined}
      data-run-id={entry.id}
    >
      <div
        className="run-history-entry tool-card"
        data-state={entry.status}
        data-status={entry.status}
        data-active={entry.active || entry.status === 'running' ? 'true' : undefined}
        data-live={animateIn ? 'true' : undefined}
      >
        <button
          type="button"
          className="run-history-entry-header"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className="run-history-mark" data-status={entry.status} aria-hidden="true">
            {STATUS_MARK[entry.status]}
          </span>
          <span className="run-history-content">
            <span className="run-history-title-row">
              <span className="run-history-tool">{entry.toolName}</span>
              {entry.userInitiated && <span className="run-history-tag">{t('runs.you')}</span>}
              <span className="run-history-meta">
                <span key={entry.status} className="run-history-status" data-status={entry.status}>
                  {t(STATUS_KEY[entry.status])}
                </span>
                {callCount > 0 && (
                  <span>
                    {callCount === 1
                      ? t('codemode.callCountOne')
                      : t('codemode.callCount', { count: callCount })}
                  </span>
                )}
                {duration && <span>{duration}</span>}
                <svg
                  className="run-history-chevron"
                  data-open={expanded ? 'true' : undefined}
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <polyline points="2 3.5 5 6.5 8 3.5" />
                </svg>
              </span>
            </span>
            <span className="run-history-preview">{entry.preview || t('runs.noCommand')}</span>
          </span>
        </button>

        <div
          className="tool-card-body"
          data-open={expanded ? 'true' : undefined}
          aria-hidden={!expanded || undefined}
          inert={!expanded || undefined}
        >
          <div className="tool-card-body-inner">
            {showBody && (
              <div className="run-history-body">
                {entry.diffFiles && (
                  <div className="run-history-diff">
                    <PatchDiffFiles files={entry.diffFiles} layout="stacked" />
                  </div>
                )}
                {entry.kind === 'codemode' && callCount > 0 && (
                  <CodemodeCallList calls={entry.calls ?? []} omitted={entry.omittedCalls ?? 0} />
                )}
                {entry.kind === 'codemode' && entry.script && (
                  <details className="run-history-script">
                    <summary>{t('codemode.script')}</summary>
                    <pre>
                      <ToolCodeLanguageProvider lang="javascript">
                        <ToolCodeTokens text={entry.script.replace(/\r/g, '').trimEnd()} />
                      </ToolCodeLanguageProvider>
                    </pre>
                  </details>
                )}
                {entry.kind === 'tool' && entry.command && (
                  <>
                    <div className="run-history-label">{t('runs.input')}</div>
                    <pre className="run-history-command">{entry.command}</pre>
                  </>
                )}
                {entry.kind !== 'tool' &&
                  entry.command &&
                  !(entry.kind === 'codemode' && entry.script) && (
                    <pre className="run-history-command">{entry.command}</pre>
                  )}
                <RunOutput entry={entry} sessionId={sessionId} />
              </div>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

const runId = (entry: ExecutionHistoryEntry) => entry.id;

// The history's share of the Runs panel, above the header row it keeps when it
// is closed. The active list always keeps room for its title and one card.
const RUN_HISTORY_DEFAULT_HEIGHT = 320;
const RUN_HISTORY_MIN_HEIGHT = 120;
const RUN_HISTORY_MAX_HEIGHT = 2000;
const RUN_HISTORY_ACTIVE_RESERVE = 120;
const RUN_HISTORY_STORAGE_KEY = 'pi-runs-history-height';

/** The permanent run history, newest first. */
export function ExecutionHistoryPanel({
  entries,
  sessionId,
  historyOpen,
  onHistoryOpenChange,
  goal,
  isCompacting,
  compactResult,
  compactError
}: {
  entries: readonly ExecutionHistoryEntry[];
  sessionId?: string;
  historyOpen: boolean;
  onHistoryOpenChange: (open: boolean) => void;
  goal?: GoalFacts;
  isCompacting?: boolean;
  compactResult?: CompactResultInfo | null;
  compactError?: string | null;
}) {
  const { t } = useI18n();
  // The panel the history shares with the active list: the history keeps the
  // height the user drags its top edge to, and the list takes the rest.
  const containerRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLElement>(null);
  const historyHeightRef = useRef(RUN_HISTORY_DEFAULT_HEIGHT);
  const getDefaultHistoryHeight = useCallback(
    () => Math.round((containerRef.current?.clientHeight ?? 0) * 0.45),
    []
  );
  const getMaxHistoryHeight = useCallback(() => {
    const containerHeight = containerRef.current?.clientHeight ?? 0;
    const statusHeight = statusRef.current?.offsetHeight ?? 0;
    return Math.max(
      RUN_HISTORY_MIN_HEIGHT,
      containerHeight - statusHeight - RUN_HISTORY_ACTIVE_RESERVE
    );
  }, []);
  const historyResizer = useResizablePanel({
    ariaLabel: t('layout.resizeRunsHistory'),
    axis: 'vertical',
    cssVariable: '--runs-history-height',
    defaultWidth: RUN_HISTORY_DEFAULT_HEIGHT,
    getDefaultWidth: getDefaultHistoryHeight,
    getMaxWidth: getMaxHistoryHeight,
    growthDirection: 'up',
    maxWidth: RUN_HISTORY_MAX_HEIGHT,
    minWidth: RUN_HISTORY_MIN_HEIGHT,
    persistClamp: false,
    storageKey: RUN_HISTORY_STORAGE_KEY,
    widthRef: historyHeightRef
  });
  // Goal and compaction cards above the sections change what is left to share.
  const reclampHistoryHeight = historyResizer.reclampWidth;
  const panelRefs = useCallback(
    (node: HTMLDivElement | null) => {
      containerRef.current = node;
      historyResizer.panelRef.current = node;
    },
    [historyResizer.panelRef]
  );
  const ordered = useMemo(() => [...entries].reverse(), [entries]);
  const active = ordered.filter((entry) => entry.active ?? entry.status === 'running');
  const history = ordered.filter((entry) => !(entry.active ?? entry.status === 'running'));
  const initialIds = useRef(new Set(entries.map(runId)));
  const previousActive = useRef(new Set(active.map(runId)));
  const heldActive = useExitingItems(active, runId);
  const positions = new Map(ordered.map((entry, index) => [entry.id, index]));
  const visibleActive = [...heldActive].sort(
    (a, b) => (positions.get(a.item.id) ?? Infinity) - (positions.get(b.item.id) ?? Infinity)
  );
  useLayoutEffect(() => {
    previousActive.current = new Set(active.map(runId));
  });

  const hasStatus = Boolean(goal || isCompacting || compactResult || compactError);

  useLayoutEffect(() => {
    const status = hasStatus ? statusRef.current : null;
    if (!status || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => reclampHistoryHeight());
    observer.observe(status);
    return () => observer.disconnect();
  }, [hasStatus, reclampHistoryHeight]);

  return (
    <div
      ref={panelRefs}
      className={`run-history${historyResizer.isResizing ? ' is-resizing' : ''}`}
      data-history-open={historyOpen ? 'true' : 'false'}
    >
      {hasStatus && (
        <section
          ref={statusRef}
          className="run-history-status-section"
          aria-label={t('runs.status')}
        >
          {goal && (
            <div className="run-history-status-card" data-kind="goal" data-status={goal.status}>
              <div className="run-history-status-header">
                <span className="run-history-status-title-row">
                  <span className="run-history-status-badge" data-status={goal.status}>
                    <span className="run-history-status-dot" aria-hidden="true" />
                    {goal.status === 'active'
                      ? t('chat.goalStatus.active')
                      : goal.status === 'paused'
                        ? t('chat.goalStatus.paused')
                        : goal.status === 'done' || goal.status === 'completed'
                          ? t('chat.goalStatus.done')
                          : goal.status}
                  </span>
                  <span className="run-history-status-title">{t('chat.goal')}</span>
                </span>
                {goal.tokensUsed !== undefined && (
                  <span className="run-history-status-tokens">
                    {goal.tokenBudget
                      ? t('chat.goalTokensOfBudget', {
                          used: goal.tokensUsed.toLocaleString(),
                          budget: goal.tokenBudget.toLocaleString()
                        })
                      : t('chat.goalTokens', { used: goal.tokensUsed.toLocaleString() })}
                  </span>
                )}
              </div>
              {goal.objective && (
                <div className="run-history-status-objective" title={goal.objective}>
                  {goal.objective}
                </div>
              )}
            </div>
          )}

          {(isCompacting || compactResult || compactError) && (
            <div
              className="run-history-status-card"
              data-kind="compact"
              data-status={compactError ? 'error' : isCompacting ? 'running' : 'success'}
            >
              <div className="run-history-status-header">
                <span className="run-history-status-title-row">
                  <span
                    className="run-history-status-badge"
                    data-status={compactError ? 'error' : isCompacting ? 'running' : 'success'}
                  >
                    <span className="run-history-status-dot" aria-hidden="true" />
                    {compactError
                      ? t('codemode.status.error')
                      : isCompacting
                        ? t('chat.compacting')
                        : t('chat.compacted')}
                  </span>
                  <span className="run-history-status-title">{t('chat.compact')}</span>
                </span>
                {compactResult && !isCompacting && !compactError && (
                  <span className="run-history-status-tokens">
                    {compactResult.tokensBefore.toLocaleString()} →{' '}
                    {compactResult.estimatedTokensAfter.toLocaleString()}
                  </span>
                )}
              </div>
              {compactError && <div className="run-history-status-error">{compactError}</div>}
            </div>
          )}
        </section>
      )}
      <section
        className="run-history-section run-history-active"
        aria-labelledby="runs-active-title"
      >
        <h3 className="run-history-section-title" id="runs-active-title">
          <span>{t('runs.active')}</span>
          <span className="run-history-count">{active.length}</span>
        </h3>
        <div className="run-history-scroll" tabIndex={0} aria-label={t('runs.active')}>
          {visibleActive.length ? (
            <ol className="run-history-list">
              {visibleActive.map(({ item, exiting, fading }) => (
                <RunEntry
                  key={item.id}
                  entry={item}
                  sessionId={sessionId}
                  entering={!initialIds.current.has(item.id)}
                  exiting={exiting}
                  fading={fading}
                />
              ))}
            </ol>
          ) : (
            <p className="run-history-placeholder">{t('runs.noActive')}</p>
          )}
        </div>
      </section>
      {/* The active list's bottom border is the idle separator; this widens its
          grasp and lets the user give the history more or less room. */}
      {historyOpen && (
        <div
          {...historyResizer.separatorProps}
          aria-controls="runs-history-content"
          className={`panel-resize-handle run-history-resize-handle${historyResizer.isResizing ? ' is-resizing' : ''}`}
          data-resize-handle="runs-history"
          title={`${t('layout.resizeRunsHistory')}: ${t('layout.resizeHint')}`}
        />
      )}
      <section
        className="run-history-section run-history-past"
        aria-labelledby="runs-history-title"
      >
        <h3 className="run-history-section-title run-history-past-title" id="runs-history-title">
          <button
            type="button"
            className="run-history-toggle"
            aria-expanded={historyOpen}
            aria-controls="runs-history-content"
            onClick={() => onHistoryOpenChange(!historyOpen)}
          >
            <span>{t('runs.history')}</span>
            <span className="run-history-toggle-meta">
              <span className="run-history-count">{history.length}</span>
              <svg
                className="run-history-chevron"
                data-open={historyOpen ? 'true' : undefined}
                width="10"
                height="10"
                viewBox="0 0 10 10"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="2 3.5 5 6.5 8 3.5" />
              </svg>
            </span>
          </button>
        </h3>
        <div
          id="runs-history-content"
          className="run-history-scroll run-history-past-content"
          tabIndex={historyOpen ? 0 : -1}
          aria-label={t('runs.history')}
          aria-hidden={!historyOpen || undefined}
          inert={!historyOpen || undefined}
        >
          {history.length ? (
            <ol className="run-history-list">
              {history.map((entry) => (
                <RunEntry
                  key={entry.id}
                  entry={entry}
                  sessionId={sessionId}
                  entering={previousActive.current.has(entry.id)}
                />
              ))}
            </ol>
          ) : (
            <p className="run-history-placeholder">{t('runs.noHistory')}</p>
          )}
        </div>
      </section>
    </div>
  );
}
