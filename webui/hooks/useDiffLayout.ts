import { useSyncExternalStore } from 'react';

/**
 * Whether a tool card's diff draws old and new in two columns.
 *
 * Off (the default) draws every change inline: a removed line above the line
 * that replaces it, one column that a narrow card fits and reads well. On
 * draws the two columns side by side. A phone never gets two columns — its
 * card has no room for them — whatever this says.
 */
export const DIFF_SIDE_BY_SIDE_STORAGE_KEY = 'pi-diff-side-by-side';
export const DIFF_SIDE_BY_SIDE_DEFAULT = false;

function readStoredPreference(): boolean {
  try {
    return window.localStorage.getItem(DIFF_SIDE_BY_SIDE_STORAGE_KEY) === 'true';
  } catch {
    return DIFF_SIDE_BY_SIDE_DEFAULT;
  }
}

let sideBySide: boolean | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): boolean {
  if (sideBySide === null) sideBySide = readStoredPreference();
  return sideBySide;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab's change is a saved preference too: the diffs follow it
  // without a reload, the way the transcript mode already does.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== DIFF_SIDE_BY_SIDE_STORAGE_KEY) return;
    sideBySide = readStoredPreference();
    listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function setDiffSideBySide(next: boolean): void {
  sideBySide = next;
  try {
    window.localStorage.setItem(DIFF_SIDE_BY_SIDE_STORAGE_KEY, String(next));
  } catch {}
  listeners.forEach((listener) => listener());
}

export function useDiffSideBySide(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => DIFF_SIDE_BY_SIDE_DEFAULT);
}
