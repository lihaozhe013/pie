import type { MiddlewareHandler } from 'hono';
import { getAuthRetryAfterMs, recordAuthFailure, retryAfterSeconds } from '@/lib/auth-throttle';
import { isApiRequestAllowed, isApiRequestHostAllowed } from '@/lib/request-security';
import {
  isValidBasicAuthorization,
  isValidWebSessionToken,
  isWebPasswordEnabled,
  readWebSessionCookie
} from '@/lib/web-auth';

const NO_STORE = 'no-store';

function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

/**
 * The paths this middleware guards: the app shell, the login page, and every API route.
 * Anything else is a bundle asset.
 */
function isGuardedPath(path: string): boolean {
  return path === '/' || path === '/login' || isApiPath(path);
}

function tooManyAttempts(context: Parameters<MiddlewareHandler>[0], retryAfterMs: number) {
  return context.body('Too many failed attempts', 429, {
    'Cache-Control': NO_STORE,
    'Retry-After': String(retryAfterSeconds(retryAfterMs))
  });
}

/**
 * Host and origin authorization, then optional password authentication.
 *
 * Ported literally from the request interceptor this project used to run ahead of every request:
 * the throttling rules and the redirect chain are security behavior, not styling.
 */
export function security(): MiddlewareHandler {
  return async (context, next) => {
    const path = context.req.path;
    if (!isGuardedPath(path)) return next();

    const api = isApiPath(path);
    const request = context.req.raw;
    const trusted = api ? isApiRequestAllowed(request) : isApiRequestHostAllowed(request);
    if (!trusted) {
      return api
        ? context.json({ error: 'Untrusted API request' }, 403)
        : context.body('Untrusted request', 403);
    }

    const password = process.env.PIE_PASSWORD;
    if (!isWebPasswordEnabled(password)) {
      if (path === '/login') return context.redirect('/', 307);
      return next();
    }

    let authenticated = isValidWebSessionToken(readWebSessionCookie(request), password);
    const authorization = api ? request.headers.get('authorization') : null;
    if (!authenticated && authorization && /^Basic\s/i.test(authorization)) {
      // Every Basic header is a password guess, so it shares the login form's throttle;
      // otherwise any API path (or GET /api/web-auth) answers guesses at full speed. While
      // blocked even the right password is refused, or the answer would leak. A success does
      // not reset the counter: Basic clients authenticate on every request, and each reset
      // would hand an interleaved guesser a fresh short block.
      const retryAfterMs = getAuthRetryAfterMs();
      if (retryAfterMs > 0) return tooManyAttempts(context, retryAfterMs);
      authenticated = isValidBasicAuthorization(authorization, password);
      if (!authenticated) recordAuthFailure();
    }
    if (path === '/login') {
      return authenticated ? context.redirect('/', 307) : next();
    }
    if (path === '/api/web-auth') return next();

    if (!authenticated) {
      if (!api) {
        const url = new URL(request.url);
        const loginUrl = new URL('/login', url);
        if (url.search) loginUrl.searchParams.set('next', `${url.pathname}${url.search}`);
        return context.redirect(loginUrl.toString(), 307);
      }
      return context.body('Authentication required', 401, {
        'Cache-Control': NO_STORE,
        'WWW-Authenticate': `Basic realm="Pie", charset="UTF-8"`
      });
    }

    return next();
  };
}
