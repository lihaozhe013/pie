import { json } from '@/server/http';
import {
  GLOBAL_AGENTS_MAX_BYTES,
  readGlobalAgents,
  writeGlobalAgents
} from '@/lib/global-agents-file';
import { hasJsonContentType, isApiRequestAllowed } from '@/lib/request-security';

// The JSON envelope adds a little to the content size; anything beyond this
// cannot contain an allowed file and is refused before it is parsed.
const MAX_REQUEST_BYTES = GLOBAL_AGENTS_MAX_BYTES + 64 * 1024;

function errorResponse(error: unknown) {
  return json(
    { error: error instanceof Error ? error.message : String(error) },
    { status: 500 }
  );
}

function declaredContentLength(request: Request): number | null {
  const value = request.headers.get('content-length');
  if (!value || !/^\d+$/.test(value)) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : null;
}

// Settings › Global AGENTS.md. The fixed path is Pi's global context file; this
// route is not a general file reader or writer.
export async function GET() {
  try {
    return json(readGlobalAgents());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return json({ error: 'Untrusted API request' }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return json({ error: 'Content-Type must be application/json' }, { status: 415 });
  }
  const declared = declaredContentLength(req);
  if (declared !== null && declared > MAX_REQUEST_BYTES) {
    return json(
      { error: 'Global AGENTS.md must be 1 MiB or smaller' },
      { status: 413 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const content = (body as { content?: unknown } | null)?.content;
  if (typeof content !== 'string') {
    return json({ error: 'content must be a string' }, { status: 400 });
  }
  if (Buffer.byteLength(content, 'utf8') > GLOBAL_AGENTS_MAX_BYTES) {
    return json(
      { error: 'Global AGENTS.md must be 1 MiB or smaller' },
      { status: 413 }
    );
  }

  try {
    const path = writeGlobalAgents(content);
    return json({ path, content, exists: true });
  } catch (error) {
    return errorResponse(error);
  }
}
