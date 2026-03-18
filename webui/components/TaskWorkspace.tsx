/**
 * The task workspace: one board and one work surface that reads the selected
 * task or chat, the task editor, and the live activity of the running task.
 *
 * It is the center column of the app in `?mode=tasks`; the shell keeps the
 * sidebar and toolbar. Nothing here is imported by the conversation; the
 * workspace reads and writes the queue through the `/api/tasks` routes, shows
 * the project's chat sessions as task-shaped rows, and renders a task's session
 * as an ordinary Pi session.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '@/hooks/useI18n';
import { useIsMobile } from '@/hooks/useIsMobile';
import { AskUserPanel } from './AskUserPanel';
import { DirectoryPicker } from './DirectoryPicker';
import { ModelSelector, type ModelSelectorOption } from './ModelSelector';
import { QueueSettingsDialog } from './QueueSettingsDialog';
import { SidebarMenu, type SidebarMenuAnchor, type SidebarMenuItem } from './SidebarMenu';
import {
  ChevronIcon,
  EyeIcon,
  MoreIcon,
  PlusIcon,
  TrashIcon
} from './SidebarIcons';
import {
  chatTasksForProject,
  completedTaskIds,
  detailPlacement,
  groupTasks,
  hasVerification,
  isTaskLocked,
  projectLabelFromPath,
  queuePrimaryAction,
  questionRequestFor,
  rangeSelection,
  reorderPending,
  taskElapsedMs,
  type ChatTask,
  type TaskQueuePayload
} from '@/lib/tasks/board';
import type { TaskProjectSummary, TaskRecord, TaskStatus } from '@/lib/tasks/types';
import type { SessionInfo } from '@/lib/types';

const EMPTY_IDS: ReadonlySet<string> = new Set();

export interface TaskWorkspaceProps {
  /** Opens the task's ordinary Pi session in the chat view. */
  onOpenSession?: (sessionId: string) => void;
  /** `?task=<id>`: the task a deep link opens. */
  initialTaskId?: number | null;
  /** Test seam and first paint: the payload the first poll would return. */
  initialData?: TaskQueuePayload | null;
  /** Test seam: suspended polling. */
  polling?: boolean;
  /** Desktop: the queue is docked in the shell's right panel instead of the center. */
  queuePanelDocked?: boolean;
  /** The docked queue panel is open. */
  queuePanelOpen?: boolean;
  /** The shell's slot for the docked queue list. */
  queuePanelSlot?: HTMLElement | null;
  /** Opens or collapses the docked queue panel. */
  onToggleQueuePanel?: () => void;
  /** The project this board reads; null asks the server to pick one. */
  selectedCwd?: string | null;
  /** The shell owns the URL, so the board reports a project change to it. */
  onProjectChange?: (cwd: string | null) => void;
  /** Every project's queue summary, bubbled to the shell's project list. */
  onProjectsChange?: (projects: TaskProjectSummary[]) => void;
  /** The chat catalogue, so a conversation appears here as project work. */
  sessions?: readonly SessionInfo[];
  /** Conversations running now; the live poll owns this set. */
  runningSessionIds?: ReadonlySet<string>;
  /** Conversations parked on an input dialog. */
  awaitingSessionIds?: ReadonlySet<string>;
  /** Sessions a queue child is writing; their task row already represents them. */
  taskSessionIds?: ReadonlySet<string>;
}

type Draft = { mode: 'new' } | { mode: 'edit'; taskId: number } | null;

interface TaskFormState {
  description: string;
  cwd: string;
  verifyCommands: string;
}

const EMPTY_FORM: TaskFormState = {
  description: '',
  cwd: '',
  verifyCommands: ''
};

function taskForm(task: TaskRecord): TaskFormState {
  return {
    // A task from before descriptions were required only has a title; edit
    // it as the text it represents so the first line keeps naming the task.
    description: task.description ?? task.title,
    cwd: task.cwd,
    verifyCommands: (task.verifyCommands ?? []).join('\n')
  };
}

function elapsedText(ms: number | null): string {
  if (ms === null) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

const STATUS_ORDER: Record<TaskStatus, number> = {
  IN_PROGRESS: 0,
  PENDING: 1,
  BLOCKED: 2,
  FAILED: 3,
  DONE: 4
};

/** One row menu icon set; small enough to keep beside the board it serves. */
function menuIcon(children: ReactNode) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const MENU_ICON = {
  select: menuIcon(
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  close: menuIcon(
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
  edit: menuIcon(
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </>
  ),
  up: menuIcon(<polyline points="18 15 12 9 6 15" />),
  down: menuIcon(<polyline points="6 9 12 15 18 9" />),
  duplicate: menuIcon(
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
      <path d="M15 12v6M12 15h6" />
    </>
  ),
  copy: menuIcon(
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </>
  ),
  paste: menuIcon(
    <>
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <rect x="8" y="2" width="8" height="4" rx="1" />
    </>
  ),
  session: menuIcon(<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />),
  delete: menuIcon(
    <>
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M19 6l-1 14H6L5 6" />
    </>
  )
};

/** Run controls use a filled play/stop glyph; their buttons carry the label. */
const RUN_ICON = {
  play: menuIcon(<path d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none" />),
  pause: menuIcon(
    <>
      <path d="M9 5v14" />
      <path d="M15 5v14" />
    </>
  ),
  stop: menuIcon(<rect x="7" y="7" width="10" height="10" rx="1" fill="currentColor" stroke="none" />)
};

/** What "Copy" keeps: the fields "Paste" would send back to the queue. */
interface TaskClipboard {
  title: string;
  description: string | null;
  cwd: string;
  verifyCommands: string[] | null;
}

const TASK_CLIPBOARD_KEY = 'pie:task-clipboard';
const TASK_FINISHED_KEY = 'pie:tasks-finished-open';

function clipboardFromTask(task: TaskRecord): TaskClipboard {
  return {
    title: task.title,
    description: task.description,
    cwd: task.cwd,
    verifyCommands: task.verifyCommands
  };
}

function taskBody(clipboard: TaskClipboard, title: string): Record<string, unknown> {
  return {
    title,
    description: clipboard.description,
    cwd: clipboard.cwd,
    verify_commands: clipboard.verifyCommands
  };
}

function statusTone(status: TaskStatus): string {
  if (status === 'IN_PROGRESS') return 'var(--accent)';
  if (status === 'DONE') return 'var(--success, #16a34a)';
  if (status === 'BLOCKED') return 'var(--warning, #d97706)';
  if (status === 'FAILED') return 'var(--danger, #dc2626)';
  return 'var(--text-dim)';
}

export function TaskWorkspace({
  onOpenSession,
  initialTaskId = null,
  initialData = null,
  polling = true,
  queuePanelDocked = false,
  queuePanelOpen = false,
  queuePanelSlot = null,
  onToggleQueuePanel,
  selectedCwd = null,
  onProjectChange,
  onProjectsChange,
  sessions = [],
  runningSessionIds = EMPTY_IDS,
  awaitingSessionIds = EMPTY_IDS,
  taskSessionIds = EMPTY_IDS
}: TaskWorkspaceProps) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [payload, setPayload] = useState<TaskQueuePayload | null>(initialData);
  const [selectedId, setSelectedId] = useState<number | null>(initialTaskId);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  // A project switch invalidates the previous board before the next poll
  // lands, so a quick click cannot start or pause the project just left.
  useEffect(() => {
    if (!selectedCwd) return;
    setPayload((current) =>
      current && current.project?.cwd !== selectedCwd ? null : current
    );
  }, [selectedCwd]);
  // A `?task=` deep link without a project needs one read to find its cwd. The
  // default-project effect must not win that race.
  const [deepLinkReady, setDeepLinkReady] = useState(
    initialTaskId === null || selectedCwd !== null
  );
  const [sheetOpen, setSheetOpen] = useState(initialTaskId !== null);
  const [draft, setDraft] = useState<Draft>(null);
  const [form, setForm] = useState<TaskFormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [cwdError, setCwdError] = useState<string | null>(null);
  const [cwdChecking, setCwdChecking] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [modelOptions, setModelOptions] = useState<ModelSelectorOption[]>([]);
  const [defaultModel, setDefaultModel] = useState<{ provider: string; modelId: string } | null>(
    null
  );
  const [modelBusy, setModelBusy] = useState(false);
  const [queueSettingsOpen, setQueueSettingsOpen] = useState(false);
  const [finishedOpen, setFinishedOpen] = useState(false);
  // Ids selected on top of the anchor (`selectedId`); together they are the
  // selection a batch action works on.
  const [extraSelectedIds, setExtraSelectedIds] = useState<number[]>([]);
  const [confirm, setConfirm] = useState<{
    anchor: SidebarMenuAnchor;
    kind: 'selection' | 'completed';
    ids: number[];
    opener: HTMLElement;
  } | null>(null);
  const [clipboard, setClipboard] = useState<TaskClipboard | null>(null);
  const [menu, setMenu] = useState<{ anchor: SidebarMenuAnchor; taskId: number | null } | null>(
    null
  );
  const menuOpenerRef = useRef<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState('');
  const rowRefs = useRef(new Map<number, HTMLButtonElement>());
  const pendingFocusId = useRef<number | null>(null);
  const pendingSelectId = useRef<number | null>(null);
  const selectedCwdRef = useRef(selectedCwd);
  selectedCwdRef.current = selectedCwd;
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const sheetReturnFocus = useRef<HTMLElement | null>(null);
  const folderButtonRef = useRef<HTMLButtonElement | null>(null);

  const refresh = useCallback(async () => {
    const requestedCwd = selectedCwd;
    try {
      const query = requestedCwd ? `?cwd=${encodeURIComponent(requestedCwd)}` : '';
      const response = await fetch(`/api/tasks${query}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as TaskQueuePayload;
      // A slow response for the project just left must not repaint the board.
      if (selectedCwdRef.current !== requestedCwd) return null;
      setPayload(data);
      setError(null);
      return data;
    } catch (refreshError) {
      if (selectedCwdRef.current === requestedCwd) {
        setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
      }
      return null;
    }
  }, [selectedCwd]);

  // The clipboard outlives a reload; nothing renders from it until a menu opens.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(TASK_CLIPBOARD_KEY);
      if (raw) setClipboard(JSON.parse(raw) as TaskClipboard);
    } catch {
      // An unreadable clipboard only means there is nothing to paste.
    }
  }, []);

  useEffect(() => {
    try {
      setFinishedOpen(window.localStorage.getItem(TASK_FINISHED_KEY) === 'true');
    } catch {
      // The section stays collapsed when browser storage is unavailable.
    }
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 2600);
    return () => clearTimeout(timer);
  }, [notice]);

  // The model list is the app's own: the same route the composer uses, without
  // a session. A failed load leaves the header with just the queue controls.
  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/models', { cache: 'no-store' });
        if (!response.ok) return;
        const data = (await response.json()) as {
          modelList?: { id: string; name: string; provider: string }[];
          defaultModel?: { provider: string; modelId: string } | null;
        };
        if (cancelled) return;
        setModelOptions(
          (data.modelList ?? []).map((model) => ({
            provider: model.provider,
            modelId: model.id,
            name: model.name
          }))
        );
        setDefaultModel(data.defaultModel ?? null);
      } catch {
        // The queue still runs with Pi's own default model.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [polling]);

  const status = payload?.orchestrator ?? null;
  const tasks = useMemo(() => payload?.tasks ?? [], [payload]);
  const runningTask = tasks.find((task) => task.status === 'IN_PROGRESS') ?? null;
  const questionPending = Boolean(runningTask?.pendingQuestion);
  const anyProjectRunning =
    payload?.projects.some(
      (project) =>
        project.activeTaskId !== null ||
        project.state === 'RUNNING' ||
        (project.activeSessions?.length ?? 0) > 0
    ) ?? false;
  const interval =
    runningTask || questionPending || anyProjectRunning || runningSessionIds.size > 0
      ? 1_000
      : 5_000;
  const projectKey = payload?.project?.projectKey ?? null;
  const projectCwd = selectedCwd ?? payload?.project?.cwd ?? null;
  const projectName = projectCwd ? projectLabelFromPath(projectCwd) : null;
  const hasProject = Boolean(projectCwd);
  const loopRunning = Boolean(status?.state === 'RUNNING' && status.running);
  const linkedSessionIds = useMemo(() => {
    const ids = new Set<string>(taskSessionIds);
    for (const task of tasks) if (task.sessionId) ids.add(task.sessionId);
    return ids;
  }, [taskSessionIds, tasks]);
  const chats = useMemo(
    () =>
      chatTasksForProject(sessions, {
        projectKey,
        linkedSessionIds,
        runningIds: runningSessionIds,
        awaitingIds: awaitingSessionIds
      }),
    [
      awaitingSessionIds,
      linkedSessionIds,
      projectKey,
      runningSessionIds,
      sessions
    ]
  );
  const selectedChat = useMemo(() => {
    if (selectedId !== null) return null;
    return (
      chats.find((chat) => chat.session.id === selectedChatId) ??
      (initialTaskId === null ? (chats.find((chat) => chat.running) ?? null) : null)
    );
  }, [chats, initialTaskId, selectedChatId, selectedId]);
  const selectedSessionCount = status?.activeSessions?.length ?? 0;
  // A stored RUNNING state without a live loop is an interrupted queue; it
  // reads as idle and the primary action is Start, not Pause.
  const queueState =
    status?.state === 'RUNNING' && !status.running ? 'IDLE' : (status?.state ?? 'IDLE');
  useEffect(() => {
    if (selectedChatId && !chats.some((chat) => chat.session.id === selectedChatId)) {
      setSelectedChatId(null);
    }
  }, [chats, selectedChatId]);

  // Polling: fast while work happens, slow otherwise, suspended with the page.
  useEffect(() => {
    if (!polling) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (delay: number) => {
      timer = setTimeout(tick, delay);
    };
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === 'hidden') {
        schedule(interval);
        return;
      }
      await refresh();
      if (!stopped) schedule(interval);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && !stopped) {
        if (timer) clearTimeout(timer);
        void tick();
      }
    };
    void tick();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [interval, polling, refresh]);

  // The live tail of the running task, read from the server's bounded buffer.
  useEffect(() => {
    if (!polling || !runningTask) {
      setOutput('');
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === 'hidden') {
        timer = setTimeout(tick, 2_000);
        return;
      }
      try {
        const response = await fetch(`/api/tasks/${runningTask.id}/output`, { cache: 'no-store' });
        if (response.ok) {
          const data = (await response.json()) as { output?: string };
          setOutput(data.output ?? '');
        }
      } catch {
        // The next tick retries; the board keeps showing the queue.
      }
      if (!stopped) timer = setTimeout(tick, 1_000);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [polling, runningTask]);

  const groups = useMemo(() => groupTasks(tasks), [tasks]);
  // An archive reads newest first; the queue's stored rank is for pending work.
  const finishedTasks = useMemo(
    () =>
      [...groups.done].sort(
        (a, b) =>
          (b.finishedAt ?? b.updatedAt).localeCompare(a.finishedAt ?? a.updatedAt) ||
          b.id - a.id
      ),
    [groups.done]
  );
  const primaryAction = queuePrimaryAction(status);
  const primaryLabel =
    primaryAction === 'pause'
      ? t('tasks.pause')
      : primaryAction === 'resume'
        ? t('tasks.resume')
        : t('tasks.start');
  const primaryDisabled =
    busy || !hasProject || (primaryAction === 'start' && groups.queued.length === 0);
  const stopDisabled = busy || !hasProject || !(runningTask || loopRunning);
  const selected = useMemo(
    () =>
      selectedChat
        ? null
        : (tasks.find((task) => task.id === selectedId) ?? runningTask ?? tasks[0] ?? null),
    [runningTask, selectedChat, selectedId, tasks]
  );
  const questionRequest = selected ? questionRequestFor(selected) : null;
  const selection = useMemo(() => {
    const ids = new Set<number>();
    if (selectedId !== null) ids.add(selectedId);
    for (const id of extraSelectedIds) ids.add(id);
    return ids;
  }, [extraSelectedIds, selectedId]);
  const selectedTasks = useMemo(
    () => tasks.filter((task) => selection.has(task.id)),
    [selection, tasks]
  );
  const multiSelected = selection.size > 1;
  const doneTasks = useMemo(() => tasks.filter((task) => task.status === 'DONE'), [tasks]);
  // The rail's reading order, which is also the order a shift range follows.
  const boardOrder = useMemo(
    () =>
      tasks
        .slice()
        .sort(
          (a, b) =>
            STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.rank - b.rank || a.id - b.id
        )
        .map((task) => task.id),
    [tasks]
  );

  // The shell's project list needs every queue, not only the selected one.
  // The signature keeps a poll that changed nothing from rerendering the shell.
  const projectsSignature = useMemo(
    () => JSON.stringify(payload?.projects ?? []),
    [payload?.projects]
  );
  // Keep the array's identity while its contents are unchanged, so the shell
  // does not rerender on every one-second poll.
  const projects = useMemo(
    () => payload?.projects ?? null,
    // oxlint-disable-next-line react/exhaustive-deps -- the signature is the content key.
    [projectsSignature]
  );
  useEffect(() => {
    if (projects) onProjectsChange?.(projects);
  }, [projects, onProjectsChange]);

  // A task deep link with no cwd: read the task once, then open its project.
  useEffect(() => {
    if (initialTaskId === null || selectedCwd !== null || deepLinkReady) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/tasks/${initialTaskId}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as { task?: TaskRecord };
        if (!cancelled && data.task) {
          pendingSelectId.current = data.task.id;
          onProjectChange?.(data.task.cwd);
        }
      } catch {
        // A deleted task leaves the board on its default project.
      } finally {
        if (!cancelled) setDeepLinkReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deepLinkReady, initialTaskId, onProjectChange, selectedCwd]);

  // With no project in the URL the server chooses the running or most recent
  // one; record that choice in the URL so a reload returns to it.
  useEffect(() => {
    if (!deepLinkReady) return;
    const resolved = payload?.project?.cwd ?? null;
    if (!resolved) return;
    if (selectedCwd === resolved) return;
    if (selectedCwd === null) onProjectChange?.(resolved);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- only a resolved default should move the URL.
  }, [deepLinkReady, payload?.project?.cwd, selectedCwd, onProjectChange]);

  // A project switch is a new board: drop the previous selection, draft, and
  // sheet. The running task is then selected by the `selected` fallback below.
  useEffect(() => {
    const pending = pendingSelectId.current;
    pendingSelectId.current = null;
    setSelectedId(pending ?? initialTaskId);
    setSelectedChatId(null);
    setExtraSelectedIds([]);
    setDraft(null);
    setSheetOpen(false);
    setOutput('');
    setError(null);
  }, [initialTaskId, projectKey]);

  // A poll can remove a selected task; the selection must not keep its id.
  useEffect(() => {
    setExtraSelectedIds((current) => {
      const alive = current.filter((id) => tasks.some((task) => task.id === id));
      return alive.length === current.length ? current : alive;
    });
  }, [tasks]);

  // Escape drops a multi-selection before anything else takes the key.
  useEffect(() => {
    if (selection.size < 2 || pickerOpen || draft) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setExtraSelectedIds([]);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [draft, pickerOpen, selection.size]);

  // With the queue docked on the right, the center is the work surface. Where
  // the queue takes the center (narrow windows, phones), the detail is a sheet
  // the person opens explicitly, so closing it does not reopen on the fallback.
  const queueDocked = Boolean(queuePanelDocked);
  const detailIsSheet = !queueDocked;
  const placement = detailPlacement({
    overlay: detailIsSheet,
    hasTask: selected !== null || selectedChat !== null,
    hasDraft: draft !== null,
    sheetOpen
  });

  const focusTask = useCallback((taskId: number | null) => {
    pendingFocusId.current = taskId;
  }, []);

  useEffect(() => {
    const id = pendingFocusId.current;
    if (id === null) return;
    const element = rowRefs.current.get(id);
    if (element) {
      element.focus();
      pendingFocusId.current = null;
    }
    // A reorder repaints the rows; focus returns after that paint.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- tasks is the repaint signal.
  }, [tasks]);

  const call = useCallback(
    async (input: string, init: RequestInit): Promise<unknown | null> => {
      setBusy(true);
      setError(null);
      try {
        const response = await fetch(input, {
          ...init,
          headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) }
        });
        const data = (await response.json().catch(() => ({}))) as {
          error?: string;
          [key: string]: unknown;
        };
        if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
        await refresh();
        return data;
      } catch (callError) {
        setError(callError instanceof Error ? callError.message : String(callError));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  /**
   * Chat's own rule for a directory: `/api/cwd/validate` resolves `~` and
   * relative paths, refuses a path that is not an existing directory, and
   * allows the root for the file routes. The queue records the resolved path,
   * so a directory the user picks here behaves like one picked for a session.
   */
  const validateCwdPath = useCallback(async (candidate: string): Promise<string | null> => {
    setCwdError(null);
    setCwdChecking(true);
    try {
      const response = await fetch('/api/cwd/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: candidate })
      });
      const data = (await response.json().catch(() => ({}))) as { cwd?: string; error?: string };
      if (!response.ok || data.error || !data.cwd) {
        setCwdError(data.error ?? `HTTP ${response.status}`);
        return null;
      }
      setForm((current) => ({ ...current, cwd: data.cwd as string }));
      return data.cwd;
    } catch (validateError) {
      setCwdError(validateError instanceof Error ? validateError.message : String(validateError));
      return null;
    } finally {
      setCwdChecking(false);
    }
  }, []);

  const closePicker = useCallback((refocus = true) => {
    setPickerOpen(false);
    setCwdError(null);
    if (refocus) requestAnimationFrame(() => folderButtonRef.current?.focus());
  }, []);

  const pickDirectory = useCallback(
    async (path: string) => {
      if (!(await validateCwdPath(path))) return;
      closePicker();
    },
    [closePicker, validateCwdPath]
  );

  // The sheet covers the board, so it remembers the control that opened it and
  // hands focus back there; a phone keyboard user is never left on the body.
  const openSheet = useCallback(() => {
    if (typeof document !== 'undefined') {
      sheetReturnFocus.current = document.activeElement as HTMLElement | null;
    }
    setSheetOpen(true);
  }, []);

  const closeSheet = useCallback(() => {
    setSelectedId(null);
    setSelectedChatId(null);
    setDraft(null);
    setSheetOpen(false);
    const target = sheetReturnFocus.current;
    sheetReturnFocus.current = null;
    if (target?.isConnected) requestAnimationFrame(() => target.focus());
  }, []);

  const toggleFinished = useCallback(() => {
    setFinishedOpen((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(TASK_FINISHED_KEY, String(next));
      } catch {
        // The section still toggles for this page without persistence.
      }
      return next;
    });
  }, []);

  const startNewTask = useCallback(() => {
    const cwd = projectCwd ?? selected?.cwd ?? runningTask?.cwd ?? '';
    setForm({ ...EMPTY_FORM, cwd });
    setCwdError(null);
    setDraft({ mode: 'new' });
    openSheet();
  }, [openSheet, projectCwd, runningTask?.cwd, selected?.cwd]);

  const startEdit = useCallback(
    (task: TaskRecord) => {
      if (isTaskLocked(task)) return;
      setForm(taskForm(task));
      setCwdError(null);
      setDraft({ mode: 'edit', taskId: task.id });
      setSelectedId(task.id);
      openSheet();
    },
    [openSheet]
  );

  const closeDraft = useCallback(() => {
    setDraft(null);
    setError(null);
  }, []);

  // A modal dialog takes focus and answers Escape even while focus is still on
  // the board behind it. An open draft focuses its own description field instead.
  useEffect(() => {
    if (placement !== 'sheet' || draft) return;
    sheetRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeSheet();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [closeSheet, draft, placement]);

  const saveDraft = useCallback(async () => {
    // A typed directory is resolved and allowed exactly like a picked one.
    const cwd = await validateCwdPath(form.cwd);
    if (!cwd) return;
    const verifyCommands = form.verifyCommands
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const body: Record<string, unknown> = {
      description: form.description || null,
      cwd,
      verify_commands: verifyCommands
    };
    if (draft?.mode === 'new') {
      const result = (await call('/api/tasks', {
        method: 'POST',
        body: JSON.stringify(body)
      })) as
        | { task?: TaskRecord; project?: { projectKey: string; cwd: string } }
        | null;
      if (result?.task) {
        if (result.project && result.project.cwd !== projectCwd) {
          pendingSelectId.current = result.task.id;
          onProjectChange?.(result.project.cwd);
        } else {
          setSelectedId(result.task.id);
          setSheetOpen(true);
        }
        setDraft(null);
        setCwdError(null);
      }
      return;
    }
    if (draft?.mode === 'edit') {
      const result = (await call(`/api/tasks/${draft.taskId}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'update', ...body })
      })) as
        | { task?: TaskRecord; project?: { projectKey: string; cwd: string } }
        | null;
      if (result?.task) {
        if (result.project && result.project.cwd !== projectCwd) {
          pendingSelectId.current = result.task.id;
          onProjectChange?.(result.project.cwd);
        }
        setDraft(null);
        setCwdError(null);
      }
    }
  }, [call, draft, form, onProjectChange, projectCwd, validateCwdPath]);

  const removeTask = useCallback(
    async (task: TaskRecord) => {
      if (isTaskLocked(task)) return;
      const result = await call(`/api/tasks/${task.id}`, { method: 'DELETE' });
      if (result) {
        if (selectedId === task.id) {
          setSelectedId(null);
          setSheetOpen(false);
        }
        if (draft?.mode === 'edit' && draft.taskId === task.id) setDraft(null);
      }
    },
    [call, draft, selectedId]
  );

  const postTask = useCallback(
    async (copy: TaskClipboard, title: string): Promise<TaskRecord | null> => {
      const result = (await call('/api/tasks', {
        method: 'POST',
        body: JSON.stringify(taskBody(copy, title))
      })) as { task?: TaskRecord } | null;
      return result?.task ?? null;
    },
    [call]
  );

  const createTaskFrom = useCallback(
    async (copy: TaskClipboard, title: string): Promise<TaskRecord | null> => {
      const created = await postTask(copy, title);
      if (!created) return null;
      setSelectedId(created.id);
      setExtraSelectedIds([]);
      return created;
    },
    [postTask]
  );

  const copyTask = useCallback(
    (task: TaskRecord) => {
      const copy = clipboardFromTask(task);
      setClipboard(copy);
      try {
        window.localStorage.setItem(TASK_CLIPBOARD_KEY, JSON.stringify(copy));
      } catch {
        // The in-memory copy still works for this page.
      }
      setNotice(t('tasks.copied'));
    },
    [t]
  );

  const pasteTask = useCallback(async () => {
    if (!clipboard) return;
    const created = await createTaskFrom(clipboard, `${clipboard.title} ${t('tasks.copySuffix')}`);
    if (created) setNotice(t('tasks.pasted'));
  }, [clipboard, createTaskFrom, t]);

  /** Drop the whole selection, anchor included: the detail falls back to its default. */
  const clearSelection = useCallback(() => {
    setSelectedId(null);
    setExtraSelectedIds([]);
  }, []);

  const toggleSelection = useCallback(
    (taskId: number) => {
      if (selectedId === null) {
        setSelectedId(taskId);
        return;
      }
      if (taskId === selectedId) {
        const [next, ...rest] = extraSelectedIds;
        setSelectedId(next ?? null);
        setExtraSelectedIds(rest);
        return;
      }
      const extra = extraSelectedIds.includes(taskId)
        ? extraSelectedIds.filter((id) => id !== taskId)
        : [...extraSelectedIds, taskId];
      setExtraSelectedIds(extra);
      // A phone keeps its batch actions in the sheet; show them as soon as a
      // second row joins the selection.
      if (extra.length + 1 > 1) openSheet();
    },
    [extraSelectedIds, openSheet, selectedId]
  );

  const selectRange = useCallback(
    (order: number[], taskId: number) => {
      const anchor = selectedId ?? taskId;
      const ids = rangeSelection(order, anchor, taskId);
      setSelectedId(anchor);
      setExtraSelectedIds(ids.filter((id) => id !== anchor));
    },
    [selectedId]
  );

  const selectAll = useCallback(() => {
    if (boardOrder.length === 0) return;
    setSelectedId(boardOrder[0]);
    setExtraSelectedIds(boardOrder.slice(1));
  }, [boardOrder]);

  /** Shift+Arrow extends from the focused row to its neighbour in `order`. */
  const extendSelection = useCallback(
    (order: number[], taskId: number, delta: -1 | 1) => {
      const index = order.indexOf(taskId);
      const next = order[index + delta];
      if (index < 0 || next === undefined) return;
      // The row under the keyboard anchors the range when nothing was selected yet.
      const anchor = selectedId ?? taskId;
      const ids = rangeSelection(order, anchor, next);
      setSelectedId(anchor);
      setExtraSelectedIds(ids.filter((id) => id !== anchor));
      // Focus the row now: the next Shift+Arrow must start from here, not from
      // wherever the range began.
      rowRefs.current.get(next)?.focus();
    },
    [selectedId]
  );

  const duplicateTasks = useCallback(
    async (list: TaskRecord[]) => {
      const created: number[] = [];
      for (const task of list) {
        const copy = await postTask(
          clipboardFromTask(task),
          `${task.title} ${t('tasks.copySuffix')}`
        );
        if (copy) created.push(copy.id);
      }
      if (created.length === 0) return;
      setSelectedId(created[0]);
      setExtraSelectedIds(created.slice(1));
      setNotice(t('tasks.duplicatedCount', { count: created.length }));
    },
    [postTask, t]
  );

  /**
   * Delete several tasks at once. The queue refuses a running one, so the
   * caller offers only tasks it may remove; a failure still reports why.
   */
  const deleteTasks = useCallback(
    async (ids: number[]) => {
      if (ids.length === 0) return;
      setBusy(true);
      setError(null);
      const removed: number[] = [];
      const failures: string[] = [];
      await Promise.all(
        ids.map(async (id) => {
          try {
            const response = await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
            if (response.ok) removed.push(id);
            else {
              const data = (await response.json().catch(() => ({}))) as { error?: string };
              failures.push(data.error ?? `HTTP ${response.status}`);
            }
          } catch (deleteError) {
            failures.push(deleteError instanceof Error ? deleteError.message : String(deleteError));
          }
        })
      );
      await refresh();
      if (removed.length > 0) {
        setSelectedId((current) =>
          current !== null && removed.includes(current) ? null : current
        );
        setExtraSelectedIds((current) => current.filter((id) => !removed.includes(id)));
        setNotice(t('tasks.removedCount', { count: removed.length }));
      }
      if (failures.length > 0) setError(failures[0]);
      setBusy(false);
    },
    [refresh, t]
  );

  const openConfirm = useCallback(
    (kind: 'selection' | 'completed', ids: number[], opener: HTMLElement) => {
      const rect = opener.getBoundingClientRect();
      setConfirm({
        kind,
        ids,
        opener,
        anchor: {
          kind: 'rect',
          align: 'end',
          rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
        }
      });
    },
    []
  );

  const confirmRemoval = useCallback(async () => {
    if (!confirm) return;
    const ids = confirm.ids;
    setConfirm(null);
    await deleteTasks(ids);
  }, [confirm, deleteTasks]);

  const saveModel = useCallback(
    async (model: { provider: string; modelId: string } | null) => {
      setModelBusy(true);
      setError(null);
      try {
        const response = await fetch('/api/tasks/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model })
        });
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
        await refresh();
        setNotice(t('tasks.modelSaved'));
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : String(saveError));
      } finally {
        setModelBusy(false);
      }
    },
    [refresh, t]
  );

  const closeMenu = useCallback(() => {
    setMenu(null);
  }, []);

  // A right-click or the row's menu button act on that row, not on the
  // selection, so the board never guesses which task was meant.
  const openRowMenu = useCallback(
    (task: TaskRecord, anchor: SidebarMenuAnchor, opener: HTMLElement) => {
      // Opening a row's menu outside a multi-selection re-anchors it there, so the
      // highlighted rows and the menu's targets never disagree.
      if (selection.size > 1 && !selection.has(task.id)) {
        setSelectedId(task.id);
        setExtraSelectedIds([]);
      }
      menuOpenerRef.current = opener;
      setMenu({ anchor, taskId: task.id });
    },
    [selection]
  );

  const openBoardMenu = useCallback((anchor: SidebarMenuAnchor, opener: HTMLElement) => {
    menuOpenerRef.current = opener;
    setMenu({ anchor, taskId: null });
  }, []);

  const moveTask = useCallback(
    async (task: TaskRecord, direction: 'up' | 'down') => {
      if (isTaskLocked(task)) return;
      const ordered = reorderPending(tasks, task.id, direction);
      if (!ordered) return;
      setSelectedId(task.id);
      focusTask(task.id);
      await call(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'move', direction })
      });
    },
    [call, focusTask, tasks]
  );

  const control = useCallback(
    async (action: 'start' | 'pause' | 'resume' | 'abort') => {
      const cwd = projectCwd;
      if (!cwd) {
        setError(t('tasks.noProjectSelected'));
        return;
      }
      await call('/api/tasks/control', {
        method: 'POST',
        body: JSON.stringify({
          action,
          cwd,
          ...(action === 'abort' && runningTask ? { id: runningTask.id } : {})
        })
      });
    },
    [call, projectCwd, runningTask, t]
  );

  const answerQuestion = useCallback(
    async (response: { value: string } | { cancelled: true }): Promise<void> => {
      if (!selected) return;
      const result = await call(`/api/tasks/${selected.id}/answer`, {
        method: 'POST',
        body: JSON.stringify('value' in response ? { answer: response.value } : { cancelled: true })
      });
      if (!result) throw new Error('the answer was not accepted');
    },
    [call, selected]
  );

  /** The strip asks for the running task, which may not be the selected one. */
  const answerFor = useCallback(
    async (task: TaskRecord, response: { value: string } | { cancelled: true }): Promise<void> => {
      const result = await call(`/api/tasks/${task.id}/answer`, {
        method: 'POST',
        body: JSON.stringify('value' in response ? { answer: response.value } : { cancelled: true })
      });
      if (!result) throw new Error('the answer was not accepted');
    },
    [call]
  );

  const onRowKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, task: TaskRecord, order: number[]) => {
      if (event.nativeEvent.isComposing) return;
      // Cmd/Ctrl+A takes the whole queue; Shift+Arrow grows the selection.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        selectAll();
        return;
      }
      if (event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault();
        extendSelection(order, task.id, event.key === 'ArrowUp' ? -1 : 1);
        return;
      }
      // The keyboard's own context-menu gesture, at the row like a right-click.
      if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        openRowMenu(
          task,
          {
            kind: 'rect',
            align: 'end',
            rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
          },
          event.currentTarget
        );
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        void moveTask(task, 'up');
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        void moveTask(task, 'down');
      } else if (event.key === 'Enter') {
        event.preventDefault();
        startEdit(task);
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        void removeTask(task);
      }
    },
    [extendSelection, moveTask, openRowMenu, removeTask, selectAll, startEdit]
  );

  /**
   * One row's menu. Right-clicking a row inside a multi-selection acts on the
   * whole selection, the way a file list does; anything else acts on that row.
   */
  const menuItemsFor = (task: TaskRecord): SidebarMenuItem[] => {
    const targets = multiSelected && selection.has(task.id) ? selectedTasks : [task];
    const single = targets.length === 1;
    const locked = isTaskLocked(task);
    const removable = targets.filter((entry) => !isTaskLocked(entry));
    const pending = groups.queued.findIndex((entry) => entry.id === task.id);
    const canMoveUp = single && pending > 0;
    const canMoveDown = single && pending >= 0 && pending < groups.queued.length - 1;
    const lockedReason = locked ? t('tasks.lockedExplanation') : undefined;
    const items: SidebarMenuItem[] = [
      {
        type: 'item',
        id: 'select',
        label: selection.has(task.id) ? t('tasks.deselect') : t('tasks.select'),
        icon: MENU_ICON.select,
        onSelect: () => toggleSelection(task.id)
      },
      { type: 'separator', id: 'sep-edit' },
      {
        type: 'item',
        id: 'edit',
        label: t('tasks.edit'),
        icon: MENU_ICON.edit,
        disabled: !single || locked,
        disabledReason: locked ? lockedReason : undefined,
        onSelect: () => startEdit(task)
      },
      { type: 'separator', id: 'sep-move' },
      {
        type: 'item',
        id: 'move-up',
        label: t('tasks.moveUp'),
        icon: MENU_ICON.up,
        disabled: !canMoveUp,
        disabledReason: t('tasks.moveBlocked'),
        onSelect: () => void moveTask(task, 'up')
      },
      {
        type: 'item',
        id: 'move-down',
        label: t('tasks.moveDown'),
        icon: MENU_ICON.down,
        disabled: !canMoveDown,
        disabledReason: t('tasks.moveBlocked'),
        onSelect: () => void moveTask(task, 'down')
      },
      { type: 'separator', id: 'sep-copy' },
      {
        type: 'item',
        id: 'duplicate',
        label: single ? t('tasks.duplicate') : t('tasks.duplicateCount', { count: targets.length }),
        icon: MENU_ICON.duplicate,
        onSelect: () => void duplicateTasks(targets)
      },
      {
        type: 'item',
        id: 'copy',
        label: t('tasks.copy'),
        icon: MENU_ICON.copy,
        disabled: !single,
        onSelect: () => copyTask(task)
      },
      {
        type: 'item',
        id: 'paste',
        label: t('tasks.paste'),
        icon: MENU_ICON.paste,
        disabled: !clipboard,
        disabledReason: clipboard ? undefined : t('tasks.nothingToPaste'),
        onSelect: () => void pasteTask()
      }
    ];
    if (single && task.sessionId) {
      items.push(
        { type: 'separator', id: 'sep-session' },
        {
          type: 'item',
          id: 'open-session',
          label: t('tasks.openSession'),
          icon: MENU_ICON.session,
          onSelect: () => onOpenSession?.(task.sessionId as string)
        }
      );
    }
    items.push(
      { type: 'separator', id: 'sep-delete' },
      {
        type: 'item',
        id: 'delete',
        label: single ? t('tasks.delete') : t('tasks.deleteCount', { count: removable.length }),
        icon: MENU_ICON.delete,
        danger: true,
        disabled: removable.length === 0,
        disabledReason: removable.length === 0 ? lockedReason : undefined,
        onSelect: () => {
          if (single) {
            void removeTask(task);
            return;
          }
          const opener = menuOpenerRef.current;
          if (opener) {
            openConfirm(
              'selection',
              removable.map((entry) => entry.id),
              opener
            );
          }
        }
      }
    );
    return items;
  };

  const boardMenuItems = (): SidebarMenuItem[] => [
    {
      type: 'item',
      id: 'new',
      label: t('tasks.new'),
      icon: MENU_ICON.edit,
      onSelect: startNewTask
    },
    {
      type: 'item',
      id: 'paste',
      label: t('tasks.paste'),
      icon: MENU_ICON.paste,
      disabled: !clipboard,
      disabledReason: clipboard ? undefined : t('tasks.nothingToPaste'),
      onSelect: () => void pasteTask()
    },
    { type: 'separator', id: 'sep-select' },
    {
      type: 'item',
      id: 'select-all',
      label: t('tasks.selectAll'),
      icon: MENU_ICON.select,
      disabled: tasks.length === 0,
      onSelect: selectAll
    },
    {
      type: 'item',
      id: 'clear-selection',
      label: t('tasks.clearSelection'),
      icon: MENU_ICON.close,
      disabled: selection.size === 0,
      onSelect: clearSelection
    },
    {
      type: 'item',
      id: 'remove-completed',
      label: t('tasks.clearCompletedCount', { count: doneTasks.length }),
      icon: MENU_ICON.delete,
      danger: true,
      disabled: doneTasks.length === 0,
      onSelect: () => {
        const opener = menuOpenerRef.current;
        if (opener) openConfirm('completed', completedTaskIds(tasks), opener);
      }
    }
  ];

  const menuTask =
    menu?.taskId == null ? null : (tasks.find((task) => task.id === menu.taskId) ?? null);
  const menuItems = menu ? (menuTask ? menuItemsFor(menuTask) : boardMenuItems()) : [];

  const statusLabel = (value: TaskStatus): string => {
    if (value === 'IN_PROGRESS') return t('tasks.status.inProgress');
    if (value === 'PENDING') return t('tasks.status.pending');
    if (value === 'DONE') return t('tasks.status.done');
    if (value === 'BLOCKED') return t('tasks.status.blocked');
    return t('tasks.status.failed');
  };

  const activityLabel = status?.activity
    ? t(`tasks.activity.${status.activity.kind}`) +
      (status.activity.detail ? ` · ${status.activity.detail}` : '')
    : null;

  const chatTitle = (chat: ChatTask) => chat.title || t('tasks.untitledChat');
  // Board chats are live work only, so a row is always running or waiting.
  const chatStatusLabel = (chat: ChatTask) =>
    chat.awaiting ? t('tasks.chatWaiting') : t('tasks.status.inProgress');

  const renderChatRow = (chat: ChatTask) => {
    const active = selectedChat?.session.id === chat.session.id;
    return (
      <div
        key={`chat-${chat.session.id}`}
        className="task-row-shell"
        data-active={active}
        data-chat="true"
        data-menu-open={undefined}
      >
        <button
          type="button"
          className="task-row"
          data-active={active}
          data-status={chat.status}
          aria-current={active ? 'true' : undefined}
          aria-label={`${chatStatusLabel(chat)}: ${chatTitle(chat)}`}
          title={t('tasks.chatHint')}
          onClick={() => {
            setDraft(null);
            setSelectedId(null);
            setExtraSelectedIds([]);
            setSelectedChatId(chat.session.id);
            openSheet();
          }}
          onDoubleClick={() => onOpenSession?.(chat.session.id)}
        >
          <span
            className="task-row-marker"
            style={{ background: statusTone(chat.status) }}
            aria-hidden="true"
          />
          <span className="task-row-body">
            <span className="task-row-title">{chatTitle(chat)}</span>
            <span className="task-row-meta">
              <span className="task-row-cwd">{chat.session.cwd}</span>
              <span>{t('tasks.chat')}</span>
              {chat.session.messageCount > 0 && (
                <span>{t('tasks.messageCount', { count: chat.session.messageCount })}</span>
              )}
            </span>
          </span>
          <span className="task-row-status">{chatStatusLabel(chat)}</span>
        </button>
        <button
          type="button"
          className="task-row-more"
          aria-label={t('tasks.openChat')}
          title={t('tasks.openChat')}
          onClick={() => onOpenSession?.(chat.session.id)}
        >
          {MENU_ICON.session}
        </button>
      </div>
    );
  };

  const renderRow = (task: TaskRecord, order: number[]) => {
    const locked = isTaskLocked(task);
    const active = selected?.id === task.id;
    const selectedHere = selection.has(task.id);
    const menuOpen = menu?.taskId === task.id;
    return (
      <div
        key={task.id}
        className="task-row-shell"
        data-active={active}
        data-selected={selectedHere ? 'true' : undefined}
        data-menu-open={menuOpen ? 'true' : undefined}
        onContextMenu={(event) => {
          event.preventDefault();
          openRowMenu(
            task,
            { kind: 'point', x: event.clientX, y: event.clientY },
            event.currentTarget
          );
        }}
      >
        <button
          ref={(element) => {
            if (element) rowRefs.current.set(task.id, element);
            else rowRefs.current.delete(task.id);
          }}
          type="button"
          className="task-row"
          data-active={active}
          data-status={task.status}
          aria-current={active ? 'true' : undefined}
          aria-label={`${selectedHere && multiSelected ? `${t('tasks.selectedPrefix')} ` : ''}${statusLabel(task.status)}: ${task.title}`}
          title={
            locked
              ? t('tasks.lockedExplanation')
              : `${t('tasks.reorderHint')} · ${t('tasks.editHint')}`
          }
          onClick={(event) => {
            setDraft(null);
            if (event.shiftKey) {
              selectRange(order, task.id);
              openSheet();
              return;
            }
            if (event.metaKey || event.ctrlKey) {
              toggleSelection(task.id);
              return;
            }
            setSelectedChatId(null);
            setSelectedId(task.id);
            setExtraSelectedIds([]);
            openSheet();
          }}
          onDoubleClick={() => startEdit(task)}
          onKeyDown={(event) => onRowKeyDown(event, task, order)}
        >
          <span
            className="task-row-marker"
            style={{ background: statusTone(task.status) }}
            aria-hidden="true"
          />
          <span className="task-row-body">
            <span className="task-row-title">{task.title}</span>
            <span className="task-row-meta">
              <span className="task-row-cwd">{task.cwd}</span>
              {task.createdBy && (
                <span className="task-row-actor" title={t('tasks.queuedByOrchestrator')}>
                  {t('tasks.queuedByOrchestratorShort')}
                </span>
              )}
              {(task.attempts > 0 || task.runStartedAt) && (
                <span>
                  {task.attempts > 0 ? t('tasks.attempts', { count: task.attempts }) : null}
                  {task.attempts > 0 && task.runStartedAt ? ' · ' : null}
                  {task.runStartedAt ? elapsedText(taskElapsedMs(task)) : null}
                </span>
              )}
            </span>
          </span>
          {/* The group heading already names queued, running, and done rows;
              a failed row says so, because its group also holds blocked ones. */}
          {task.status === 'FAILED' && (
            <span className="task-row-status">{statusLabel(task.status)}</span>
          )}
        </button>
        <button
          type="button"
          className="task-row-more"
          aria-label={t('tasks.moreActions')}
          title={t('tasks.moreActions')}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            openRowMenu(
              task,
              {
                kind: 'rect',
                align: 'end',
                rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
              },
              event.currentTarget
            );
          }}
        >
          <MoreIcon size={14} />
        </button>
      </div>
    );
  };

  const groupSection = (key: 'running' | 'queued' | 'blocked' | 'done', list: TaskRecord[]) => {
    if (list.length === 0) return null;
    return (
      <section className="task-group" key={key} aria-label={t(`tasks.group.${key}`)}>
        <h3 className="task-group-title">
          {t(`tasks.group.${key}`)}
          <span className="task-group-count">{list.length}</span>
        </h3>
        <div className="task-group-list">{list.map((task) => renderRow(task, boardOrder))}</div>
      </section>
    );
  };

  /** Finished work is an archive at the panel's bottom edge, not another
   * always-open group in the active list. */
  const renderFinished = () => {
    if (finishedTasks.length === 0) return null;
    return (
      <section
        className="task-finished"
        data-open={finishedOpen ? 'true' : undefined}
        aria-label={t('tasks.finished')}
      >
        <div className="task-finished-head">
          <button
            type="button"
            className="task-finished-toggle"
            aria-expanded={finishedOpen}
            aria-controls="task-finished-list"
            onClick={toggleFinished}
          >
            <ChevronIcon
              size={12}
              strokeWidth={3}
              className={`task-finished-chevron${finishedOpen ? ' is-open' : ''}`}
            />
            <span className="task-finished-label">{t('tasks.finished')}</span>
            <span className="task-finished-count">{finishedTasks.length}</span>
          </button>
          <button
            type="button"
            className="task-finished-clear"
            data-task-action="clear-completed"
            aria-label={t('tasks.clearCompletedCount', { count: finishedTasks.length })}
            title={t('tasks.clearCompletedCount', { count: finishedTasks.length })}
            aria-haspopup="dialog"
            disabled={busy}
            onClick={(event) =>
              openConfirm('completed', completedTaskIds(tasks), event.currentTarget)
            }
          >
            <TrashIcon size={13} />
          </button>
        </div>
        {finishedOpen && (
          <div className="task-finished-list" id="task-finished-list">
            {finishedTasks.map((task) => renderRow(task, boardOrder))}
          </div>
        )}
      </section>
    );
  };

  /** The one queue list: the center column where the panel cannot dock, or the
   * shell's right panel through a portal. Both read the same state. */
  const renderQueueList = (showHeading: boolean) => (
    <div
      className="task-queue-body"
      onContextMenu={(event) => {
        // A right-click on a row belongs to that row's menu; the empty
        // queue offers the two things that need no task.
        if ((event.target as HTMLElement).closest('.task-row-shell')) return;
        event.preventDefault();
        openBoardMenu({ kind: 'point', x: event.clientX, y: event.clientY }, event.currentTarget);
      }}
    >
      {showHeading && (
        <div className="task-queue-heading">
          <span>{t('tasks.board')}</span>
          {projectName && (
            <span className="task-queue-project" title={projectCwd ?? undefined}>
              {projectName}
            </span>
          )}
          <span className="task-group-count">{tasks.length + chats.length}</span>
        </div>
      )}
      <div className="task-queue-scroll">
        {tasks.length === 0 && chats.length === 0 ? (
          <p className="task-empty">
            {hasProject ? t('tasks.emptyWork') : t('tasks.chooseProject')}
          </p>
        ) : (
          <>
            {chats.length > 0 && (
              <section className="task-group" aria-label={t('tasks.group.chats')}>
                <h3 className="task-group-title">
                  {t('tasks.group.chats')}
                  <span className="task-group-count">{chats.length}</span>
                </h3>
                <div className="task-group-list">{chats.map(renderChatRow)}</div>
              </section>
            )}
            {groupSection('running', groups.running)}
            {groupSection('queued', groups.queued)}
            {groupSection('blocked', groups.blocked)}
            {!finishedOpen && finishedTasks.length === tasks.length && chats.length === 0 && (
              <p className="task-empty">{t('tasks.allFinished')}</p>
            )}
          </>
        )}
      </div>
      {renderFinished()}
      <p className="task-queue-hint">{t('tasks.reorderHint')}</p>
    </div>
  );

  return (
    <div className="task-workspace">
      {/* The queue's own bar. The page's Chat | Tasks switch lives one row
          above it, in the shell toolbar, so this row carries only what the
          queue itself needs. */}
      <div className="task-header">
        <div className="task-header-summary">
          {projectName && (
            <span className="task-header-project" title={projectCwd ?? undefined}>
              <span className="task-project-name">{projectName}</span>
              {projectCwd && <span className="task-project-path">{projectCwd}</span>}
            </span>
          )}
          <div className="task-header-state-group">
            {status && (
              <span
                className="task-header-state"
                data-state={selectedSessionCount > 0 ? 'RUNNING' : queueState}
                title={status.pausedReason ?? undefined}
              >
                {selectedSessionCount > 0
                  ? t('tasks.chatRunning', { count: selectedSessionCount })
                  : t(`tasks.queueState.${queueState.toLowerCase()}`)}
              </span>
            )}
            {payload && (
              <span
                className="task-mode-chip"
                data-mode={payload.config.autonomous ? 'autonomous' : 'standard'}
                title={t('tasks.modeHint')}
              >
                {payload.config.autonomous ? t('tasks.modeAutonomous') : t('tasks.modeStandard')}
              </span>
            )}
            {payload?.watch && (
              <span
                className="task-header-watch"
                role="img"
                aria-label={t('tasks.watching')}
                title={t('tasks.watching')}
              >
                <EyeIcon size={13} />
              </span>
            )}
            {status?.state === 'PAUSED' && status.pausedReason && (
              <span className="task-header-reason" title={status.pausedReason}>
                {status.pausedReason}
              </span>
            )}
          </div>
          {queueDocked && !queuePanelOpen && onToggleQueuePanel && (
            <button
              type="button"
              className="task-queue-toggle"
              data-task-queue-toggle="true"
              data-open={queuePanelOpen ? 'true' : undefined}
              aria-expanded={queuePanelOpen}
              aria-controls="task-queue-panel"
              title={queuePanelOpen ? t('tasks.hideQueue') : t('tasks.showQueue')}
              onClick={onToggleQueuePanel}
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
              >
                <path d="M4 6h9M4 12h15M4 18h6" />
                <circle cx="18" cy="6" r="2" />
                <circle cx="15" cy="18" r="2" />
              </svg>
              <span>{t('tasks.board')}</span>
              <span className="task-group-count">{tasks.length + chats.length}</span>
              {(runningTask || chats.some((chat) => chat.running)) && (
                <span className="task-queue-toggle-dot" aria-hidden="true" />
              )}
            </button>
          )}
          {notice && (
            <span className="task-header-notice" role="status">
              {notice}
            </span>
          )}
        </div>
        <div className="task-header-tools">
          {modelOptions.length > 0 && (
            <span className="task-model" title={t('tasks.modelHint')}>
              <ModelSelector
                options={modelOptions}
                value={payload?.config.model ?? null}
                onChange={(provider, modelId) => void saveModel({ provider, modelId })}
                onClear={() => void saveModel(null)}
                emptyLabel={
                  defaultModel
                    ? `${t('tasks.modelDefault')}: ${
                        modelOptions.find(
                          (option) =>
                            option.provider === defaultModel.provider &&
                            option.modelId === defaultModel.modelId
                        )?.name ?? defaultModel.modelId
                      }`
                    : t('tasks.modelDefault')
                }
                ariaLabel={t('tasks.model')}
                busy={modelBusy}
                variant="toolbar"
                placement="auto"
              />
            </span>
          )}
          <button
            type="button"
            className="task-icon-button"
            aria-label={t('tasks.queueSettings')}
            title={t('tasks.queueSettings')}
            aria-haspopup="dialog"
            onClick={() => setQueueSettingsOpen(true)}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h8M16 18h4" />
              <circle cx="16" cy="6" r="2" />
              <circle cx="10" cy="12" r="2" />
              <circle cx="14" cy="18" r="2" />
            </svg>
          </button>
          <div className="task-header-actions">
            <button
              type="button"
              className={`task-icon-button task-run-control${
                primaryAction !== 'start' || groups.queued.length > 0 ? ' is-primary' : ''
              }`}
              aria-label={primaryLabel}
              title={primaryLabel}
              disabled={primaryDisabled}
              onClick={() => void control(primaryAction)}
            >
              {primaryAction === 'pause' ? RUN_ICON.pause : RUN_ICON.play}
            </button>
            <button
              type="button"
              className="task-icon-button is-danger"
              data-task-action="abort"
              aria-label={t('tasks.abort')}
              title={t('tasks.abort')}
              disabled={stopDisabled}
              onClick={() => void control('abort')}
            >
              {RUN_ICON.stop}
            </button>
            <button
              type="button"
              className={`task-icon-button${tasks.length === 0 ? ' is-primary' : ''}`}
              data-task-action="new"
              aria-label={t('tasks.new')}
              title={t('tasks.new')}
              disabled={busy}
              onClick={startNewTask}
            >
              <PlusIcon size={15} />
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="task-banner is-error" role="alert">
          {error}
        </div>
      )}
      {/* The same panel the chat composer uses: a waiting question is answered
          from here without opening the task's surface. */}
      {runningTask?.pendingQuestion && questionRequestFor(runningTask) && (
        <div className="task-question-strip">
          <AskUserPanel
            key={`strip-${runningTask.id}-${runningTask.pendingQuestion.requestId}`}
            request={questionRequestFor(runningTask) as never}
            waitingCount={0}
            onRespond={(_request, response) => answerFor(runningTask, response)}
            onReturnFocus={() => {}}
          />
        </div>
      )}

      <div className="task-body">
        {queueDocked ? (
          <section className="task-detail" aria-label={t('tasks.detail')}>
            {renderDetail() ?? renderEmptyDetail()}
          </section>
        ) : (
          <aside className="task-queue" aria-label={t('tasks.board')}>
            {renderQueueList(true)}
          </aside>
        )}
      </div>

      {/* The docked list lives beside the center column, so it spans the page
          height like the Runs panel rather than sitting inside the surface. */}
      {queueDocked && queuePanelSlot ? createPortal(renderQueueList(false), queuePanelSlot) : null}

      {queueSettingsOpen && payload && (
        <QueueSettingsDialog
          config={payload.config}
          modelOptions={modelOptions}
          defaultModelLabel={
            defaultModel
              ? (modelOptions.find(
                  (option) =>
                    option.provider === defaultModel.provider &&
                    option.modelId === defaultModel.modelId
                )?.name ?? defaultModel.modelId)
              : null
          }
          onClose={() => setQueueSettingsOpen(false)}
          onSaved={() => {
            setQueueSettingsOpen(false);
            setNotice(t('tasks.defaultsSaved'));
            void refresh();
          }}
        />
      )}

      <SidebarMenu
        open={confirm !== null}
        anchor={confirm?.anchor ?? null}
        sheet={isMobile}
        ariaLabel={t('tasks.removeConfirm')}
        title={confirm?.kind === 'completed' ? t('tasks.clearCompleted') : t('tasks.removeConfirm')}
        cancelLabel={t('i18n.cancel')}
        onClose={() => setConfirm(null)}
        returnFocusTo={confirm?.opener ?? null}
        width={280}
      >
        <div className="task-confirm">
          <p className="task-confirm-title" role="status">
            {confirm?.kind === 'completed'
              ? t('tasks.removeCompletedTitle', { count: confirm?.ids.length ?? 0 })
              : t('tasks.removeSelectionTitle', { count: confirm?.ids.length ?? 0 })}
          </p>
          <p className="task-confirm-text">{t('tasks.removeCannotUndo')}</p>
          <div className="task-confirm-actions">
            <button
              type="button"
              className="task-control is-danger"
              onClick={() => void confirmRemoval()}
            >
              {t('tasks.remove', { count: confirm?.ids.length ?? 0 })}
            </button>
            <button
              type="button"
              className="task-control"
              data-sidebar-menu-autofocus={isMobile ? undefined : ''}
              onClick={() => setConfirm(null)}
            >
              {t('tasks.cancel')}
            </button>
          </div>
        </div>
      </SidebarMenu>

      <SidebarMenu
        open={menu !== null}
        anchor={menu?.anchor ?? null}
        sheet={isMobile}
        ariaLabel={t('tasks.moreActions')}
        title={menuTask ? menuTask.title : t('tasks.board')}
        items={menuItems}
        cancelLabel={t('i18n.cancel')}
        onClose={closeMenu}
        returnFocusTo={menuOpenerRef.current}
        width={248}
      />

      {pickerOpen && (
        <DirectoryPicker
          title={t('tasks.chooseFolderTitle')}
          description={t('tasks.chooseFolderDescription')}
          initialPath={form.cwd.trim() || undefined}
          busy={cwdChecking || busy}
          error={cwdError}
          onCancel={() => closePicker()}
          onSelect={(path) => void pickDirectory(path)}
        />
      )}

      {placement === 'sheet' && (
        <div
          ref={sheetRef}
          tabIndex={-1}
          className="task-detail-sheet"
          role="dialog"
          aria-modal="true"
          aria-label={t('tasks.detail')}
        >
          <div className="task-sheet-bar">
            <span className="task-sheet-title">{t('tasks.detail')}</span>
            <button type="button" className="task-sheet-close" onClick={closeSheet}>
              {t('tasks.close')}
            </button>
          </div>
          <div className="task-detail">{renderDetail()}</div>
        </div>
      )}
    </div>
  );

  function renderSelection() {
    const removable = selectedTasks.filter((task) => !isTaskLocked(task));
    return (
      <div className="task-selection">
        <h2 className="task-detail-title">{t('tasks.selectedCount', { count: selection.size })}</h2>
        {/* Keyboard modifiers mean nothing on a phone, where rows are picked from
            their menus and this panel covers them. */}
        <p className="task-hint">
          {t(detailIsSheet ? 'tasks.selectionHintPhone' : 'tasks.selectionHint')}
        </p>
        <div className="task-detail-actions">
          <button
            type="button"
            className="task-control"
            disabled={busy}
            onClick={() => void duplicateTasks(selectedTasks)}
          >
            {t('tasks.duplicateCount', { count: selectedTasks.length })}
          </button>
          <button
            type="button"
            className="task-control is-danger"
            data-task-action="delete-selection"
            disabled={busy || removable.length === 0}
            title={removable.length === 0 ? t('tasks.lockedExplanation') : undefined}
            onClick={(event) =>
              openConfirm(
                'selection',
                removable.map((task) => task.id),
                event.currentTarget
              )
            }
          >
            {t('tasks.deleteCount', { count: removable.length })}
          </button>
          <button type="button" className="task-control" onClick={clearSelection} disabled={busy}>
            {t('tasks.clearSelection')}
          </button>
        </div>
      </div>
    );
  }

  function renderEmptyDetail() {
    if (!hasProject) {
      return (
        <div className="task-detail-empty">
          <svg
            className="task-detail-empty-mark"
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M4 6h10M4 12h16M4 18h7" />
            <circle cx="18" cy="6" r="2" />
            <circle cx="15" cy="18" r="2" />
          </svg>
          <h2 className="task-detail-empty-title">{t('tasks.chooseProject')}</h2>
          <p className="task-detail-empty-text">{t('tasks.chooseProjectHint')}</p>
          <button type="button" className="task-control is-primary" onClick={startNewTask}>
            {t('tasks.new')}
          </button>
        </div>
      );
    }
    return (
      <div className="task-detail-empty">
        <svg
          className="task-detail-empty-mark"
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M4 6h10M4 12h16M4 18h7" />
          <circle cx="18" cy="6" r="2" />
          <circle cx="15" cy="18" r="2" />
        </svg>
        <h2 className="task-detail-empty-title">{t('tasks.detailEmptyTitle')}</h2>
        <p className="task-detail-empty-text">{t('tasks.detailEmptyText')}</p>
        <button type="button" className="task-control is-primary" onClick={startNewTask}>
          {t('tasks.new')}
        </button>
      </div>
    );
  }

  function renderChatDetail(chat: ChatTask) {
    const title = chatTitle(chat);
    return (
      <>
        <header className="task-detail-head">
          <h2 className="task-detail-title">{title}</h2>
          <p className="task-detail-status" data-status={chat.status}>
            <span className="task-row-marker" style={{ background: statusTone(chat.status) }} />
            <span>{chatStatusLabel(chat)}</span>
            <span className="task-detail-fact">
              {t('tasks.messageCount', { count: chat.session.messageCount })}
            </span>
          </p>
          {chat.session.messageCount > 0 && chat.session.firstMessage && (
            <p className="task-detail-text">{chat.session.firstMessage}</p>
          )}
        </header>
        <dl className="task-facts">
          <dt>{t('tasks.cwdLabel')}</dt>
          <dd className="task-mono">{chat.session.cwd}</dd>
          <dt>{t('tasks.session')}</dt>
          <dd className="task-mono">{chat.session.id}</dd>
          <dt>{t('tasks.lastActivity')}</dt>
          <dd>{new Date(chat.session.modified).toLocaleString()}</dd>
        </dl>
        {chat.awaiting && (
          <p className="task-activity" role="status">
            <span className="task-activity-dot" aria-hidden="true" />
            {t('tasks.chatWaitingHint')}
          </p>
        )}
        <div className="task-detail-actions">
          <button
            type="button"
            className="task-control is-primary"
            disabled={!onOpenSession}
            onClick={() => onOpenSession?.(chat.session.id)}
          >
            {t('tasks.openChat')}
          </button>
        </div>
      </>
    );
  }

  function renderDetail() {
    // The new-task form is the one detail pane that exists before a task does.
    if (draft) return renderForm();
    if (selectedChat) return renderChatDetail(selectedChat);
    if (multiSelected) return renderSelection();
    if (!selected) return null;
    const locked = isTaskLocked(selected);
    return (
      <>
        <header className="task-detail-head">
          <h2 className="task-detail-title">{selected.title}</h2>
          <p className="task-detail-status" data-status={selected.status}>
            <span className="task-row-marker" style={{ background: statusTone(selected.status) }} />
            <span>{statusLabel(selected.status)}</span>
            {selected.attempts > 0 && (
              <span className="task-detail-fact">
                {t('tasks.attempts', { count: selected.attempts })}
              </span>
            )}
            <span className="task-detail-fact task-detail-elapsed">
              {selected.runStartedAt ? elapsedText(taskElapsedMs(selected)) : null}
            </span>
          </p>
          {selected.description && <p className="task-detail-text">{selected.description}</p>}
        </header>
        <dl className="task-facts">
          <dt>{t('tasks.cwdLabel')}</dt>
          <dd className="task-mono">{selected.cwd}</dd>
          {selected.resultSummary && (
            <>
              <dt>{t('tasks.result')}</dt>
              <dd className="task-mono task-summary">{selected.resultSummary}</dd>
            </>
          )}
          {selected.verifyOutput && (
            <>
              <dt>{t('tasks.verifyOutput')}</dt>
              <dd className="task-mono task-summary">{selected.verifyOutput}</dd>
            </>
          )}
          <dt>{t('tasks.verification')}</dt>
          <dd>
            {payload && hasVerification(selected, payload.config)
              ? (selected.verifyCommands ?? payload.config.verifyCommands).join(' · ')
              : t('tasks.noVerification')}
          </dd>
          {selected.sessionId && (
            <>
              <dt>{t('tasks.session')}</dt>
              <dd>
                <button
                  type="button"
                  className="task-link"
                  onClick={() => onOpenSession?.(selected.sessionId as string)}
                >
                  {t('tasks.openSession')}
                </button>
              </dd>
            </>
          )}
        </dl>
        {selected.pendingQuestion && questionRequest && (
          <AskUserPanel
            key={questionRequest.id}
            request={questionRequest as never}
            waitingCount={0}
            onRespond={(_request, response) => answerQuestion(response)}
            onReturnFocus={() => {}}
          />
        )}
        {runningTask?.id === selected.id && activityLabel && (
          <p className="task-activity" role="status">
            <span className="task-activity-dot" aria-hidden="true" />
            {activityLabel}
          </p>
        )}
        {selected.status === 'IN_PROGRESS' && output && (
          <details className="task-tail" open>
            <summary>{t('tasks.liveTail')}</summary>
            <pre className="task-mono">{output.slice(-4_000)}</pre>
          </details>
        )}
        <div className="task-detail-actions">
          <button
            type="button"
            className="task-control"
            data-task-action="edit"
            disabled={locked || busy}
            title={locked ? t('tasks.lockedExplanation') : undefined}
            onClick={() => startEdit(selected)}
          >
            {t('tasks.edit')}
          </button>
          {(selected.status === 'BLOCKED' || selected.status === 'FAILED') && (
            <button
              type="button"
              className="task-control"
              disabled={busy}
              onClick={() =>
                void call(`/api/tasks/${selected.id}`, {
                  method: 'PATCH',
                  body: JSON.stringify({ action: 'retry' })
                })
              }
            >
              {t('tasks.retry')}
            </button>
          )}
          {selected.status !== 'DONE' && (
            <button
              type="button"
              className="task-control"
              disabled={locked || busy}
              onClick={() =>
                void call(`/api/tasks/${selected.id}`, {
                  method: 'PATCH',
                  body: JSON.stringify({ action: 'markDone' })
                })
              }
            >
              {t('tasks.markDone')}
            </button>
          )}
          <button
            type="button"
            className="task-control is-danger"
            data-task-action="delete"
            disabled={locked || busy}
            title={locked ? t('tasks.lockedExplanation') : undefined}
            onClick={() => void removeTask(selected)}
          >
            {t('tasks.delete')}
          </button>
        </div>
      </>
    );
  }

  function renderForm() {
    return (
      <form
        className="task-form"
        onSubmit={(event) => {
          event.preventDefault();
          void saveDraft();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            closeDraft();
          }
        }}
      >
        <h2 className="task-detail-title">
          {draft?.mode === 'new' ? t('tasks.new') : t('tasks.edit')}
        </h2>
        <label className="task-field">
          <span>{t('tasks.descriptionLabel')}</span>
          <textarea
            rows={6}
            required
            autoFocus
            value={form.description}
            aria-describedby="task-description-hint"
            onChange={(event) => setForm({ ...form, description: event.target.value })}
          />
          <span className="task-hint" id="task-description-hint">
            {t('tasks.descriptionHint')}
          </span>
        </label>
        <div className="task-field">
          <label htmlFor="task-cwd">{t('tasks.cwdLabel')}</label>
          <div className="task-cwd-row">
            <input
              id="task-cwd"
              className="task-mono"
              value={form.cwd}
              required
              aria-invalid={cwdError ? true : undefined}
              aria-describedby={cwdError ? 'task-cwd-error' : 'task-cwd-hint'}
              onChange={(event) => {
                setCwdError(null);
                setForm({ ...form, cwd: event.target.value });
              }}
            />
            <button
              ref={folderButtonRef}
              type="button"
              className="task-control"
              data-task-action="choose-folder"
              disabled={busy || cwdChecking}
              onClick={() => {
                setCwdError(null);
                setPickerOpen(true);
              }}
            >
              {t('tasks.chooseFolder')}
            </button>
          </div>
          {cwdError ? (
            <span className="task-field-error" id="task-cwd-error" role="alert">
              {cwdError}
            </span>
          ) : (
            <span className="task-hint" id="task-cwd-hint">
              {t('tasks.cwdHint')}
            </span>
          )}
        </div>
        <label className="task-field">
          <span>{t('tasks.verifyCommandsLabel')}</span>
          <textarea
            className="task-mono"
            rows={3}
            placeholder={t('tasks.verifyCommandsHint')}
            value={form.verifyCommands}
            onChange={(event) => setForm({ ...form, verifyCommands: event.target.value })}
          />
        </label>
        <div className="task-detail-actions">
          <button type="submit" className="task-control is-primary" disabled={busy}>
            {t('tasks.save')}
          </button>
          <button type="button" className="task-control" onClick={closeDraft} disabled={busy}>
            {t('tasks.cancel')}
          </button>
        </div>
      </form>
    );
  }
}
