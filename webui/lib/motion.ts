/**
 * The user asked for less motion: nothing moves, every change is instant.
 * Shared by the sidebar's fold (hooks/useSidebarMotion.ts) and the transcript's
 * tool cards (hooks/useToolCardMotion.ts).
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}
