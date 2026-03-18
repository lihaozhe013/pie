import { json } from '@/server/http';
import { hasJsonContentType, isApiRequestAllowed } from '@/lib/request-security';
import { isProviderUsageId, queryProviderUsage } from '@/lib/provider-usage';

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request))
    return json({ error: 'Untrusted API request' }, { status: 403 });
  if (!hasJsonContentType(request))
    return json({ error: 'Content-Type must be application/json' }, { status: 415 });

  let body: { providerId?: unknown };
  try {
    body = (await request.json()) as { providerId?: unknown };
  } catch {
    return json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const providerId = typeof body.providerId === 'string' ? body.providerId : '';
  if (!isProviderUsageId(providerId))
    return json({ error: 'Unsupported provider' }, { status: 400 });

  try {
    const result = await queryProviderUsage(providerId);
    return json(result);
  } catch {
    return json({
      providerId,
      status: 'query-failed',
      message: 'The provider usage query failed.'
    });
  }
}
