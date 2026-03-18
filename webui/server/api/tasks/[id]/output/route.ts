import { json } from '@/server/http';
import { getTaskOrchestrator } from '@/lib/tasks/orchestrator';
import { getTaskQueue } from '@/lib/tasks/queue';
import { noStore, taskErrorResponse } from '@/lib/tasks/request';

/** The live tail of the active task, read from the in-memory buffer only. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const taskId = Number(id);
    const task = getTaskQueue().getTask(taskId);
    const orchestrator = getTaskOrchestrator(task.projectKey, task.cwd);
    const status = orchestrator.status();
    return json(
      {
        taskId,
        running: status.activeTaskId === taskId,
        output: orchestrator.output(taskId),
        activity: status.activeTaskId === taskId ? status.activity : null
      },
      noStore()
    );
  } catch (error) {
    return taskErrorResponse(error);
  }
}
