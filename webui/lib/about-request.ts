/**
 * The desktop shell's way into About.
 *
 * The macOS app menu's About item cannot click the sidebar's wordmark, so the
 * shell dispatches this DOM event in the page instead (src-tauri/src/menu.rs
 * evaluates it) and the interface opens the same About dialog the wordmark
 * opens. One-way only: the page still has no way to call back into Rust.
 *
 * Client-safe: the event target is passed in, so tests use a stand-in.
 */

/** The DOM event the shell dispatches. Keep in sync with `SHOW_ABOUT_SCRIPT`. */
export const SHOW_ABOUT_EVENT = 'pie:show-about';

/** The part of `window` this listens on. */
export interface ShowAboutTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** Opens About when the shell asks for it; returns the cleanup. */
export function listenForShowAbout(target: ShowAboutTarget, onShow: () => void): () => void {
  target.addEventListener(SHOW_ABOUT_EVENT, onShow);
  return () => target.removeEventListener(SHOW_ABOUT_EVENT, onShow);
}
