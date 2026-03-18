/**
 * The built-in queue defaults: client-safe, so the settings dialog can offer
 * "restore defaults" without reading the configuration file.
 */
import type { TaskConfig } from './types';

/** `null` runs without a watchdog: the first-install default is no time limit. */
export const DEFAULT_VERIFY_TIMEOUT_MS: number | null = null;
export const DEFAULT_TASK_TIMEOUT_MS: number | null = null;

/** Standing instructions are one prompt-sized block, not a second database. */
export const TASK_INSTRUCTIONS_MAX_LENGTH = 20_000;

export const TASK_CONFIG_DEFAULTS: TaskConfig = {
  model: null,
  verifyCommands: [],
  verifyTimeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
  taskTimeoutMs: DEFAULT_TASK_TIMEOUT_MS,
  autonomous: true,
  instructions: ''
};
