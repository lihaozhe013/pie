import { readContextWindowLimit, writeContextWindowLimit } from '@/lib/model-context-limit';

/** The global context window limit every model resolves with; `null` is an explicit no cap. */
export async function GET() {
  try {
    return Response.json({ limit: readContextWindowLimit() });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}

interface ContextLimitRequest {
  limit?: unknown;
}

export async function PUT(req: Request) {
  let body: ContextLimitRequest;
  try {
    body = (await req.json()) as ContextLimitRequest;
  } catch {
    return Response.json({ error: 'Request body must be JSON' }, { status: 400 });
  }
  if (!('limit' in body)) {
    return Response.json(
      { error: 'limit is required (a positive token count or null)' },
      { status: 400 }
    );
  }
  try {
    const limit = await writeContextWindowLimit(body.limit as number | string | null);
    return Response.json({ limit });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 }
    );
  }
}
