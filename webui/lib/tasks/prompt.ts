/**
 * The prompt a task run receives.
 *
 * A task runs in a fresh SDK session rather than a conversation someone drives
 * turn by turn, so the prompt carries the rules a chat session gets from the
 * person: where to work, whether autonomous decisions replace questions, and
 * what the final message must report. Standing instructions are not here: the session receives them
 * as a system-prompt append, so they live with the rest of the instructions.
 */
import { verificationShellName } from './gate';
import type { TaskRecord } from './types';

export const QUEUED_TASK_PROMPT_HEADER =
  "You are running a task from Pie's project task queue in one fresh session.";

export function isQueuedTaskPrompt(text: string | null | undefined): boolean {
  if (!text) return false;
  return (
    text.startsWith(QUEUED_TASK_PROMPT_HEADER) ||
    text.startsWith('You are running task #')
  );
}

export interface TaskPromptInput {
  task: Pick<TaskRecord, 'title' | 'description' | 'cwd'>;
  verifyCommands: string[];
  autonomous: boolean;
}

export function buildTaskPrompt({ task, verifyCommands, autonomous }: TaskPromptInput): string {
  const lines: string[] = [];
  const verificationShell = verificationShellName();
  lines.push(
    QUEUED_TASK_PROMPT_HEADER,
    ''
  );
  lines.push(`Task: ${task.description ?? task.title}`);
  lines.push(
    '',
    'Working directory:',
    task.cwd,
    '',
    'Rules for this run:',
    '- Do all work for this task inside the working directory above. If the task needs another location, state that in your final message instead of changing directories.',
    '- Do not create branches, worktrees, pull requests, or pushes.',
    '- Verify your work where it can be verified. Do not claim something you did not check.',
    verifyCommands.length > 0
      ? `- After you finish, these verification commands run outside this session: ${verifyCommands
          .map((command) => `\`${command}\``)
          .join(
            ', '
          )}. They run in ${verificationShell}, not in this session's shell, so keep them portable: \`echo\`, \`node -e\` and the project's own scripts work there; interactive or POSIX-only tools may not.`
      : '- No verification commands are configured for this task; the result is judged from your report.',
    autonomous
      ? '- Autonomous mode is on. Make the most reasonable assumption yourself, do not ask the user, and keep working through clear low-risk next steps until the task is actually done.'
      : '- You may use ask_user if a decision is genuinely unclear. The queue waits for the answer, so ask only when the choice changes what you would build.',
    autonomous
      ? '- A goal is active for this task. Do not stop after a plan or a partial result: continue until the work is complete, then mark the goal complete only after checking the result.'
      : '- Finish with a short report: what changed, what you verified, and what is left.'
  );
  return lines.join('\n');
}
