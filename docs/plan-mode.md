# Plan mode

Plan mode is the same work mode in both clients. It is stored in the session log as
`pie:work-mode` with `mode: "plan"`, but its main artifact is a Markdown file outside the
conversation. Context compaction rewrites messages; it cannot remove that file.

The two clients share this contract but not code. Changes to the tool name, entry shape, plan
location, or injection rules must be made in both `tui/internal/bridge/pie-bridge.ts` and
`webui/lib/plan-mode-extension.ts` (with `webui/lib/plan-file.ts`).

## Plan file

```text
<agentDir>/pie-plans/<session-id>.md
```

- `agentDir` is `PI_CODING_AGENT_DIR` when set, otherwise `~/.pi/agent`.
- A session id that is not `[A-Za-z0-9_-]{1,128}` is replaced by its sha256 hex digest.
- The directory is created with mode `0700`; the file is written atomically with mode `0600`.
- A plan path is readable only when it resolves below `<agentDir>/pie-plans`. A symlink that
  leaves that directory is rejected, and the plan file itself must not be a symlink.
- The file is per session. Fork and clone copy the parent plan to the new session's path so the
  two conversations do not share edits.
- The file is not deleted when a session is deleted. Plan files are durable artifacts; a later
  cleanup command can be added without changing the format.

The file is Markdown with a small, optional convention:

```markdown
# Plan title

Status: draft

## Goal

## Constraints

## Steps

- [ ] Step one
- [ ] Step two

## Files

## Verification

## Risks and open questions
```

`Status` is one of `draft`, `ready`, `in-progress`, or `done`. Without a status line, the clients
derive it from the checklist: no checked steps is `draft`, some are `in-progress`, and all are
`done`. The file is authoritative; the session entry is only a pointer.

## Session entry

```json
{
  "version": 1,
  "path": "/absolute/path/to/pie-plans/<session-id>.md",
  "updatedAt": "2026-01-01T00:00:00.000Z",
  "bytes": 4096
}
```

The newest valid custom entry with `customType: "pie:plan"` wins. Readers re-read the file for
title, status, and content; the entry's metadata is a hint, not state. If the entry's path is
outside the plan directory, it is ignored and the deterministic path is used.

## Tool

Plan mode registers one model tool, `update_plan`:

```text
parameters:
  content: string          required, full Markdown, replaces the file
  baseRevision?: string    optional sha256 of the current file
```

- The tool writes only the current session's plan file; it accepts no path argument.
- It is registered with `defaultActive: false` and is activated by the Plan preset.
- It executes sequentially and writes atomically.
- `baseRevision` refuses the write when the file changed after the injected context was built.
- Every successful write appends a `pie:plan` entry so clients can refresh.

The name is `update_plan`, not `write_plan`. The web UI's `write_*` name predicate would otherwise
treat the plan file as an ordinary project write and Plan mode's own write guard would block it.

## Work mode rules

- Project files and shell commands stay read-only. `write`, `edit`, `bash`, `powershell`, and patch
  tools are blocked.
- `read`, `grep`, `find`, `ls`, and `ask_user` stay available.
- `update_plan` is the only plan-mode write. It writes outside the project, in the agent directory.
- Extension and MCP tools keep their own semantics; Plan mode is not a security sandbox.
- Leaving Plan mode restores the previous preset. The plan file and its entry remain. Normal
  `edit`/`write` can update the plan during implementation, and the plan context keeps being
  injected.

## Compaction guarantee

The plan file is never part of the message history. Three layers keep it available:

1. `before_agent_start` reads the file and adds a small `<pie-plan>` system-prompt section with
   the path, title, status, and revision.
2. `context` reads the file before every model request and appends a request-local custom message.
   A plan of up to 12,000 characters is included whole; a larger plan contributes its outline and
   the path, and the model reads the rest with `read`. The message is not written to the session
   log, so it cannot be compacted away and is regenerated on the next request.
3. `session_before_compact` and `session_compact` set a flag. The next request says explicitly
   that the conversation was compacted and that the plan file, not the summary, is authoritative.

Even if the `pie:plan` entry is compacted out of the model's context, clients read the full session
entries and the deterministic path still points at the file. A missing file is recreated from the
template and announced through the entry.

Plans larger than 256 KiB are refused by `update_plan`; a manually larger file is still readable
but the injected context is an outline. The UI caps display reads and reports truncation.

## Presentation

TUI:

- `shift+tab` enters Plan mode and restores the previous preset on exit.
- The status line reports `plan mode` and whether a plan file exists.
- `/plan` opens the plan file in the read-only viewer; `y` copies and `esc` closes.
- `/context` includes the plan path, status, and revision published by the bridge.

Web UI:

- The composer's `...` menu has a Plan mode card; the tool preset list keeps the same `plan` entry.
- A Plan file card opens a read-only Markdown dialog and can refresh.
- `GET /api/sessions/[id]` reports plan facts; `GET /api/sessions/[id]/plan` returns the content.
- Both routes validate the plan path before reading it.

## Verification

The repository has no tests. A change is checked with `go build ./...` in `tui/` and
`bun run typecheck` plus `bun run lint` in `webui/`; the owner verifies the behavior by hand.
