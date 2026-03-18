/**
 * The tasks workspace's left panel: one row per project, with its queue state.
 *
 * It replaces the conversation sidebar only in `?mode=tasks`; chat keeps the
 * session list untouched. The rows are the same projects the ChatGPT sidebar
 * groups by (a project is a working directory), so a task in `/repo` and a
 * conversation in `/repo` share one row. Projects with tasks but no
 * conversations are added from the queue summaries.
 */
import { useI18n } from '@/hooks/useI18n';
import { useSessionUiState } from '@/hooks/useSessionUiState';
import { getRecentProjects } from '@/lib/project-groups';
import { projectLabelFromPath } from '@/lib/tasks/board';
import type { SessionInfo } from '@/lib/types';
import type { TaskProjectSummary } from '@/lib/tasks/types';
import { useMemo, useState } from 'react';
import { DirectoryPicker } from './DirectoryPicker';
import { PieTitle } from './PieTitle';
import { PinIcon, PlusIcon } from './SidebarIcons';

export interface TaskProjectsSidebarProps {
  /** The chat's session catalogue, used for projects that have no task yet. */
  sessions: SessionInfo[];
  /** Every project queue, from the task board's poll. */
  taskProjects: TaskProjectSummary[];
  /** The project the board is reading, named by its cwd. */
  selectedCwd: string | null;
  onSelectProject: (cwd: string) => void;
}

interface ProjectRow {
  key: string;
  root: string;
  name: string;
  pinned: boolean;
  order: number;
  recent: number;
  task: TaskProjectSummary | null;
}

function priority(row: ProjectRow): number {
  const task = row.task;
  if (!task) return 4;
  if (
    task.activeTaskId !== null ||
    task.state === 'RUNNING' ||
    (task.activeSessions?.length ?? 0) > 0
  ) {
    return 0;
  }
  if (task.state === 'PAUSED' || task.blocked > 0 || task.failed > 0) return 1;
  if (task.pending > 0) return 2;
  if (task.total > 0) return 3;
  return 4;
}

function compareRows(a: ProjectRow, b: ProjectRow): number {
  return (
    priority(a) - priority(b) ||
    Number(b.pinned) - Number(a.pinned) ||
    a.order - b.order ||
    a.recent - b.recent ||
    a.name.localeCompare(b.name)
  );
}

export function TaskProjectsSidebar({
  sessions,
  taskProjects,
  selectedCwd,
  onSelectProject
}: TaskProjectsSidebarProps) {
  const { t } = useI18n();
  const uiState = useSessionUiState();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);

  const rows = useMemo(() => {
    const recent = getRecentProjects(sessions);
    const recentIndex = new Map(recent.map((project, index) => [project.key, index]));
    const taskByKey = new Map(taskProjects.map((project) => [project.projectKey, project]));
    const keys = new Set([...recent.map((project) => project.key), ...taskByKey.keys()]);
    const order = new Map(
      (uiState.state.projectOrder ?? []).map((key, index) => [key, index])
    );
    const names = uiState.state.projectNames ?? {};
    const pinned = uiState.state.projects ?? {};
    return [...keys]
      .map((key): ProjectRow => {
        const task = taskByKey.get(key) ?? null;
        const recentProject = recent.find((project) => project.key === key);
        const root = task?.cwd || recentProject?.root || key;
        return {
          key,
          root,
          name: names[key] || projectLabelFromPath(root),
          pinned: Boolean(pinned[key]),
          order: order.get(key) ?? Number.MAX_SAFE_INTEGER,
          recent: recentIndex.get(key) ?? Number.MAX_SAFE_INTEGER,
          task
        };
      })
      .sort(compareRows);
  }, [sessions, taskProjects, uiState.state.projectNames, uiState.state.projectOrder, uiState.state.projects]);

  const active = rows.filter((row) => priority(row) <= 2);
  const idle = rows.filter((row) => priority(row) >= 3);

  const pickProject = async (path: string) => {
    setPickerBusy(true);
    setPickerError(null);
    try {
      const response = await fetch('/api/cwd/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: path })
      });
      const data = (await response.json().catch(() => ({}))) as { cwd?: string; error?: string };
      if (!response.ok || data.error || !data.cwd) {
        setPickerError(data.error ?? `HTTP ${response.status}`);
        return;
      }
      setPickerOpen(false);
      onSelectProject(data.cwd);
    } catch (error) {
      setPickerError(error instanceof Error ? error.message : String(error));
    } finally {
      setPickerBusy(false);
    }
  };

  const renderRow = (row: ProjectRow) => {
    const selected = selectedCwd !== null && row.root === selectedCwd;
    const task = row.task;
    const running = Boolean(
      task &&
        (task.activeTaskId !== null ||
          task.state === 'RUNNING' ||
          (task.activeSessions?.length ?? 0) > 0)
    );
    const activeSessions = task?.activeSessions ?? [];
    const paused = task?.state === 'PAUSED';
    const pending = task?.pending ?? 0;
    const attention = (task?.blocked ?? 0) + (task?.failed ?? 0);
    const statusText = running
      ? activeSessions.length > 0 && task?.activeTaskId === null
        ? t('tasks.chatRunning', { count: activeSessions.length })
        : t('tasks.queueState.running')
      : paused
        ? t('tasks.queueState.paused')
        : pending > 0
          ? t('tasks.projectQueued', { count: pending })
          : t('tasks.queueState.idle');
    const detail =
      running && task && task.activeTaskId !== null && task.activeTaskTitle
        ? task.activeTaskTitle
        : running && activeSessions.length > 0
          ? t('tasks.chatRunningDetail', { title: activeSessions[0].title })
          : paused && task?.pausedReason
            ? task.pausedReason
            : row.root;
    return (
      <button
        key={row.key}
        type="button"
        className="task-project-row"
        data-active={selected ? 'true' : undefined}
        data-state={running ? 'RUNNING' : paused ? 'PAUSED' : 'IDLE'}
        aria-current={selected ? 'true' : undefined}
        aria-label={`${row.name}, ${statusText}${attention > 0 ? `, ${t('tasks.projectAttention', { count: attention })}` : ''}`}
        title={row.root}
        onClick={() => onSelectProject(row.root)}
      >
        <span className="task-project-row-main">
          <span className="task-project-row-name">
            <span className="task-project-row-dot" aria-hidden="true" />
            <span className="task-project-row-label">{row.name}</span>
            {row.pinned && <PinIcon size={10} className="task-project-row-pin" />}
          </span>
          <span className="task-project-row-detail">{detail}</span>
        </span>
        <span className="task-project-row-side">
          {pending > 0 && <span className="task-project-row-count">{pending}</span>}
          {attention > 0 && (
            <span className="task-project-row-attention" aria-hidden="true">
              !
            </span>
          )}
        </span>
      </button>
    );
  };

  return (
    <div className="task-projects">
      <div className="sidebar-header">
        <PieTitle />
        <span className="sidebar-header-spacer" />
        <button
          type="button"
          className="sidebar-new-button"
          onClick={() => {
            setPickerError(null);
            setPickerOpen(true);
          }}
          title={t('tasks.addProject')}
          aria-haspopup="dialog"
          aria-expanded={pickerOpen}
        >
          <PlusIcon size={12} />
          <span className="sidebar-new-label">{t('tasks.addProject')}</span>
        </button>
      </div>

      <div className="task-projects-scroll" role="navigation" aria-label={t('tasks.projects')}>
        {rows.length === 0 ? (
          <div className="task-projects-empty">
            <p>{t('tasks.noProjects')}</p>
            <button
              type="button"
              className="task-control is-primary"
              onClick={() => {
                setPickerError(null);
                setPickerOpen(true);
              }}
            >
              {t('tasks.addProject')}
            </button>
          </div>
        ) : (
          <>
            {active.length > 0 && (
              <section className="task-projects-section" aria-label={t('tasks.activeProjects')}>
                <h2 className="task-projects-heading">{t('tasks.activeProjects')}</h2>
                {active.map(renderRow)}
              </section>
            )}
            {idle.length > 0 && (
              <section className="task-projects-section" aria-label={t('tasks.allProjects')}>
                <h2 className="task-projects-heading">
                  {active.length > 0 ? t('tasks.allProjects') : t('tasks.projects')}
                </h2>
                {idle.map(renderRow)}
              </section>
            )}
          </>
        )}
      </div>

      {pickerOpen && (
        <DirectoryPicker
          title={t('tasks.chooseFolderTitle')}
          description={t('tasks.chooseFolderDescription')}
          busy={pickerBusy}
          error={pickerError}
          onCancel={() => {
            setPickerOpen(false);
            setPickerError(null);
          }}
          onSelect={(path) => void pickProject(path)}
        />
      )}
    </div>
  );
}
