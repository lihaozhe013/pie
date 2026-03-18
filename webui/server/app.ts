import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { security } from './middleware/security';
import { registerApiRoutes } from './routes';
import { registerStatic } from './static';

function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

/**
 * The whole HTTP surface: API routes, the built app, and the middleware that guards both.
 *
 * One process serves the browser app and the API for the web version and the desktop shell,
 * so the two never diverge.
 */
export function createApp(distDir: string): Hono {
  const app = new Hono();

  // Every JSON body over 1 KiB is compressed here instead of in each route, and this is
  // also what sets `Vary: Accept-Encoding`. SSE and range responses are left alone.
  app.use('*', compress());
  app.use('*', security());

  registerApiRoutes(app);
  registerStatic(app, distDir);

  app.notFound((context) =>
    isApiPath(context.req.path)
      ? context.json({ error: 'Not found' }, 404)
      : context.text('Not found', 404)
  );

  return app;
}
