import { json } from '@/server/http';
import { configChangeSummary, readTaskConfig, writeTaskConfig } from '@/lib/tasks/config';
import { parseTaskConfigPatch } from '@/lib/tasks/config-fields';
import { noStore, readTaskBody, taskErrorResponse } from '@/lib/tasks/request';
import { getTaskStore } from '@/lib/tasks/store';


/**
 * The queue's own defaults. Only the fields the board or the orchestrator can
 * edit are accepted; everything else in the file stays whatever the person
 * wrote there.
 */
export async function PUT(req: Request) {
  try {
    const patch = parseTaskConfigPatch(await readTaskBody(req));
    const before = readTaskConfig();
    const config = writeTaskConfig(patch);
    try {
      // The defaults live in a JSON file, so the event follows the write rather
      // than sharing a transaction with it.
      getTaskStore().appendEvent({ kind: 'config', summary: configChangeSummary(before, config) });
    } catch {
      // A missing event is not a failed configuration.
    }
    return json({ config }, noStore());
  } catch (error) {
    return taskErrorResponse(error);
  }
}

export async function GET() {
  try {
    return json({ config: readTaskConfig() }, noStore());
  } catch (error) {
    return taskErrorResponse(error);
  }
}
