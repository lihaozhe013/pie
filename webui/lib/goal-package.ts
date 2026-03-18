/**
 * Where the goal package comes from, and when Pie must not add its own.
 *
 * Pie ships `pi-better-goal` as a dependency and loads it as an extension
 * path, the same way a person's installed package is loaded, so goal support
 * works on a fresh install without a second setup step. The package still owns
 * everything about the goal; this module only finds the copy and keeps a second
 * goal package from running its loop beside it.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** The package Pie ships, loaded unless the person has chosen a goal package themselves. */
export const BUNDLED_GOAL_PACKAGE = 'pi-better-goal';

/** A configured package whose name says it provides goals: any of them owns the loop. */
const GOAL_PACKAGE_NAME = /goal/i;

let resolved: string | undefined | null = null;

/**
 * Resolve from wherever this module was loaded. The server bundle is one file, but the packager
 * installs the app's `node_modules` beside it, so the working directory is a fallback when a
 * loader has no `import.meta.url`.
 */
function resolveOptional(id: string): string | undefined {
  const requireFns: Array<() => NodeJS.Require> = [
    () => createRequire(import.meta.url),
    () => createRequire(__filename),
    () => createRequire(join(process.cwd(), 'pie.js'))
  ];
  for (const make of requireFns) {
    try {
      return make().resolve(id);
    } catch {
      /* try the next anchor */
    }
  }
  return undefined;
}

/**
 * The installed copy of the bundled package, or undefined when this build has
 * no such dependency (a trimmed deployment, for instance). Resolving its
 * `package.json` gives the package root, whose `pi.extensions` manifest the
 * loader then follows.
 */
export function bundledGoalExtensionPath(): string | undefined {
  if (resolved !== null) return resolved;
  const entry = resolveOptional(`${BUNDLED_GOAL_PACKAGE}/package.json`);
  resolved = entry ? dirname(entry) : undefined;
  return resolved;
}

/** Only the tests reset this; the installed location cannot change while the server runs. */
export function resetBundledGoalExtensionPath(): void {
  resolved = null;
}

/**
 * The package name a Pi package source points at: `npm:@scope/name@1.2.3`,
 * `git:github.com/owner/name@v1`, `https://…/name`, `./local-name` or a bare
 * name all reduce to `name`.
 */
export function packageNameOfSource(source: string): string | undefined {
  const spec = source
    .replace(/^(?:npm|git|https?):(?:\/\/)?/, '')
    .replace(/@[^/@]*$/, '')
    .replace(/[\\/]+$/, '');
  const name = (spec.split(/[\\/]/).pop() ?? '').replace(/\.git$/, '');
  return name || undefined;
}

interface SettingsLike {
  packages?: unknown;
}

function sourceOf(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined;
  const source = (entry as { source?: unknown }).source;
  return typeof source === 'string' ? source : undefined;
}

/**
 * The configured package that already provides goals, if there is one. Its
 * presence — not its location — is the signal: a project entry filtered to
 * `extensions: []` still means the person decided which package owns goals.
 */
export function goalPackageInSettings(
  ...settings: Array<SettingsLike | undefined>
): string | undefined {
  for (const value of settings) {
    const packages = value?.packages;
    if (!Array.isArray(packages)) continue;
    for (const entry of packages) {
      const source = sourceOf(entry);
      if (!source) continue;
      const name = packageNameOfSource(source);
      if (name && GOAL_PACKAGE_NAME.test(name)) return name;
    }
  }
  return undefined;
}

/**
 * The extension paths this session should add for goals: the bundled package,
 * or nothing when the person already configured a goal package of their own.
 */
export function goalExtensionPaths(...settings: Array<SettingsLike | undefined>): string[] {
  if (goalPackageInSettings(...settings)) return [];
  const path = bundledGoalExtensionPath();
  return path ? [path] : [];
}
