// The version, commit, and Pi release a build reports in Settings -> About, and the desktop
// flag that disables the service worker inside the Tauri shell.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The short commit this build came from, shown as the app version's build metadata
 * (`0.1.0+1c02256`). A portable build runs in a copy without `.git`, so packaging forwards the
 * commit as `PIE_COMMIT`; outside a Git checkout the commit is "unknown".
 */
function readCommit() {
  const provided = process.env.PIE_COMMIT ?? process.env.GIT_COMMIT;
  if (provided?.trim()) return provided.trim().slice(0, 7);
  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return 'unknown';
  }
}

export function readBuildInfo() {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  let piVersion = 'unknown';
  try {
    const piPackage = join(root, 'node_modules/@earendil-works/pi-coding-agent/package.json');
    piVersion = JSON.parse(readFileSync(piPackage, 'utf8')).version;
  } catch {
    /* package not found, use default */
  }
  return { version, piVersion, commit: readCommit() };
}

/** The `define` entries that inline the build's identity into the client bundle. */
export function buildInfoDefine() {
  const { version, piVersion, commit } = readBuildInfo();
  return {
    'process.env.VITE_APP_VERSION': JSON.stringify(version),
    'process.env.VITE_APP_COMMIT': JSON.stringify(commit),
    'process.env.VITE_PI_VERSION': JSON.stringify(piVersion),
    'process.env.VITE_PIE_DESKTOP': JSON.stringify(process.env.VITE_PIE_DESKTOP ?? '')
  };
}
