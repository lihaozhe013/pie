import type { Context, Handler } from 'hono';
import type { RouteContext, RouteHandler, RouteParams } from './http';

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The path parameters handed to a route, in the shape the handlers were written against:
 * named captures as strings, and the rest of a wildcard route as decoded `path` segments.
 */
function routeParams(context: Context): RouteParams {
  const params: RouteParams = { ...context.req.param() };
  const rest = params['*'];
  delete params['*'];
  if (typeof rest === 'string') {
    params.path = rest.split('/').filter(Boolean).map(decodeSegment);
  }
  return params;
}

/**
 * Register a route handler as a Hono handler.
 *
 * The handler still receives a Web `Request` and its own `context`, so a test calls it
 * directly and this adapter stays the only place that knows about the router.
 */
export function toHono<T extends RouteContext>(
  handler: (request: Request, context: T) => Response | Promise<Response>
): Handler {
  // The cast only bridges the handler's narrower `params` type; the adapter supplies exactly
  // the names its route pattern declares.
  const route = handler as RouteHandler;
  return (context) => route(context.req.raw, { params: Promise.resolve(routeParams(context)) });
}
