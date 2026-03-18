/**
 * The queue-defaults fields a client may write, validated once for the HTTP
 * route and for the orchestrator's tools. Everything else in the file stays
 * whatever the person wrote there.
 */
import { TASK_INSTRUCTIONS_MAX_LENGTH } from './defaults';
import { TaskInputError } from './queue';
import type { TaskConfig, TaskModelSelection } from './types';

export const TASK_CONFIG_COMMAND_MAX_LENGTH = 2_000;
export const TASK_CONFIG_COMMAND_MAX_COUNT = 20;

/** Milliseconds for a numeric field; `null` means "no limit". */
function timeoutMs(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TaskInputError(`${field} must be a positive number of milliseconds, or null`);
  }
  return Math.round(value);
}

function booleanField(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new TaskInputError(`${field} must be a boolean`);
  return value;
}

/** Standing instructions are free text; an empty string clears them. */
function instructionsField(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new TaskInputError(`${field} must be a string`);
  const instructions = value.replaceAll('\0', '').trim();
  if (instructions.length > TASK_INSTRUCTIONS_MAX_LENGTH) {
    throw new TaskInputError(`${field} is limited to ${TASK_INSTRUCTIONS_MAX_LENGTH} characters`);
  }
  return instructions;
}

function commandListField(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new TaskInputError(`${field} must be a list of strings`);
  }
  const commands = value.map((entry) => entry.trim()).filter(Boolean);
  if (commands.some((command) => command.length > TASK_CONFIG_COMMAND_MAX_LENGTH)) {
    throw new TaskInputError(
      `${field} entries are limited to ${TASK_CONFIG_COMMAND_MAX_LENGTH} characters`
    );
  }
  if (commands.length > TASK_CONFIG_COMMAND_MAX_COUNT) {
    throw new TaskInputError(`${field} is limited to ${TASK_CONFIG_COMMAND_MAX_COUNT} entries`);
  }
  return commands;
}

function modelField(value: unknown): TaskModelSelection | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TaskInputError('model must be { provider, modelId } or null');
  }
  const record = value as Record<string, unknown>;
  const provider = typeof record.provider === 'string' ? record.provider.trim() : '';
  const modelId = typeof record.modelId === 'string' ? record.modelId.trim() : '';
  if (!provider || !modelId) {
    throw new TaskInputError('model needs both a provider and a modelId');
  }
  return { provider, modelId };
}

/**
 * Normalize a patch. An unknown field is ignored rather than refused, because a
 * newer tool describing a field this build does not know must not fail; a patch
 * with nothing recognizable is an error, so a typo cannot look like success.
 */
export function parseTaskConfigPatch(body: Record<string, unknown>): Partial<TaskConfig> {
  const patch: Partial<TaskConfig> = {};
  if ('model' in body) patch.model = modelField(body.model);
  if ('verifyCommands' in body) {
    patch.verifyCommands = commandListField(body.verifyCommands, 'verifyCommands');
  }
  if ('verifyTimeoutMs' in body) {
    patch.verifyTimeoutMs = timeoutMs(body.verifyTimeoutMs, 'verifyTimeoutMs');
  }
  if ('taskTimeoutMs' in body) {
    patch.taskTimeoutMs = timeoutMs(body.taskTimeoutMs, 'taskTimeoutMs');
  }
  if ('autonomous' in body) {
    patch.autonomous = booleanField(body.autonomous, 'autonomous');
  }
  if ('instructions' in body) {
    patch.instructions = instructionsField(body.instructions, 'instructions');
  }
  if (Object.keys(patch).length === 0) {
    throw new TaskInputError('No queue default to change');
  }
  return patch;
}
