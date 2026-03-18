import { json } from '@/server/http';
import { resolveSessionPath } from '@/lib/session-reader';
import { startRpcSession, getRpcSession, setRpcSessionTools } from '@/lib/rpc-manager';

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let commandType: string | undefined;
  let promptAccepted = false;

  try {
    const body = (await req.json()) as { type: string; [key: string]: unknown };
    commandType = typeof body.type === 'string' ? body.type : undefined;
    const requestedToolNames = body.toolNames;
    if (
      requestedToolNames !== undefined &&
      (!Array.isArray(requestedToolNames) ||
        requestedToolNames.some((name) => typeof name !== 'string'))
    ) {
      throw new Error('toolNames must be an array of strings');
    }
    const toolNames = requestedToolNames as string[] | undefined;
    const requestedExtensionTools = body.extensionTools;
    // `null` clears a stored work mode; an absent field leaves it alone.
    const requestedMode = 'mode' in body ? body.mode : undefined;

    // Fast path: already-running session
    const existing = getRpcSession(id);
    if (body.type === 'set_tools') {
      const filePath = existing?.sessionFile || (await resolveSessionPath(id)) || undefined;
      if (!existing?.isAlive() && !filePath) {
        return json({ error: 'Session not found' }, { status: 404 });
      }
      const changed = await setRpcSessionTools(
        id,
        filePath,
        toolNames,
        requestedMode,
        requestedExtensionTools
      );
      return json({
        success: true,
        data: { sessionId: changed.sessionId, recreated: changed.recreated }
      });
    }
    if (existing?.isAlive()) {
      const result = await existing.send(body);
      promptAccepted = body.type === 'prompt';
      return json({ success: true, data: result });
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return json(
        {
          error: 'Session not found',
          ...(body.type === 'prompt' ? { code: 'prompt_rejected', accepted: false } : {})
        },
        { status: 404 }
      );
    }

    const { session } = await startRpcSession(id, filePath, undefined, {
      ...(toolNames !== undefined
        ? {
            toolNames,
            ...(requestedExtensionTools !== undefined
              ? { extensionTools: requestedExtensionTools as 'all' | 'selected' }
              : {})
          }
        : {})
    });
    const result = await session.send(body);
    promptAccepted = body.type === 'prompt';

    return json({ success: true, data: result });
  } catch (error) {
    return json(
      {
        error: error instanceof Error ? error.message : String(error),
        ...(commandType === 'prompt' && !promptAccepted
          ? { code: 'prompt_rejected', accepted: false }
          : {})
      },
      { status: 500 }
    );
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const session = getRpcSession(id);
    if (!session || !session.isAlive()) {
      return json({ running: false });
    }

    const state = (await session.send({ type: 'get_state' })) as Record<string, unknown>;
    // Status reads leave out the system prompt, most of the reply (agentStatusUrl()).
    if (new URL(req.url).searchParams.get('systemPrompt') === '0') delete state.systemPrompt;
    return json({ running: true, state });
  } catch (error) {
    return json({ error: String(error) }, { status: 500 });
  }
}
