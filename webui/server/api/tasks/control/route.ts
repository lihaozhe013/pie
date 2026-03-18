import { normalizeCwd } from '@/lib/cwd-path';
import { json } from '@/server/http';
import { getTaskOrchestrator } from '@/lib/tasks/orchestrator';
import { projectKeyOfCwd, TaskInputError, getTaskQueue } from '@/lib/tasks/queue';
import { noStore, readTaskBody, taskErrorResponse } from '@/lib/tasks/request';

/**
 * `start`, `pause`, `resume`, `abort` for one project's queue. The project is
 * named by `cwd`; abort also accepts `id` so a notification deep link can stop
 * the task it names. Starting resolves when the queue drains, so it is not
 * awaited.
 */
export async function POST(req: Request) {
  try {
    const body = await readTaskBody(req);
    const action = body.action;
    const queue = getTaskQueue();
    const taskId =
      typeof body.id === 'number' && Number.isInteger(body.id) && body.id > 0
        ? body.id
        : null;
    const requestedCwd =
      typeof body.cwd === 'string' && body.cwd.trim()
        ? normalizeCwd(body.cwd.trim())
        : null;
    const cwd =
      requestedCwd ??
      (taskId !== null ? queue.getTask(taskId).cwd : null);
    if (!cwd) {
      throw new TaskInputError('A working directory is required');
    }
    const orchestrator = getTaskOrchestrator(projectKeyOfCwd(cwd), cwd);
    if (action === 'start') {
      void orchestrator
        .start()
        .catch(() => {
          // The stored queue state already says why the loop could not start.
        })
        .finally(() => {});
      return json({ orchestrator: orchestrator.status() }, noStore());
    }
    if (action === 'pause') {
      const status = await orchestrator.pause();
      return json({ orchestrator: status }, noStore());
    }
    if (action === 'resume') {
      const status = await orchestrator.resume();
      return json({ orchestrator: status }, noStore());
    }
    if (action === 'abort') {
      const status = await orchestrator.abort();
      return json({ orchestrator: status }, noStore());
    }
    throw new TaskInputError('action must be start, pause, resume, or abort');
  } catch (error) {
    return taskErrorResponse(error);
  }
}
