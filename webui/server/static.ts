import type { Context, Hono } from 'hono';
import { getMimeType } from 'hono/utils/mime';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import { Readable } from 'node:stream';
import { webManifest } from '@/lib/web-manifest';

/** Hashed bundle names never change contents, so they can be cached for a year. */
const IMMUTABLE = 'public, max-age=31536000, immutable';
/** The service worker, the manifest, and the offline page must be revalidated on every load. */
const REVALIDATE = 'public, max-age=0, must-revalidate';
/** The app shell must never be reused from cache: it names the current bundle. */
const SHELL = 'private, no-cache, max-age=0, must-revalidate';

/** A request path that names a file inside the bundle, or null when it cannot. */
function bundleFile(distDir: string, path: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const relativePath = normalize(decoded)
    .replace(/^[/\\]+/, '')
    .split(sep)
    .join('/');
  if (relativePath.split('/').some((segment) => segment === '..' || segment === '.')) return null;
  const file = join(distDir, relativePath);
  // A directory name is not a file: `/assets` must fall through to the shell rule, not open a
  // stream that errors on a directory handle.
  return existsSync(file) && statSync(file).isFile() ? relativePath : null;
}

function fileResponse(distDir: string, relativePath: string): Response {
  const file = join(distDir, relativePath);
  const stats = statSync(file);
  const headers: Record<string, string> = {
    'Content-Type': getMimeType(file) ?? 'application/octet-stream',
    'Content-Length': String(stats.size),
    'Last-Modified': stats.mtime.toUTCString(),
    'Cache-Control': relativePath.startsWith('assets/') ? IMMUTABLE : REVALIDATE
  };
  if (relativePath === 'sw.js') {
    // The service worker's scope is the whole origin, not just its own directory.
    headers['Service-Worker-Allowed'] = '/';
  }
  return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { headers });
}

/**
 * Serve the built single-page app.
 *
 * Only the app shell and the files the bundle actually contains are answers; a client route such
 * as `/login` falls back to the shell so a reload still boots the app. A missing file keeps the
 * shell only when it has no extension, because an absent asset is a build error, not a route.
 */
export function registerStatic(app: Hono, distDir: string): void {
  const shell = (context: Context) => {
    let html: string;
    try {
      html = readFileSync(join(distDir, 'index.html'), 'utf8');
    } catch {
      return context.text('The Pie interface is not built. Run `bun run build`.', 503);
    }
    return context.html(html, 200, { 'Cache-Control': SHELL });
  };

  app.get('/', shell);
  app.get('/login', shell);

  // Built per request: `PIE_APP_NAME` is a launch setting, not a build setting.
  app.get('/manifest.webmanifest', (context) =>
    context.body(JSON.stringify(webManifest()), 200, {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': REVALIDATE
    })
  );

  app.get('/*', (context) => {
    const file = bundleFile(distDir, context.req.path);
    if (file) return fileResponse(distDir, file);
    const name = context.req.path.slice(context.req.path.lastIndexOf('/') + 1);
    if (name.includes('.')) return context.text('Not found', 404);
    return shell(context);
  });
}
