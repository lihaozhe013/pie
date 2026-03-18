/**
 * Queue defaults, read from `<agentDir>/pie-task-orchestrator.json`.
 *
 * Every field is optional. The file is written by the app or edited by the
 * person, never by a task, so the values are trusted configuration rather than
 * an input-validation boundary. Verification commands are the only field a
 * single task may override; the autonomous switch is global on purpose.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '../session-reader';
import {
  DEFAULT_TASK_TIMEOUT_MS,
  DEFAULT_VERIFY_TIMEOUT_MS,
  TASK_CONFIG_DEFAULTS,
  TASK_INSTRUCTIONS_MAX_LENGTH
} from './defaults';
import type { TaskConfig, TaskModelSelection } from './types';

export const TASK_CONFIG_FILE = 'pie-task-orchestrator.json';

export const DEFAULT_TASK_CONFIG: TaskConfig = TASK_CONFIG_DEFAULTS;

export function taskConfigPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, TASK_CONFIG_FILE);
}

/**
 * A timeout is a positive number of milliseconds, or `null` for "no limit".
 * A missing or malformed value falls back to the default, which is itself
 * "no limit" on a first install.
 */
function timeoutOrNull(value: unknown, fallback: number | null): number | null {
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : fallback;
}

function commandList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const commands = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return commands;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Free-form standing instructions; malformed values fall back to none. The text
 * travels in one system-prompt block, so a manual edit is clamped rather than
 * allowed to grow without bound.
 */
function instructions(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_TASK_CONFIG.instructions;
  return value.replaceAll('\0', '').trim().slice(0, TASK_INSTRUCTIONS_MAX_LENGTH);
}

/** A model is a provider and an id, both non-empty; anything else means "default". */
function modelSelection(value: unknown): TaskModelSelection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const provider = typeof record.provider === 'string' ? record.provider.trim() : '';
  const modelId = typeof record.modelId === 'string' ? record.modelId.trim() : '';
  return provider && modelId ? { provider, modelId } : null;
}

/**
 * Normalize a parsed configuration object. Unknown fields are dropped and a
 * malformed field falls back to its default instead of failing the queue.
 */
export function normalizeTaskConfig(raw: unknown): TaskConfig {
  const record =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    model: modelSelection(record.model),
    verifyCommands: commandList(record.verifyCommands, DEFAULT_TASK_CONFIG.verifyCommands),
    verifyTimeoutMs: timeoutOrNull(record.verifyTimeoutMs, DEFAULT_VERIFY_TIMEOUT_MS),
    taskTimeoutMs: timeoutOrNull(record.taskTimeoutMs, DEFAULT_TASK_TIMEOUT_MS),
    autonomous: boolean(record.autonomous, DEFAULT_TASK_CONFIG.autonomous),
    instructions: instructions(record.instructions)
  };
}

/**
 * Apply a patch and write the normalized configuration. Only the app's own
 * fields are written: the file is queue defaults, not a scratch pad.
 */
export function writeTaskConfig(
  patch: Partial<TaskConfig>,
  agentDir: string = getAgentDir()
): TaskConfig {
  const next = normalizeTaskConfig({ ...readTaskConfig(agentDir), ...patch });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(taskConfigPath(agentDir), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

export function readTaskConfig(agentDir: string = getAgentDir()): TaskConfig {
  const path = taskConfigPath(agentDir);
  if (!existsSync(path)) return { ...DEFAULT_TASK_CONFIG };
  try {
    return normalizeTaskConfig(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    // An unreadable configuration must not stop the queue: defaults apply.
    return { ...DEFAULT_TASK_CONFIG };
  }
}

/** One digest line naming what a write changed, without quoting the values. */
export function configChangeSummary(before: TaskConfig, after: TaskConfig): string {
  const fields: string[] = [];
  if (before.model?.provider !== after.model?.provider || before.model?.modelId !== after.model?.modelId) {
    fields.push('model');
  }
  if (before.verifyCommands.join('\n') !== after.verifyCommands.join('\n')) {
    fields.push('verification commands');
  }
  if (before.verifyTimeoutMs !== after.verifyTimeoutMs) fields.push('verification timeout');
  if (before.taskTimeoutMs !== after.taskTimeoutMs) fields.push('task timeout');
  if (before.autonomous !== after.autonomous) fields.push('autonomous mode');
  if (before.instructions !== after.instructions) fields.push('instructions');
  return fields.length > 0
    ? `queue defaults changed: ${fields.join(', ')}`
    : 'queue defaults written with no change';
}

/** The effective policy of one task: its override, else the queue default. */
export function resolveTaskPolicy(
  config: TaskConfig,
  task: {
    verifyCommands: string[] | null;
  }
): TaskConfig {
  return {
    ...config,
    verifyCommands: task.verifyCommands ?? config.verifyCommands
  };
}
