import { defineTool, type InlineExtension } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { ASK_USER_TOOL_NAME } from './ask-user-extension';
import {
  PLAN_ENTRY_TYPE,
  PLAN_TOOL_NAME,
  ensurePlanFile,
  planEntryData,
  readPlanEntry,
  readPlanForSession,
  renderPlanContext,
  renderPlanSection,
  writePlanFile
} from './plan-file';
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
  if (toolName === PLAN_TOOL_NAME) return false;
  if (PLAN_BLOCKED_EXACT.has(toolName)) return true;
  return (
    isApplyPatchToolName(toolName) ||
    isEditToolName(toolName) ||
    isWriteToolName(toolName) ||
    isShellToolName(toolName)
  );
}

export function planModeBlockReason(toolName: string): string {
  return `Plan mode is read-only for the project, so "${toolName}" is blocked. Read the workspace and ask the user with ${ASK_USER_TOOL_NAME}; record the plan with ${PLAN_TOOL_NAME}. They leave Plan mode when they want changes made.`;
}

export const PLAN_MODE_GUIDELINES = [
  'Plan mode is on: the project is read-only. Explore the workspace freely, but do not modify project files or run commands that change anything — the write and shell tools are blocked.',
  `Write the plan with ${PLAN_TOOL_NAME}. The plan file is the deliverable and the source of truth; it lives outside the conversation, so context compaction cannot remove it.`,
  `Ask before assuming. When the request is ambiguous, a trade-off matters, or a decision changes what you would build, call ${ASK_USER_TOOL_NAME} with one focused question and 2–3 concrete options.`,
  'Ask about intent, priorities, constraints, and choices the repository cannot answer; read the code instead of asking what it contains.',
  'Before ending a planning turn, call update_plan with a self-contained plan: goal, constraints, ordered steps, files, verification, and risks. Use Status: draft while exploring, ready when the plan is complete, in-progress after the user approves, and done after verification.',
  'If the conversation was compacted or the plan is no longer in context, read the plan file before continuing. Do not reconstruct the plan from the summary.'
];

export function createPlanModeExtension(options: { agentDir: string }): InlineExtension {
  return {
    name: PLAN_MODE_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      // Set when compaction finishes. The next request receives an explicit reminder
      // that the plan file, not the compacted transcript, is authoritative.
      let planCompacted = false;

      const entries = (ctx: { sessionManager: { getEntries: () => unknown[] } }) =>
        ctx.sessionManager.getEntries() as unknown as SessionEntry[];

      const ensure = (ctx: {
        sessionManager: {
          getEntries: () => unknown[];
          getSessionId: () => string;
        };
      }) =>
        ensurePlanFile({
          agentDir: options.agentDir,
          sessionId: ctx.sessionManager.getSessionId(),
          entries: entries(ctx),
          appendEntry: (data) => pi.appendEntry(PLAN_ENTRY_TYPE, data)
        });

      pi.registerTool(
        defineTool({
          name: PLAN_TOOL_NAME,
          label: 'Update plan',
          description:
            "Write the session's durable Markdown plan file. The full content replaces the current file. The plan file lives outside the conversation and survives context compaction.",
          promptSnippet: "Write the session's durable plan file",
          promptGuidelines: [
            'Write a self-contained plan: goal, constraints, ordered steps, files, verification, and risks. Use Status: draft while exploring, ready when complete, in-progress after approval, and done after verification.',
            'Pass baseRevision from the injected plan context when replacing an existing plan; the tool refuses a write if the file changed first.'
          ],
          exposure: 'direct',
          defaultActive: false,
          // A plan is one document; concurrent replacements would interleave.
          executionMode: 'sequential',
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false
          },
          parameters: Type.Object({
            content: Type.String({
              description: 'The full Markdown plan. This replaces the current plan file.'
            }),
            baseRevision: Type.Optional(
              Type.String({
                description:
                  'The revision shown in the injected plan context. If it no longer matches, the write is refused.'
              })
            )
          }),
          async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const sessionId = ctx.sessionManager.getSessionId();
            const snapshot = writePlanFile(
              options.agentDir,
              sessionId,
              params.content,
              params.baseRevision
            );
            pi.appendEntry(PLAN_ENTRY_TYPE, planEntryData(snapshot));
            const text = [
              `Plan written to ${snapshot.path}.`,
              `Title: ${snapshot.title}`,
              `Status: ${snapshot.status}`,
              `Revision: ${snapshot.revision ? snapshot.revision.slice(0, 12) : 'unavailable'}`,
              `Bytes: ${snapshot.bytes}`,
              'This file is authoritative and survives context compaction. Pass baseRevision when replacing it again.',
              '',
              'Outline:',
              snapshot.outline
            ].join('\n');
            return {
              content: [{ type: 'text' as const, text }],
              details: {
                path: snapshot.path,
                title: snapshot.title,
                status: snapshot.status,
                revision: snapshot.revision,
                bytes: snapshot.bytes,
                outline: snapshot.outline,
                truncated: snapshot.truncated
              }
            };
          }
        })
      );

      pi.on('session_start', (_event, ctx) => {
        const current = entries(ctx);
        if (readWorkMode(current) === 'plan' || readPlanEntry(current)) {
          try {
            ensure(ctx);
          } catch (error) {
            console.warn('[pie] could not prepare the plan file:', error);
          }
        }
      });

      // Read on every run: the mode is session state the user can switch at any time.
      pi.on('before_agent_start', (event, ctx) => {
        const current = entries(ctx);
        const mode = readWorkMode(current);
        const systemPromptOptions = event.systemPromptOptions;

        let plan;
        if (mode === 'plan' || readPlanEntry(current)) {
          try {
            plan = ensure(ctx);
          } catch (error) {
            console.warn('[pie] could not read the plan file:', error);
          }
        }

        if (mode === 'plan') {
          systemPromptOptions.promptGuidelines.push(...PLAN_MODE_GUIDELINES);
          if (!systemPromptOptions.selectedTools.includes(PLAN_TOOL_NAME)) {
            systemPromptOptions.selectedTools.push(PLAN_TOOL_NAME);
          }
        }
        if (plan) {
          systemPromptOptions.sections['pie-plan'] = renderPlanSection(plan);
        }
      });

      // Request-local plan context. It is not a session entry, so compaction cannot
      // remove it; every request after a compaction reads the file again.
      pi.on('context', (event, ctx) => {
        const plan = readPlanForSession(
          options.agentDir,
          ctx.sessionManager.getSessionId(),
          entries(ctx)
        );
        if (!plan) return;
        const compacted = planCompacted;
        planCompacted = false;
        event.messages.push({
          role: 'custom',
          customType: 'pie-plan-context',
          content: [{ type: 'text', text: renderPlanContext(plan, compacted) }],
          display: false,
          timestamp: Date.now()
        });
      });

      pi.on('session_before_compact', () => {
        planCompacted = true;
      });
      pi.on('session_compact', () => {
        planCompacted = true;
      });

      pi.on('tool_call', (event, ctx) => {
        if (!isPlanModeBlockedTool(event.toolName)) return;
        if (readWorkMode(entries(ctx)) !== 'plan') return;
        return { block: true, reason: planModeBlockReason(event.toolName) };
      });
    }
  };
}
