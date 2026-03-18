/**
 * The version strings the interface shows. The package version stays at the
 * hand-maintained 0.1.0 for personal use; the short commit appended as SemVer
 * build metadata (`0.1.0+1c02256`) tells one build from another.
 */

/** The version shown when the build provided none. */
export const FALLBACK_VERSION = '0.0.0';
/** The commit shown when the build came from outside a Git checkout. */
export const UNKNOWN_COMMIT = 'unknown';
/** How many commit characters the version carries. */
export const COMMIT_LENGTH = 7;

/** The first {@link COMMIT_LENGTH} characters of `commit`, or "unknown". */
export function shortCommit(commit: string | null | undefined): string {
  const trimmed = commit?.trim();
  return trimmed ? trimmed.slice(0, COMMIT_LENGTH) : UNKNOWN_COMMIT;
}

/**
 * `version` with the short commit as build metadata: `0.1.0+1c02256`. A build
 * made outside a Git checkout keeps the bare version.
 */
export function formatAppVersion(
  version: string | null | undefined,
  commit: string | null | undefined
): string {
  const base = version?.trim() || FALLBACK_VERSION;
  const hash = shortCommit(commit);
  return hash === UNKNOWN_COMMIT ? base : `${base}+${hash}`;
}
