import { isToolPresetSelection, type ToolPresetSelection } from './tool-presets';

const STORAGE_KEY = 'pi-tool-preset';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Only an explicit pick from the tool dropdown is ever stored, so a missing value
 * means "never chose"; those sessions pin the full coding toolset, the
 * first-install default. A stored `custom:<id>` stays valid as a reference; a
 * preset deleted later resolves to the configured defaults where the selection
 * is applied.
 */
export function getPreferredToolPreset(
  storage: StorageLike | null = getBrowserStorage()
): ToolPresetSelection {
  if (!storage) return 'full';
  try {
    const value = storage.getItem(STORAGE_KEY);
    return isToolPresetSelection(value) ? value : 'full';
  } catch {
    return 'full';
  }
}

export function setPreferredToolPreset(
  preset: ToolPresetSelection,
  storage: StorageLike | null = getBrowserStorage()
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, preset);
  } catch {
    // Browser storage is best-effort.
  }
}
