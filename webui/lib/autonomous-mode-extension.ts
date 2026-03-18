/**
 * Autonomous mode: the agent decides without waiting for a person.
 *
 * The task queue uses this mode when its single global autonomous switch is on.
 * A normal chat may select it too. The mode contributes prompt guidance and
 * refuses `ask_user`; it does not start a goal. The task runner starts the goal
 * so a task cannot settle just because the foreground turn went idle.
 */
import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import { ASK_USER_TOOL_NAME } from './ask-user-extension';
import type { SessionEntry } from './types';
import { readWorkMode } from './work-mode';

export const AUTONOMOUS_MODE_EXTENSION_NAME = 'pie-autonomous-mode';

export const AUTONOMOUS_MODE_GUIDELINES = [
  'Autonomous mode is on: make the reasonable decision yourself instead of waiting for a person. Do not stop to ask a question; state the assumption you chose when it matters.',
  'Work through clear low-risk next steps until the objective is actually complete. A plan, a summary, or a partial implementation is not completion.',
  'Check the result before calling it done. When the session has an active goal, mark that goal complete only after the completion audit; otherwise report what changed and what is left.'
];

export function autonomousModeBlockReason(toolName: string): string {
  return `Autonomous mode does not ask the user, so "${toolName}" is blocked. Decide from the workspace and state your assumption in the result.`;
}

export function createAutonomousModeExtension(): InlineExtension {
  return {
    name: AUTONOMOUS_MODE_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      const active = (entries: readonly SessionEntry[]) => readWorkMode(entries) === 'autonomous';

      pi.on('before_agent_start', (event, ctx) => {
        if (!active(ctx.sessionManager.getEntries() as unknown as SessionEntry[])) return;
        event.systemPromptOptions.promptGuidelines.push(...AUTONOMOUS_MODE_GUIDELINES);
      });

      pi.on('tool_call', (event, ctx) => {
        if (event.toolName !== ASK_USER_TOOL_NAME) return;
        if (!active(ctx.sessionManager.getEntries() as unknown as SessionEntry[])) return;
        return { block: true, reason: autonomousModeBlockReason(event.toolName) };
      });
    }
  };
}
