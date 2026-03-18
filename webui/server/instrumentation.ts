import { configureHttpDispatcher, readHttpIdleTimeoutMs } from '@/lib/http-dispatcher';
import { closeAllAgentEventStreams } from '@/lib/agent-event-stream';
import { startTaskChatWatcher, stopTaskChatWatcher } from '@/lib/tasks/chat-watcher';
import {
  ensureTaskQueuesRecovered,
  shutdownTaskOrchestrators
} from '@/lib/tasks/orchestrator';

/**
 * Process-wide setup that has to happen before the first request, and the shutdown steps that
 * run before the listener closes.
 */
export function registerNodeInstrumentation(): void {
  // The pi CLI applies settings' `httpIdleTimeoutMs` to the same undici
  // body/header timeouts, so a Web UI session gets the timeout the user
  // configured. Without it the built-in five minutes aborts a provider stream
  // that stays quiet for longer, which a CLI session tolerates.
  configureHttpDispatcher(readHttpIdleTimeoutMs());

  // A server close waits for every connection to end. SSE streams only end when the client
  // disconnects, so they are closed first or the process never exits.
  const shutdownStreams = () => closeAllAgentEventStreams();
  process.on('SIGINT', shutdownStreams);
  process.on('SIGTERM', shutdownStreams);

  // A running task session must not outlive the server that owns it: abort the
  // active run and settle its task before the process goes away. This creates
  // no orchestrator when the queue was never used.
  const shutdownTasks = () => {
    stopTaskChatWatcher();
    void shutdownTaskOrchestrators().catch(() => {});
  };
  process.on('SIGINT', shutdownTasks);
  process.on('SIGTERM', shutdownTasks);

  // A task left IN_PROGRESS belongs to a server that is gone unless another
  // process holds its project lock. Start the probe now; the first task API
  // request waits for it, so the board never reports a dead run as running.
  void ensureTaskQueuesRecovered()
    .then(() => startTaskChatWatcher())
    .catch((error) => {
      console.warn('[pie] could not recover task queues at startup:', error);
    });

  // A route's module is evaluated on its first request, so the first /api/sessions used to pay
  // for importing the whole pi SDK, seconds on Windows (#964). Start that import now, unawaited
  // so startup stays fast: it overlaps the browser opening, and the routes reuse Node's cached
  // module. A failure is left for the routes' own import to report.
  import('@earendil-works/pi-coding-agent').catch(() => {});
}
