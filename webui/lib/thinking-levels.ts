import type { ThinkingLevel } from '@earendil-works/pi-agent-core';

/** Pi's reasoning levels, ascending cost. `auto` is a selector-only value. */
export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
];

/** Translation keys for the one-line meaning of each level. */
export const THINKING_LEVEL_LABEL_KEYS: Record<string, string> = {
  off: 'chat.thinkingOff',
  minimal: 'chat.thinkingMinimal',
  low: 'chat.thinkingLow',
  medium: 'chat.thinkingMedium',
  high: 'chat.thinkingHigh',
  xhigh: 'chat.thinkingXhigh',
  max: 'chat.thinkingMax'
};
