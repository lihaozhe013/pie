import { useSyncExternalStore } from 'react';
import type { TranscriptToolDisplay } from '@/lib/quiet-activity';

/**
 * How much of a run the conversation transcript shows.
 *
 * `conversation` is the default: the transcript carries the user's messages and
 * the agent's replies, and every call belongs to the Runs panel.
 * `cards` keeps writes, edits, and patches as transcript cards instead.
 */
export type { TranscriptToolDisplay };

export const TRANSCRIPT_MODE_STORAGE_KEY = 'pi-transcript-mode';
export const TRANSCRIPT_MODE_DEFAULT: TranscriptToolDisplay = 'conversation';

function readStoredMode(): TranscriptToolDisplay {
  try {
    const raw = window.localStorage.getItem(TRANSCRIPT_MODE_STORAGE_KEY);
    return raw === 'cards' ? 'cards' : TRANSCRIPT_MODE_DEFAULT;
  } catch {
    return TRANSCRIPT_MODE_DEFAULT;
  }
}

let mode: TranscriptToolDisplay | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): TranscriptToolDisplay {
  if (mode === null) mode = readStoredMode();
  return mode;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab's change is a saved preference too: the transcript follows it
  // without a reload, the way the font preferences already do.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== TRANSCRIPT_MODE_STORAGE_KEY) return;
    mode = readStoredMode();
    listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function setTranscriptToolDisplay(next: TranscriptToolDisplay): void {
  mode = next;
  try {
    window.localStorage.setItem(TRANSCRIPT_MODE_STORAGE_KEY, next);
  } catch {}
  listeners.forEach((listener) => listener());
}

export function useTranscriptToolDisplay(): TranscriptToolDisplay {
  return useSyncExternalStore(subscribe, getSnapshot, () => TRANSCRIPT_MODE_DEFAULT);
}
