import { useImperativeHandle, useRef, useState, type Ref } from 'react';
import { useI18n } from '@/hooks/useI18n';
import {
  describeProjectChoices,
  type NewSessionTarget,
  type ProjectPickerContext
} from '@/lib/new-session-context';
import { SidebarMenu, type SidebarMenuAnchor, type SidebarMenuItem } from './SidebarMenu';

export type ProjectControl = 'project';
export interface ProjectPickerHandle {
  button(control: ProjectControl): HTMLButtonElement | null;
  openMenu(control: ProjectControl): void;
}
interface Props {
  context: ProjectPickerContext;
  mobile: boolean;
  label: string;
  layout: 'inline';
  handleRef?: Ref<ProjectPickerHandle>;
  onPick: (target: NewSessionTarget, from: ProjectControl) => void;
  onStartWithoutProject: () => void;
  onOpenFolder: (opener: HTMLElement | null) => void;
}

/** A directory chooser for new conversations, independent of Git operations. */
export function ProjectPicker({
  context,
  mobile,
  label,
  handleRef,
  onPick,
  onStartWithoutProject,
  onOpenFolder
}: Props) {
  const { t } = useI18n();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<SidebarMenuAnchor | null>(null);
  const open = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect)
      setAnchor({
        kind: 'rect',
        align: 'start',
        rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
      });
  };
  useImperativeHandle(handleRef, () => ({ button: () => buttonRef.current, openMenu: open }));
  const items: SidebarMenuItem[] = describeProjectChoices(context.projects).map(
    ({ choice, name, note }) => ({
      type: 'item',
      id: choice.key,
      label: name,
      title: choice.root,
      note: note ?? undefined,
      checked: choice.key === context.project?.key,
      onSelect: () =>
        onPick({ cwd: choice.root, projectKey: choice.key, projectRoot: choice.root }, 'project')
    })
  );
  items.push(
    { type: 'separator', id: 'directories' },
    {
      type: 'item',
      id: 'default',
      label: t('sidebar.startWithoutProject'),
      onSelect: onStartWithoutProject
    },
    {
      type: 'item',
      id: 'browse',
      label: t('sidebar.addProject'),
      onSelect: () => onOpenFolder(buttonRef.current)
    }
  );
  return (
    <div className="project-picker is-inline" role="group" aria-label={label}>
      <button
        ref={buttonRef}
        type="button"
        className="project-picker-button is-project"
        onClick={open}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        title={context.project?.root}
      >
        <svg
          className="project-picker-icon"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          aria-hidden="true"
        >
          <path d="M3 7h7l2 2h9v11H3z" />
          <path d="M3 7V4h7l2 3" />
        </svg>
        <span className="project-picker-name">
          <span className="project-picker-leaf">
            {context.project?.alias ??
              context.projects.find((project) => project.key === context.project?.key)?.alias ??
              context.project?.root.split(/[\\/]/).filter(Boolean).at(-1) ??
              t('sidebar.selectProject')}
          </span>
        </span>
      </button>
      <SidebarMenu
        open={anchor !== null}
        anchor={anchor}
        sheet={mobile}
        ariaLabel={label}
        items={items}
        cancelLabel={t('sidebar.cancel')}
        onClose={() => setAnchor(null)}
        returnFocusTo={buttonRef.current}
      />
    </div>
  );
}
