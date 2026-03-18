/**
 * A hidden extension that appends one labelled block to the session's system
 * prompt on every run. The task queue uses it for its standing instructions so
 * they travel with the SDK session instead of a launcher argument.
 */
import type { InlineExtension } from '@earendil-works/pi-coding-agent';

export const APPEND_SYSTEM_PROMPT_EXTENSION_NAME = 'pie-append-system-prompt';

export function createAppendSystemPromptExtension(text: string): InlineExtension {
  const block = text.trim();
  return {
    name: APPEND_SYSTEM_PROMPT_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      if (!block) return;
      pi.on('before_agent_start', (event) => {
        const existing = event.systemPromptOptions.appendSystemPrompt.trim();
        event.systemPromptOptions.appendSystemPrompt = existing
          ? `${existing}\n\n${block}`
          : block;
      });
    }
  };
}
