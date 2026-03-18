import { json } from '@/server/http';
import {
  OrchestratorConflictError,
  getTaskOrchestrator
} from '@/lib/tasks/orchestrator';
import { getTaskQueue } from '@/lib/tasks/queue';
import { noStore, readTaskBody, taskErrorResponse } from '@/lib/tasks/request';
import type { TaskAnswerInput } from '@/lib/tasks/types';

/** Answer or dismiss the question the running task is waiting on. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const taskId = Number(id);
    if (!Number.isInteger(taskId) || taskId <= 0) {
      throw new OrchestratorConflictError('no_pending_question', 'Invalid task id');
    }
    const body = await readTaskBody(req);
    const input: TaskAnswerInput = {
      answer: typeof body.answer === 'string' ? body.answer : undefined,
      cancelled: body.cancelled === true
    };
    if (!input.cancelled && !input.answer?.trim()) {
      throw new OrchestratorConflictError('no_pending_question', 'An answer is required');
    }
    const task = getTaskQueue().getTask(taskId);
    await getTaskOrchestrator(task.projectKey, task.cwd).answer(taskId, input);
    return json({ answered: taskId }, noStore());
  } catch (error) {
    return taskErrorResponse(error);
  }
}
