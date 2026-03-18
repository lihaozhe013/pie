import { mkdir, readdir, realpath, stat } from 'fs/promises';
import { homedir } from 'os';
import path from 'path';

export interface BrowsableDirectory {
  name: string;
  path: string;
}

export function shouldShowWindowsDrivePicker(
  directory?: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === 'win32' && !directory;
}

export function getBrowseStartDirectory(directory?: string): string {
  return directory || homedir();
}

export function getWindowsDriveCandidates(): BrowsableDirectory[] {
  return 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((letter) => ({
    name: `${letter}:`,
    path: `${letter}:\\`
  }));
}

export async function listWindowsDrives(): Promise<BrowsableDirectory[]> {
  const candidates = await Promise.all(
    getWindowsDriveCandidates().map(async (drive) => {
      try {
        const driveStat = await stat(drive.path);
        return driveStat.isDirectory() ? drive : null;
      } catch {
        return null;
      }
    })
  );

  return candidates.filter((drive): drive is BrowsableDirectory => drive !== null);
}

export function normalizeDirectory(directory: string): string {
  if (directory === '~') return homedir();
  if (directory.startsWith('~/') || (process.platform === 'win32' && directory.startsWith('~\\')))
    return path.resolve(homedir(), directory.slice(2));
  return path.resolve(directory);
}

export function getParentDirectory(directory: string): string | null {
  const pathApi =
    /^[a-zA-Z]:[\\/]/.test(directory) || directory.startsWith('\\\\') ? path.win32 : path.posix;
  const normalized = pathApi.normalize(directory);
  const parent = pathApi.dirname(normalized);
  return parent === normalized ? null : parent;
}

export async function resolveDirectory(directory: string): Promise<string> {
  return realpath(normalizeDirectory(directory));
}

export function isValidDirectoryName(name: string): boolean {
  return Boolean(name) && name !== '.' && name !== '..' && !/[\\/\0]/.test(name);
}

export async function createDirectory(parentDirectory: string, name: string): Promise<string> {
  const directoryName = name.trim();
  if (!isValidDirectoryName(directoryName)) {
    throw new Error('Directory name must be a single folder name');
  }

  const resolvedParent = await resolveDirectory(parentDirectory);
  const parentStat = await stat(resolvedParent);
  if (!parentStat.isDirectory()) throw new Error('Parent path is not a directory');

  const createdPath = path.join(resolvedParent, directoryName);
  await mkdir(createdPath);
  return realpath(createdPath);
}

export async function completeDirectory(input: string): Promise<{
  path: string | null;
  parentPath: string | null;
  directories: BrowsableDirectory[];
}> {
  const normalized = normalizeDirectory(input);
  let resolved: string | undefined;
  try {
    resolved = await realpath(normalized);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
  }
  if (resolved && (await stat(resolved)).isDirectory()) {
    return {
      path: resolved,
      parentPath: getParentDirectory(resolved),
      directories: await listDirectories(resolved)
    };
  }
  const parent = await realpath(path.dirname(normalized));
  const prefix = path.basename(normalized).toLocaleLowerCase();
  const directories = (await listDirectories(parent)).filter((entry) =>
    entry.name.toLocaleLowerCase().startsWith(prefix)
  );
  return { path: null, parentPath: parent, directories };
}

export async function listDirectories(directory: string): Promise<BrowsableDirectory[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  // 忽略损坏、不可访问或不指向目录的符号链接。
  const candidates = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory()) {
        return { name: entry.name, path: path.join(directory, entry.name) };
      }
      if (!entry.isSymbolicLink()) return null;

      try {
        const entryPath = path.join(directory, entry.name);
        const realEntryPath = await realpath(entryPath);
        const entryStat = await stat(realEntryPath);
        if (!entryStat.isDirectory()) return null;
        return { name: entry.name, path: entryPath };
      } catch {
        return null;
      }
    })
  );

  return candidates
    .filter((entry): entry is BrowsableDirectory => entry !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}
