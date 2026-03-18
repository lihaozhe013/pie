import { AsyncLocalStorage } from 'node:async_hooks';

type QuestionPresentation = { options: string[]; inline?: boolean };

// Share the scope across extension loader module instances and development reloads.
// AsyncLocalStorage still isolates concurrent sessions and unrelated extension requests.
const host = globalThis as typeof globalThis & {
  __pieQuestionScope?: AsyncLocalStorage<QuestionPresentation>;
};

/** Presentation metadata only; answers still use Pi's extension UI request/response channel. */
export const askUserPresentation = (host.__pieQuestionScope ??=
  new AsyncLocalStorage<QuestionPresentation>());
