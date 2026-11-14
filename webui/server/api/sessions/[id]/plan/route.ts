import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { getRpcSession } from '@/lib/rpc-manager';
import { PLAN_VIEW_MAX_BYTES, planFacts, readPlanForSession } from '@/lib/plan-file';
import { openSessionManager, resolveSessionPath } from '@/lib/session-reader';
import type { SessionEntry } from '@/lib/types';
import { json } from '@/server/http';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const rpc = getRpcSession(id);
    let sessionManager;
    if (rpc?.isAlive()) {
      sessionManager = rpc.inner.sessionManager;
    } else {
      const filePath = await resolveSessionPath(id);
      if (!filePath) return json({ error: 'Session not found' }, { status: 404 });
      sessionManager = openSessionManager(filePath);
    }

    const plan = readPlanForSession(
      getAgentDir(),
      sessionManager.getSessionId(),
      sessionManager.getEntries() as unknown as SessionEntry[],
      PLAN_VIEW_MAX_BYTES
    );
    if (!plan) return json({ plan: null, content: '', truncated: false });
    return json({
      plan: planFacts(plan),
      content: plan.content,
      truncated: plan.truncated
    });
  } catch (error) {
    return json({ error: String(error) }, { status: 500 });
  }
}
