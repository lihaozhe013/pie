import { json } from '@/server/http';
import { existsSync, statSync } from 'fs';
import {
  attachSessionProjectInfo,
  openSessionManager,
  resolveSessionPath,
  resolveSessionIdByPath,
  invalidateSessionListCache,
  invalidateSessionManagerCache,
  buildSessionContext
} from '@/lib/session-reader';
import { getRpcSession } from '@/lib/rpc-manager';
import { projectTreeForResponse, toSummaryTree } from '@/lib/project-tree';
import { computeSessionTotalActiveMs } from '@/lib/session-timing';
import { computeSessionStats } from '@/lib/session-stats';
import { startServerPerf } from '@/lib/perf';
import { computeSessionRevision } from '@/lib/session-revision';
import type { SessionEntry } from '@/lib/types';
import {
  readSessionExtensionToolsPolicy,
  readSessionToolSelection
} from '@/lib/session-tool-selection';
import { readWorkMode } from '@/lib/work-mode';
import { readGoalFacts } from '@/lib/goal-driver';
import { deleteSessions } from '@/lib/session-delete';
import {
  attachTranscriptNotices,
  readSessionTranscriptNotices
} from '@/lib/transcript-notices-server';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const perf = startServerPerf('GET /api/sessions/[id]');
  try {
    perf?.span('resolve');
    const rpc = getRpcSession(id);
    const searchParams = new URL(req.url).searchParams;
    const force = searchParams.get('force') === '1';

    // A live wrapper only reflects the appends pie itself made. When another
    // pi process (the TUI) writes the same session file, the in-memory index
    // stays stale. Only probe on ?force=1 (session mount / page refresh): two
    // processes writing one JSONL is unsupported, so post-turn reads must not
    // scan disk. Eviction is idle-only; mid-run the wrapper owns the write path.
    let liveWrapper = rpc?.isAlive() ? rpc : undefined;
    let wrapperRebuilt = false;
    if (force && liveWrapper?.evictIfDiskAhead()) {
      wrapperRebuilt = true;
      liveWrapper = undefined;
    }
    const liveRpc = liveWrapper;
    const resolvedPath = liveRpc ? null : await resolveSessionPath(id);
    if (!liveRpc && !resolvedPath) {
      return json({ error: 'Session not found' }, { status: 404 });
    }

    const sm = liveRpc?.inner.sessionManager ?? openSessionManager(resolvedPath!);
    perf?.span('open');
    const filePath = liveRpc?.sessionFile || sm.getSessionFile() || resolvedPath || '';
    const entries = sm.getEntries();
    const leafId = sm.getLeafId();
    const summaryTree = searchParams.get('tree') === 'summary';
    const tree = summaryTree
      ? toSummaryTree(projectTreeForResponse(sm.getTree()))
      : projectTreeForResponse(sm.getTree());
    perf?.span('tree');
    const deferThinking = searchParams.has('deferThinking');
    const deferToolResultImages = searchParams.has('deferMedia');
    const rawTail = Number(searchParams.get('tail'));
    const tail = Number.isFinite(rawTail) && rawTail > 0 ? Math.min(rawTail, 1000) : 50;
    // pi's showCacheMissNotices (#1265): cache, cost and provider notices on the messages they follow.
    const transcriptNotices = readSessionTranscriptNotices({
      entries: entries as unknown as SessionEntry[],
      cwd: sm.getHeader()?.cwd ?? '',
      leafId: leafId,
      models: liveRpc?.inner.modelRuntime
    });
    const context = attachTranscriptNotices(
      buildSessionContext(entries as never, leafId, {
        deferThinking,
        deferToolResultImages,
        tail,
        sessionId: id // local: lazy URLs for historical tool-result images
      }),
      transcriptNotices
    );
    perf?.span('context');
    const totalActiveMs = computeSessionTotalActiveMs(entries);
    // Cumulative usage over ALL entries, including history compacted away —
    // the same aggregation the SDK's getSessionStats() uses. Lets the client
    // keep monotonic token/cost counters across compaction and page reloads.
    const stats = computeSessionStats(entries as unknown as SessionEntry[]);
    perf?.span('stats');
    // Opaque freshness token for the session view cache. Derived from the
    // disk fingerprint and the actual read source; null tells the client the
    // snapshot is unstable and must not be cached as fresh.
    const latestEntry = entries[entries.length - 1] as { id?: string } | undefined;
    const snapshotRevision = computeSessionRevision({
      filePath,
      // The notices switch changes the messages without touching the file.
      sourceId: `${liveRpc ? `runtime:${String(liveRpc.inner.sessionId)}` : 'disk'}${transcriptNotices ? '+notices' : ''}`,
      entryCount: entries.length,
      latestEntryId: typeof latestEntry?.id === 'string' ? latestEntry.id : null,
      leafId: leafId ?? null
    });
    const sessionName = sm.getSessionName();
    const firstUserEntry = entries.find(
      (entry) => entry.type === 'message' && entry.message.role === 'user'
    );
    const firstUserMessage =
      firstUserEntry?.type === 'message' ? firstUserEntry.message : undefined;

    const header = sm.getHeader();
    let modified = header?.timestamp ?? new Date().toISOString();
    try {
      modified = statSync(filePath).mtime.toISOString();
    } catch {
      /* use header timestamp */
    }
    const parentSessionId = header?.parentSession
      ? await resolveSessionIdByPath(header.parentSession)
      : undefined;
    const toolNames = readSessionToolSelection(entries as never);
    const extensionTools = readSessionExtensionToolsPolicy(entries as never);
    // Plan and Read-only pin the same tools, so the stored mode is reported beside them.
    const workMode = readWorkMode(entries as never);
    // The goal is branch state like the work mode, and an installed goal package
    // writes it: read the package's own record from the same entries.
    const goal = readGoalFacts(entries as never);
    const info = header
      ? (
          await attachSessionProjectInfo([
            {
              path: filePath,
              id: header.id,
              cwd: header.cwd ?? '',
              name: sessionName,
              created: header.timestamp,
              modified,
              messageCount: stats.totalMessages,
              firstMessage: firstUserMessage
                ? (() => {
                    const c = (firstUserMessage as { content: unknown }).content;
                    return typeof c === 'string'
                      ? c
                      : (Array.isArray(c)
                          ? ((
                              c.find((b: { type: string }) => b.type === 'text') as
                                { text: string } | undefined
                            )?.text ?? '')
                          : '') || '(no messages)';
                  })()
                : '(no messages)',
              parentSessionId,
              ...(header.parentSession
                ? {
                    relation: {
                      kind: 'fork' as const,
                      ...(parentSessionId ? { originSessionId: parentSessionId } : {})
                    }
                  }
                : {}),
              transient: !filePath || !existsSync(filePath)
            }
          ])
        )[0]
      : null;

    return (
      perf?.attach(
        json({
          sessionId: id,
          filePath,
          info,
          leafId,
          tree,
          ...(summaryTree ? { treeFormat: 'summary' as const } : {}),
          snapshotRevision,
          context,
          stats,
          totalActiveMs,
          ...(toolNames !== undefined ? { toolNames, extensionTools } : {}),
          ...(workMode !== undefined ? { mode: workMode } : {}),
          ...(goal ? { goal } : {}),
          ...(wrapperRebuilt ? { wrapperRebuilt: true } : {})
        })
      ) ??
      json({
        sessionId: id,
        filePath,
        info,
        leafId,
        tree,
        ...(summaryTree ? { treeFormat: 'summary' as const } : {}),
        snapshotRevision,
        context,
        stats,
        totalActiveMs,
        ...(toolNames !== undefined ? { toolNames, extensionTools } : {}),
        ...(workMode !== undefined ? { mode: workMode } : {}),
        ...(goal ? { goal } : {}),
        ...(wrapperRebuilt ? { wrapperRebuilt: true } : {})
      })
    );
  } catch (error) {
    return json({ error: String(error) }, { status: 500 });
  }
}

// PATCH /api/sessions/[id]  body: { name: string }
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { name } = (await req.json()) as { name?: string };
    if (typeof name !== 'string') {
      return json({ error: 'name is required' }, { status: 400 });
    }
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return json({ error: 'Session not found' }, { status: 404 });
    }

    // PATCH writes via appendSessionInfo — open fresh, bypassing the cache.
    const sm = openSessionManager(filePath, { mutable: true });
    sm.appendSessionInfo(name.trim());
    invalidateSessionManagerCache(filePath);
    invalidateSessionListCache();
    return json({ ok: true });
  } catch (error) {
    return json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { missing } = await deleteSessions([id]);
    if (missing.length > 0) {
      return json({ error: 'Session not found' }, { status: 404 });
    }
    return json({ ok: true });
  } catch (error) {
    return json({ error: String(error) }, { status: 500 });
  }
}
