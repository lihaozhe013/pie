/**
 * Small HTTP helpers shared by the task routes: a bounded JSON body and one
 * mapping from queue errors to the documented status codes.
 */
import { json } from '../../server/http';
import { TaskInputError } from './queue';

export const TASK_BODY_LIMIT_BYTES = 1_048_576;

/**
 * The status for every queue error code. Mapping by `code` rather than by class
 * keeps the answers stable when a module is loaded twice, which happens between
 * the dev server's bundles and the test runner's module resolution.
 */
const TASK_ERROR_STATUS: Record<string, number> = {
  invalid_input: 400,
  task_not_found: 404,
  task_locked: 409,
  task_not_pending: 409,
  already_running: 409,
  not_running: 409,
  no_pending_question: 409
};

export async function readTaskBody(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(length) && length > TASK_BODY_LIMIT_BYTES) {
    throw new TaskInputError('The request body is too large');
  }
  const text = await request.text();
  if (text.length > TASK_BODY_LIMIT_BYTES) {
    throw new TaskInputError('The request body is too large');
  }
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TaskInputError('The request body is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TaskInputError('The request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

export function taskErrorResponse(error: unknown): Response {
  const code = (error as { code?: unknown } | null)?.code;
  const status = typeof code === 'string' ? TASK_ERROR_STATUS[code] : undefined;
  if (status !== undefined) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message, code }, { status });
  }
  const message = error instanceof Error ? error.message : String(error);
  return json({ error: message, code: 'internal_error' }, { status: 500 });
}

export function noStore(): { headers: Record<string, string> } {
  return { headers: { 'Cache-Control': 'no-store' } };
}
