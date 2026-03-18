/**
 * The HTTP shape the route handlers speak: a Web `Request` in, a Web `Response` out.
 *
 * A handler stays an ordinary function that takes a `Request` and returns a `Response`, so
 * `server/hono-route.ts` is the only module that knows about the server framework.
 */

/** Path parameters, in the form the handlers already expect: a name, or the segments of a
 * rest route such as `/api/files/[...path]`. */
export type RouteParams = Record<string, string | string[]>;

export interface RouteContext {
  params: Promise<RouteParams>;
}

export type RouteHandler = (
  request: Request,
  context: RouteContext
) => Response | Promise<Response>;

/**
 * A JSON response with no per-response compression. The `compress()` middleware compresses
 * every compressible body over 1 KiB and sets `Vary: Accept-Encoding`, which is one place
 * instead of one call site per route.
 */
export function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}
