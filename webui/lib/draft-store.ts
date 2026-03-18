import type { AttachedFile } from './attached-files';

export interface ChatDraft {
  value: string;
  /** Files the composer references by chip; absent while none are attached. */
  files?: AttachedFile[];
}

const drafts = new Map<string, ChatDraft>();

function cloneDraft(draft: ChatDraft): ChatDraft {
  const clone: ChatDraft = { value: draft.value };
  const files = (draft.files ?? []).map((file) => ({ ...file }));
  // An empty list is not stored, so a draft that carries no files keeps the
  // shape it had before chips existed.
  if (files.length > 0) clone.files = files;
  return clone;
}

function isEmptyDraft(draft: ChatDraft): boolean {
  return !draft.value && !draft.files?.length;
}

export function getDraft(key: string): ChatDraft | null {
  const draft = drafts.get(key);
  return draft ? cloneDraft(draft) : null;
}

export function setDraft(key: string, draft: ChatDraft): void {
  if (isEmptyDraft(draft)) {
    drafts.delete(key);
    return;
  }
  drafts.set(key, cloneDraft(draft));
}

export function clearDraft(key: string): void {
  drafts.delete(key);
}

export function mergeRestoredSubmissionText(submitted: string, current: string): string {
  if (!submitted.trim()) return current;
  if (!current.trim()) return submitted;
  return `${submitted}\n\n${current}`;
}

/**
 * The draft a rejected submission merges into. Chips stay what they were: only
 * the text comes back, and its `@path` mentions are plain text again.
 */
export function mergeRestoredSubmissionDraft(
  submittedText: string,
  currentText: string,
  currentFiles: AttachedFile[] = []
): ChatDraft {
  const restored: ChatDraft = {
    value: mergeRestoredSubmissionText(submittedText, currentText)
  };
  if (currentFiles.length > 0) restored.files = currentFiles.map((file) => ({ ...file }));
  return restored;
}

export function restoreDraftSubmission(key: string, text: string): ChatDraft {
  const current = getDraft(key) ?? { value: '' };
  const restored = mergeRestoredSubmissionDraft(text, current.value, current.files);
  setDraft(key, restored);
  return restored;
}

export function rekeyDraft(
  previousKey: string,
  nextKey: string,
  currentDraft?: ChatDraft
): ChatDraft | null {
  if (previousKey === nextKey) return currentDraft ? cloneDraft(currentDraft) : getDraft(nextKey);

  const storedPrevious = getDraft(previousKey);
  const previous =
    currentDraft && !isEmptyDraft(currentDraft)
      ? cloneDraft(currentDraft)
      : (storedPrevious ?? (currentDraft ? cloneDraft(currentDraft) : null));
  const next = getDraft(nextKey);
  clearDraft(previousKey);
  if (!previous) return next;

  const merged = next
    ? mergeRestoredSubmissionDraft(next.value, previous.value, previous.files)
    : previous;
  setDraft(nextKey, merged);
  return cloneDraft(merged);
}
