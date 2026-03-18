import { json } from '@/server/http';
import {
  attachSessionProjectInfo,
  getSessionListVersion,
  listAllSessions,
  listSessionSummaries,
  mergeSessionLists
} from '@/lib/session-reader';
import {
  getAwaitingInputRpcSessionIds,
  getRpcSessionInfos,
  getRunningRpcSessionIds
} from '@/lib/rpc-manager';
import { startServerPerf } from '@/lib/perf';
import { activeTaskSessionIds } from '@/lib/tasks/active-sessions';

export async function GET(req: Request) {
  const perf = startServerPerf('GET /api/sessions');
  try {
    const searchParams = new URL(req.url).searchParams;
    const force = searchParams.get('force') === '1';
    // `summary=1` serves header/stat metadata so the sidebar can paint without
    // waiting for every session transcript to be parsed.
    const summary = searchParams.get('summary') === '1';
    // Task mode shows a fresh conversation as a task before its first message
    // is persisted. Chat mode keeps the default, which hides idle draft runtimes.
    const includeTransient = searchParams.get('includeTransient') === '1';
    perf?.span('start');
    const persistedSessionsPromise = summary ? listSessionSummaries() : listAllSessions({ force });
    // Capture before awaiting: mutations during the scan still require a later refresh.
    const sessionListVersion = getSessionListVersion();
    const [persistedSessions, runtimeSessions] = await Promise.all([
      persistedSessionsPromise,
      attachSessionProjectInfo(getRpcSessionInfos({ includeTransient }))
    ]);
    perf?.span('scan+projects');
    const sessions = mergeSessionLists(persistedSessions, runtimeSessions);
    return (
      perf?.attach(
        json({
            sessions,
            sessionListVersion,
            runningSessionIds: getRunningRpcSessionIds(),
            awaitingInputSessionIds: getAwaitingInputRpcSessionIds(),
            taskSessionIds: activeTaskSessionIds()
          },
          { headers: { 'Cache-Control': 'no-store' } }
        )
      ) ??
      json({
          sessions,
          sessionListVersion,
          runningSessionIds: getRunningRpcSessionIds(),
          awaitingInputSessionIds: getAwaitingInputRpcSessionIds(),
          taskSessionIds: activeTaskSessionIds()
        },
        { headers: { 'Cache-Control': 'no-store' } }
      )
    );
  } catch (error) {
    return json(
      { error: String(error) },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
