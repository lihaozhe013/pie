import type { AgentEndInfo, NewSessionChoices } from '@/hooks/useAgentSession';
import { useAudio } from '@/hooks/useAudio';
import { useFontPreferences } from '@/hooks/useFontPreferences';
import { useI18n } from '@/hooks/useI18n';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useGlobalKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useResizablePanel } from '@/hooks/useResizablePanel';
import { useTheme } from '@/hooks/useTheme';
import { useViewportHeight } from '@/hooks/useViewportHeight';
import { sendAgentCommand } from '@/lib/agent-client';
import type { McpErrorResponse, ProjectTrustStatus } from '@/lib/api-types';
import {
  claimExtensionAttentionNotification,
  shouldShowBrowserNotification,
  showBrowserNotification
} from '@/lib/browser-notifications';
import type { ChatScrollPosition } from '@/lib/chat-scroll-position';
import { copyText } from '@/lib/clipboard';
import { getDraft, rekeyDraft } from '@/lib/draft-store';
import type { ExecutionHistoryEntry } from '@/lib/execution-history';
import { getFileName } from '@/lib/file-paths';
import { getInitialNavigation, linkedSessionId, withTabOpen } from '@/lib/initial-navigation';
import {
  contextForCwd,
  type NewSessionContext,
  type NewSessionMove,
  type NewSessionOptions,
  type NewSessionTarget
} from '@/lib/new-session-context';
import {
  getRightPanelMaxWidth,
  getSidebarMaxWidth,
  isRunsPanelOpen,
  RIGHT_PANEL_DEFAULT_WIDTH,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  RUNS_PANEL_DEFAULT_PREFERENCE,
  type RunsPanelPreference,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  toggleRunsPanelPreference
} from '@/lib/panel-layout';
import type { SessionStatsInfo } from '@/lib/pi-types';
import { setupPushSubscription } from '@/lib/push-client';
import {
  getLastSettingsSection,
  settingsSectionRequiresProject,
  type SettingsSection
} from '@/lib/settings-navigation';
import {
  clearTabOpenSession,
  getTabOpen,
  setTabOpenNewSession,
  setTabOpenSession
} from '@/lib/tab-session';
import { type ToolEntry } from '@/lib/tool-presets';
import type { BlockingExtensionUiRequest, SessionInfo, SessionTreeNode } from '@/lib/types';
import type { TaskProjectSummary } from '@/lib/tasks/types';
import {
  clearLastOpen,
  getLastOpenSession,
  setLastOpenSession,
  workspaceKeyOf
} from '@/lib/workspace-memory';
import { useRouter, useSearchParams } from '@/hooks/useAppLocation';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BranchNavigator, hasSessionBranches } from './BranchNavigator';
import type { ChatInputHandle } from './ChatInput';
import { ChatWindow } from './ChatWindow';
import { ExecutionHistoryPanel } from './ExecutionHistoryPanel';
import type { GoalFacts } from '@/lib/goal-driver';
import type { CompactResultInfo } from '@/hooks/useAgentSession';
import { NewSessionContextBar, type NewSessionContextControl } from './NewSessionContextBar';
import { ProjectTrustDialog, type ProjectTrustFailure } from './ProjectTrustDialog';
import { mergeCatalogRow } from './session-catalog-helpers';
import { SessionInfoSidebar, useInformationPanelOverlay } from './SessionInfoSidebar';
import { SessionModal } from './SessionModal';
import { SessionPanelActions } from './SessionPanelActions';
import { SessionStatsModal, type SessionCopyField } from './SessionStatsModal';
import {
  SessionSidebar,
  type SelectSessionOptions,
  type SessionSidebarControl
} from './SessionSidebar';
import { SettingsPanel, SettingsSectionIcon } from './SettingsPanel';
import { SystemPromptPanel } from './SystemPromptPanel';
import { TaskProjectsSidebar } from './TaskProjectsSidebar';
import { TaskWorkspace } from './TaskWorkspace';
import { ToolDefinitionsPanel } from './ToolDefinitionsPanel';
import { WorkspaceSwitch } from './WorkspaceSwitch';

type AutoNameStatus =
  { kind: 'idle' } | { kind: 'naming' } | { kind: 'success' } | { kind: 'error'; message: string };

const TOP_BAR_ICON_BUTTON_SIZE = 36;

function parkedNewSessionDraftKey(cwd: string): string {
  return `parked-new:${cwd}`;
}

export function AppShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [initialNavigation, setInitialNavigation] = useState(() =>
    getInitialNavigation(searchParams)
  );
  // `?mode=tasks` switches the whole workspace. With the parameter absent,
  // nothing about the conversation view changes.
  const taskMode = searchParams.get('mode') === 'tasks';
  // The task board's project is URL state, like a conversation's id. The board
  // reports the server's default choice here so a reload returns to it.
  const taskCwd = taskMode ? (searchParams.get('cwd') || null) : null;
  const [taskProjects, setTaskProjects] = useState<TaskProjectSummary[]>([]);
  const handleTaskProjectsChange = useCallback((projects: TaskProjectSummary[]) => {
    setTaskProjects(projects);
  }, []);
  const handleTaskProjectChange = useCallback(
    (cwd: string | null) => {
      const next = new URLSearchParams(window.location.search);
      next.set('mode', 'tasks');
      if (cwd) next.set('cwd', cwd);
      else next.delete('cwd');
      router.replace(`?${next.toString()}`, { scroll: false });
    },
    [router]
  );
  // Keep the system-theme subscription mounted for the lifetime of the app.
  useTheme();
  // Restore fonts even when Settings and the chat composer have not been opened.
  useFontPreferences();
  const { locale, t: translate } = useI18n();
  const isMobile = useIsMobile();
  const handleTaskProjectSelect = useCallback(
    (cwd: string) => {
      const next = new URLSearchParams(window.location.search);
      next.set('mode', 'tasks');
      next.set('cwd', cwd);
      // A project switch is a new board; a task deep link from another project
      // must not reopen over it.
      next.delete('task');
      router.replace(`?${next.toString()}`, { scroll: false });
      if (isMobile) setSidebarOpen(false);
    },
    [isMobile, router]
  );
  useViewportHeight();

  // Once the user has granted notification permission, register a Web Push
  // subscription so the server can notify backgrounded PWAs (notably iOS,
  // which suspends page JS and never receives the SSE completion event).
  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    void setupPushSubscription(locale);
  }, [locale]);
  // Audio ownership lives here (not in ChatWindow) so the completion tone can
  // also fire for tasks finishing in a non-active workspace whose ChatWindow
  // is not mounted. ChatWindow receives the audio callbacks as props.
  const { soundEnabled, onSoundToggle, playDoneSound, unlockAudio, holdAudio, soundEnabledRef } =
    useAudio();
  const [quoteSelectionEnabled, setQuoteSelectionEnabled] = useState(false);
  useEffect(() => {
    try {
      setQuoteSelectionEnabled(localStorage.getItem('pi-quote-selection-enabled') === 'true');
    } catch {
      // Browser storage is best-effort.
    }
  }, []);
  const handleQuoteSelectionChange = useCallback((enabled: boolean) => {
    setQuoteSelectionEnabled(enabled);
    try {
      localStorage.setItem('pi-quote-selection-enabled', String(enabled));
    } catch {
      // Keep the current page usable when storage is unavailable.
    }
  }, []);
  const notifiedAttentionRequestIdsRef = useRef(new Set<string>());
  const handleBackgroundTaskDone = useCallback(() => {
    if (soundEnabledRef.current) playDoneSound();
  }, [playDoneSound, soundEnabledRef]);
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);
  // Latest selection readable from async callbacks whose captured state is
  // stale (e.g. a delete that completes after the user navigated away).
  const selectedSessionRef = useRef(selectedSession);
  selectedSessionRef.current = selectedSession;
  const [sessionCatalog, setSessionCatalog] = useState<SessionInfo[]>([]);
  const handleSessionsChange = useCallback((sessions: SessionInfo[]) => {
    setSessionCatalog(sessions);
    // The sidebar hydrates metadata after the selected session has already
    // mounted. Merge that update into the active session without changing the
    // ChatWindow key or restarting its history load.
    setSelectedSession((current) => {
      if (!current) return current;
      const refreshed = sessions.find((session) => session.id === current.id);
      return refreshed ? mergeCatalogRow(current, refreshed) : current;
    });
  }, []);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const [awaitingInputSessionIds, setAwaitingInputSessionIds] = useState<Set<string>>(
    () => new Set()
  );
  // Sessions a task child is writing. The task board keeps them in their task
  // row instead of listing them as chat work.
  const [taskSessionIds, setTaskSessionIds] = useState<Set<string>>(() => new Set());
  const handleTaskSessionIdsChange = useCallback((ids: Set<string>) => {
    setTaskSessionIds((previous) => {
      if (previous.size === ids.size && [...ids].every((id) => previous.has(id))) return previous;
      return ids;
    });
  }, []);
  const handleRunningSessionIdsChange = useCallback((ids: Set<string>) => {
    setRunningSessionIds((previous) => {
      if (previous.size === ids.size && [...ids].every((id) => previous.has(id))) return previous;
      return ids;
    });
  }, []);
  const handleAwaitingInputSessionIdsChange = useCallback((ids: Set<string>) => {
    setAwaitingInputSessionIds((previous) => {
      if (previous.size === ids.size && [...ids].every((id) => previous.has(id))) return previous;
      return ids;
    });
  }, []);
  // Task mode has no conversation sidebar, so it owns the same live catalogue
  // the chat sidebar would otherwise poll: projects need new sessions at once,
  // and rows need to turn into running tasks as soon as a prompt starts.
  useEffect(() => {
    if (!taskMode) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let sessionListVersion: number | null = null;
    let runningKey = '';
    const loadSessions = async () => {
      try {
        const response = await fetch('/api/sessions?includeTransient=1', {
          cache: 'no-store'
        });
        if (!response.ok) return;
        const data = (await response.json()) as { sessions: SessionInfo[] };
        if (!stopped) handleSessionsChange(data.sessions);
      } catch {
        // The last catalogue remains usable; the next poll retries.
      }
    };
    const schedule = (delay: number) => {
      if (stopped) return;
      timer = setTimeout(() => void tick(), delay);
    };
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === 'hidden') {
        schedule(3_000);
        return;
      }
      let anyRunning = false;
      try {
        const response = await fetch('/api/agent/running', { cache: 'no-store' });
        if (response.ok) {
          const data = (await response.json()) as {
            sessionListVersion: number;
            runningSessionIds?: string[];
            awaitingInputSessionIds?: string[];
          };
          if (stopped) return;
          const running = new Set(data.runningSessionIds ?? []);
          anyRunning = running.size > 0;
          handleRunningSessionIdsChange(running);
          handleAwaitingInputSessionIdsChange(
            new Set(data.awaitingInputSessionIds ?? [])
          );
          const nextRunningKey = [...running].sort().join('\n');
          if (
            sessionListVersion === null ||
            sessionListVersion !== data.sessionListVersion ||
            nextRunningKey !== runningKey
          ) {
            sessionListVersion = data.sessionListVersion;
            runningKey = nextRunningKey;
            await loadSessions();
          }
        }
      } catch {
        // Keep the last state; the next visible-tab poll retries.
      } finally {
        schedule(anyRunning ? 1_000 : 3_000);
      }
    };
    void loadSessions().finally(() => schedule(0));
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    handleAwaitingInputSessionIdsChange,
    handleRunningSessionIdsChange,
    handleSessionsChange,
    taskMode
  ]);
  // The temporary id distinguishes consecutive fresh composers in one cwd.
  const [newSessionCwd, setNewSessionCwd] = useState<string | null>(null);
  const [newSessionDraftId, setNewSessionDraftId] = useState('initial');
  const activeNewSessionDraftKeyRef = useRef<string | null>(null);
  // The bar above a fresh composer (NewSessionContextBar): the sidebar reports
  // what it shows and carries out its moves, which remount the composer. Its
  // model and reasoning picks, as it last reported them, go along with the
  // draft to the composer that replaces it, which takes them once.
  const sidebarControlRef = useRef<SessionSidebarControl | null>(null);
  const [sidebarNewSessionContext, setSidebarNewSessionContext] =
    useState<NewSessionContext | null>(null);
  const newSessionMoveRef = useRef<NewSessionMove | null>(null);
  const handleSidebarNewSessionContext = useCallback((context: NewSessionContext | null) => {
    if (context && context.cwd === newSessionMoveRef.current?.cwd) newSessionMoveRef.current = null;
    setSidebarNewSessionContext(context);
  }, []);
  const newSessionBarFocusRef = useRef<NewSessionContextControl | null>(null);
  const newSessionChoicesRef = useRef<NewSessionChoices | null>(null);
  const [carriedNewSessionChoices, setCarriedNewSessionChoices] =
    useState<NewSessionChoices | null>(null);
  const handleNewSessionChoicesChange = useCallback((choices: NewSessionChoices) => {
    newSessionChoicesRef.current = choices;
    setCarriedNewSessionChoices(null);
  }, []);
  const [initialCwdStatus, setInitialCwdStatus] = useState<
    'idle' | 'validating' | 'ready' | 'error'
  >(() => (initialNavigation.requestedCwd ? 'validating' : 'idle'));
  const [initialCwdError, setInitialCwdError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sessionKey, setSessionKey] = useState(0);
  const sessionScrollPositionsRef = useRef(new Map<string, ChatScrollPosition>());
  const handleSessionScrollPositionChange = useCallback(
    (sessionId: string, position: ChatScrollPosition) => {
      sessionScrollPositionsRef.current.set(sessionId, position);
    },
    []
  );
  const [searchTarget, setSearchTarget] = useState<{
    sessionId: string;
    entryId: string;
    blockIndex?: number;
  } | null>(null);
  const handleSearchTargetHandled = useCallback(
    (target: { sessionId: string; entryId: string }) => {
      setSearchTarget((current) => (current === target ? null : current));
    },
    []
  );
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  // Bumped when Settings › Tools saves; the session's composer reloads its preset copy.
  const [toolPresetsRefreshKey, setToolPresetsRefreshKey] = useState(0);
  const [projectTrust, setProjectTrust] = useState<ProjectTrustStatus | null>(null);
  const [projectTrustDialogOpen, setProjectTrustDialogOpen] = useState(false);
  const [projectTrustBusy, setProjectTrustBusy] = useState(false);
  const [projectTrustError, setProjectTrustError] = useState<ProjectTrustFailure | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => !initialNavigation.sidebarCollapsed);
  const desktopSidebarOpenRef = useRef(!initialNavigation.sidebarCollapsed);
  const [mobileSidebarReady, setMobileSidebarReady] = useState(false);
  const sidebarWidthRef = useRef(SIDEBAR_DEFAULT_WIDTH);
  const runsPanelWidthRef = useRef(RIGHT_PANEL_DEFAULT_WIDTH);
  const getResponsiveSidebarMaxWidth = useCallback(
    () =>
      typeof window === 'undefined'
        ? SIDEBAR_MAX_WIDTH
        : getSidebarMaxWidth({
            viewportWidth: window.innerWidth,
            rightPanelOpen: false,
            rightPanelWidth: 0
          }),
    []
  );
  const sidebarResizer = useResizablePanel({
    ariaLabel: translate('layout.resizeSidebar'),
    cssVariable: '--sidebar-width',
    defaultWidth: SIDEBAR_DEFAULT_WIDTH,
    getMaxWidth: getResponsiveSidebarMaxWidth,
    growthDirection: 'right',
    maxWidth: SIDEBAR_MAX_WIDTH,
    minWidth: SIDEBAR_MIN_WIDTH,
    storageKey: 'pi-sidebar-width',
    widthRef: sidebarWidthRef
  });
  // On mobile the sidebar is an overlay drawer; hide it by default so the chat
  // is visible on load. Runs once the breakpoint resolves after hydration.
  // Mobile drawer actions must not change the remembered desktop preference.
  useEffect(() => {
    setSidebarOpen(isMobile ? false : desktopSidebarOpenRef.current);
  }, [isMobile]);
  useEffect(() => {
    setMobileSidebarReady(true);
  }, []);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const [pendingQuotePrompt, setPendingQuotePrompt] = useState<{
    sessionId: string;
    text: string;
  } | null>(null);
  const topBarRef = useRef<HTMLDivElement>(null);
  // Branch navigator state — populated by ChatWindow via onBranchDataChange
  const [branchTree, setBranchTree] = useState<SessionTreeNode[]>([]);
  const [branchActiveLeafId, setBranchActiveLeafId] = useState<string | null>(null);
  const [branchSwitchLocked, setBranchSwitchLocked] = useState(false);
  const branchLeafChangeFnRef = useRef<((leafId: string | null) => void) | null>(null);
  const sessionHasBranches = hasSessionBranches(branchTree);

  const handleBranchDataChange = useCallback(
    (
      tree: SessionTreeNode[],
      activeLeafId: string | null,
      onLeafChange: (leafId: string | null) => void,
      locked: boolean
    ) => {
      setBranchTree(tree);
      setBranchActiveLeafId(activeLeafId);
      setBranchSwitchLocked(locked);
      branchLeafChangeFnRef.current = onLeafChange;
    },
    []
  );

  const handleBranchLeafChange = useCallback((leafId: string | null) => {
    branchLeafChangeFnRef.current?.(leafId);
  }, []);

  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [systemTools, setSystemTools] = useState<ToolEntry[] | null>(null);
  const [executionHistory, setExecutionHistory] = useState<ExecutionHistoryEntry[]>([]);
  const [runHistoryOpen, setRunHistoryOpen] = useState(false);
  const [systemInfoLoading, setSystemInfoLoading] = useState(false);
  const systemInfoLoaderRef = useRef<(() => Promise<void>) | null>(null);
  const systemInfoLoadIdRef = useRef(0);

  const handleSystemPromptChange = useCallback((prompt: string | null) => {
    setSystemPrompt(prompt);
    setSystemInfoLoading(false);
  }, []);

  const handleSystemToolsChange = useCallback((tools: ToolEntry[] | null) => {
    setSystemTools(tools);
  }, []);

  const handleExecutionHistoryChange = useCallback((entries: ExecutionHistoryEntry[]) => {
    setExecutionHistory(entries);
  }, []);

  const [sessionGoal, setSessionGoal] = useState<GoalFacts | undefined>(undefined);
  const [sessionCompaction, setSessionCompaction] = useState<{
    isCompacting: boolean;
    compactResult: CompactResultInfo | null;
    compactError: string | null;
  }>({ isCompacting: false, compactResult: null, compactError: null });

  const handleGoalChange = useCallback((goal: GoalFacts | undefined) => {
    setSessionGoal(goal);
  }, []);

  const handleCompactionChange = useCallback(
    (compaction: {
      isCompacting: boolean;
      compactResult: CompactResultInfo | null;
      compactError: string | null;
    }) => {
      setSessionCompaction(compaction);
    },
    []
  );

  const informationPanelOverlay = useInformationPanelOverlay(
    sidebarOpen ? sidebarResizer.width : 0
  );
  const runInProgress = executionHistory.some((entry) => entry.status === 'running');

  const handleSystemInfoLoaderChange = useCallback((loader: (() => Promise<void>) | null) => {
    systemInfoLoadIdRef.current += 1;
    systemInfoLoaderRef.current = loader;
    setSystemInfoLoading(false);
  }, []);

  // Session stats (tokens + cost) — populated by ChatWindow, displayed in top bar
  const [sessionStats, setSessionStats] = useState<SessionStatsInfo | null>(null);
  const [autoNameStatus, setAutoNameStatus] = useState<AutoNameStatus>({ kind: 'idle' });
  const autoNameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSessionIdRef = useRef<string | null>(selectedSession?.id ?? null);
  activeSessionIdRef.current = selectedSession?.id ?? null;
  const handleSessionStatsChange = useCallback((stats: SessionStatsInfo | null) => {
    setSessionStats(stats);
  }, []);
  const [copiedSessionField, setCopiedSessionField] = useState<SessionCopyField | null>(null);
  const sessionCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopySessionField = useCallback((field: SessionCopyField, value: string) => {
    void copyText(value).then(() => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      setCopiedSessionField(field);
      sessionCopyTimerRef.current = setTimeout(() => setCopiedSessionField(null), 1400);
    });
  }, []);

  useEffect(() => {
    return () => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    };
  }, []);

  // Context usage — populated by ChatWindow, displayed in top bar
  const [contextUsage, setContextUsage] = useState<{
    percent: number | null;
    contextWindow: number;
    tokens: number | null;
  } | null>(null);
  const handleContextUsageChange = useCallback(
    (usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => {
      setContextUsage(usage);
    },
    []
  );

  // The right panel is dedicated exclusively to Runs and belongs to the
  // default page: docked, it is open until the user collapses it, even before
  // a command runs. Where it would overlay the conversation it starts closed
  // so the conversation stays visible. The viewport is measured after mount,
  // so the server never renders a panel that a phone would cover.
  const [runsPanelViewportReady, setRunsPanelViewportReady] = useState(false);
  useLayoutEffect(() => setRunsPanelViewportReady(true), []);
  const [runsPanelPreference, setRunsPanelPreference] = useState<RunsPanelPreference>(
    RUNS_PANEL_DEFAULT_PREFERENCE
  );
  const runsPanelOpen =
    runsPanelViewportReady &&
    isRunsPanelOpen(runsPanelPreference, {
      overlay: informationPanelOverlay,
      settingsOpen: Boolean(settingsSection)
    });
  // The Runs panel is a docked, resizable column beside the conversation. Its
  // size is the user's own (stored, never rewritten by a small window), and a
  // window, a wide sidebar or the chat's minimum width caps what it shows.
  const getResponsiveRunsPanelMaxWidth = useCallback(
    () =>
      typeof window === 'undefined'
        ? RIGHT_PANEL_MAX_WIDTH
        : getRightPanelMaxWidth({
            viewportWidth: window.innerWidth,
            sidebarOpen: sidebarOpen && !isMobile,
            sidebarWidth: sidebarOpen ? sidebarResizer.width : 0,
            overlay: informationPanelOverlay
          }),
    [informationPanelOverlay, isMobile, sidebarOpen, sidebarResizer.width]
  );
  const runsPanelResizer = useResizablePanel({
    ariaLabel: translate('layout.resizeRunsPanel'),
    cssVariable: '--runs-panel-width',
    defaultWidth: RIGHT_PANEL_DEFAULT_WIDTH,
    getMaxWidth: getResponsiveRunsPanelMaxWidth,
    growthDirection: 'left',
    maxWidth: RIGHT_PANEL_MAX_WIDTH,
    minWidth: RIGHT_PANEL_MIN_WIDTH,
    persistClamp: false,
    storageKey: 'pi-runs-panel-width',
    widthRef: runsPanelWidthRef
  });
  // The panel gives way to the conversation: a sidebar that grows, or a window
  // that shrinks, narrows it, and the user's width returns when there is room.
  const reclampRunsPanelWidth = runsPanelResizer.reclampWidth;
  useLayoutEffect(() => {
    if (!runsPanelViewportReady) return;
    reclampRunsPanelWidth();
  }, [reclampRunsPanelWidth, runsPanelViewportReady]);
  // A panel the user asked for takes focus; one that belongs to the default
  // page must not pull focus out of the conversation.
  const focusRunsPanelRef = useRef(false);
  useEffect(() => {
    if (!runsPanelOpen) focusRunsPanelRef.current = false;
  }, [runsPanelOpen]);

  // Modals for System Prompt, Tools, Session Stats, and Branches
  const [activeModal, setActiveModal] = useState<
    'system' | 'tools' | 'session' | 'branches' | null
  >(null);

  useEffect(() => {
    if (!sessionHasBranches) {
      setActiveModal((modal) => (modal === 'branches' ? null : modal));
    }
  }, [sessionHasBranches]);

  useEffect(() => {
    if (settingsSection) setActiveModal(null);
  }, [settingsSection]);

  const toggleRunsPanel = useCallback(() => {
    if (isMobile) setSidebarOpen(false);
    focusRunsPanelRef.current = !runsPanelOpen;
    setRunsPanelPreference((preference) =>
      toggleRunsPanelPreference(preference, {
        open: runsPanelOpen,
        overlay: informationPanelOverlay
      })
    );
  }, [informationPanelOverlay, isMobile, runsPanelOpen]);

  const runsPanelToggleRef = useRef<HTMLButtonElement>(null);
  const closeRunsPanel = useCallback(() => {
    focusRunsPanelRef.current = false;
    setRunsPanelPreference({ collapsed: true, overlayRequested: false });
    // The header's close button leaves the page; the edge toggle takes focus.
    requestAnimationFrame(() => runsPanelToggleRef.current?.focus({ preventScroll: true }));
  }, []);

  // A phone's drawer covers the Runs overlay. Dismissing it is not the same as
  // collapsing the panel: the docked layout keeps its default open state.
  const dismissRunsPanelOverlay = useCallback(() => {
    setRunsPanelPreference((preference) =>
      preference.overlayRequested ? { ...preference, overlayRequested: false } : preference
    );
  }, []);

  // The task queue lives in the same right-hand slot as the Runs panel, so the
  // two workspaces share one spatial language: sidebar, center, inspector. It
  // keeps its own collapse choice (collapsing Runs does not hide the queue) but
  // shares the resized width, so the center's edge does not move between modes.
  // Where the panel cannot dock, the queue stays in the center column.
  const [taskQueuePreference, setTaskQueuePreference] = useState<RunsPanelPreference>(
    RUNS_PANEL_DEFAULT_PREFERENCE
  );
  const taskQueuePanelDocked = runsPanelViewportReady && !informationPanelOverlay;
  const taskQueuePanelOpen =
    taskMode &&
    taskQueuePanelDocked &&
    isRunsPanelOpen(taskQueuePreference, {
      overlay: false,
      settingsOpen: Boolean(settingsSection)
    });
  // The queue list is rendered by TaskWorkspace, which owns its state, and
  // portaled into this slot so the panel spans the page height beside the
  // center column instead of sitting inside it.
  const [taskQueuePanelSlot, setTaskQueuePanelSlot] = useState<HTMLDivElement | null>(null);
  const focusTaskQueuePanelRef = useRef(false);
  useEffect(() => {
    if (!taskQueuePanelOpen) focusTaskQueuePanelRef.current = false;
  }, [taskQueuePanelOpen]);
  const toggleTaskQueuePanel = useCallback(() => {
    focusTaskQueuePanelRef.current = !taskQueuePanelOpen;
    setTaskQueuePreference((preference) =>
      toggleRunsPanelPreference(preference, { open: taskQueuePanelOpen, overlay: false })
    );
  }, [taskQueuePanelOpen]);
  const closeTaskQueuePanel = useCallback(() => {
    focusTaskQueuePanelRef.current = false;
    setTaskQueuePreference({ collapsed: true, overlayRequested: false });
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>('[data-task-queue-toggle="true"]')
        ?.focus({ preventScroll: true });
    });
  }, []);

  const requestSystemInformation = useCallback((): boolean => {
    const load = systemInfoLoaderRef.current;
    if (!load) return false;
    const loadId = ++systemInfoLoadIdRef.current;
    setSystemInfoLoading(true);
    void load()
      .catch((error) => {
        console.error('Failed to load system information:', error);
      })
      .finally(() => {
        if (systemInfoLoadIdRef.current === loadId) {
          setSystemInfoLoading(false);
        }
      });
    return true;
  }, []);

  const handleSystemInfoToggle = useCallback(
    (modal: 'system' | 'tools') => {
      const opening = activeModal !== modal;
      if (isMobile) setSidebarOpen(false);
      setActiveModal((cur) => (cur === modal ? null : modal));
      if (!opening || systemInfoLoading) return;
      requestSystemInformation();
    },
    [activeModal, isMobile, requestSystemInformation, systemInfoLoading]
  );

  // Settings › Tools lists the tools of the current session, including installed
  // extensions, so opening it asks the session for its loadout once. A failure keeps
  // the editor's static fallback and does not retry in a loop.
  const settingsToolsLoadRef = useRef<string | null>(null);
  useEffect(() => {
    if (settingsSection !== 'tools') {
      settingsToolsLoadRef.current = null;
      return;
    }
    if (systemTools !== null) return;
    const key = selectedSession?.id ?? 'new-session';
    if (settingsToolsLoadRef.current === key) return;
    if (!requestSystemInformation()) return;
    settingsToolsLoadRef.current = key;
  }, [requestSystemInformation, selectedSession?.id, settingsSection, systemTools]);

  const openSessionStatsPanel = useCallback(() => {
    if (isMobile) setSidebarOpen(false);
    setActiveModal('session');
  }, [isMobile]);

  // The composer opens Settings too: a bare /mcp opens Settings › MCP (useAgentSession).
  const openSettingsSection = useCallback((section: SettingsSection) => {
    setActiveModal(null);
    setSettingsSection(section);
  }, []);

  const handleSidebarToggle = useCallback(() => {
    if (isMobile) dismissRunsPanelOverlay();
    setSidebarOpen((open) => {
      const next = !open;
      if (!isMobile) desktopSidebarOpenRef.current = next;
      return next;
    });
  }, [dismissRunsPanelOverlay, isMobile]);

  const initialSessionId = initialNavigation.sessionId;
  const initialLinkedSessionId = linkedSessionId(initialNavigation);
  const [activeCwd, setActiveCwd] = useState<string | null>(null);
  // Chat -> Tasks keeps the conversation's project, so the board opens the
  // same project the person was already looking at.
  const taskLinkCwd = taskMode ? taskCwd : (selectedSession?.cwd ?? newSessionCwd ?? activeCwd);
  const activeProjectKeyRef = useRef<string | null>(null);
  // True once the initial ?session= URL param has been resolved (or confirmed absent)
  const [initialSessionRestored, setInitialSessionRestored] = useState<boolean>(
    () => !initialSessionId
  );
  // sessionStorage is empty during SSR. Applying the tab's remembered session
  // in the useState initializer made the first client tree differ from the
  // server HTML (sidebar "select project" vs ""). Restore after mount instead.
  useLayoutEffect(() => {
    // The task workspace owns the URL it was opened with: restoring a
    // remembered conversation here would replace `?mode=tasks` and drop the
    // user back into chat before the queue ever renders.
    if (taskMode) return;
    const next = withTabOpen(initialNavigation, getTabOpen());
    if (next === initialNavigation) return;
    setInitialNavigation(next);
    if (next.sessionId) setInitialSessionRestored(false);
  }, [initialNavigation, taskMode]);
  // Suppresses sessionKey bump in handleCwdChange during the initial URL restore
  const suppressCwdBumpRef = useRef(false);
  // Set when the session the URL linked to is gone: the project the sidebar
  // adopts next keeps a fresh composer instead of restoring its last session.
  const skipWorkspaceRestoreRef = useRef(false);
  // Guards the async workspace restore so a slow response from an earlier
  // switch cannot resurrect a session into a project the user already left.
  const workspaceRestoreTokenRef = useRef(0);

  const invalidateWorkspaceRestore = useCallback(() => {
    workspaceRestoreTokenRef.current += 1;
  }, []);

  // Persist every active-session transition, including new and forked sessions
  // that bypass the sidebar selection handler. Transient sessions do not yet
  // carry projectKey, so use the active project identity until hydration.
  // The workspace memory is shared by every tab; the tab memory keeps this
  // tab's own session so a reload does not follow another tab's last pick.
  // New session is a selection too: remember the composer cwd so reload stays
  // on that UI instead of resurrecting the previous chat.
  useEffect(() => {
    if (selectedSession) {
      const projectKey =
        selectedSession.projectKey ??
        activeProjectKeyRef.current ??
        workspaceKeyOf(selectedSession);
      setLastOpenSession(projectKey, selectedSession.id);
      setTabOpenSession(selectedSession.id);
      return;
    }
    if (newSessionCwd) setTabOpenNewSession(newSessionCwd);
  }, [newSessionCwd, selectedSession]);

  useEffect(() => {
    const requestedCwd = initialNavigation.requestedCwd;
    // A visible conversation wins over a requested directory that was already
    // applied: the navigation snapshot only changes on mount and tab-memory
    // restore, not when the workspace switch changes the visible view.
    if (!requestedCwd || taskMode || selectedSession) return;

    const controller = new AbortController();
    setInitialCwdStatus('validating');
    setInitialCwdError(null);

    void fetch('/api/cwd/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: requestedCwd }),
      signal: controller.signal
    })
      .then(async (response) => {
        const data = (await response.json().catch(() => ({}))) as { cwd?: string; error?: string };
        if (!response.ok || !data.cwd) {
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }

        // The sidebar will notify us when it adopts this cwd. Avoid remounting
        // the just-created empty chat during that initial synchronization.
        suppressCwdBumpRef.current = true;
        const draftId = `initial:${requestedCwd}`;
        setNewSessionDraftId(draftId);
        activeNewSessionDraftKeyRef.current = `new:${draftId}:${data.cwd}`;
        setNewSessionCwd(data.cwd);
        setInitialCwdStatus('ready');
        if (!new URLSearchParams(window.location.search).get('cwd')) {
          router.replace(`?cwd=${encodeURIComponent(data.cwd)}`, { scroll: false });
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setInitialCwdError(error instanceof Error ? error.message : String(error));
        setInitialCwdStatus('error');
      });

    return () => controller.abort();
  }, [initialNavigation, router, selectedSession, taskMode]);

  // Restore the workspace's last open session after switching to it. Called
  // from handleCwdChange once the outgoing context has been reset. The session
  // is looked up against the live list so a deleted or drifted session falls
  // back to the default welcome page instead of erroring.
  const restoreWorkspaceContext = useCallback(
    (projectKey: string, cwd: string) => {
      const token = ++workspaceRestoreTokenRef.current;
      const lastOpenSessionId = getLastOpenSession(projectKey);
      if (!lastOpenSessionId) return;
      const adopt = (d: { sessions: SessionInfo[] } | null) => {
        if (token !== workspaceRestoreTokenRef.current) return; // stale switch
        const s = d?.sessions.find((x) => x.id === lastOpenSessionId);
        if (!s) {
          // The list loaded but the remembered session is gone — forget it.
          // When the list itself failed (d === null) keep the memory so a
          // later switch retries the restore.
          if (d) clearLastOpen(projectKey);
          return;
        }
        if (workspaceKeyOf(s) !== projectKey) {
          // Defensive: the remembered session drifted out of this workspace.
          clearLastOpen(projectKey);
          return;
        }
        const activeDraftKey = activeNewSessionDraftKeyRef.current;
        if (activeDraftKey) {
          rekeyDraft(activeDraftKey, parkedNewSessionDraftKey(cwd));
        }
        activeNewSessionDraftKeyRef.current = null;
        // Selecting the session must remount the chat with the session
        // present: useAgentSession loads content in a mount-only effect, so
        // the null-session welcome mount from the switch would never load
        // the restored session's messages.
        setSelectedSession(s);
        setSessionKey((k) => k + 1);
        if (new URLSearchParams(window.location.search).get('session') !== s.id) {
          router.replace(`?session=${encodeURIComponent(s.id)}`, { scroll: false });
        }
      };
      // Fast path: the sidebar already delivered the catalogue — restore
      // without waiting on a fresh /api/sessions round trip.
      if (sessionCatalog.length > 0) {
        adopt({ sessions: sessionCatalog });
        return;
      }
      void fetch('/api/sessions')
        .then((r) => (r.ok ? (r.json() as Promise<{ sessions: SessionInfo[] }>) : null))
        .then(adopt)
        .catch(() => {
          // Network hiccup: keep the remembered session for a later retry.
        });
    },
    [router, sessionCatalog]
  );

  const handleCwdChange = useCallback(
    (cwd: string | null, projectRoot?: string | null, projectKey?: string | null) => {
      invalidateWorkspaceRestore();
      const currentFreshCwd = newSessionCwd ?? activeCwd;
      setActiveCwd(cwd);
      // Skip if cwd is null (initial mount).
      if (!cwd) return;
      const skipWorkspaceRestore = skipWorkspaceRestoreRef.current;
      skipWorkspaceRestoreRef.current = false;
      const newProject = projectKey ?? projectRoot ?? cwd;
      const currentProject =
        activeProjectKeyRef.current ?? (selectedSession ? workspaceKeyOf(selectedSession) : null);
      activeProjectKeyRef.current = newProject;

      // Keep the project identity in sync during the initial URL restore without
      // remounting the just-created or restored chat.
      if (suppressCwdBumpRef.current) {
        suppressCwdBumpRef.current = false;
        return;
      }
      // The server may hydrate a normalized key after a custom cwd is already
      // active. Updating identity for the exact same cwd is not a user switch.
      if (currentFreshCwd === cwd && currentProject !== newProject) return;
      if (currentProject === newProject && (selectedSession !== null || currentFreshCwd === cwd)) {
        return;
      }
      // Close any session that belongs to a different project — it no longer
      // matches the selected project directory.
      const previousDraftKey = activeNewSessionDraftKeyRef.current;
      if (previousDraftKey && currentFreshCwd) {
        rekeyDraft(previousDraftKey, parkedNewSessionDraftKey(currentFreshCwd));
      }
      const draftId =
        typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const draftKey = `new:${draftId}:${cwd}`;
      rekeyDraft(parkedNewSessionDraftKey(cwd), draftKey);
      setNewSessionDraftId(draftId);
      activeNewSessionDraftKeyRef.current = draftKey;
      setSelectedSession(null);
      setNewSessionCwd((prev) => {
        if (prev && prev !== cwd) return null;
        return prev;
      });
      setSessionKey((k) => k + 1);
      setBranchTree([]);
      setBranchActiveLeafId(null);
      setBranchSwitchLocked(false);
      setSystemPrompt(null);
      setSystemTools(null);
      setSystemInfoLoading(false);
      if (currentProject !== newProject && !taskMode) {
        // Restore the workspace we switched to: its last open session, or keep
        // the default welcome page when none is remembered. The task view has
        // no conversation to restore and owns its own URL.
        if (!skipWorkspaceRestore) restoreWorkspaceContext(newProject, cwd);
      }
      if (taskMode) return;
      router.replace(typeof window !== 'undefined' ? window.location.pathname : '/', {
        scroll: false
      });
    },
    [
      activeCwd,
      invalidateWorkspaceRestore,
      newSessionCwd,
      router,
      selectedSession,
      restoreWorkspaceContext,
      taskMode
    ]
  );

  const handleSelectSession = useCallback(
    (
      session: SessionInfo,
      isRestore = false,
      entryId?: string,
      blockIndex?: number,
      options?: SelectSessionOptions
    ) => {
      setSearchTarget(entryId ? { sessionId: session.id, entryId, blockIndex } : null);
      invalidateWorkspaceRestore();
      const activeDraftKey = activeNewSessionDraftKeyRef.current;
      const activeDraftCwd = newSessionCwd ?? (selectedSession === null ? activeCwd : null);
      if (activeDraftKey && activeDraftCwd) {
        rekeyDraft(activeDraftKey, parkedNewSessionDraftKey(activeDraftCwd));
      }
      activeNewSessionDraftKeyRef.current = null;
      // Adopt an explicitly selected session before the sidebar reports its cwd.
      const projectKey = workspaceKeyOf(session);
      activeProjectKeyRef.current = projectKey;
      // Re-clicking the already-open session must not remount the chat and
      // re-run the full load/positioning cycle. Only skip when the effective
      // cwd context already matches — otherwise a pending cwd move still needs
      // the full re-select flow.
      if (!isRestore && selectedSession) {
        const sameProject = workspaceKeyOf(selectedSession) === workspaceKeyOf(session);
        // The task workspace can sit on the conversation it already has in
        // state; choosing that row is still how the person returns to it, so
        // only skip the remount when the conversation is the visible view.
        if (selectedSession.id === session.id && sameProject && !taskMode) {
          if (isMobile) setSidebarOpen(false);
          return;
        }
      }
      setNewSessionCwd(null);
      setSelectedSession(session);
      setSessionKey((k) => k + 1);
      setBranchTree([]);
      setBranchActiveLeafId(null);
      setBranchSwitchLocked(false);
      branchLeafChangeFnRef.current = null;
      setSystemPrompt(null);
      setSystemTools(null);
      setSystemInfoLoading(false);
      setInitialSessionRestored(true);
      // On mobile, collapse the overlay drawer so the chat is revealed after pick
      // (unless the sidebar still has something to show: a fork's row and toast).
      if (isMobile && !isRestore && !options?.keepSidebarOpen) setSidebarOpen(false);
      if (isRestore) {
        // Suppress the redundant sessionKey bump that would come from the
        // onCwdChange effect firing after setSelectedCwd in the sidebar
        suppressCwdBumpRef.current = true;
      }
      // Skip router.replace when the URL already has this session; replacing
      // it again would re-render the shell for no change.
      // Tab-memory restore lands on `/` and must write `?session=` so reload
      // and copy-link keep this session.
      if (!isRestore || new URLSearchParams(window.location.search).get('session') !== session.id) {
        router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
      }
    },
    [
      activeCwd,
      invalidateWorkspaceRestore,
      router,
      isMobile,
      newSessionCwd,
      selectedSession,
      taskMode
    ]
  );

  const handleNewSession = useCallback(
    (sessionId: string, cwd: string, projectKey?: string | null, options?: NewSessionOptions) => {
      invalidateWorkspaceRestore();
      const draftKey = `new:${sessionId}:${cwd}`;
      // Leaving a fresh composer for another cwd parks its draft there, as a
      // workspace switch does; New in the same cwd still starts empty. The bar
      // above the composer moves the composer instead: its draft (the live
      // text, as promoteNewSession takes it) and its model picks go along.
      const activeDraftKey = activeNewSessionDraftKeyRef.current;
      const activeDraftCwd = newSessionCwd ?? (selectedSession === null ? activeCwd : null);
      if (options?.carryComposer && selectedSession === null && activeDraftKey) {
        const input = chatInputRef.current;
        if (input) input.rekeyDraft(activeDraftKey, draftKey);
        else rekeyDraft(activeDraftKey, draftKey);
        setCarriedNewSessionChoices(newSessionChoicesRef.current);
      } else if (activeDraftKey && activeDraftCwd && activeDraftCwd !== cwd) {
        rekeyDraft(activeDraftKey, parkedNewSessionDraftKey(activeDraftCwd));
      }
      // Adopt the target project before the sidebar reports its cwd, as an
      // explicit session pick does. Without a key (Ctrl+Alt+N) the current cwd
      // keeps its project.
      const targetProject =
        projectKey ?? (cwd === activeCwd ? activeProjectKeyRef.current : null) ?? cwd;
      activeProjectKeyRef.current = targetProject;
      // A draft parked in this cwd comes back, unless one was carried here: it
      // stays parked for the next time, never merged into what was carried.
      if (!getDraft(draftKey)) rekeyDraft(parkedNewSessionDraftKey(cwd), draftKey);
      activeNewSessionDraftKeyRef.current = draftKey;
      setNewSessionDraftId(sessionId);
      setSelectedSession(null);
      setNewSessionCwd(cwd);
      setSessionKey((k) => k + 1);
      setBranchTree([]);
      setBranchActiveLeafId(null);
      setBranchSwitchLocked(false);
      setSystemPrompt(null);
      setSystemTools(null);
      setSystemInfoLoading(false);
      if (isMobile) setSidebarOpen(false);
      router.replace(`?cwd=${encodeURIComponent(cwd)}`, { scroll: false });
      // The fresh composer takes the caret once it renders (#1313), unless the
      // move came from the new-session bar, whose control keeps focus instead
      // (newSessionBarFocusRef), or a phone would raise the keyboard for it.
      // A dialog still open over the page (Ctrl+Alt+N under Settings) keeps it.
      if (!isMobile && !newSessionBarFocusRef.current) {
        requestAnimationFrame(() => {
          if (document.activeElement?.closest("[aria-modal='true']")) return;
          chatInputRef.current?.focus();
        });
      }
    },
    [activeCwd, invalidateWorkspaceRestore, isMobile, newSessionCwd, router, selectedSession]
  );

  // Global keyboard shortcuts (handles Esc, Ctrl+Alt+N etc.)
  useGlobalKeyboardShortcuts({
    onNewSession: (cwd: string) => handleNewSession(`kb-${Date.now()}`, cwd),
    activeCwd
  });

  const hydrateSelectedSession = useCallback((sessionId: string) => {
    void fetch('/api/sessions', { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<{ sessions: SessionInfo[] }>) : null))
      .then((d) => {
        const full = d?.sessions.find((s) => s.id === sessionId);
        if (!full) return;
        setSelectedSession((prev) =>
          prev?.id === sessionId ? { ...prev, ...full, transient: full.transient ?? false } : prev
        );
      })
      .catch(() => {});
  }, []);

  // Leaving the task workspace for Chat returns to the conversation this
  // project last had open: the sidebar and the switch stay where they are, so
  // the two views read as one workspace. An explicit pick or the tab's parked
  // new-session composer already decided what to show and wins over memory.
  const wasTaskModeRef = useRef(taskMode);
  useEffect(() => {
    const wasTaskMode = wasTaskModeRef.current;
    wasTaskModeRef.current = taskMode;
    if (!wasTaskMode || taskMode) return;
    // The task view owned the URL, so there is no pending ?session= restore to
    // wait for once the conversation is visible again.
    setInitialSessionRestored(true);
    if (selectedSession || newSessionCwd) return;
    // The initial-navigation effect mounts the tab's own fresh composer; a
    // restored session would take its place.
    if (getTabOpen()?.kind === 'new') return;
    if (!activeProjectKeyRef.current || !activeCwd) return;
    restoreWorkspaceContext(activeProjectKeyRef.current, activeCwd);
  }, [activeCwd, newSessionCwd, restoreWorkspaceContext, selectedSession, taskMode]);

  // Called by ChatWindow when a new session gets its real id from pi
  const handleSessionCreated = useCallback(
    (session: SessionInfo, sourceDraftKey: string) => {
      setRefreshKey((k) => k + 1);
      if (activeNewSessionDraftKeyRef.current !== sourceDraftKey) return;
      invalidateWorkspaceRestore();
      activeNewSessionDraftKeyRef.current = null;
      setNewSessionCwd(null);
      setSelectedSession(session);
      hydrateSelectedSession(session.id);
      router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
    },
    [invalidateWorkspaceRestore, router, hydrateSelectedSession]
  );

  const deliverSessionNotification = useCallback(
    ({
      targetSession,
      title,
      body,
      tag
    }: {
      targetSession: SessionInfo | null;
      title: string;
      body: string;
      tag?: string;
    }) => {
      if (!('Notification' in window)) return;

      const fire = () => {
        const sessionUrl = targetSession
          ? `/?session=${encodeURIComponent(targetSession.id)}`
          : '/';
        void showBrowserNotification({
          title,
          body,
          sessionUrl,
          tag,
          onClick: () => {
            window.focus();
            if (targetSession) handleSelectSession(targetSession);
          }
        });
      };

      if (Notification.permission === 'granted') {
        fire();
        void setupPushSubscription(locale);
      } else if (Notification.permission === 'default') {
        void Notification.requestPermission().then((p) => {
          if (p === 'granted') {
            fire();
            void setupPushSubscription(locale);
          }
        });
      }
    },
    [handleSelectSession, locale]
  );

  const handleAgentEnd = useCallback(
    (end: AgentEndInfo) => {
      // The sidebar's reload merges the selected session's new row into it
      // (handleSessionsChange), so no list fetch of its own here.
      setRefreshKey((k) => k + 1);

      if (end.aborted) return;
      if (!shouldShowBrowserNotification()) return;
      const targetSession = selectedSession;
      deliverSessionNotification({
        targetSession,
        title: targetSession?.name ?? translate('i18n.sessionComplete'),
        body: translate('i18n.taskFinished'),
        tag: targetSession ? `pi-session-complete:${targetSession.id}` : 'pi-session-complete'
      });
    },
    [deliverSessionNotification, selectedSession, translate]
  );

  const handleAttentionNeeded = useCallback(
    (request: BlockingExtensionUiRequest) => {
      if (!shouldShowBrowserNotification()) return;
      if (!claimExtensionAttentionNotification(request, notifiedAttentionRequestIdsRef.current))
        return;

      deliverSessionNotification({
        targetSession: selectedSession,
        title: translate('i18n.attentionNeeded'),
        body: request.method === 'custom' ? translate('i18n.extensionInputNeeded') : request.title,
        tag: `pi-extension-ui:${request.id}`
      });
    },
    [deliverSessionNotification, selectedSession, translate]
  );

  const handleAutoName = useCallback(async () => {
    const sessionId = selectedSession?.id;
    if (!sessionId || autoNameStatus.kind === 'naming') return;
    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    setAutoNameStatus({ kind: 'naming' });

    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/auto-name`, {
        method: 'POST'
      });
      const body = (await response.json().catch(() => ({}))) as { title?: string; error?: string };
      if (!response.ok || !body.title) {
        throw new Error(body.error || `HTTP ${response.status}`);
      }

      const title = body.title.trim();
      setRefreshKey((key) => key + 1);
      if (activeSessionIdRef.current !== sessionId) return;
      setSelectedSession((current) =>
        current?.id === sessionId ? { ...current, name: title } : current
      );
      setSessionStats((current) =>
        current?.sessionId === sessionId ? { ...current, sessionName: title } : current
      );
      setAutoNameStatus({ kind: 'success' });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: 'idle' }), 1800);
    } catch (error) {
      if (activeSessionIdRef.current !== sessionId) return;
      const message = error instanceof Error ? error.message : String(error);
      setAutoNameStatus({ kind: 'error', message });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: 'idle' }), 5000);
    }
  }, [autoNameStatus.kind, selectedSession?.id]);

  const autoNameSessionId = selectedSession?.id;
  const previousAutoNameSessionIdRef = useRef(autoNameSessionId);
  useEffect(() => {
    if (previousAutoNameSessionIdRef.current === autoNameSessionId) return;
    previousAutoNameSessionIdRef.current = autoNameSessionId;
    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    setAutoNameStatus({ kind: 'idle' });
  }, [autoNameSessionId]);

  const handleSessionForked = useCallback(
    (newSessionId: string) => {
      invalidateWorkspaceRestore();
      activeNewSessionDraftKeyRef.current = null;
      setRefreshKey((k) => k + 1);
      setSessionKey((k) => k + 1);
      setNewSessionCwd(null);
      setSelectedSession((prev) => ({
        ...(prev ?? {
          path: '',
          cwd: '',
          created: '',
          modified: '',
          messageCount: 0,
          firstMessage: ''
        }),
        id: newSessionId,
        transient: false
      }));
      hydrateSelectedSession(newSessionId);
      router.replace(`?session=${encodeURIComponent(newSessionId)}`, { scroll: false });
    },
    [invalidateWorkspaceRestore, router, hydrateSelectedSession]
  );

  const handleAskInNewChat = useCallback(
    async (prompt: string, sourceSessionId: string, sourceEntryId: string) => {
      const result = await sendAgentCommand<{ newSessionId?: string }>(sourceSessionId, {
        type: 'fork_branch',
        entryId: sourceEntryId
      });
      if (!result?.newSessionId) throw new Error(translate('chat.quoteForkFailed'));
      setPendingQuotePrompt({ sessionId: result.newSessionId, text: prompt });
      handleSessionForked(result.newSessionId);
    },
    [handleSessionForked, translate]
  );

  // The sidebar calls this when the initial session is not in its list.
  const handleInitialRestoreDone = useCallback(() => {
    setInitialSessionRestored(true);
    if (initialLinkedSessionId) skipWorkspaceRestoreRef.current = true;
  }, [initialLinkedSessionId]);

  const handleSessionDeleted = useCallback(
    (sessionId: string) => {
      invalidateWorkspaceRestore();
      setRefreshKey((k) => k + 1);
      // The DELETE can outlive a session switch: this callback's captured
      // selectedSession is from the delete click. Read the latest selection
      // and only fall back to the empty composer when the user is still on
      // the deleted session at the moment removal completes.
      const active = selectedSessionRef.current;
      if (active?.id === sessionId) {
        clearTabOpenSession(sessionId);
        const cwd = active.cwd;
        const draftId =
          typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        setNewSessionDraftId(draftId);
        activeNewSessionDraftKeyRef.current = cwd ? `new:${draftId}:${cwd}` : null;
        setSelectedSession(null);
        setNewSessionCwd(cwd ?? null);
        setSessionKey((k) => k + 1);
        setBranchTree([]);
        setBranchActiveLeafId(null);
        setBranchSwitchLocked(false);
        setSystemPrompt(null);
        setSystemTools(null);
        setSystemInfoLoading(false);
        router.replace(
          cwd
            ? `?cwd=${encodeURIComponent(cwd)}`
            : typeof window !== 'undefined'
              ? window.location.pathname
              : '/',
          { scroll: false }
        );
      }
    },
    [invalidateWorkspaceRestore, router]
  );

  const handleViewFullHistory = useCallback(() => {
    if (!selectedSession) return;
    window.open(
      `/api/sessions/${encodeURIComponent(selectedSession.id)}/export?inline=1`,
      '_blank',
      'noopener,noreferrer'
    );
  }, [selectedSession]);

  // Show chat area if a session is selected, or if we have a cwd to start a new session in
  const effectiveNewSessionCwd =
    newSessionCwd ?? (selectedSession === null && activeCwd ? activeCwd : null);
  const newSessionDraftKey =
    selectedSession === null && effectiveNewSessionCwd
      ? `new:${newSessionDraftId}:${effectiveNewSessionCwd}`
      : null;
  useLayoutEffect(() => {
    activeNewSessionDraftKeyRef.current = newSessionDraftKey;
  }, [newSessionDraftKey]);

  // The bar above a fresh composer. Only a fresh composer moves, and only
  // somewhere else: the folder in use would remount it for nothing. The
  // control the move came from takes focus in the bar of the new composer.
  const handlePickNewSessionContext = useCallback(
    (target: NewSessionTarget, from: NewSessionContextControl) => {
      if (
        selectedSession !== null ||
        !effectiveNewSessionCwd ||
        target.cwd === effectiveNewSessionCwd
      )
        return;
      newSessionBarFocusRef.current = from;
      if (
        target.projectKey &&
        target.projectRoot &&
        newSessionMoveRef.current?.cwd !== target.cwd
      ) {
        newSessionMoveRef.current = {
          cwd: target.cwd,
          project: { key: target.projectKey, root: target.projectRoot }
        };
      }
      sidebarControlRef.current?.startNewSessionIn({ ...target, carryComposer: true });
    },
    [effectiveNewSessionCwd, selectedSession]
  );
  // The folder picker answers later: its pick runs the newest closure, guard included.
  const pickNewSessionContextRef = useRef(handlePickNewSessionContext);
  pickNewSessionContextRef.current = handlePickNewSessionContext;
  const handleOpenFolderForNewSession = useCallback((opener: HTMLElement | null) => {
    sidebarControlRef.current?.openFolderForNewSession(
      (target) => pickNewSessionContextRef.current(target, 'project'),
      opener
    );
  }, []);
  const handleDefaultDirectoryForNewSession = useCallback(() => {
    sidebarControlRef.current?.openDefaultDirectoryForNewSession((target) =>
      pickNewSessionContextRef.current(target, 'project')
    );
  }, []);
  const handleNewSessionBarFocusDone = useCallback(() => {
    newSessionBarFocusRef.current = null;
  }, []);
  const newSessionContextBar =
    selectedSession === null && effectiveNewSessionCwd ? (
      <NewSessionContextBar
        context={contextForCwd(
          sidebarNewSessionContext,
          effectiveNewSessionCwd,
          newSessionMoveRef.current
        )}
        mobile={isMobile}
        initialFocus={newSessionBarFocusRef.current}
        onInitialFocusDone={handleNewSessionBarFocusDone}
        onPick={handlePickNewSessionContext}
        onStartWithoutProject={handleDefaultDirectoryForNewSession}
        onOpenFolder={handleOpenFolderForNewSession}
      />
    ) : null;
  const showChat = selectedSession !== null || effectiveNewSessionCwd !== null;
  const projectTrustCwd = selectedSession?.cwd ?? effectiveNewSessionCwd;
  // While restoring initial session from URL, don't show the placeholder
  const showPlaceholder = initialSessionRestored && !showChat;

  useEffect(() => {
    setProjectTrust(null);
    setProjectTrustDialogOpen(false);
    setProjectTrustError(null);
    if (!projectTrustCwd) return;

    const controller = new AbortController();
    // The answer also lists the project's MCP servers (`mcpFile`, `mcpServers`), unused here: the
    // trust dialog fetches the listing again when it opens, since the file can change in between.
    fetch(`/api/project-trust?cwd=${encodeURIComponent(projectTrustCwd)}`, {
      signal: controller.signal
    })
      .then(async (response) => {
        const data = (await response.json()) as ProjectTrustStatus & { error?: string };
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        setProjectTrust(data);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        console.error('Failed to load project trust:', error);
      });
    return () => controller.abort();
  }, [projectTrustCwd]);

  const handleTrustProject = useCallback(async () => {
    if (!projectTrustCwd || projectTrustBusy) return;
    setProjectTrustBusy(true);
    setProjectTrustError(null);
    try {
      const response = await fetch('/api/project-trust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: projectTrustCwd })
      });
      const data = (await response.json()) as ProjectTrustStatus & Partial<McpErrorResponse>;
      if (!response.ok || data.error) {
        // The dialog translates the reason; the English error is only its diagnostic.
        setProjectTrustError({
          error: data.error ?? `HTTP ${response.status}`,
          ...(data.reason ? { reason: data.reason } : {})
        });
        return;
      }
      setProjectTrust(data);
      setProjectTrustDialogOpen(false);
      setModelsRefreshKey((key) => key + 1);
      setSessionKey((key) => key + 1);
    } catch (error) {
      setProjectTrustError({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      setProjectTrustBusy(false);
    }
  }, [projectTrustBusy, projectTrustCwd]);

  // The restricted-mode banner and Settings › MCP's trust notice open the same dialog.
  const openProjectTrustDialog = useCallback(() => {
    setProjectTrustError(null);
    setProjectTrustDialogOpen(true);
  }, []);

  // Settings › MCP added a project server: `.pi/mcp.json` alone makes a folder require trust, and a
  // fresh folder was trusted in the same step. Every mounted section reloads in place on the new
  // status (projectTrustReloadKey); nothing was rebuilt, so the chat needs no new session key.
  const handleProjectTrustChanged = useCallback(
    (cwd: string, status: ProjectTrustStatus) => {
      if (cwd === projectTrustCwd) setProjectTrust(status);
    },
    [projectTrustCwd]
  );

  const activeCwdName = activeCwd ? getFileName(activeCwd) || activeCwd : null;
  // The task workspace is its own page: a reload, a bookmark, or a push
  // notification labels the tab by the queue, not by the conversation behind it.
  const windowTitle = taskMode
    ? `${translate('tasks.board')} - Pie`
    : activeCwdName
      ? `${activeCwdName} - Pie`
      : 'Pie';

  useEffect(() => {
    const syncWindowTitle = () => {
      if (document.title !== windowTitle) document.title = windowTitle;
    };

    syncWindowTitle();
    const observer = new MutationObserver(syncWindowTitle);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [windowTitle]);

  const sidebarContent = (
    <>
      {taskMode ? (
        <TaskProjectsSidebar
          sessions={sessionCatalog}
          taskProjects={taskProjects}
          selectedCwd={taskCwd}
          onSelectProject={handleTaskProjectSelect}
        />
      ) : (
        <SessionSidebar
          selectedSessionId={selectedSession?.id ?? null}
          onSelectSession={handleSelectSession}
          onNewSession={handleNewSession}
          controlRef={sidebarControlRef}
          onNewSessionContextChange={handleSidebarNewSessionContext}
          initialSessionId={initialSessionId}
          initialSessionLinked={initialLinkedSessionId !== null}
          skipInitialProjectSelection={initialNavigation.requestedCwd !== null}
          onInitialRestoreDone={handleInitialRestoreDone}
          refreshKey={refreshKey}
          onSessionDeleted={handleSessionDeleted}
          selectedCwd={selectedSession?.cwd ?? newSessionCwd ?? null}
          onCwdChange={handleCwdChange}
          onBackgroundTaskDone={handleBackgroundTaskDone}
          onRunningSessionIdsChange={handleRunningSessionIdsChange}
          onTaskSessionIdsChange={handleTaskSessionIdsChange}
          onSessionsChange={handleSessionsChange}
        />
      )}
      <div
        style={{
          padding: '8px',
          flexShrink: 0,
          display: 'flex',
          justifyContent: 'space-between',
          gap: 4
        }}
      >
        {(
          [
            ['models', translate('common.models')],
            ['skills', translate('common.skills')]
          ] as const
        ).map(([section, label]) => {
          const disabled = settingsSectionRequiresProject(section) && !projectTrustCwd;
          return (
            <button
              key={section}
              type="button"
              onClick={() => setSettingsSection(section)}
              disabled={disabled}
              title={disabled ? translate('settings.projectRequired') : label}
              aria-label={label}
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                height: 32,
                padding: 0,
                background: 'none',
                border: 'none',
                borderRadius: 9,
                color: 'var(--text-muted)',
                cursor: disabled ? 'default' : 'pointer',
                fontSize: 12,
                opacity: disabled ? 0.35 : 1,
                transition: 'background 0.12s, color 0.12s'
              }}
              onMouseEnter={(event) => {
                if (!disabled) {
                  event.currentTarget.style.background = 'var(--bg-hover)';
                  event.currentTarget.style.color = 'var(--text)';
                }
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.background = 'none';
                event.currentTarget.style.color = 'var(--text-muted)';
              }}
            >
              <SettingsSectionIcon section={section} size={14} strokeWidth={2} />
              <span>{label}</span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setSettingsSection(getLastSettingsSection(projectTrustCwd))}
          title={translate('common.settings')}
          aria-label={translate('common.settings')}
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            height: 32,
            padding: 0,
            background: 'none',
            border: 'none',
            borderRadius: 9,
            color: 'var(--text-muted)',
            cursor: 'pointer',
            fontSize: 12,
            transition: 'background 0.12s, color 0.12s'
          }}
          onMouseEnter={(event) => {
            event.currentTarget.style.background = 'var(--bg-hover)';
            event.currentTarget.style.color = 'var(--text)';
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.background = 'none';
            event.currentTarget.style.color = 'var(--text-muted)';
          }}
        >
          <SettingsSectionIcon section="general" size={14} strokeWidth={2} />
          <span>{translate('common.settings')}</span>
        </button>
      </div>
    </>
  );

  const renderProjectTrustWarning = (mobileBanner: boolean) => {
    if (!showChat || !projectTrust?.requiresTrust || projectTrust.trusted) return null;
    return (
      <button
        type="button"
        onClick={openProjectTrustDialog}
        title={translate('trust.resourcesNotLoaded')}
        aria-label={translate('trust.resourcesNotLoaded')}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: mobileBanner ? 'flex-start' : 'center',
          gap: 6,
          width: mobileBanner ? '100%' : undefined,
          minHeight: mobileBanner ? 32 : undefined,
          height: mobileBanner ? undefined : '100%',
          padding: mobileBanner ? '6px 12px' : '0 12px',
          background: mobileBanner ? 'color-mix(in srgb, #d97706 8%, var(--bg-panel))' : 'none',
          border: 'none',
          borderRight: mobileBanner ? 'none' : '1px solid var(--border)',
          borderBottom: mobileBanner ? '1px solid var(--border)' : 'none',
          color: '#d97706',
          cursor: 'pointer',
          flexShrink: 0,
          fontSize: 11,
          lineHeight: 1.35,
          textAlign: 'left'
        }}
        data-mobile-trust-banner={mobileBanner ? 'true' : undefined}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          style={{ flexShrink: 0 }}
        >
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
          <path d="M12 8v4" />
          <path d="M12 16h.01" />
        </svg>
        <span>{translate('trust.resourcesNotLoaded')}</span>
      </button>
    );
  };

  // These controls describe the session rather than the next message, so they
  // live in the Runs panel, beside the runs that belong to it.
  const sessionTokens = sessionStats?.tokens ?? null;
  const sessionCost = sessionStats?.cost ?? 0;
  const hasSessionStats = Boolean(sessionStats || contextUsage);
  const sessionStatsTooltip = (() => {
    const parts: string[] = [];
    if (sessionTokens) {
      parts.push(`in: ${sessionTokens.input.toLocaleString(locale)}`);
      parts.push(`out: ${sessionTokens.output.toLocaleString(locale)}`);
      parts.push(`cache read: ${sessionTokens.cacheRead.toLocaleString(locale)}`);
      parts.push(`cache write: ${sessionTokens.cacheWrite.toLocaleString(locale)}`);
      if (sessionCost > 0) parts.push(`cost: $${sessionCost.toFixed(4)}`);
    }
    if (contextUsage?.contextWindow) {
      const percent = contextUsage.percent;
      const contextText =
        contextUsage.tokens !== null
          ? `${contextUsage.tokens.toLocaleString(locale)}${percent !== null ? ` (${percent.toFixed(1)}%)` : ''}`
          : percent !== null
            ? `${percent.toFixed(1)}%`
            : 'unknown';
      parts.push(
        `context: ${contextText} of ${contextUsage.contextWindow.toLocaleString(locale)} tokens`
      );
    }
    return parts.join('  |  ');
  })();
  const titleHasMessages = Boolean(
    selectedSession && ((sessionStats?.userMessages ?? 0) > 0 || selectedSession.messageCount > 0)
  );
  const titleDisabled =
    !selectedSession ||
    Boolean(selectedSession.transient) ||
    !titleHasMessages ||
    autoNameStatus.kind === 'naming';
  const titleLabel =
    autoNameStatus.kind === 'naming'
      ? translate('title.generating')
      : autoNameStatus.kind === 'success'
        ? translate('title.updated')
        : autoNameStatus.kind === 'error'
          ? translate('title.failed')
          : translate('title.generate');
  const titleTitle =
    !selectedSession || selectedSession.transient
      ? translate('title.unsaved')
      : !titleHasMessages
        ? translate('title.noMessages')
        : autoNameStatus.kind === 'error'
          ? autoNameStatus.message
          : translate('title.generateSession');
  const sessionPanelActions = (
    <SessionPanelActions
      onOpenHistory={handleViewFullHistory}
      historyDisabled={!selectedSession}
      historyTitle={selectedSession ? translate('history.full') : translate('history.unsaved')}
      onGenerateTitle={() => void handleAutoName()}
      name={{
        label: titleLabel,
        title: titleTitle,
        disabled: titleDisabled,
        busy: autoNameStatus.kind === 'naming',
        tone:
          autoNameStatus.kind === 'success'
            ? 'success'
            : autoNameStatus.kind === 'error'
              ? 'error'
              : 'default'
      }}
      onOpenSystem={() => handleSystemInfoToggle('system')}
      systemLoaded={Boolean(systemPrompt)}
      onOpenTools={() => handleSystemInfoToggle('tools')}
      toolsActive={Boolean(systemTools?.some((tool) => tool.active))}
      onOpenBranches={
        sessionHasBranches
          ? () => setActiveModal((cur) => (cur === 'branches' ? null : 'branches'))
          : null
      }
      stats={
        hasSessionStats
          ? {
              tokens: sessionTokens
                ? {
                    input: sessionTokens.input,
                    output: sessionTokens.output,
                    cacheRead: sessionTokens.cacheRead
                  }
                : null,
              cost: sessionCost,
              contextPercent: contextUsage?.percent ?? null,
              contextWindow: contextUsage?.contextWindow ?? null,
              contextTokens: contextUsage?.tokens ?? null,
              tooltip: sessionStatsTooltip
            }
          : null
      }
      onOpenStats={openSessionStatsPanel}
    />
  );

  // Settings and the trust dialog belong to the shell, not to one view: the
  // task workspace opens the same panels the conversation does.
  const settingsOverlays = (
    <>
      {settingsSection && (
        <SettingsPanel
          cwd={projectTrustCwd}
          sessionId={selectedSession?.id ?? null}
          initialSection={settingsSection}
          quoteSelectionEnabled={quoteSelectionEnabled}
          onQuoteSelectionChange={handleQuoteSelectionChange}
          onClose={() => {
            setSettingsSection(null);
            setModelsRefreshKey((key) => key + 1);
          }}
          onSessionReloaded={() => setSessionKey((key) => key + 1)}
          projectTrust={projectTrust}
          onOpenTrustDialog={openProjectTrustDialog}
          onProjectTrustChanged={handleProjectTrustChanged}
          onToolPresetsChanged={() => setToolPresetsRefreshKey((key) => key + 1)}
          availableTools={systemTools}
          toolsLoading={systemInfoLoading}
        />
      )}
      {/* After Settings, so it opens above it (z-index 1100 over 1000) when Settings › MCP asks for it. */}
      {projectTrustDialogOpen && projectTrustCwd && (
        <ProjectTrustDialog
          cwd={projectTrustCwd}
          busy={projectTrustBusy}
          error={projectTrustError}
          onCancel={() => {
            if (!projectTrustBusy) setProjectTrustDialogOpen(false);
          }}
          onConfirm={() => void handleTrustProject()}
          onStatus={setProjectTrust}
        />
      )}
    </>
  );

  return (
    <>
      <style>{`
      @keyframes session-info-pop {
        0% {
          opacity: 0;
          transform: translateY(-24px);
          filter: blur(6px);
          box-shadow: 0 2px 8px rgba(0,0,0,0);
        }
        55% {
          opacity: 1;
          transform: translateY(0);
          filter: blur(0);
          background: color-mix(in srgb, var(--accent) 8%, var(--bg-panel));
          box-shadow: 0 18px 44px rgba(37,99,235,0.16);
        }
        100% {
          opacity: 1;
          transform: translateY(0);
          filter: blur(0);
          background: var(--bg-panel);
          box-shadow: 0 10px 28px rgba(0,0,0,0.10);
        }
      }
      @keyframes session-info-light-wash {
        0% {
          opacity: 0;
          transform: translateX(-110%) skewX(-16deg);
        }
        24% {
          opacity: 0.42;
        }
        100% {
          opacity: 0;
          transform: translateX(115%) skewX(-16deg);
        }
      }
      .session-info-popover {
        position: relative;
        overflow: hidden;
        transform-origin: top right;
        animation: session-info-pop 360ms ease-out both;
        will-change: transform, opacity, filter, background, box-shadow;
      }
      .session-info-popover::after {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        width: 44%;
        pointer-events: none;
        background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 24%, transparent), transparent);
        animation: session-info-light-wash 620ms ease-out both;
      }
      @media (prefers-reduced-motion: reduce) {
        .session-info-popover,
        .session-info-popover::after {
          animation: none;
        }
      }
      .mobile-session-stats {
        container-type: inline-size;
      }
      @container (max-width: 158px) {
        .mobile-session-stat-io {
          display: none !important;
        }
      }
      @container (max-width: 88px) {
        .mobile-session-stat-cost {
          display: none !important;
        }
      }
      @media (max-width: 640px) {
        .sidebar-overlay-backdrop.sidebar-mobile-pending {
          opacity: 0 !important;
          pointer-events: none !important;
        }
        .sidebar-container.sidebar-mobile-pending.sidebar-open {
          transform: translateX(calc(-100% - env(safe-area-inset-left)));
          box-shadow: none;
        }
      }
    `}</style>
      {/* Shared workspace styling; layout behavior remains in the React components. */}
      <div
        ref={runsPanelResizer.panelRef}
        className="app-workspace"
        style={{
          display: 'flex',
          width: '100%',
          height: 'var(--app-viewport-height, 100dvh)',
          paddingLeft: 'env(safe-area-inset-left)',
          paddingRight: 'env(safe-area-inset-right)',
          overflow: 'hidden',
          background: 'var(--bg)'
        }}
      >
        {/* Mobile overlay backdrop */}
        <div
          className={`sidebar-overlay-backdrop${mobileSidebarReady ? '' : ' sidebar-mobile-pending'}`}
          onClick={() => setSidebarOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 199,
            background: 'rgba(0,0,0,0.4)',
            opacity: sidebarOpen ? 1 : 0,
            pointerEvents: sidebarOpen ? 'auto' : 'none',
            transition: 'opacity 0.25s ease'
          }}
        />

        {/* Left sidebar */}
        <div
          ref={sidebarResizer.panelRef}
          id="session-sidebar"

          className={`sidebar-container${sidebarOpen ? ' sidebar-open' : ' sidebar-closed'}${mobileSidebarReady ? '' : ' sidebar-mobile-pending'}${sidebarResizer.isResizing ? ' sidebar-resizing' : ''}`}
          style={
            {
              '--sidebar-width': `${sidebarResizer.width}px`,
              background: 'var(--bg-panel)',
              borderRight: '1px solid var(--border)',
              display: 'flex',
              flexDirection: 'column',
              flexShrink: 0,
              paddingTop: 'env(safe-area-inset-top)',
              paddingBottom: 'env(safe-area-inset-bottom)',
              zIndex: 200
            } as React.CSSProperties
          }
        >
          {sidebarContent}
        </div>
        {sidebarOpen && (
          <div
            {...sidebarResizer.separatorProps}

            aria-controls="session-sidebar"
            className={`panel-resize-handle sidebar-resize-handle${sidebarResizer.isResizing ? ' is-resizing' : ''}`}
            data-resize-handle="sidebar"
            title={`${translate('layout.resizeSidebar')}: ${translate('layout.resizeHint')}`}
          />
        )}

        {/* Center: chat */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            minWidth: 0
          }}
        >
          {/* Top bar with sidebar toggle */}
          <div
            ref={topBarRef}
            className="workspace-toolbar"
            style={{ flexShrink: 0, background: 'var(--bg-panel)' }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                position: 'relative',
                borderBottom: '1px solid var(--border)',
                height: 'calc(36px + env(safe-area-inset-top))',
                paddingTop: 'env(safe-area-inset-top)'
              }}
            >
              <button
                onClick={handleSidebarToggle}
                title={sidebarOpen ? translate('sidebar.hide') : translate('sidebar.show')}
                aria-label={sidebarOpen ? translate('sidebar.hide') : translate('sidebar.show')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: TOP_BAR_ICON_BUTTON_SIZE,
                  height: TOP_BAR_ICON_BUTTON_SIZE,
                  padding: 0,
                  background: 'none',
                  border: 'none',
                  borderRight: '1px solid var(--border)',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  flexShrink: 0,
                  transition: 'color 0.12s'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = 'var(--text)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = 'var(--text-muted)';
                }}
              >
                {sidebarOpen ? (
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <line x1="9" y1="3" x2="9" y2="21" />
                  </svg>
                ) : (
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  >
                    <line x1="3" y1="6" x2="21" y2="6" />
                    <line x1="3" y1="12" x2="21" y2="12" />
                    <line x1="3" y1="18" x2="21" y2="18" />
                  </svg>
                )}
              </button>
              <div className="workspace-toolbar-mode">
                <WorkspaceSwitch
                  mode={taskMode ? 'tasks' : 'chat'}
                  tasksHref={
                    taskLinkCwd
                      ? `/?mode=tasks&cwd=${encodeURIComponent(taskLinkCwd)}`
                      : '/?mode=tasks'
                  }
                />
              </div>
              {!isMobile && renderProjectTrustWarning(false)}
              {/* The Runs panel's toggle mirrors the sidebar's: a panel icon at
                  the page's right edge, where the panel docks. */}
              {!taskMode && !runsPanelOpen && (
                <button
                  ref={runsPanelToggleRef}
                  type="button"
                  onClick={toggleRunsPanel}
                  className="runs-panel-toggle-btn"
                  data-runs-panel-toggle="true"
                  title={`${translate('runs.title')}: ${translate('sidebar.show')}`}
                  aria-label={`${translate('runs.title')}: ${translate('sidebar.show')}`}
                  aria-expanded={false}
                  aria-controls="session-information"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    style={{
                      color: runInProgress ? 'var(--accent)' : undefined,
                      flexShrink: 0
                    }}
                  >
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <line x1="15" y1="3" x2="15" y2="21" />
                  </svg>
                  {(runInProgress || sessionCompaction.isCompacting) && (
                    <span className="runs-toggle-dot" aria-hidden="true" />
                  )}
                </button>
              )}
            </div>
            {isMobile && renderProjectTrustWarning(true)}
          </div>

          {/* The conversation and the task queue are two views of the same
              page: the sidebar and this toolbar stay in place, and only this
              area changes. */}
          {taskMode ? (
            <div className="workspace-task-view">
              <TaskWorkspace
                initialTaskId={Number(searchParams.get('task')) || null}
                queuePanelDocked={taskQueuePanelDocked}
                queuePanelOpen={taskQueuePanelOpen}
                queuePanelSlot={taskQueuePanelSlot}
                onToggleQueuePanel={toggleTaskQueuePanel}
                selectedCwd={taskCwd}
                onProjectChange={handleTaskProjectChange}
                onProjectsChange={handleTaskProjectsChange}
                sessions={sessionCatalog}
                runningSessionIds={runningSessionIds}
                awaitingSessionIds={awaitingInputSessionIds}
                taskSessionIds={taskSessionIds}
                onOpenSession={(sessionId) => {
                  // The sidebar already lists the conversation when the task's
                  // project is open; use it so the switch is a client-side
                  // change. A session outside that list falls back to a full
                  // navigation, which restores it on mount.
                  const session = sessionCatalog.find((entry) => entry.id === sessionId);
                  if (session) {
                    handleSelectSession(session);
                    return;
                  }
                  window.location.assign(`/?session=${encodeURIComponent(sessionId)}`);
                }}
              />
            </div>
          ) : (
            <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
              {showChat ? (
                <ChatWindow
                  key={sessionKey}
                  session={selectedSession}
                  searchTarget={
                    searchTarget?.sessionId === selectedSession?.id ? searchTarget : null
                  }
                  onSearchTargetHandled={handleSearchTargetHandled}
                  initialScrollPosition={
                    selectedSession
                      ? (sessionScrollPositionsRef.current.get(selectedSession.id) ?? null)
                      : null
                  }
                  onScrollPositionChange={handleSessionScrollPositionChange}
                  sessionRunning={Boolean(
                    selectedSession && runningSessionIds.has(selectedSession.id)
                  )}
                  newSessionCwd={effectiveNewSessionCwd}
                  newSessionDraftKey={newSessionDraftKey}
                  newSessionContextBar={newSessionContextBar}
                  initialNewSessionChoices={
                    selectedSession === null ? carriedNewSessionChoices : null
                  }
                  onNewSessionChoicesChange={handleNewSessionChoicesChange}
                  onAgentEnd={handleAgentEnd}
                  onAttentionNeeded={handleAttentionNeeded}
                  onSessionCreated={handleSessionCreated}
                  onSessionForked={handleSessionForked}
                  modelsRefreshKey={modelsRefreshKey}
                  toolPresetsRefreshKey={toolPresetsRefreshKey}
                  chatInputRef={chatInputRef}
                  onBranchDataChange={handleBranchDataChange}
                  onSystemPromptChange={handleSystemPromptChange}
                  onSystemToolsChange={handleSystemToolsChange}
                  onSystemInfoLoaderChange={handleSystemInfoLoaderChange}
                  onExecutionHistoryChange={handleExecutionHistoryChange}
                  onGoalChange={handleGoalChange}
                  onCompactionChange={handleCompactionChange}
                  onSessionStatsChange={handleSessionStatsChange}
                  onSessionStatsPanelOpen={openSessionStatsPanel}
                  onOpenSettings={openSettingsSection}
                  onContextUsageChange={handleContextUsageChange}
                  onAskInNewChat={handleAskInNewChat}
                  quoteSelectionEnabled={quoteSelectionEnabled}
                  initialPrompt={
                    pendingQuotePrompt?.sessionId === selectedSession?.id
                      ? pendingQuotePrompt?.text
                      : undefined
                  }
                  onInitialPromptConsumed={() => setPendingQuotePrompt(null)}
                  soundEnabled={soundEnabled}
                  onSoundToggle={onSoundToggle}
                  playDoneSound={playDoneSound}
                  unlockAudio={unlockAudio}
                  holdAudio={holdAudio}
                />
              ) : initialCwdStatus === 'validating' ? (
                <div
                  role="status"
                  style={{
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    padding: 24,
                    color: 'var(--text-muted)',
                    textAlign: 'center'
                  }}
                >
                  <div style={{ fontSize: 14, color: 'var(--text)' }}>
                    {translate('workspace.opening')}
                  </div>
                  <div
                    style={{
                      maxWidth: 'min(720px, 100%)',
                      overflowWrap: 'anywhere',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 12
                    }}
                  >
                    {initialNavigation.requestedCwd}
                  </div>
                </div>
              ) : initialCwdStatus === 'error' ? (
                <div
                  role="alert"
                  style={{
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    padding: 24,
                    color: 'var(--text-muted)',
                    textAlign: 'center'
                  }}
                >
                  <div style={{ fontSize: 14, color: '#dc2626' }}>
                    {translate('workspace.unable')}
                  </div>
                  <div
                    style={{
                      maxWidth: 'min(720px, 100%)',
                      overflowWrap: 'anywhere',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 12
                    }}
                  >
                    {initialNavigation.requestedCwd}
                  </div>
                  <div style={{ maxWidth: 720, fontSize: 12 }}>{initialCwdError}</div>
                </div>
              ) : showPlaceholder ? (
                activeCwd ? (
                  <div
                    style={{
                      height: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'var(--text-muted)',
                      fontSize: 15
                    }}
                  >
                    {translate('workspace.selectSession')}
                  </div>
                ) : (
                  <div
                    style={{
                      position: 'absolute',
                      top: 12,
                      left: 12,
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 8,
                      userSelect: 'none',
                      pointerEvents: 'none'
                    }}
                  >
                    <svg
                      width="44"
                      height="44"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="var(--accent)"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{ opacity: 0.7, flexShrink: 0 }}
                    >
                      <line x1="20" y1="12" x2="4" y2="12" />
                      <polyline points="10 6 4 12 10 18" />
                    </svg>
                    <div>
                      <div
                        style={{
                          fontSize: 18,
                          fontWeight: 600,
                          color: 'var(--text)',
                          marginBottom: 8
                        }}
                      >
                        {translate('workspace.getStarted')}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.8 }}>
                        <span style={{ color: 'var(--text-dim)', marginRight: 6 }}>1.</span>
                        {translate('workspace.selectProject')}
                        <br />
                        <span style={{ color: 'var(--text-dim)', marginRight: 6 }}>2.</span>
                        {translate('workspace.addModels')}
                      </div>
                    </div>
                  </div>
                )
              ) : null}
            </div>
          )}
        </div>

        {taskQueuePanelOpen && (
          <>
            {/* The same resize handle as the Runs panel: one right-hand edge. */}
            <div
              {...runsPanelResizer.separatorProps}
              aria-controls="task-queue-panel"
              className={`panel-resize-handle runs-panel-resize-handle${runsPanelResizer.isResizing ? ' is-resizing' : ''}`}
              data-resize-handle="task-queue-panel"
              title={`${translate('layout.resizeRunsPanel')}: ${translate('layout.resizeHint')}`}
            />
            <SessionInfoSidebar
              panelId="task-queue-panel"
              title={translate('tasks.board')}
              toggleSelector='[data-task-queue-toggle="true"]'
              contentClassName="task-queue-panel-content"
              icon={
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ color: 'var(--accent)', flexShrink: 0 }}
                  aria-hidden="true"
                >
                  <path d="M4 6h9M4 12h15M4 18h6" />
                  <circle cx="18" cy="6" r="2" />
                  <circle cx="15" cy="18" r="2" />
                </svg>
              }
              sidebarWidth={sidebarOpen ? sidebarResizer.width : 0}
              onClose={closeTaskQueuePanel}
              focusOnMount={focusTaskQueuePanelRef.current}
            >
              <div ref={setTaskQueuePanelSlot} className="task-queue-panel-slot" />
            </SessionInfoSidebar>
          </>
        )}

        {runsPanelOpen && !taskMode && (
          <>
            {/* The panel's border is the idle separator; this widens its grasp. */}
            {!informationPanelOverlay && (
              <div
                {...runsPanelResizer.separatorProps}
                aria-controls="session-information"
                className={`panel-resize-handle runs-panel-resize-handle${runsPanelResizer.isResizing ? ' is-resizing' : ''}`}
                data-resize-handle="runs-panel"
                title={`${translate('layout.resizeRunsPanel')}: ${translate('layout.resizeHint')}`}
              />
            )}
            <SessionInfoSidebar
              title={translate('runs.title')}
              sidebarWidth={sidebarOpen ? sidebarResizer.width : 0}
              onClose={closeRunsPanel}
              focusOnMount={focusRunsPanelRef.current}
            >
              <div className="session-panel-stack">
                {sessionPanelActions}
                <ExecutionHistoryPanel
                  entries={executionHistory}
                  sessionId={selectedSession?.id}
                  historyOpen={runHistoryOpen}
                  onHistoryOpenChange={setRunHistoryOpen}
                  goal={sessionGoal}
                  isCompacting={sessionCompaction.isCompacting}
                  compactResult={sessionCompaction.compactResult}
                  compactError={sessionCompaction.compactError}
                />
              </div>
            </SessionInfoSidebar>
          </>
        )}
      </div>

      {activeModal === 'system' && (
        <SessionModal
          title={translate('system.prompt')}
          onClose={() => setActiveModal(null)}
          maxWidth={800}
          icon={
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--accent)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="8" y1="13" x2="16" y2="13" />
              <line x1="8" y1="17" x2="13" y2="17" />
            </svg>
          }
        >
          <SystemPromptPanel
            loading={systemInfoLoading}
            prompt={systemPrompt}
            translate={translate}
          />
        </SessionModal>
      )}

      {activeModal === 'tools' && (
        <SessionModal
          title={translate('tools.title')}
          onClose={() => setActiveModal(null)}
          maxWidth={960}
          icon={
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--accent)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z" />
            </svg>
          }
        >
          <ToolDefinitionsPanel
            loading={systemInfoLoading}
            tools={systemTools}
            translate={translate}
          />
        </SessionModal>
      )}

      {activeModal === 'branches' && (
        <SessionModal
          title={translate('i18n.branches')}
          onClose={() => setActiveModal(null)}
          maxWidth={640}
          icon={
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--accent)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
          }
        >
          <BranchNavigator
            tree={branchTree}
            activeLeafId={branchActiveLeafId}
            onLeafChange={handleBranchLeafChange}
            locked={branchSwitchLocked}
            hasSession={showChat}
            embedded
          />
        </SessionModal>
      )}

      {activeModal === 'session' && (
        <SessionStatsModal
          isOpen={activeModal === 'session'}
          onClose={() => setActiveModal(null)}
          sessionStats={sessionStats}
          selectedSession={selectedSession}
          contextUsage={contextUsage}
          copiedSessionField={copiedSessionField}
          onCopySessionField={handleCopySessionField}
          translate={translate}
          locale={locale}
          isMobile={isMobile}
        />
      )}
      {settingsOverlays}
    </>
  );
}
