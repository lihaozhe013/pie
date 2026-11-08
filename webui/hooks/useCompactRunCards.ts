import { useSyncExternalStore } from 'react';

/**
 * Whether the Runs panel keeps active cards folded to their summary row.
 *
 * On is the default: an active run shows its tool, status, duration and command
 * preview in one compact card, and the user opens the command and output when
 * they want them. Completed runs already fold into history. Off restores the
 * previous behavior, where an active run's body opens as soon as it appears.
 */
export const COMPACT_RUN_CARDS_STORAGE_KEY = 'pi-compact-run-cards';
export const COMPACT_RUN_CARDS_DEFAULT = true;

function readStoredPreference(): boolean {
  try {
    const raw = window.localStorage.getItem(COMPACT_RUN_CARDS_STORAGE_KEY);
    return raw === null ? COMPACT_RUN_CARDS_DEFAULT : raw === 'true';
  } catch {
    return COMPACT_RUN_CARDS_DEFAULT;
  }
}

let compact: boolean | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): boolean {
  if (compact === null) compact = readStoredPreference();
  return compact;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab's change is a saved preference too: the panel follows it
  // without a reload, the way the other display preferences already do.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== COMPACT_RUN_CARDS_STORAGE_KEY) return;
    compact = readStoredPreference();
    listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function setCompactRunCards(next: boolean): void {
  compact = next;
  try {
    window.localStorage.setItem(COMPACT_RUN_CARDS_STORAGE_KEY, String(next));
  } catch {}
  listeners.forEach((listener) => listener());
}

export function useCompactRunCards(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => COMPACT_RUN_CARDS_DEFAULT);
}
