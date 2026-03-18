import { json } from '@/server/http';
import { getSessionListVersion } from '@/lib/session-reader';
import { getAwaitingInputRpcSessionIds, getRunningRpcSessionIds } from '@/lib/rpc-manager';
import { getSessionUiStateRevision } from '@/lib/session-ui-state';
import { activeTaskSessionIds } from '@/lib/tasks/active-sessions';

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
// sessionUiStateRevision (null when unreadable) tells the sidebar its pins and
// archive changed elsewhere; it costs one stat while the file is unchanged.
export async function GET() {
  return json(
    {
      sessionListVersion: getSessionListVersion(),
      runningSessionIds: getRunningRpcSessionIds(),
      awaitingInputSessionIds: getAwaitingInputRpcSessionIds(),
      taskSessionIds: activeTaskSessionIds(),
      sessionUiStateRevision: getSessionUiStateRevision()
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
