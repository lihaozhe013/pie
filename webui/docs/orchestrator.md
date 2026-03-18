# Orchestrator: agent-driven queue control

**Status: implemented.** This document describes how an agent drives the per-project task queues in
[Tasks](tasks.md). The manager is no longer a dedicated project, page, or extension loaded by a
working-directory check. It is a tool preset: **Orchestrator** is the full coding loadout plus one
`task_manager` tool, available in any conversation and scoped to that conversation's project.

## What it is

A person can operate a queue from `?mode=tasks`. The Orchestrator preset adds a second operator: an
ordinary chat session that can read, create, reorder, start, stop, and answer tasks for the project
it is already in. It is not a separate agent runtime, a project, a daemon, or a second protocol.

The preset is deliberately additive:

```
full coding tools  +  task_manager
```

The coding tools are the ordinary `bash`, `read`, `edit`, `write`, `grep`, `find`, and `ls` tools.
`task_manager` is one tool with an action parameter; its methods call the same queue controller and
orchestrator the board uses.

Any conversation may select Orchestrator. Two conversations in the same project can both have it,
and nothing tries to coordinate them beyond the queue's own guards. The default expectation is that
the person will not run two orchestrators against one queue at the same time.

## Boundary

- **Allowed:** one `task_manager` tool in any session on the Orchestrator preset, or in a custom
  preset that opts into it.
- **Allowed:** reading and changing every task in the session's own project, starting and stopping
  that project's queue, and receiving that project's queue events.
- **Still refused:** subagent spawning or control, parallel queued-task execution inside a project,
  agent profiles, worktrees, a second agent protocol, raw SQL access to the task database, and any
  cross-project task operation.

The queue remains the scheduler. One `IN_PROGRESS` row per project, fencing tokens, an immutable
running task, verification commands, and the path allow-list all apply exactly as they do to the
board.

## Why a preset instead of a project

Pie previously gave the manager a dedicated real directory, `<agentDir>/task-manager`, so the
server could inject its tools by `cwd`. That worked, but it made the manager a second place to look
and a special project in the sidebar. The preset model is simpler:

- The composer already has a tool selector; Orchestrator is one more built-in entry there.
- A session's `cwd` is already its project identity, so the tool needs no project argument.
- The loadout is built once in `startRpcSession`, where the server already knows the session mode.
- No directory is created, no `AGENTS.md` is written, and no `/api/tasks/manager` route exists.

An old `<agentDir>/task-manager` directory is not deleted or migrated. If it exists, it is an
ordinary directory and its conversations are ordinary conversations; the only way to give them
queue tools now is to select Orchestrator.

## Preset and loadout

`lib/tool-presets.ts` defines:

```ts
export const ORCHESTRATOR_TOOL_PRESET = 'orchestrator';

export function getToolNamesForPreset(preset) {
  if (preset === ORCHESTRATOR_TOOL_PRESET) return [...PRESET_FULL];
  // ...
}

export function getWorkModeForPreset(preset) {
  if (preset === ORCHESTRATOR_TOOL_PRESET) return 'orchestrator';
  // ...
}
```

The work mode (`lib/work-mode.ts`, custom entry `pie:work-mode`) is how a tool list that is equal to
`full` is still recognized as Orchestrator. The mode travels with the session in
`GET /api/sessions/[id]` and `get_tools`, just as Plan and Autonomous do.

`startRpcSession` loads the extension for the Orchestrator mode, or when a custom preset names the
`task_manager` tool:

```ts
const orchestratorMode =
  readWorkMode(sessionManager.getEntries() as SessionEntry[]) === 'orchestrator';
const taskManagerMode = orchestratorMode || activeToolNames?.includes('task_manager') === true;

// ...
extensionFactories: [
  ...builtins,
  // ...
  ...(taskManagerMode ? [createTaskManagerExtension()] : [])
]
```

Switching to or away from Orchestrator, or adding/removing `task_manager` in a custom preset,
crosses a loadout boundary. `setRpcSessionTools` rebuilds the session in that case, so the tool is
registered or removed immediately. Plan and Autonomous still change only prompt behavior and do
not need a rebuild.

The other built-in presets never register `task_manager`. A custom preset may opt in by checking
the tool in Settings › Tools. A task session started by the queue uses the full or autonomous
preset and therefore has no queue control tool.

## Scope: one project, no cwd argument

The session's working directory is the project. `TaskTools` stores it at construction:

```ts
readonly cwd: string;
readonly projectKey = projectKeyOfCwd(cwd);
```

Consequences:

- `create` uses `cwd` for every new task. There is no `cwd` parameter and no `authorizeCwd`.
- `list`, `events`, and the queue snapshot read only that `projectKey`.
- `update`, `move`, `delete`, `retry`, `mark_done`, and `answer` call `taskFor(id)` first. That
  function loads the task and refuses it with `wrong_project` if its `project_key` differs.
- `start`, `pause`, `resume`, and `abort` resolve the orchestrator from the session's `cwd`.
- Clearing completed tasks clears only the current project.
- Event reads pass `projectKey` into `store.readSessionEvents` / `listEventsSince`, so a digest
  never contains another project's work.
- A tool result carries a one-element `projects` array: the current project's queue snapshot.

Task ids remain numeric and internal. The UI, session name, push notification, and prompt never show
`T<id>`; the tool needs the id only to address a row.

## The tool

One tool, `task_manager`, with an `action` parameter. The actions map to existing controller calls;
no action contains SQL.

| Action      | Parameters                                                        | Backing code                                      |
| ----------- | ----------------------------------------------------------------- | ------------------------------------------------- |
| `list`      | `status?`, `includeRuns?`                                         | `queue.listTasks(projectKey)`, `listRuns`         |
| `create`    | `description?`, `title?`, `verifyCommands?`                       | `queue.createTask` with the session `cwd`         |
| `update`    | `id`, `title?`, `description?`, `verifyCommands?`                 | `queue.updateTask`; cwd cannot be changed         |
| `move`      | `id`, `direction?` or `position?`                                 | `queue.moveTask`                                  |
| `delete`    | `id` \| `ids` \| `completed`, `confirm`                           | `queue.deleteTask`; done ids only in this project |
| `start`     | none                                                              | `orchestrator.start`; starts the watch            |
| `pause`     | `note?`                                                           | `orchestrator.pause`                              |
| `resume`    | none                                                              | `orchestrator.resume`                             |
| `abort`     | `id?`, `confirm`                                                  | `orchestrator.abort`                              |
| `retry`     | `id`                                                              | `queue.retryTask`                                 |
| `mark_done` | `id`, `note?`, `confirm`                                          | `queue.markDone`                                  |
| `answer`    | `id`, `answer?` \| `cancelled`                                    | `orchestrator.answer`                             |
| `events`    | `afterId?`, `limit?`, `waitMs?` (at most 50 s)                    | project-filtered event cursor                     |
| `watch`     | `watch`: `on` \| `off` \| `status`                                | the extension's project-scoped watch              |

`create` accepts a description alone; its first non-empty line becomes the title. An explicit
`title` is optional.

`task_manager` deliberately has no queue-defaults action. The defaults in
`<agentDir>/pie-task-orchestrator.json` are global and are edited in the board's **Queue defaults**
dialog. A tool scoped to one project should not silently change another project's defaults.

Errors use the same codes the board handles: `invalid_input`, `task_locked`, `task_not_found`,
`already_running`, `no_pending_question`, `confirmation_required`, and `wrong_project`.

## Event delivery

`lib/tasks/store.ts` keeps `task_events` and `task_event_cursors` in the queue database. The tool
scope is applied at the store layer, so the same cursor cannot leak another project's event.

### Pull

Every successful or refused tool result includes the current project snapshot and the project
events this session has not seen. A session that never watches still sees every transition the next
time it acts.

### Push: `watch`

`action: "watch", watch: "on"` (or `action: "start"`) starts a watch. It:

1. Polls `task_events` every 1.5 s, filtered by the watch's project, and peeks before advancing the
   cursor.
2. Sends only while the session is idle; a busy session keeps its events unseen until its turn ends.
3. Coalesces events into one digest and sends it with
   `pi.sendMessage({ customType: 'pie-task-event', ... }, { triggerTurn: true, deliverAs: 'followUp' })`.
4. Ends when this project's queue is idle after work, after 100 wakes or two hours, or when the
   session asks to stop.
5. Registers a liveness provider so idle eviction does not kill the watch.

The digest names only the current project:

```
- settled DONE in /repo: bun run typecheck passed
queue: repo IDLE, wake 1 of 100, as of 2026-01-01T14:35:12.000Z
```

One watch row exists per process. A second live watcher is refused with `watch_held`; starting a
second orchestrator conversation is allowed, but only one of them can hold the push watch at a
time. This is a transport budget, not a project lock.

On `session_start`, an orchestrator session replays the project's unseen events as one
non-triggering digest. A restart therefore tells the session what changed without spending a model
turn.

## Questions

In Standard mode a task may ask a question through `ask_user`. The orchestrator receives it in the
same digest and can call `action: "answer"`. In Autonomous mode tasks have no `ask_user` tool and no
pending question; the goal drives completion instead.

Policy:

- Relay the question by default. State the options and wait for the person.
- Answer directly only when the person told the orchestrator to decide.
- Dismissal is not consent. Report `cancelled` and continue with a stated assumption.

## Interface

- **Entry point.** The composer's tool selector lists **Orchestrator** beside Plan, Autonomous, and
  the coding presets. It appears in every project. There is no task-manager button in the task bar
  and no `/api/tasks/manager` route.
- **Board.** `?mode=tasks` is unchanged. The board is where a person inspects work; chat is where
  they talk to an orchestrator about it.
- **Watch state.** `GET /api/tasks` still includes the one watch row, so the board can say a session
  is listening.
- **Event cards.** Wake digests render through the generic `pie-task-event` custom-message card.
- **Origin marker.** A task shows a "Chat" mark when a session queued it; the source is
  `created_by`, not the description.

## Security and failure containment

- No tool accepts a project path. The session `cwd` is the only project authority.
- Task ids from another project are refused with `wrong_project`; list, events, queue state, and
  clearing completed tasks are project-filtered.
- The queue controller remains the write path, so path validation, command bounds, the one-running
  claim, and fencing tokens are unchanged.
- `delete`, `abort`, and `mark_done` require `confirm: true`; the model is told to ask first.
- The built-in presets other than Orchestrator, and every task run, do not load the tool. A custom
  preset can opt in explicitly; the browser can then include `task_manager` in `set_tools`, but no
  other tool name is added implicitly.
- Two orchestrator sessions can still issue conflicting queue commands. That is deliberate: the
  queue's state guards make each command safe, and the person is expected not to run two at once.
- The watch is bounded in wakes and time and is released on `session_shutdown`.

## Verification

Testing is manual; the project keeps no tests. Use a scratch project:

1. Select Orchestrator in a new conversation in that project. Confirm `get_tools` reports
   `workMode: "orchestrator"` and an active `task_manager`.
2. Ask the agent to call `action: "list"`; confirm it reports only this project's queue.
3. Create a task, edit it, reorder it, then delete it.
4. Create a task in a second project from the board, then ask the first session to update that id.
   Confirm `wrong_project`.
5. Switch the session to Full. Confirm `task_manager` disappears. Switch back to Orchestrator and
   confirm it returns.
6. Start the queue and confirm the watch wakes the session when the task settles.

## Settled decisions

| Decision        | Value                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------ |
| Shape           | A built-in tool preset, not a project, page, daemon, or subagent runtime                    |
| Preset          | `orchestrator`: full coding tools plus the one `task_manager` tool                          |
| Scope           | The session `cwd` and its `projectKey`; no cwd argument and no cross-project ids            |
| Loadout         | `startRpcSession` registers the extension only in Orchestrator mode; switching rebuilds     |
| Tool surface    | One action-based tool over the queue controller; no raw database access                    |
| Defaults        | Global queue defaults stay in the board's Queue defaults dialog, not in the project tool    |
| Status delivery | Durable, project-filtered events pulled by every tool result and optionally pushed by watch |
| Concurrency     | One queued task per project; different projects may run in parallel; duplicate orchestrators are allowed but not coordinated beyond the queue guards |
