/**
 * Build metadata shown in the interface.
 *
 * Vite `define`s these `process.env` reads with the values it knows at build time, so the
 * bundle carries the version, the commit, and the Pi release of the build it came from. A Node
 * test sets the same environment variables and reads them unchanged.
 */
export const BUILD_VERSION = process.env.VITE_APP_VERSION ?? '0.0.0';
export const BUILD_COMMIT = process.env.VITE_APP_COMMIT ?? 'unknown';
export const BUILD_PI_VERSION = process.env.VITE_PI_VERSION ?? '0.0.0';

/**
 * The desktop shell renders the same app in a system webview, where a service worker caches by
 * origin, outlives a port change, and can serve a stale shell after an update.
 */
export const IS_DESKTOP_SHELL = process.env.VITE_PIE_DESKTOP === '1';
