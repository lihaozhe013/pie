import { json } from '@/server/http';
import { stat } from 'fs/promises';
import { hasJsonContentType, isApiRequestAllowed } from '@/lib/request-security';
import {
  createDirectory,
  completeDirectory,
  getBrowseStartDirectory,
  getParentDirectory,
  listDirectories,
  listWindowsDrives,
  resolveDirectory,
  shouldShowWindowsDrivePicker
} from '@/lib/directory-browser';

// GET /api/cwd/browse?path=...：列出文件系统中的可读子目录。
export async function GET(request: Request) {
  try {
    const requested = new URL(request.url).searchParams.get('path')?.trim();

    if (new URL(request.url).searchParams.get('complete') === '1' && requested) {
      try {
        return json(await completeDirectory(requested));
      } catch (error) {
        const code =
          error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        const message =
          code === 'EACCES' || code === 'EPERM'
            ? 'Permission denied'
            : 'Directory does not exist or cannot be read';
        return json(
          { error: message },
          { status: code === 'EACCES' || code === 'EPERM' ? 403 : 404 }
        );
      }
    }

    if (shouldShowWindowsDrivePicker(requested)) {
      return json({
        path: '',
        parentPath: null,
        drives: await listWindowsDrives(),
        directories: []
      });
    }

    const candidate = getBrowseStartDirectory(requested);

    let resolved: string;
    try {
      resolved = await resolveDirectory(candidate);
    } catch {
      return json({ error: 'Directory does not exist' }, { status: 404 });
    }

    const directoryStat = await stat(resolved);
    if (!directoryStat.isDirectory()) {
      return json({ error: 'Path is not a directory' }, { status: 400 });
    }

    const directories = await listDirectories(resolved);

    return json({
      path: resolved,
      parentPath: getParentDirectory(resolved),
      directories
    });
  } catch (error) {
    return json({ error: String(error) }, { status: 500 });
  }
}

// POST /api/cwd/browse  body: { path: string, name: string }
// Creates one direct child of the currently browsed directory.
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return json({ error: 'Untrusted API request' }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return json({ error: 'Content-Type must be application/json' }, { status: 415 });
  }

  try {
    const body = (await request.json()) as { path?: unknown; name?: unknown };
    const parentPath = typeof body.path === 'string' ? body.path.trim() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';

    if (!parentPath) {
      return json({ error: 'Parent path is required' }, { status: 400 });
    }
    if (!name) {
      return json({ error: 'Directory name is required' }, { status: 400 });
    }

    const createdPath = await createDirectory(parentPath, name);
    return json({ success: true, path: createdPath });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code === 'EEXIST') {
      return json(
        { error: 'A file or directory with this name already exists' },
        { status: 409 }
      );
    }
    if (code === 'ENOENT') {
      return json({ error: 'Parent directory does not exist' }, { status: 404 });
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return json({ error: 'Permission denied' }, { status: 403 });
    }
    if (code === 'EINVAL' || code === 'ENAMETOOLONG') {
      return json({ error: 'Directory name is invalid' }, { status: 400 });
    }
    if (
      error instanceof Error &&
      (error.message === 'Directory name must be a single folder name' ||
        error.message === 'Parent path is not a directory')
    ) {
      return json({ error: error.message }, { status: 400 });
    }
    return json({ error: String(error) }, { status: 500 });
  }
}
