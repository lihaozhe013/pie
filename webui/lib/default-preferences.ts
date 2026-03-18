import { join } from 'path';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { getAgentDir, type SettingsManager } from '@earendil-works/pi-coding-agent';
import { displaySettingsPath } from './enabled-models-runtime';
import { getGlobalSettingsPath, updateGlobalSettings } from './global-settings-file';
import { THINKING_LEVELS } from './thinking-levels';

const VALID_THINKING_LEVELS = new Set<ThinkingLevel>(THINKING_LEVELS);

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && VALID_THINKING_LEVELS.has(value as ThinkingLevel);
}

/** What the model and reasoning selectors' "save as default" action writes. */
export interface DefaultPreferencesEdit {
  model?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
  /** Drop `defaultThinkingLevel` so new chats use pi's own level for the model. */
  clearThinkingLevel?: boolean;
}

/**
 * Project settings keys that would hide this edit.
 *
 * `SettingsManager` only ever writes the global file, and a project
 * `.pi/settings.json` value wins over it, so writing a default the project
 * overrides would report success while new chats kept starting with the
 * project's choice. The route refuses instead and names the file.
 */
export function shadowingProjectKeys(
  settingsManager: SettingsManager,
  edit: DefaultPreferencesEdit
): string[] {
  const project = settingsManager.getProjectSettings();
  const keys: string[] = [];
  if (edit.model) {
    if (project.defaultProvider !== undefined) keys.push('defaultProvider');
    if (project.defaultModel !== undefined) keys.push('defaultModel');
  }
  if ((edit.thinkingLevel || edit.clearThinkingLevel) && project.defaultThinkingLevel !== undefined)
    keys.push('defaultThinkingLevel');
  return keys;
}

export function projectSettingsPath(cwd: string): string {
  return displaySettingsPath(join(cwd, '.pi', 'settings.json'));
}

/** A per-model reasoning level, which applies when a chat switches to that model. */
export interface ModelThinkingLevelEdit {
  provider: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
  /** Drop the model's entry so it follows the global default again. */
  clear?: boolean;
}

/**
 * The project entry that would hide this model's global reasoning default.
 *
 * `modelThinkingLevels` merges per key, so only a project entry for the same
 * model shadows the global one; other models' project entries do not.
 */
export function shadowingProjectModelThinkingLevel(
  settingsManager: SettingsManager,
  provider: string,
  modelId: string
): string | undefined {
  return settingsManager.getProjectSettings().modelThinkingLevels?.[`${provider}/${modelId}`];
}

/**
 * Persist a model's default reasoning level in the global settings file.
 *
 * Like `writeDefaultPreferences`, this drains `SettingsManager`'s storage
 * errors: a level that did not reach disk must not report success.
 */
export async function writeModelThinkingLevel(
  settingsManager: SettingsManager,
  edit: ModelThinkingLevelEdit
): Promise<void> {
  const loadErrors = settingsManager.drainErrors();
  const globalLoadError = loadErrors.find((entry) => entry.scope === 'global');
  if (globalLoadError) throw globalLoadError.error;
  if (edit.clear) {
    if (settingsManager.getModelThinkingLevel(edit.provider, edit.modelId) !== undefined)
      settingsManager.removeModelThinkingLevel(edit.provider, edit.modelId);
  } else if (edit.thinkingLevel) {
    settingsManager.setModelThinkingLevel(edit.provider, edit.modelId, edit.thinkingLevel);
  }
  await settingsManager.flush();
  const errors = settingsManager.drainErrors();
  if (errors.length > 0) throw errors[0].error;
}

/**
 * Persist the global defaults new sessions start with, like the TUI's Ctrl+S
 * in `/model` and `/thinking`.
 *
 * `SettingsManager` skips the write when it could not load the settings file
 * and collects storage failures instead of throwing, so the queue is drained
 * here: a default that did not reach disk must not report success.
 */
export async function writeDefaultPreferences(
  settingsManager: SettingsManager,
  edit: DefaultPreferencesEdit,
  agentDir = getAgentDir()
): Promise<void> {
  const loadErrors = settingsManager.drainErrors();
  const globalLoadError = loadErrors.find((entry) => entry.scope === 'global');
  if (globalLoadError) throw globalLoadError.error;
  if (edit.model)
    settingsManager.setDefaultModelAndProvider(edit.model.provider, edit.model.modelId);
  if (edit.thinkingLevel) settingsManager.setDefaultThinkingLevel(edit.thinkingLevel);
  await settingsManager.flush();
  const errors = settingsManager.drainErrors();
  if (errors.length > 0) throw errors[0].error;
  // SettingsManager has no setter that removes a key, so the clear is a locked
  // file edit on the same path it writes; the instance is dropped afterwards.
  if (edit.clearThinkingLevel) {
    await updateGlobalSettings(getGlobalSettingsPath(agentDir), (settings) => {
      delete settings.defaultThinkingLevel;
    });
  }
}
