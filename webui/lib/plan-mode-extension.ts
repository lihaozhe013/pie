import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import { ASK_USER_TOOL_NAME } from './ask-user-extension';
import {
  isApplyPatchToolName,
  isEditToolName,
  isShellToolName,
  isWriteToolName
} from './tool-names';
import type { SessionEntry } from './types';
import { readWorkMode } from './work-mode';

export const PLAN_MODE_EXTENSION_NAME = 'pie-plan-mode';

const PLAN_BLOCKED_EXACT = new Set<string>(['bash', 'powershell', 'edit', 'write']);

/** Whether plan mode refuses this call. MCP tools keep their own `readOnlyHint` policy. */
export function isPlanModeBlockedTool(toolName: string): boolean {
  if (PLAN_BLOCKED_EXACT.has(toolName)) return true;
  return (
    isApplyPatchToolName(toolName) ||
    isEditToolName(toolName) ||
    isWriteToolName(toolName) ||
    isShellToolName(toolName)
  );
}

export function planModeBlockReason(toolName: string): string {
  return `Plan mode is read-only, so "${toolName}" is blocked. Read the workspace and ask the user with ${ASK_USER_TOOL_NAME} instead; they leave Plan mode when they want changes made.`;
}

export const PLAN_MODE_GUIDELINES = [
  'Plan mode is on: this is a read-only conversation. Explore the workspace freely, but do not modify files or run commands that change anything — the write and shell tools are blocked.',
  `Ask before assuming. When the request is ambiguous, a trade-off matters, or a decision changes what you would build, call ${ASK_USER_TOOL_NAME} with one focused question and 2–3 concrete options.`,
  'Ask about intent, priorities, constraints, and choices the repository cannot answer; read the code instead of asking what it contains.',
  'When the direction is settled, summarize briefly: the goal, the steps, the files involved, and the risks. Then wait for the user to leave Plan mode before implementing.'
];

export function createPlanModeExtension(): InlineExtension {
  return {
    name: PLAN_MODE_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      const planModeActive = (entries: readonly SessionEntry[]) => readWorkMode(entries) === 'plan';

      // Read on every run: the mode is session state the user can switch at any time.
      pi.on('before_agent_start', (event, ctx) => {
        if (!planModeActive(ctx.sessionManager.getEntries() as unknown as SessionEntry[])) return;
        event.systemPromptOptions.promptGuidelines.push(...PLAN_MODE_GUIDELINES);
      });

      pi.on('tool_call', (event, ctx) => {
        if (!isPlanModeBlockedTool(event.toolName)) return;
        if (!planModeActive(ctx.sessionManager.getEntries() as unknown as SessionEntry[])) return;
        return { block: true, reason: planModeBlockReason(event.toolName) };
      });
    }
  };
}
