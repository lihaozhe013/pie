import { json } from '@/server/http';
import { getTaskQueue, TaskInputError } from '@/lib/tasks/queue';
import { noStore, readTaskBody, taskErrorResponse } from '@/lib/tasks/request';
import type { TaskMoveAction, TaskUpdateInput } from '@/lib/tasks/types';

function updateFromBody(body: Record<string, unknown>): TaskUpdateInput {
  const update: TaskUpdateInput = {};
  if (typeof body.title === 'string') update.title = body.title;
  if ('description' in body) {
    update.description = typeof body.description === 'string' ? body.description : null;
  }
  if (typeof body.cwd === 'string') update.cwd = body.cwd;
  if ('verify_commands' in body) {
    update.verifyCommands = Array.isArray(body.verify_commands)
      ? body.verify_commands.filter((entry): entry is string => typeof entry === 'string')
      : null;
  }
  return update;
}

/** The task behind a deep link, with the project a board should open. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const taskId = Number(id);
    const task = getTaskQueue().getTask(taskId);
    return json(
      {
        task,
        project: { projectKey: task.projectKey, cwd: task.cwd }
      },
      noStore()
    );
  } catch (error) {
    return taskErrorResponse(error);
  }
}

/** `update`, `move`, `retry`, and `markDone`; every path respects the running guard. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const taskId = Number(id);
    if (!Number.isInteger(taskId) || taskId <= 0) throw new TaskInputError('Invalid task id');
    const body = await readTaskBody(req);
    const action = body.action;
    const queue = getTaskQueue();

    if (action === 'update') {
      const task = await queue.updateTask(taskId, updateFromBody(body));
      return json(
        {
          task,
          project: { projectKey: task.projectKey, cwd: task.cwd }
        },
        noStore()
      );
    }
    if (action === 'move') {
      const move: TaskMoveAction = {};
      if (body.direction === 'up' || body.direction === 'down') move.direction = body.direction;
      if (typeof body.position === 'number') move.position = body.position;
      const tasks = queue.moveTask(taskId, move);
      return json({ tasks }, noStore());
    }
    if (action === 'retry') {
      const task = queue.retryTask(taskId);
      return json({ task }, noStore());
    }
    if (action === 'markDone') {
      const note = typeof body.note === 'string' ? body.note : null;
      const task = queue.markDone(taskId, note);
      return json({ task }, noStore());
    }
    throw new TaskInputError('action must be update, move, retry, or markDone');
  } catch (error) {
    return taskErrorResponse(error);
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const taskId = Number(id);
    if (!Number.isInteger(taskId) || taskId <= 0) throw new TaskInputError('Invalid task id');
    getTaskQueue().deleteTask(taskId);
    return json({ deleted: taskId }, noStore());
  } catch (error) {
    return taskErrorResponse(error);
  }
}
