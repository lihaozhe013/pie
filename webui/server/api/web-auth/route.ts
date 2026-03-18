import { json } from '@/server/http';
import {
  getAuthRetryAfterMs,
  recordAuthFailure,
  recordAuthSuccess,
  retryAfterSeconds
} from '@/lib/auth-throttle';
import { hasJsonContentType, isApiRequestAllowed } from '@/lib/request-security';
import {
  createWebSessionToken,
  isValidBasicAuthorization,
  isValidWebPassword,
  isValidWebSessionToken,
  isWebPasswordEnabled,
  PIE_SESSION_MAX_AGE,
  readWebSessionCookie,
  webSessionCookie
} from '@/lib/web-auth';

function tooManyAttempts(retryAfterMs: number): Response {
  return json(
    { error: 'Too many failed attempts', retryAfterMs },
    {
      status: 429,
      headers: {
        'Cache-Control': 'no-store',
        'Retry-After': String(retryAfterSeconds(retryAfterMs))
      }
    }
  );
}

function withSessionCookie(request: Request, value: string, maxAge: number): Response {
  return json(
    { ok: true },
    { headers: { 'Set-Cookie': webSessionCookie(request, value, maxAge) } }
  );
}

export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return json({ error: 'Untrusted API request' }, { status: 403 });
  }

  const password = process.env.PIE_PASSWORD;
  const enabled = isWebPasswordEnabled(password);
  const authenticated =
    !enabled ||
    isValidBasicAuthorization(request.headers.get('authorization'), password) ||
    isValidWebSessionToken(readWebSessionCookie(request), password);
  return json(
    { enabled, authenticated },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return json({ error: 'Untrusted API request' }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return json({ error: 'Content-Type must be application/json' }, { status: 415 });
  }

  const password = process.env.PIE_PASSWORD;
  if (!isWebPasswordEnabled(password)) {
    return json({ error: 'Password authentication is disabled' }, { status: 404 });
  }

  const retryAfterMs = getAuthRetryAfterMs();
  if (retryAfterMs > 0) {
    return tooManyAttempts(retryAfterMs);
  }

  const body = (await request.json().catch(() => null)) as { password?: unknown } | null;
  if (!body || typeof body.password !== 'string' || !isValidWebPassword(body.password, password)) {
    const delayMs = recordAuthFailure();
    console.warn(
      `[web-auth] Password authentication failed; next attempt blocked for ${delayMs}ms`
    );
    return json(
      { error: 'Invalid password', retryAfterMs: delayMs },
      { status: 401, headers: { 'Retry-After': String(retryAfterSeconds(delayMs)) } }
    );
  }

  recordAuthSuccess();
  return withSessionCookie(request, createWebSessionToken(password), PIE_SESSION_MAX_AGE);
}

export async function DELETE(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return json({ error: 'Untrusted API request' }, { status: 403 });
  }

  return withSessionCookie(request, '', 0);
}
