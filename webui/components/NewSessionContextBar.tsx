import { useI18n } from '@/hooks/useI18n';
import type { NewSessionContext, NewSessionTarget } from '@/lib/new-session-context';
import { focusIfLost } from '@/lib/stacked-dialog';
import { useEffect, useRef } from 'react';
import { ProjectPicker, type ProjectControl, type ProjectPickerHandle } from './ProjectPicker';

/** The bar's project control. A move names the one it came from, which takes focus in the bar that replaces this one. */
export type NewSessionContextControl = ProjectControl;

interface Props {
  context: NewSessionContext;
  /** A phone: the menus open as bottom sheets. */
  mobile: boolean;
  /** The control the move that mounted this bar came from: it takes focus once, if focus fell to the page. */
  initialFocus: NewSessionContextControl | null;
  onInitialFocusDone: () => void;
  /** Start the fresh composer over in `target`; the shell ignores a move to where it already is. */
  onPick: (target: NewSessionTarget, from: NewSessionContextControl) => void;
  /** "Start without a project": today's scratch folder, which goes to `onPick`. */
  onStartWithoutProject: () => void;
  /** "Add a project…": the folder picker, which hands its folder to `onPick`. */
  onOpenFolder: (opener: HTMLElement | null) => void;
}

/** The selected directory above a fresh composer; moves preserve its draft. */
export function NewSessionContextBar({
  context,
  mobile,
  initialFocus,
  onInitialFocusDone,
  onPick,
  onStartWithoutProject,
  onOpenFolder
}: Props) {
  const { t } = useI18n();
  const pickerRef = useRef<ProjectPickerHandle>(null);
  const initialFocusRef = useRef(initialFocus);
  const onInitialFocusDoneRef = useRef(onInitialFocusDone);
  onInitialFocusDoneRef.current = onInitialFocusDone;

  // The control that moved the composer went away with it: its counterpart
  // here takes focus, so a keyboard user goes on from where they were.
  useEffect(() => {
    const from = initialFocusRef.current;
    if (!from) return;
    initialFocusRef.current = null;
    onInitialFocusDoneRef.current();
    const picker = pickerRef.current;
    focusIfLost(document, picker?.button('project') ?? null);
  }, []);

  return (
    <div className="new-session-context">
      <ProjectPicker
        handleRef={pickerRef}
        layout="inline"
        context={context}
        mobile={mobile}
        label={t('workspace.newSessionContext')}
        onPick={onPick}
        onStartWithoutProject={onStartWithoutProject}
        onOpenFolder={onOpenFolder}
      />
    </div>
  );
}
