# Per-project Task Queues

A local task board for one person: a small Jira per project. Each working directory has its own
queue, and queued tasks in one project are claimed one at a time. Every queued task is executed by
a brand-new Pi SDK session created by the same in-process runtime chat uses. A task never reuses a
session: the next queued task in that project starts from an empty window. Because the session is
an ordinary SDK session, it appears in chat immediately, can be read while it runs, and can be
continued after it finishes.

Chat sessions are first-class work on the same board. A live conversation — one that is running
or waiting for input — appears as a task-shaped row in its project, and any running conversation
keeps that project active. An idle conversation is not queue work: it goes back to the chat
sidebar, so finished work appears on the board only in the Finished drawer. Chat may run in
parallel:
several conversations in one project can run at once, and a conversation may start while a queued
task is already running. The queue has the lower priority. A started queue claims its next task
only while no conversation is running in the project; if a conversation is still running when a
queued task ends, the next queued task waits. Different projects have different queues and may each
run work at the same time.

This document is the design and the record of what was built. The queue, the `Chat | Tasks` switch,
and the project panel are implemented. The sections below describe the implemented behavior, with
the differences noted where the built version is narrower than the original plan.

## Why this is not the boundary the project had

`docs/README.md` and `docs/architecture.md` previously ruled out a multi-agent orchestrator and a
subagent/queue feature. This document replaces that part of the boundary with a narrower rule:

- **Allowed:** one queue per working directory with one active queued task at a time, executed as a
  fresh Pi SDK session through the same runtime chat uses.
- **Allowed:** ordinary chat sessions in the same project, including several running at once and a
  chat that starts beside a queued task. A started queue waits for running chats before its next
  claim.
- **Allowed:** different projects running their own work concurrently, each in its own SDK session.
- **Allowed:** one management surface for every queue, described in
  [Orchestrator](orchestrator.md): the Orchestrator preset in any project. It adds one
  `task_manager` tool to the full coding loadout, scoped to that session's own queue. It controls the
  queue, not agents.
- **Still refused:** parallel queued tasks inside one project, a global worker pool, agent profiles,
  worktrees, subagent spawning or control, and any two-agent protocol. Task sessions are not
  subagents: they are ordinary sessions with queue metadata around them.

The queue owns scheduling, persistence, and progress reporting. It owns no agent capability: it
starts a session through the same SDK factory and tool presets chat uses. Deleting `lib/tasks`,
`server/api/tasks`, and `components/TaskWorkspace*` must leave the chat experience untouched.

## Goals

- **One queued task at a time per project; chat has priority.** Never two queued tasks at once in
  the same working directory, in one process or across processes. Chat sessions may run in parallel
  with each other and with a queued task; a queue claims its next task only when the project has no
  running conversation. The project, not the repository, is the unit: `/repo` and
  `/repo/packages/app` are separate queues.
- **Projects run in parallel.** A queue for another project may run while the first one is busy;
  the concurrency limit is the number of projects with work.
- **Zero context bleeding.** Every task runs in a fresh SDK session; a queue never reuses a session
  to save tokens.
- **Durable queue.** Survives reloads and server restarts; every transition is a single SQLite
  transaction with the state guard in the SQL itself.
- **Human interruption.** The running task can be stopped for real (abort, then a forced session
  shutdown after a grace period), and a standard-mode task may ask a question in chat.
- **Reviewable work.** Each task leaves an ordinary Pi session that the chat view can render, plus a
  verification result and a final report.

## Non-goals

- Multiple queued tasks running at once inside one project. Chat concurrency is owned by the chat
  runtime; the queue does not create a second worker or a global concurrency cap. There are no
  priorities beyond manual rank and no dependencies between tasks.
- Pull requests, branches, worktrees, or pushes. The queue never publishes; whether a run commits is
  a standing instruction the person writes into the task prompt.
- Multi-user operation, remote execution, or a hosted service.
- Per-task or per-project tool configuration. One global switch chooses standard or autonomous for every
  queue, matching the two useful states: at the computer or away.
- Providing a task-specific rendering of agent output. A task's session renders through the ordinary
  chat transcript.

## Layering and coupling

```
components/TaskWorkspace*          view: queue board, task editor, live activity
        │ HTTP (polling)
server/api/tasks/**                thin routes: validation, delegation, no logic
        │
lib/tasks/orchestrator.ts          the only loop: claim → run → gate → settle
        ├── lib/tasks/queue.ts     QueueController: CRUD, ordering, state guards
        ├── lib/tasks/store.ts     SQLite (WAL), migrations, the only module with SQL
        ├── lib/tasks/runner.ts    one task → one SDK session → one outcome
        ├── lib/tasks/prompt.ts    the task prompt and its rules
        └── lib/tasks/gate.ts      verification commands
```

| Boundary                             | Cost                                                                                                                                                                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent runtime (`lib/rpc-manager.ts`) | The runner starts a task through the same `startRpcSession` factory chat uses, so the session joins the ordinary registry and event stream. The runtime registers a cwd-busy check through `lib/tasks/runtime-sessions.ts`; a running task's session stays interactive in chat. |
| Pi                                   | Uses the same SDK, extensions, settings, and tool presets chat uses. No child protocol and no second agent implementation.                                                                                                              |
| Web layer                            | Eight REST routes underneath one client hook. The board can be removed without touching chat.                                                                                                                                          |
| Packaging                            | No new dependency. Storage uses Node's built-in `node:sqlite`; the SDK is already the app's runtime.                                                                                                                                   |
| Desktop shell                        | None. `src-tauri/` and `packaging/desktop.mjs` are untouched.                                                                                                                                                                          |

### Alternatives considered

| Option                                              | Rejected because                                                                                                                                                                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A `pi --mode rpc` child per task                    | It duplicated the agent runtime. Task sessions had a different runtime lifecycle from chat, were hard to open and intervene in, and used a CLI-only question channel instead of the SDK's extension UI.                           |
| A fake task-only agent loop                         | The queue would become an agent implementation rather than a scheduler; prompts, tools, models, and extensions would drift from chat.                                                                                             |
| A separate daemon spawned by `bin/pie.js`           | Duplicate lifecycle, agent-directory resolution, and shutdown handling with no benefit: the UI needs the server anyway.                                                                                                           |
| Reading the session file instead of the event stream | Loses the question and activity channel, adds partial-write races, and reports progress later than the events do.                                                                                                                 |

## Session model

Each queued task starts one new SDK session through `startRpcSession` in the server process:

- The session's `cwd` is the task's `cwd`, so Pi discovers that project's settings, skills, prompt
  templates, and `AGENTS.md` exactly as it does for chat.
- The session gets a stable id (`newSessionId`) and a name (the task title), so the task row and the
  chat sidebar point at the same session from the first prompt.
- Project trust is the same decision chat uses. An untrusted project's local extensions are not
  loaded; a queued run must not be the first thing that executes a repository's
  `.pi/extensions`.
- The session is persisted and stays an ordinary Pi session: it appears in chat immediately, renders
  through the normal transcript, and can be continued after the task finishes. The next task still
  starts from a fresh session.
- The task runner subscribes to the same SDK events chat uses. It maps tool activity to the board's
  activity line and keeps a bounded output tail for `/api/tasks/[id]/output`.
- `full` mode pins the `full` preset and leaves `ask_user` available. `autonomous` mode pins the
  `autonomous` preset, omits `ask_user`, and starts a goal; the goal package owns continuation and
  the agent must mark it complete before the task settles.
- A task timeout sends `abort`; the runner then waits a short grace period and destroys the SDK
  session if it has not settled. A server restart aborts the same way and settles the task as
  blocked, so no task is left `IN_PROGRESS`.

### Why the SDK, not a child

The SDK is the same runtime chat uses. It gives the task the same extension UI, tool presets,
project trust, session registry, event stream, and MCP host as a conversation. A task can therefore
be opened in chat while it runs, its `ask_user` card can be answered from either surface, and the
goal controls work without a second protocol. The old CLI-child model had none of that.

The trade-off is that a hung agent shares the server process. The runner bounds this with a timeout
and a forced destroy after abort; the task queue itself never relies on a hard process kill. The
verification gate still runs as a separate process with its own shell.

## Storage

`node:sqlite` (`DatabaseSync`) at `<agentDir>/pie-tasks.db`, that is, next to Pie's other state and
never inside a user's repository. `PRAGMA journal_mode = WAL` (the returned mode is checked and a
fallback to `delete` is logged), `synchronous = NORMAL`, `busy_timeout = 5000`, `foreign_keys = ON`.
Schema changes are numbered steps gated by `PRAGMA user_version`.

A database module is a per-process singleton (a `globalThis` key, as `lib/custom-tool-presets.ts`
does) because route handlers are bundled separately and hot reload re-evaluates modules.

```sql
CREATE TABLE tasks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  title            TEXT NOT NULL,
  description      TEXT,
  status           TEXT NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING','IN_PROGRESS','DONE','BLOCKED','FAILED')),
  rank             INTEGER NOT NULL,
  project_key      TEXT NOT NULL,        -- projectIdentityKey(cwd)
  cwd              TEXT NOT NULL,
  verify_commands  TEXT,                 -- JSON array; NULL: use the queue default
  session_id       TEXT,                 -- the Pi session of the current attempt
  claimed_token    TEXT,                 -- fencing token for the active claim
  pending_question TEXT,                 -- JSON { id, question, options, asked_at } while waiting
  attempts         INTEGER NOT NULL DEFAULT 0,
  result_summary   TEXT,
  exit_code        INTEGER,
  verify_output    TEXT,                 -- tail, bounded
  run_started_at   DATETIME,
  created_at       DATETIME NOT NULL,
  updated_at       DATETIME NOT NULL,
  finished_at      DATETIME
);

CREATE INDEX tasks_project_queue ON tasks (project_key, status, rank, id);

CREATE TABLE task_runs (                 -- one row per attempt; retries keep their history
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id        INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt        INTEGER NOT NULL,
  status         TEXT NOT NULL,          -- final status of that attempt
  session_id     TEXT,
  exit_code      INTEGER,
  verify_exit    INTEGER,
  output_tail    TEXT,
  started_at     DATETIME NOT NULL,
  finished_at    DATETIME
);

CREATE TABLE project_queue_state (       -- one row per project
  project_key     TEXT PRIMARY KEY,
  cwd             TEXT NOT NULL,
  state           TEXT NOT NULL,         -- IDLE | RUNNING | PAUSED
  paused_reason   TEXT,
  active_task_id  INTEGER,
  updated_at      DATETIME NOT NULL
);

CREATE TABLE task_events (               -- durable feed, one row per transition
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id           INTEGER,
  project_key       TEXT,
  kind              TEXT NOT NULL,
  status            TEXT,
  summary           TEXT,
  origin_session_id TEXT,
  created_at        DATETIME NOT NULL
);

CREATE INDEX task_events_project ON task_events (project_key, id);
```

The live queue state moved from one global row to one row per project. A server can drive several
projects at once; each project's pause reason, active task, and running loop are independent. The
database migration from the old single queue is one-way (`user_version = 7`), and every pending
migration first writes a `VACUUM INTO <db>.v<old>-<stamp>.bak` backup. The autonomous-mode step
drops the former per-task `allow_ask_user` column; an idempotent repair step covers a database that
an intermediate build advanced without dropping it.

`rank` stays an integer and is scoped to a project: inserts take that project's
`max(rank) + 10`, and any reorder rewrites only that project's pending segment as 10, 20, 30, …
inside one transaction. No fractional keys, no gaps to maintain, deterministic order with
`ORDER BY rank, id`.

## Queue controller

`lib/tasks/queue.ts` is the only writer. Every guard is expressed in SQL, not only in JavaScript, so
a stale caller cannot win a race it lost.

| Operation            | Rule                                                                                                                                                                                                                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createTask`         | Title required; `cwd` must exist and pass the file-access allow-list check; the project key is derived from `cwd`; rank appended at the end of that project; status `PENDING`.                                                                                                                                |
| `updateTask`         | `IN_PROGRESS` is refused with `TaskLockedError`.                                                                                                                                                                                                                                                            |
| `deleteTask`         | `IN_PROGRESS` is refused. Other statuses may be deleted; `task_runs` follows by cascade.                                                                                                                                                                                                                    |
| `moveTask`           | Reorders within one project's pending segment only; a non-pending task is refused. Accepts "move up", "move down", or an absolute position.                                                                                                                                                                 |
| `claimNext`          | One `BEGIN IMMEDIATE` transaction scoped to a project: assert no row in that project is `IN_PROGRESS`; select its lowest `rank`/`id` `PENDING` row; update it to `IN_PROGRESS` with a fresh `claimed_token`, `attempts + 1`, and `run_started_at`, `WHERE id = ? AND status = 'PENDING'`; require `changes === 1`. No pending row means `null`. |
| `settle`             | One transaction: the final status, `result_summary`, `exit_code`, `finished_at`, a `task_runs` row, and the project's `project_queue_state`. The update is conditioned on the task still being `IN_PROGRESS` with the caller's token.                                                                       |
| `retryTask`          | `BLOCKED`/`FAILED` → `PENDING`. Attempts are counted at claim time.                                                                                                                                                                                                                                         |
| `markDone`           | Human override, recorded with a note; the board asks for confirmation.                                                                                                                                                                                                                                      |
| `recoverInterrupted` | At start-up, a row left `IN_PROGRESS` in one project becomes `BLOCKED` with `result_summary = "orchestrator restarted during the run"`, because its session ended with the old server.                                                                                                                          |

### State machine

```
PENDING ──claim──► IN_PROGRESS ──gate passed──► DONE
                        │
                        ├── failed run / lost session / timeout ──► FAILED
                        ├── verification command failed ─────► BLOCKED
                        └── aborted by the person ───────────► BLOCKED

FAILED, BLOCKED ──retry──► PENDING (attempts counted again)
DONE, FAILED, BLOCKED ──delete/edit──► allowed
IN_PROGRESS ──edit/delete/reorder──► refused (HTTP 409, code task_locked)
```

`FAILED` and `BLOCKED` are distinct because they mean different things to the person reading the
board: the run did not finish versus the agent finished but the work did not pass. Both pause the
loop; neither retries on its own.

## Orchestrator loop

`lib/tasks/orchestrator.ts` keeps one loop per project in a process-local registry
(`globalThis.__pieTaskOrchestrators`). Each loop has its own `proper-lockfile` lock at
`<agentDir>/pie-task-locks/<sha256(projectKey)>.lock`, so two servers — a second checkout, or a
stale process — cannot both drive the same project. Different projects have different lock files
and may be driven at the same time.

```
getTaskOrchestrator(projectKey, cwd)
  └─ start()
       ├─ take this project's lock, recoverInterrupted(projectKey), set its state RUNNING
       └─ loop:
            if this project is PAUSED or stopping: stop
            if a chat session is running in this project:
                 wait until it ends (pause/stop still break the wait)
            task = claimNext(projectKey)
            if task is null:
                 state = IDLE, notify "project queue complete", stop
            else:
                 run(task)            — see below
                 on DONE: continue
                 on BLOCKED/FAILED: state = PAUSED with the reason, notify, stop
```

The liveness check runs before each claim, not during a run. A conversation that starts while a
queued task is executing is allowed to run beside it; the queue does not abort or pause the task.
After that task ends, the next claim waits for the conversation, so the queue never starts a second
piece of queued work while chat is active. The board overlays running sessions on the stored queue
state, so a project with only a running conversation still appears in the Active section.

A small process-wide watcher (`lib/tasks/chat-watcher.ts`) starts a project's loop when a non-task
chat is running and that project has pending work. This is what makes "a running chat has started
the queue" true even if nobody pressed Start: the loop reports RUNNING, waits for the chat, and
claims the pending task when the chat ends. A queue explicitly paused by the person is never started
by the watcher.

Recovery at startup walks the stored project summaries. A project whose lock is free and that has
an interrupted `IN_PROGRESS` row is blocked and paused; a project whose lock is held by another
server is left alone, because that server owns it. The dashboard can start another project while
one is paused: nothing global gates the loops.

`run(task)`:

1. Build the prompt (`lib/tasks/prompt.ts`): the description (or the title when it has none), the
   verification commands, and the working directory. Standard mode says a question is available;
   autonomous mode says to decide and keep working. Both require the work to happen in this directory and a final report.
2. Start a fresh SDK session through `startRpcSession` with its stable session id and title, the
   selected preset, the queue's model, and the standing instructions as a system-prompt append. The session
   immediately joins the ordinary registry, so chat can open it.
3. Send the prompt and wait for `agent_settled`. In autonomous mode, send
   `/goal <task prompt>` instead and wait for the goal package to report `complete` before settling;
   an intermediate `agent_settled` is a continuation point, not task completion. Events update the
   board activity and a bounded in-memory tail (64 KiB). A watchdog aborts and settles the task as
   `FAILED` after the task timeout (60 min default).
4. `lib/tasks/gate.ts` runs the verification commands in the task's `cwd`. Non-zero or timeout means
   `BLOCKED`. The failure carries the command's own output: its first line goes into the pause
   reason, a bounded tail into the result summary, and the full text stays on the board as
   `verify_output`. `exit 1` alone is not actionable; `'sleep' is not recognized` is. Each command
   is one command line for `cmd.exe` on Windows and `/bin/sh` elsewhere — not the session's own bash
   — so quoted arguments and `&&` chains work everywhere, while POSIX-only tools (`sleep`, `bc`) do
   not. The run prompt says so, and the queue defaults dialog repeats it.
5. `settle`, including the session id and a short summary. Successful SDK runs report exit code 0;
   an abort or a failed run reports no process exit code.

Control operations:

| Operation | Effect                                                                                                            |
| --------- | ----------------------------------------------------------------------------------------------------------------- |
| `start`   | Acquires the lock, recovers, runs the loop. Refused while one is running.                                         |
| `pause`   | Sets `PAUSED`; takes effect between tasks, never mid-run.                                                         |
| `resume`  | Clears the pause and restarts the loop.                                                                           |
| `abort`   | Sends `abort`, waits for the session to settle, then destroys it after the grace period; settles the task as `BLOCKED` (`aborted by user`) and pauses the loop. |

Aborting settles as `BLOCKED` rather than rolling back to `PENDING`, because an abort usually means
"this task is wrong": rolling it back would let `resume` immediately repeat the same mistake.
Explicit `retry` is the way back.

Shutdown: `server/instrumentation.ts` already owns SIGINT/SIGTERM handling for streams and
sessions. It calls `shutdownTaskOrchestrators()`, which aborts every live project loop in turn and
settles each active task as `BLOCKED`, so a server restart never leaves an agent writing into a
directory the user believes is idle.

Notifications reuse the existing Web Push path (`lib/web-push.ts`, `server/api/push`): queue complete,
task failed or blocked, and — importantly — a question waiting.

## A question during a task

Tasks use the same `ask_user` extension and the same extension-UI channel chat uses.

- **Recognition.** The runner treats a `select` or `input` request carrying the ask-user
  presentation metadata as a question. Any other extension dialog receives `cancelled: true`
  because nobody is guaranteed to be watching.
- **Presentation.** The question is stored on the task (`pending_question`, JSON with the request
  id, question, and options), so a reload of the board still shows it. It renders through the task
  workspace and, because the task session is an ordinary session, above the chat composer too.
- **Answering.** Choosing an option or typing text sends one `extension_ui_response` with `value`;
  the inline ask_user card accepts both in one response. Dismissing sends `cancelled: true`, which
  the tool reports as "not an answer".
- **Policy.** There is one global mode. `full` keeps `ask_user` available and the queue waits for
  the answer; `autonomous` omits the tool and starts a goal instead, so the agent must decide and
  keep working. The timeout stays a watchdog, not an answer.
- **Intervention.** A running task's session is fully interactive in chat: the transcript streams
  live, the composer can steer or follow up the same run, the question card is answerable, and goal
  pause/resume controls work through the same session commands. A steer joins the run the queue is
  already waiting on; it does not start a second writer.

One question at a time: the tool is `executionMode: 'sequential'`, and a project runs one queued
task at a time. A chat session may run beside the waiting task; that does not answer the question.

## Verification gate

Defaults live in `<agentDir>/pie-task-orchestrator.json`; every field is optional. The only
per-task override is `verify_commands`. The autonomous switch is global on purpose: it describes
whether the person is at the computer, not a different policy for each project.

```json
{
  "model": null,
  "verifyCommands": [],
  "verifyTimeoutMs": null,
  "taskTimeoutMs": null,
  "// timeouts": "a positive number of milliseconds, or null for no limit",
  "autonomous": true,
  "instructions": ""
}
```

The first-install defaults are no time limit for either watchdog and autonomous mode on; the file
is written once the board saves a change, and an unconfigured field falls back to these defaults.

- `model` is the queue's own model for the next run, `{ "provider", "modelId" }` or `null` for Pi's
  default. The board writes it through `PUT /api/tasks/config` (the chip in its header, and the same
  selector inside the queue defaults dialog); the SDK session starts on it, and a run already in
  flight keeps the model it started with.
- The board's **Queue defaults** dialog (`components/QueueSettingsDialog.tsx`, opened from the
  slider button beside the model chip) edits the global defaults: the model, both timeouts, the
  standing task instructions, the verification commands, and **Autonomous decision mode**. The route
  validates each field and writes only the ones it was sent, so a patch never rewrites a field the
  dialog did not touch.
- **Autonomous decision mode** is one switch for every project and queue. On: tasks use the
  `autonomous` tool preset (full coding tools), `ask_user` is absent, and a goal is started so the
  agent keeps working until it reports completion. Off: tasks use standard mode (`full` preset) and may ask a
  question, which leaves the task waiting for a person.
- A timeout is one number plus a unit (minutes or hours; switching converts the number so the
  duration survives), or **No limit**, which replaces the number with `∞` and stores `null`. `null`
  means the watchdog is absent, not zero: the runner arms no abort timer and the gate spawns each
  command without a kill timer. A malformed value in the file still falls back to the built-in
  number, so a typo cannot silently remove a limit. **Restore defaults** fills the dialog from
  `lib/tasks/defaults.ts` without saving; Save still decides, Cancel leaves the stored values alone.
- Each command runs in the task's `cwd` through the platform shell (`cmd /c` on Windows, `sh -c`
  elsewhere), with the process tree killed on timeout. The timeout applies per command. Commands are
  the user's own configuration, so this is not an input-validation boundary; the file is written by
  the app or edited by the user, never by a task.
- An empty list means "no gate": the task is `DONE` when the session settles successfully (and, in
  autonomous mode, its goal reports complete), and the board says so plainly rather than implying
  verification happened.
- A failure settles `BLOCKED` with the tail of the failing command's output.
- Reading verification commands from a project's `.pi/` directory is not part of the first version:
  a queued run must not be configured by files inside the repository it is changing.

## Task instructions

The queue does not commit, branch, push, or otherwise interpret Git. A person who wants a run to
commit writes that rule as a standing instruction in the queue defaults; the agent sees it in every
task session and decides how to follow it.

- Write only rules that apply to every task in the queue. A git rule ("commit your changes") costs a
  full step in a directory that is not a repository, and the queue cannot know which one it is.
- `instructions` is free text (up to 20,000 characters) stored in
  `<agentDir>/pie-task-orchestrator.json` and edited in the **Queue defaults** dialog. An absent or
  malformed value means no instructions.
- `lib/append-system-prompt-extension.ts` appends it to every task session's system prompt, prefixed
  with a `Pie task queue instructions:` label. An empty value adds no extension, so the session's
  system prompt is exactly Pi's own. The task prompt in `lib/tasks/prompt.ts` stays task-specific.
- It is a soft constraint by design: the queue still verifies with `verifyCommands` and settles from
  the session outcome, but it never inspects `.git`, stages files, or creates commits. Examples:
  "commit your changes when the task is done", "leave the working tree clean", "run the tests before
  you report".
- The built-in prompt still forbids branches, worktrees, pull requests, and pushes. Instructions
  narrow behavior; they do not grant a publish workflow.

## HTTP API

All routes are under `/api/tasks` and sit behind the shared `server/middleware/security.ts` origin
check, the optional web password, and the `json()` helper in `server/http.ts`.

| Route                         | Purpose                                                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/tasks?cwd=…`        | One project: `{ project, tasks, runs, orchestrator, projects, config, watch }`; `no-store`. `projects` is every queue's summary; `orchestrator.activeSessions` and each summary's `activeSessions` overlay running chat. Without `cwd`, the running or most recently updated project is chosen. |
| `POST /api/tasks`             | Create. Body: description, cwd, verify_commands, and optional title. Returns `{ task, project }`. The first line of the description becomes the title when title is absent. |
| `GET /api/tasks/[id]`         | One task and the project it belongs to; used to resolve a `?task=` deep link that has no `cwd`.                              |
| `PATCH /api/tasks/[id]`       | `{ action: 'update' \| 'move' \| 'retry' \| 'markDone' }`. `409 task_locked` while running.                                 |
| `DELETE /api/tasks/[id]`      | Same guard, same error.                                                                                                     |
| `POST /api/tasks/control`     | `{ action: 'start' \| 'pause' \| 'resume' \| 'abort', cwd?, id? }`. `cwd` names the project; `id` resolves it for `abort`.  |
| `POST /api/tasks/[id]/answer` | `{ answer?: string, cancelled?: boolean }` for the pending question.                                                        |
| `GET /api/tasks/[id]/output`  | The live tail of the active task, from the in-memory buffer.                                                                |

Validation mirrors the rest of the app: bounded body, `cwd` must exist and be readable through the
existing file-access allow-list, and no path is ever accepted from the client for anything but a
working directory. Errors are `{ error, code }` with `409` for a locked task, `400` for invalid
input, `409` for orchestration conflicts (`already_running`, `no_pending_question`).

## Interface

The board is a second workspace, not a second dashboard grafted onto the conversation. It is
delivered in two steps so the chat surface is never destabilized by a navigation rewrite.

### Step 1 — a task workspace reachable from the sidebar

- `AppShell` gains a workspace switch driven by `?mode=tasks`, rendered as `<TaskWorkspace>` in
  place of the conversation and composer. With the parameter absent, nothing about the current chat
  view changes. No second entry point, because `src/main.tsx` already owns `I18nProvider` and a
  second mount would have to repeat the provider tree. The parameter name is the one the tabs use in
  step 2, so the URL never changes. `?task=<id>` opens one task directly, which is the URL a Web Push
  notification links to.
- The workspace keeps the app's toolbar. In task mode the left panel is a project list instead of
  the conversation tree: one row per working directory, with its queue state, the running task or
  chat, and the number queued. A project with tasks but no conversation is still listed, and "Add
  project" opens the same directory picker the task form uses. The center column is one work
  surface for the task being read, and the board sits in the same right-hand panel the Runs panel
  uses in chat. The board has a Chats section above the active queue groups (running, queued, and
  blocked) and a Finished drawer below them; a conversation that also has a queue task is
  represented by that task, so the same work never appears twice. The Chats section holds only
  live work: a conversation leaves the board when it goes idle, because the panel is the queue
  and the Finished drawer is the only place finished things appear. A conversation that starts
  running appears immediately as a "New chat" row even before its first message is persisted;
  only task mode asks for transient draft sessions, so the chat sidebar's behaviour is unchanged.
- Clicking a project switches the board and the work surface to that project. The project is a URL
  parameter (`?mode=tasks&cwd=<path>`), so a reload, a new tab, and a Web Push deep link all reopen
  the same project. A chat session that starts running moves its project to the active section and
  is selected; the board's header says how many chats are running. Without a `cwd` the server
  opens the project with running work, or the most recently updated queue.
- The queue panel is docked on desktop, open until collapsed, and resizable from its left edge with
  the same handle, limits and remembered width as the Runs panel; its own header closes it. A
  `Task board` chip in the task bar shows the size and a running mark while the panel is closed
  and reopens it. Settings hides the panel without collapsing it. Its collapse choice is independent of
  the Runs panel's, so the two modes keep their own arrangements.
- Task ids exist only for route and tool addressing. The board, task session names, Web Push
  notifications, prompts, and queue summaries use the task title instead of a `T<id>` prefix.
- The chat rows use the same row language as queue tasks: status marker, title, working directory,
  message count, and a status word. Running chats sort first. Selecting one opens a small summary
  with the full title, session id, last activity, and an "Open chat" action; double-clicking the row
  opens the conversation directly. The active queue groups carry a status marker, title, working
  directory, and, once a task has run, its attempts and elapsed time. The group heading carries the
  status for queued and running rows; a failed row names its status because its group also holds
  blocked ones. Finished tasks live in one collapsed drawer at the panel's bottom edge; its header
  keeps the count and the clear action reachable, opens newest first, and remembers the fold. The
  arrow keys reorder. Keyboard: `↑`/`↓` move within the queue, `Enter` edits, `Delete`
  removes, all disabled with an explanation while a row is running.
- Several tasks can be acted on at once. Shift+click selects the range between the anchor and the
  row clicked, Command/Ctrl+click adds or removes one row, `Command/Ctrl+A` selects the queue and
  `Shift+↑`/`↓` extends the selection, so no pointer modifier is the only way in. On a phone, where
  there is no modifier, a row's menu offers "Select". A multi-selection replaces the work surface
  with the batch actions (duplicate, delete, clear) and states how many tasks are selected, so the
  count is never color-only. Duplicating a selection appends the copies and selects them; deleting
  several asks once in the same popover the row menu uses, because there is no undo.
- Completed tasks fold into the Finished drawer. Its header carries the count and a trash button
  that removes every `DONE` record in a single confirmation. It is the answer to a queue that
  accumulates finished work; tasks that are still queued, running, or waiting on a person are never
  part of it.
- Every queue row also carries a menu (`⋯`, right-click, or the keyboard's `Shift+F10`/menu key)
  with select/deselect, edit, move up/down, duplicate, copy, paste, open session, and delete. Move is
  offered only inside the queued segment; duplicate and paste append a copy at the end and select
  it; copy keeps the editable fields in `localStorage`, so the clipboard survives a reload. On a
  phone the same menu is a bottom sheet, and an empty queue's right-click offers "New task" and
  "Paste".
- The global task defaults are edited in one dialog opened from the queue's own bar, next to the
  model chip: model, timeouts, the standing task instructions, verification commands, and the
  Autonomous decision mode switch, with Save pinned while the body scrolls.
- The new-task form asks for a description only. Its first non-empty line becomes the title; an
  explicit title from the `task_manager` tool still wins, and a legacy title-only task opens with
  its title as the description text. There is no separate title field on the board.
- The working-directory field in that form is the chat shell's `DirectoryPicker` behind a "Choose
  folder" button, with the same validation call the composer uses. Typing a path works too: Save
  validates first, and a rejected directory leaves the form open with the reason under the field
  instead of failing the create request.
- Editing opens the task in the center work surface: status, description, a facts sheet, the
  pending question, the activity line, and the live tail, with the actions in a footer that sticks
  while a long tail scrolls. The new-task form uses the same surface, so the first task can be
  created from an empty queue. Where the queue panel cannot dock, the queue takes the center column
  and the work surface becomes a full-height sheet; Close or Escape returns to the queue instead of
  reopening on the fallback selection.
- A running queued task shows one activity line (the same vocabulary as the chat composer: waiting,
  thinking, reading, running a command) plus a collapsed transcript tail. "Open session" navigates
  to `?session=<id>`, that is, into the ordinary conversation view, where the work can be read in
  full. A chat row's "Open chat" does the same for a conversation the person started by hand.
- `Start queue` remains available while a chat is running. The loop takes the project lock and
  reports `RUNNING`, but holds its next claim until the chat ends; `Pause` and `Stop` still interrupt
  the wait. Starting a queue beside a chat therefore never blocks or aborts the chat.
- A pending question appears in two places, both already styled: above the work surface, and in the
  task's pane. It answers through `AskUserPanel`'s existing request shape rather than a second
  component.
- Polling: 1 s while any project is running, a chat is running, or a question is pending, 5 s
  otherwise, suspended while the page is hidden and refreshed once on return. Each poll returns all
  project summaries, so the project panel stays current without one request per project. The shell
  also polls live session ids in task mode, so a new or running conversation becomes a row without
  a reload. No new SSE machinery.
- Accessibility and responsiveness follow `docs/design.md`: semantic theme variables, visible focus,
  keyboard-only operation, reduced-motion respect, and the narrow layout keeps the queue in the
  center with the detail as a full-height sheet.

### Step 2 — two modes behind one top bar

The built version is narrower than the original sketch: it covers the switch, the toolbar migration,
and the queue's move into the right-hand inspector slot, and leaves the per-tab mode memory out.

- The page header carries the sidebar toggle and one segmented control, `Chat | Tasks`. It is
  navigation, not a tab set with panels: each choice is a real URL (`/` and `/?mode=tasks`), the
  active one carries `aria-current="page"`, and both are ordinary links, so reload, a new tab, and a
  Web Push deep link all land in the right view.
- The switch and the shell never move between views: the toolbar keeps its row, the center column
  swaps the conversation for the task work surface, and the right-hand inspector swaps Runs for the
  Queue. The left panel is mode-specific: chat lists conversations, tasks lists projects. Settings
  stays in the sidebar footer, so the task view has no second Settings entry. A task's "Open
  session" leaves for that conversation; the `Chat` segment returns to the conversation the active
  project last had open.
- The task bar, directly below the shell toolbar and the same height, groups the project identity
  with the queue state and the Standard/Autonomous mode chip, then the model chip and icon controls.
  One primary icon starts, pauses, or resumes according to the queue state; Stop and New task are
  separate icons. Finished tasks have their own collapsed drawer instead of an always-open group.
  Its empty or unselected surface explains what it shows instead of leaving
  the column blank.
- The session actions that used to share the header (full history, generate title, branches, system
  prompt, tools, token statistics) moved into the Runs panel, above the runs: a two-column grid of
  quiet action rows and one statistics card that opens the session dialog. They describe the
  session, not the next message, and the panel is part of the default page.
- Because that panel can be collapsed, closed on phones, and hidden by Settings, the moved actions
  are one click away rather than always visible: the toolbar's right-edge toggle reopens the
  panel. There is no separate overflow button; the retired phone `more` popover is gone with it.
- `?mode=tasks` wins over the remembered session: the tab-memory restore is skipped in that view, so
  a reload of the task workspace cannot replace its URL with `?session=`.
- Not built: `?mode=chat`, a mode-specific inspector that shows the task detail in task mode, and
  the per-tab mode memory in `lib/tab-session.ts`.
- `docs/design.md` is updated in the same change.

### A running task's session stays interactive in chat

While a task is `IN_PROGRESS`, its session is the same SDK session chat opens, and the composer is
enabled. The transcript streams live; a prompt uses the ordinary SDK steering path and joins the
run the task runner is already waiting on, rather than opening a second session. Follow-ups and
goal controls use the same session commands. The queue still settles from `agent_settled`, so extra
turns keep the task running until the agent actually stops.

The board learns which sessions belong to the queue from `lib/tasks/active-sessions.ts`, a global
set of session ids the task runner is driving. The set is informational: it keeps a running task's
session in its task row instead of listing it as separate chat work. Deleting the queue removes
that overlay; the session remains an ordinary chat.

## Security and failure containment

- A task session is never the first thing to trust a repository's local extensions: it uses the
  same project-trust decision chat uses, so an untrusted project's extensions are not loaded.
- A task's `cwd` is validated like any other working directory and stays inside the same allow-list
  the file routes use. That allow-list is durable: approvals are written to
  `<agentDir>/pie-allowed-roots.json`, so a directory picked once stays allowed after a restart, and
  the queue also accepts a directory already stored on a task. The form resolves a candidate through
  `POST /api/cwd/validate`, the endpoint the chat shell already trusts, so a picked folder joins
  that allow-list and `~`/relative paths resolve the same way in both places; `lib/cwd-path.ts` is
  the one spelling of that resolution.
- The queue writes only inside its own database, its per-project lock files, its agent sessions, and — when
  explicitly enabled — the task's repository index.
- A verified task never becomes `DONE` because of a lost session; a failed run is always `FAILED`.
- Verification is a separate process with its own shell. It inherits the environment, so a command
  cannot borrow the task session's shell configuration or its working state.
- Nothing in the queue calls an LLM to decide anything. Every transition is mechanical.
- A task session runs with the same credentials as the user's own sessions. The queue must not be
  exposed to an untrusted network: it starts agents that can edit files on the machine.

## Verification

Testing is manual; the project keeps no tests and no test runner. Walk the queue by hand: create a
task in one project, start its queue, and watch one attempt run to `agent_settled`; fail a
verification command to confirm that project pauses; then create a task in a second project and
start both queues at once, confirming the two tasks run concurrently while a third task in the
first project waits behind the running one. Then start a chat in the first project while its queued
task runs: the chat must keep running, and after the queued task ends the next queued task must wait
until the chat is idle. Add a pending task and start only the chat: the queue should become running,
wait, and claim the task when the chat ends. Restart the server and confirm nothing is left
`IN_PROGRESS` and each project's state is consistent.

## Implementation phases

| Phase        | Deliverable                                            | Exit criterion                                                                                  |
| ------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| 1            | `store` + `queue`                                      | Guards and ordering verified without any agent involved.                                        |
| 2            | `runner` + `prompt` + SDK session integration          | A real task runs one prompt to `agent_settled`, asks a question, and aborts on request.          |
| 3            | `gate` + `orchestrator` + lifecycle wiring + routes    | A queue drains on its own; a failed gate pauses it; a restart leaves nothing running.    |
| 4            | `TaskWorkspace` + `?mode=tasks` + i18n + docs          | The queue is fully operable from the browser, keyboard included.                                |
| 5 (optional) | Mode switch, toolbar migration, inspector panel        | Chat is unchanged in behavior, with the moved actions still reachable when the panel is hidden. |

## Implementation status

| Phase        | What exists now                                                                                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1            | `lib/tasks/store.ts` and `lib/tasks/queue.ts`. Schema `user_version = 7` (per-project queues, events, autonomous column removal), WAL, per-process singleton, SQL guards for claim/update/delete/rank scoped by project. |
| 2            | `lib/tasks/runner.ts`, `lib/tasks/prompt.ts`, and the shared `startRpcSession` runtime. One SDK session per attempt, ordinary session registry and event stream, `ask_user` round-trip, abort and forced shutdown. |
| 3            | `lib/tasks/gate.ts`, `lib/tasks/orchestrator.ts` (one loop and one lock per project), `server/instrumentation.ts` shutdown, and the `/api/tasks` routes. Project trust is the same decision chat uses; `lib/tasks/active-sessions.ts` is the only module chat imports. |
| 4            | `components/TaskWorkspace.tsx`, `components/TaskProjectsSidebar.tsx`, `?mode=tasks`/`?cwd=`/`?task=` in `AppShell`, `styles/tasks.css`, and task keys in all three locales.                                                                                          |
| 5 (optional) | The `Chat | Tasks` switch in both page headers, and the session actions moved into the Runs panel (`components/SessionPanelActions.tsx`). Not built: the mode-specific inspector and the per-tab mode memory. |

Queue defaults live in `<agentDir>/pie-task-orchestrator.json`, one global file read on every run so
an edit applies to the next task in every project. Each project's lock is
`<agentDir>/pie-task-locks/<sha256(projectKey)>.lock`. The shared runtime loads `ask_user` for chat
and standard-mode tasks; autonomous tasks omit it and use the goal package already shipped with Pie.

## Invariants to preserve

- One `IN_PROGRESS` row per project at most, enforced by the project-scoped claim transaction, not
  by the loop.
- Every task attempt is a new SDK session; a session is never reused for a second attempt. Different
  projects may have one attempt each at the same time.
- `IN_PROGRESS` tasks cannot be edited, deleted, or reordered — from any client.
- A task's terminal state is written with its run record in one transaction.
- An aborted or restarted task leaves no running SDK session; the runner sends abort and destroys
  the session after the grace period.
- The chat experience and the Pi agent runtime keep working if the queue is deleted.

## Agent orchestration

The queue is operated by a person from `?mode=tasks`. [Orchestrator](orchestrator.md) adds the
second operator: any chat session on the Orchestrator preset, with one project-scoped queue tool
and a durable event feed.

What it does not change here:

- The queue still owns scheduling. The session's tools call the same `QueueController`, so the
  guards in this document apply to both operators.
- The interface stays two modes. The manager is a chat session on the Orchestrator preset, so
  `?mode=tasks` and the queue board keep working unchanged, and a session not on that preset never
  sees the tool.
- The queue remains deletable: the feature lives in one extension factory, one tool module, and one
  preset entry, plus the loadout branch in `lib/rpc-manager.ts`.

## Open decisions already settled

| Decision               | Value                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| Execution boundary     | In-process Pi SDK session per queued task; one queued task at a time per working directory, chat may run in parallel |
| Task working directory | Stored per task and the project key; different projects can run at the same time                  |
| Abort outcome          | `BLOCKED`, loop paused                                                                            |
| `ask_user`             | Standard mode only; wait indefinitely, Web Push, abort as the exit. Autonomous mode omits it and starts a goal. |
| Verification commands  | One global config plus per-task override; no per-project config in the first version              |
| Task instructions      | Free text in the queue defaults, appended to every task system prompt; soft constraints only      |
| Storage                | `node:sqlite` database in the agent directory                                                     |
| Interface roll-out     | Task workspace first, two-mode top bar second                                                     |
