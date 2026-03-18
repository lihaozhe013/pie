import type { InlineExtension } from '@earendil-works/pi-coding-agent';

export const EXACT_SYSTEM_PROMPT_EXTENSION_NAME = 'pie-exact-system-prompt';

export function createExactSystemPromptExtension(
  getPrompt: () => string | undefined
): InlineExtension {
  return {
    name: EXACT_SYSTEM_PROMPT_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      pi.on('before_agent_start', () => {
        const systemPrompt = getPrompt();
        return systemPrompt === undefined ? undefined : { systemPrompt };
      });
    }
  };
}
