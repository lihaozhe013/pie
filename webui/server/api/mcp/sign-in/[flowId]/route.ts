import { json } from '@/server/http';
import type { McpErrorResponse, McpRefusalReason, McpSignInFlowInfo } from '@/lib/api-types';
import { cancelMcpSignIn, pasteMcpSignInRedirect, readMcpSignIn } from '@/lib/mcp-sign-in';
import { hasJsonContentType, isApiRequestAllowed } from '@/lib/request-security';

// One Settings › MCP sign-in by its id (`lib/mcp-sign-in.ts`):
//   GET     where it stands, which the panel polls about once a second;
//   POST    { redirectUrl }: the address the browser was sent back to, for a
//           browser that cannot reach Pie's loopback listener (another
//           device, a remote server); a paste that is not this sign-in's
//           answer is refused with 400 and the sign-in keeps waiting;
//   DELETE  cancel it.
// The id is a random UUID that only the start's answer carries. The entry was
// checked when the sign-in started; nothing here connects or reads a file.

function refusal(status: number, reason: McpRefusalReason, error: string) {
  return json({ error, reason } satisfies McpErrorResponse, { status });
}

const UNKNOWN = 'No sign-in has that id: it ended over a minute ago, or Pie restarted';

type Context = { params: Promise<{ flowId: string }> };

export async function GET(req: Request, { params }: Context) {
  if (!isApiRequestAllowed(req)) return refusal(403, 'request-denied', 'Untrusted API request');
  const { flowId } = await params;
  const flow = readMcpSignIn(flowId);
  if (!flow) return refusal(404, 'sign-in-unknown', UNKNOWN);
  return json(flow satisfies McpSignInFlowInfo);
}

export async function POST(req: Request, { params }: Context) {
  if (!isApiRequestAllowed(req)) return refusal(403, 'request-denied', 'Untrusted API request');
  if (!hasJsonContentType(req))
    return refusal(415, 'content-type', 'Content-Type must be application/json');
  const { flowId } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return refusal(400, 'invalid-request', 'Invalid JSON body');
  }
  const redirectUrl =
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>).redirectUrl
      : undefined;
  const result = pasteMcpSignInRedirect(flowId, redirectUrl);
  if (result.ok) return json(result.flow satisfies McpSignInFlowInfo);
  return refusal(result.status, result.reason, result.error);
}

export async function DELETE(req: Request, { params }: Context) {
  if (!isApiRequestAllowed(req)) return refusal(403, 'request-denied', 'Untrusted API request');
  const { flowId } = await params;
  const flow = cancelMcpSignIn(flowId);
  if (!flow) return refusal(404, 'sign-in-unknown', UNKNOWN);
  return json(flow satisfies McpSignInFlowInfo);
}
