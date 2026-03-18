/**
 * A task's title is a short label derived from the text that asks for the work.
 * The board no longer asks for a separate title, so the first non-empty line of
 * the description becomes the title; an explicit title from the task_manager
 * tool or an older row still wins.
 */
export const TASK_TITLE_MAX_LENGTH = 200;

/** The first non-empty line of a description, clipped to a row-sized label. */
export function taskTitleFromDescription(
  description: string | null | undefined
): string {
  if (typeof description !== 'string') return '';
  const firstLine = description.split(/\r?\n/).find((line) => line.trim().length > 0);
  return (firstLine ?? description).trim().slice(0, TASK_TITLE_MAX_LENGTH).trim();
}
