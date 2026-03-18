import { useInAppClick } from '@/hooks/useAppLocation';
import { useI18n } from '@/hooks/useI18n';

export type WorkspaceMode = 'chat' | 'tasks';

function ChatIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function TasksIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  );
}

/**
 * Chat and Tasks are two views of one workspace, so the page carries one
 * control with one choice at a time rather than two buttons that each open
 * something. Each choice is a real URL: the active view survives a reload, a
 * new tab, and a Web Push deep link.
 *
 * The control is navigation, not a tablist with panels: `aria-current` says
 * which page is open, and ordinary links keep the keyboard, the browser's
 * context menu, and "open in new tab" working without a roving tabindex.
 */
export function WorkspaceSwitch({
  mode,
  tasksHref = '/?mode=tasks'
}: {
  mode: WorkspaceMode;
  /** The task board's project, so the active segment keeps it on reload. */
  tasksHref?: string;
}) {
  const { t } = useI18n();
  const onClick = useInAppClick();
  const options = [
    { key: 'chat', href: '/', label: t('workspace.chat') },
    { key: 'tasks', href: tasksHref, label: t('workspace.tasks') }
  ] as const;

  return (
    <nav className="workspace-switch" aria-label={t('workspace.switch')}>
      {options.map((option) => (
        <a
          key={option.key}
          href={option.href}
          onClick={onClick}
          className="workspace-switch-item"
          data-active={mode === option.key ? 'true' : undefined}
          data-workspace-option={option.key}
          aria-current={mode === option.key ? 'page' : undefined}
        >
          {option.key === 'chat' ? <ChatIcon /> : <TasksIcon />}
          <span>{option.label}</span>
        </a>
      ))}
    </nav>
  );
}
