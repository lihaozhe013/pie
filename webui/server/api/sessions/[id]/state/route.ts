import { json } from '@/server/http';
import { getRpcSession } from '@/lib/rpc-manager';
import { resolveSessionPath } from '@/lib/session-reader';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const rpc = getRpcSession(id);
    if (rpc?.isAlive()) {
      const state = await rpc.send({ type: 'get_state' });
      return json({ running: true, state });
    }

    if (!(await resolveSessionPath(id))) {
      return json({ error: 'Session not found' }, { status: 404 });
    }
    return json({ running: false });
  } catch (error) {
    return json({ error: String(error) }, { status: 500 });
  }
}
