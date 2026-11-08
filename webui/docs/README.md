# Project Direction

## A minimal GUI for Pi

Pie centers on one workflow: choose a directory, send Pi a message, watch it work, and continue the
conversation.

Pi supplies the agent capabilities. This project improves the visibility and usability of the CLI
workflow, without replacing Pi or creating a parallel configuration, extension, or execution system.
Visualizing the CLI does not require a graphical manager for every command or setting.

Minimal describes the result, not the goal. The goal is reviewable signal: show what lets the user
review the agent's work and judge whether it is on track, and hide what does not serve that — long
exploratory output, raw dumps, and other detail that cannot be read at a glance. A quiet interface
is worth having only because it leaves that signal visible.

Priorities: smooth conversation, clear execution feedback, a quiet and polished interface, then
feature count.

## Positioning in Pie

The repository ships two clients with different jobs. This one is the orchestration client: several
conversations in parallel, one task queue per working directory, and the Orchestrator preset that
lets a session drive its own project's queue. The terminal client is the detail client and the
fallback: it shows the same conversation with more fidelity on any machine that has a terminal.
Both are lightweight first, and both are a UX layer over Pi.

The boundary is the same for both clients: a feature may change how Pi's work is presented,
scheduled, and driven; it may not change how Pi executes it. A subagent runtime, a second agent
loop, a parallel tool or session protocol, or any other new execution model is out of scope. The
queue and the Orchestrator preset stay inside it: they schedule ordinary Pi SDK sessions and add one
`task_manager` tool, not an agent runtime.

## Scope

Keep sessions, message input, streaming responses, tool feedback, and the controls needed to use
them. Directory selection, attachments, inline media, and file references serve the conversation;
they are not a file manager.

Do not build an IDE, file workspace, Git/worktree manager, embedded terminal, multi-panel dashboard,
or comprehensive configuration center. Pie does not implement or manage subagents; installed Pi
extensions remain Pi's responsibility. Prefer a good default over speculative settings.

The one addition beyond that surface is a task queue per project, described in [Tasks](tasks.md):
one active queued task at a time in each working directory, each executed by a fresh in-process Pi
SDK session through the same runtime chat uses. Chat sessions are shown on the same board and may
run in parallel; a started queue waits while a chat is running before its next claim, so chat
always has priority.
Different projects may run at the same time; there is no parallel queued-task execution inside a
project, no global worker pool, and no second agent protocol. A task session is visible in chat and
the queue can be deleted without changing chat behavior. One global autonomous switch chooses the
`autonomous` preset (full tools, questions refused, goal-driven) or the `full` preset; it is not a
per-project setting. The queues also have one management surface, described in
[Orchestrator](orchestrator.md): the **Orchestrator** preset in any project. It is the full coding
toolset plus one `task_manager` tool, and that tool can read or change only the queue of the
session's own working directory. It controls the queue, not agents; it adds no subagent runtime and
no second way to start work.

Historical management pages, settings, and project-specific style layers remain in the code. They
are not product commitments. Review them individually and leave configuration to Pi or its CLI when
a separate panel adds little value.

## Maintenance

Maintain this project independently, without upstream merges. Change the stack and structure freely
when doing so reduces complexity. There is no permanent separation between inherited code and fork
enhancements.

Development, verification, and optional portable packaging are local, and verification is manual:
the project ships no tests and no test runner. The repository's build-only `ci` workflow produces
the Windows installer and the portable archive for this client, plus the TUI binaries; see
[repository CI](../../docs/ci.md). [Desktop shell](desktop.md) covers the desktop-specific
packaging. No automated update channel is maintained.

## Documentation

All project documentation is maintained in English, without translated copies.

| Document                            | Purpose                                     |
| ----------------------------------- | ------------------------------------------- |
| [README](../README.md)              | Usage, security, and attribution            |
| [Agent instructions](../AGENTS.md)  | Rules for coding assistants                 |
| [Interface principles](design.md)   | Presentation and interaction                |
| [Architecture](architecture.md)     | Current entry points and boundaries         |
| [Runtime](runtime.md)               | Vite, Hono, and how a request is served     |
| [Desktop shell](desktop.md)         | Tauri 2 window and desktop packaging        |
| [Tasks](tasks.md)                   | Per-project task queues, execution boundary |
| [Orchestrator](orchestrator.md)     | The Orchestrator preset and its queue tool  |
| [Packaging](../packaging/README.md) | Local portable builds                       |
| [Repository CI](../../docs/ci.md)   | Workflow and release artifacts              |

These documents replace the upstream snapshot, fork-specific design guide, translated guides,
historical ADRs, and release instructions. Use Git history for historical context rather than
maintaining conflicting rule sets. Preserve third-party attribution and license notices.

## Attribution

Based on [Pi Web](https://github.com/agegr/pi-web) by agegr, using
[Pi](https://github.com/earendil-works/pi). Retain the original attribution and MIT license;
attribution does not require adopting the source project's maintenance model.
