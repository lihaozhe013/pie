import { json } from '@/server/http';
import { readTaskConfig } from '@/lib/tasks/config';
import {
  ensureTaskQueuesRecovered,
  getTaskOrchestrator,
  listTaskProjects
} from '@/lib/tasks/orchestrator';
import { resolveTaskProject } from '@/lib/tasks/projects';
import { getTaskQueue } from '@/lib/tasks/queue';
import {
  runningProjectSessions,
  withSessionActivity
} from '@/lib/tasks/session-activity';
import { noStore, readTaskBody, taskErrorResponse } from '@/lib/tasks/request';
import { getTaskStore } from '@/lib/tasks/store';
import type { TaskCreateInput } from '@/lib/tasks/types';

/**
 * The board's whole poll payload for one project: its tasks, recent runs, loop
 * state, all project summaries for the switcher, and the global defaults.
 * `?cwd=` names the project; without it the server opens the running or most
 * recently used one.
 */
export async function GET(req: Request) {
  try {
    await ensureTaskQueuesRecovered();
    const requestedCwd = new URL(req.url).searchParams.get('cwd');
    const store = getTaskStore();
    const projects = withSessionActivity(
      listTaskProjects(store),
      runningProjectSessions()
    );
    const selected = resolveTaskProject(projects, requestedCwd);
    const queue = getTaskQueue();
    const orchestrator = selected
      ? getTaskOrchestrator(selected.projectKey, selected.cwd)
      : null;
    const status = orchestrator?.status() ?? null;
    if (status) status.activeSessions = selected?.activeSessions ?? [];
    return json(
      {
        project: selected
          ? { projectKey: selected.projectKey, cwd: selected.cwd }
          : null,
        tasks: selected ? queue.listTasks(selected.projectKey) : [],
        runs: selected ? queue.listRuns(selected.projectKey) : [],
        orchestrator: status,
        projects,
        config: readTaskConfig(),
        // The one watch row, so the board can say a session is listening.
        watch: store.getWatch()
      },
      noStore()
    );
  } catch (error) {
    return taskErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const body = await readTaskBody(req);
    const input: TaskCreateInput = {
      ...(typeof body.title === 'string' && body.title.trim() ? { title: body.title } : {}),
      description: typeof body.description === 'string' ? body.description : null,
      cwd: typeof body.cwd === 'string' ? body.cwd : '',
      verifyCommands: Array.isArray(body.verify_commands)
        ? body.verify_commands.filter((entry): entry is string => typeof entry === 'string')
        : null
    };
    const task = await getTaskQueue().createTask(input);
    return json(
      {
        task,
        project: { projectKey: task.projectKey, cwd: task.cwd }
      },
      { status: 201, ...noStore() }
    );
  } catch (error) {
    return taskErrorResponse(error);
  }
}
