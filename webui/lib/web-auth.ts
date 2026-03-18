import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const PIE_AUTH_USERNAME = 'pi';
export const PIE_SESSION_COOKIE = 'pie_session';
export const PIE_SESSION_MAX_AGE = 60 * 60 * 24 * 30;

function hashSecret(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function secretsEqual(actual: string, expected: string): boolean {
  return timingSafeEqual(hashSecret(actual), hashSecret(expected));
}

export function isWebPasswordEnabled(
  password: string | undefined = process.env.PIE_PASSWORD
): password is string {
  return typeof password === 'string' && password.length > 0;
}

export function isValidWebPassword(
  suppliedPassword: string,
  password = process.env.PIE_PASSWORD
): boolean {
  return isWebPasswordEnabled(password) && secretsEqual(suppliedPassword, password);
}

export function isValidBasicAuthorization(
  authorization: string | null,
  password = process.env.PIE_PASSWORD
): boolean {
  if (!isWebPasswordEnabled(password) || !authorization) return false;

  const match = /^Basic\s+(\S+)$/i.exec(authorization);
  if (!match) return false;

  let credentials: string;
  try {
    const decoded = Buffer.from(match[1], 'base64');
    if (decoded.toString('base64') !== match[1]) return false;
    credentials = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
  } catch {
    return false;
  }

  const separator = credentials.indexOf(':');
  if (separator === -1) return false;

  const username = credentials.slice(0, separator);
  const suppliedPassword = credentials.slice(separator + 1);
  const usernameMatches = secretsEqual(username, PIE_AUTH_USERNAME);
  const passwordMatches = isValidWebPassword(suppliedPassword, password);
  return usernameMatches && passwordMatches;
}

function sessionSignature(payload: string, password: string): string {
  return createHmac('sha256', password).update(`pie-session:${payload}`, 'utf8').digest('hex');
}

export function createWebSessionToken(
  password: string,
  now = Date.now(),
  nonce = randomBytes(16).toString('hex')
): string {
  const payload = `v1.${Math.floor(now / 1000) + PIE_SESSION_MAX_AGE}.${nonce}`;
  return `${payload}.${sessionSignature(payload, password)}`;
}

export function isValidWebSessionToken(
  token: string | undefined,
  password = process.env.PIE_PASSWORD,
  now = Date.now()
): boolean {
  if (!token || !isWebPasswordEnabled(password)) return false;

  const match = /^(v1\.(\d+)\.[a-f0-9]{32})\.([a-f0-9]{64})$/.exec(token);
  if (!match) return false;

  const expiresAt = Number(match[2]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(now / 1000)) return false;
  return secretsEqual(match[3], sessionSignature(match[1], password));
}

/**
 * The session cookie is plain HTTP state, so the routes read and write it
 * themselves. `Secure` follows the request, because a LAN client may reach Pie
 * over HTTPS through a reverse proxy while the server itself speaks HTTP.
 */
function isSecureRequest(request: Request): boolean {
  return (
    new URL(request.url).protocol === 'https:' ||
    request.headers.get('x-forwarded-proto')?.split(',', 1)[0]?.trim() === 'https'
  );
}

export function readWebSessionCookie(request: Request): string | undefined {
  const header = request.headers.get('cookie');
  if (!header) return undefined;
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0) continue;
    if (pair.slice(0, separator).trim() !== PIE_SESSION_COOKIE) continue;
    const raw = pair.slice(separator + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

/** The `Set-Cookie` value for the session, including the attributes both the login form and
 * the logout route need. A `maxAgeSeconds` of 0 clears it. */
export function webSessionCookie(
  request: Request,
  value: string,
  maxAgeSeconds: number
): string {
  const attributes = [
    `${PIE_SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`
  ];
  if (isSecureRequest(request)) attributes.push('Secure');
  return attributes.join('; ');
}
