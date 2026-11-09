# Architecture

`pie` is a host shell. It never embeds or reimplements the agent: the whole
conversation, tool execution, session storage, and provider access live in the
`pi` binary. This document describes the boundary, the modules, and the rules the
code must keep to stay a thin client.

## Process boundary

```
┌──────────────────── pie (Go) ────────────────────────┐      ┌──────── pi (binary) ────────┐
│ cmd/pie      flags · dependency check · shutdown      │      │                             │
│                                                       │      │  agent loop · tools         │
│ internal/rpc  Client ── stdin  (JSONL commands) ──────┼─────▶│  providers · sessions       │
│                 │   ◀── stdout (JSONL events) ────────┼──────│  extensions                 │
│                 │   ◀── stderr (diagnostics) ─────────┼──────│                             │
│                 ▼                                      │      │                             │
│ internal/ui   Model (Bubble Tea) ── renders ──▶ tty    │      └─────────────────────────────┘
└───────────────────────────────────────────────────────┘
```

Rules that keep the client thin:

- No TypeScript or Node.js dependency. `go.mod` only lists Go modules.
- `pi` is discovered with `exec.LookPath` (`--pi` or `PIE_PI` override).
- stdout is protocol only. Anything the UI needs to log goes to a file (`--debug`)
  or to the child's stderr tail kept for crash reports.
- The client keeps a *projection* of the session, never the source of truth. Every
  authoritative value comes from a response or a `message_end`/`*_end` event.
- UX only. Presentation, navigation, and configuration convenience are in scope;
  execution semantics are not. No subagents, no parallel agent runs, no second
  tool or session protocol, and no feature that changes how `pi` runs a turn.

## Protocol rules

These are the invariants that make the client survive a pi upgrade.

| Rule | Where |
|---|---|
| Split records on LF only; `U+2028`/`U+2029` are legal inside strings | `rpc.readLine` |
| Never use `bufio.Scanner`: it caps a record at 64 KiB | `rpc.readLine` |
| Records above 32 MiB are dropped and the stream resynchronises | `rpc.readLine` |
| Unknown record types degrade to `UnknownEvent`, never to an error | `rpc.ParseLine` |
| Known records with unexpected payloads also degrade to `UnknownEvent` | `rpc.decodeEvent` |
| Responses are correlated by `id`; order is irrelevant | `Client.handleLine` |
| `prompt` success only means "accepted"; `data.disposition` explains how | `ui.applyResponse` |
| A run is over at `agent_settled`, not at `agent_end` | `ui.handleEvent` |
| `*_delta` is for live display; `text_end`/`message_end` are authoritative | `rpc.StreamAccumulator` |
| stderr is diagnostics, never protocol | `Client.readLoop` |
| Closing stdin requests shutdown; SIGTERM and SIGKILL are the escalation | `Client.Close` |

## Modules

### `internal/rpc`

- `events.go` — inbound record types, the permissive parser, and the streaming
  accumulator used to rebuild an assistant message from deltas.
- `client.go` — child process, pipes, correlation, backpressure, shutdown. One
  goroutine reads stdout and owns `cmd.Wait`; commands are written under a mutex;
  the event channel is bounded so the UI always sees backpressure rather than
  losing records.
- `commands.go` — typed builders for every documented command plus the response
  payload shapes the UI consumes.

The reader never renders. A slow consumer blocks the channel, which applies
backpressure to pi through the pipe instead of growing memory.

### `internal/session`

Read-only scanning of pi's session directory (`~/.pi/agent/sessions` by default,
`--session-dir`/`PI_CODING_AGENT_SESSION_DIR` override). It reads the header of
each `.jsonl` file for the ID and working directory, and finds the newest
`session_info` name by reading the file backwards in chunks. A fixed tail probe
would miss a title written early in a session and later pushed megabytes from
the end by a long conversation. Broken files are skipped so one bad file cannot
break the resume picker. `delete.go` is the only code here that writes session
storage; the resume-picker section below explains when it runs.

### `internal/ui`

- `model.go` — the Bubble Tea model: state, message dispatch, layout, and the
  frame composition. The frame is exactly `height` lines; any mismatch would
  scroll the alternate screen and hide the header.
- `update.go` — protocol events to UI state, key routing, slash commands, and the
  command helpers that call pi.
- `commands.go` — the client-side command table: canonical names, aliases, and
  the alias-to-command index shared by dispatch and completion.
- `palette.go` — the `ctrl+p` command launcher: client and pi commands ranked
  into the picker, run through the composer's dispatcher without touching the
  draft.
- `activity.go` — the live run status above the composer: phase, running tools,
  retry and compaction labels, the elapsed clock, the token estimate and t/s
  rate of the block being written, and the pulsing marker.
- `viewport.go` — transcript blocks, scrolling, incremental markdown, and the
  rendered-content cache used by mouse selection. Tool cards are bounded
  previews by default: a running tool streams a short live tail of its newest
  rows, a folded result keeps a summary row plus its trailing rows, a folded
  diff keeps its count row plus the first changed rows, and streaming
  thinking shows a live tail even when finished thinking is hidden. `ctrl+o`
  swaps every preview for the full body.
- `selection.go` — cell-accurate text selection over the rendered transcript:
  viewport-to-content coordinates, reverse-video highlighting, and plain-text
  extraction for the clipboard.
- `clipboard.go` — OSC52 plus platform clipboard commands, run asynchronously
  so a slow clipboard tool cannot stall the event loop.
- `input.go` — the prompt editor and slash completion. The editor is written
  directly against the buffer instead of nesting `bubbles/textarea`: the
  widget paints a full-line cursor background, moves across logical lines and
  hides its own scrollbar, none of which fit a soft-wrapped composer. The
  custom editor owns wrapping, the caret cell, the sticky column for vertical
  movement, mouse selection over rune indices, and the scroll offset, so the
  box height and the visible rows always agree.
- `overlay.go` — pickers and extension dialogs; `ask_user.go` renders the
  question inline above the composer instead of as a dialog, so the
  conversation stays visible and the prompt itself is the free-form answer.
- `diff.go` — tool argument/result extraction and a dependency-free line diff.
- `syntax.go` — chroma-based syntax colours for tool content: a shell
  command, or the file a coding tool reads, writes, or edits. A call whose
  language is unknown stays plain, the way the web UI treats it. Diff rows
  carry both the token colours and a theme-blended add/remove tint.
- `styles.go` — the Lip Gloss palette and the glamour style derived from it.
- `splash.go` — the hand-drawn PIE wordmark, the startup card that opens the
  transcript, and the post-exit card printed after the alternate screen
  closes. The startup card is a normal transcript block: left-aligned with
  the conversation, it scrolls out of view instead of being dismissed on the
  first key press.
- `view.go` — small formatting helpers.

### Automatic titles

An unnamed session is named automatically from its first accepted prompt. The
request is a one-shot `pi --print` subprocess with no tools or session state, so
the title appears before a long first turn finishes. If it fails, the settled
turn retries with the full transcript (including aborted turns), up to three
consecutive attempts; a fresh prompt resets that budget. Resumed, attached,
forked, and cloned sessions without a name are titled from their history
immediately.

The result is written back through `set_session_name`, the same `session_info`
record Pie reads. Only one request is allowed to write at a time, and a session
switch or manual rename invalidates an in-flight result before it can rename the
wrong session or overwrite a user's name. Before an automatic write, the client
also asks pi for the current name so a title written by another client wins.

A running TUI watches its current session file every two seconds. It seeds from
the newest record once, then reads only newly appended bytes; a `session_info`
written by the Web UI updates the header and an open resume picker. The
incremental parser lives in `internal/session` (`ParseNameChunk`). `/title`
remains the explicit regenerate action.

### Selection

Mouse selection works on the rendered transcript, not on the markdown source.
The transcript caches its rendered lines and maps a mouse cell to a
`(line, column)` point, so scrolling and re-rendering keep the highlight anchored
to the text. Highlighting and copying walk grapheme clusters with `x/ansi`, which
keeps wide characters, emoji, and existing SGR colors intact. Copying strips ANSI
sequences, trims trailing spaces per line, and preserves blank lines inside the
selection.

The composer shares the clipboard path but maps mouse cells to rune indices in
the buffer. A click places the caret; a drag highlights the wrapped rows and
copies the selected runes on release. The editor hides the caret while a
selection is visible and renders selected newlines as a trailing highlighted
cell so multi-line selections read as one block.

Clearing the prompt with `ctrl+c` pushes the draft into the editor's history, so
`up` restores it after an accidental clear. Submitted prompts and cleared drafts
share the same history ring. The chord never interrupts a running turn, which
keeps a mistyped follow-up editable-in-reverse instead of stopping pi; `esc` is
the interrupt chord. With an empty prompt, `ctrl+c` still arms quit on the
second press once no turn is running.

Mouse capture is on by default. `shift+drag` is left to the terminal for native
selection, and `/mouse` toggles capture at runtime; `--no-mouse` starts with
capture off. Copying uses OSC52 for terminals and SSH sessions plus a platform
command (`pbcopy`, `wl-copy`, `xclip`, `xsel`, or `clip`) for terminals without
OSC52 support.

### Rendering budget

Streaming assistant text is split at blank lines outside fenced code blocks,
lists, and blockquotes. Everything before the tail is a *stable segment*: it is
rendered once per width and cached on the block. Each segment drops the blank row
glamour puts at a standalone document's edges (a list or fence opens with one; a
heading ends with one behind the renderer's reset) before the segments are
joined with a single blank line. Only the tail is re-rendered, and only on a
40 ms tick, so a fast token stream cannot saturate the CPU. An unterminated
fence gets a synthetic closing marker so code does not flicker between paragraph
and block styling. When the message ends, it is rendered once as one document,
which keeps loose lists and nested blocks structurally intact; the result is
cached like any other finished block.

Tool content follows the same rule. A shell command and a diff are tokenized
once when their block is built; the diff is capped first, so rows the 200-row
scrollback limit drops are never coloured. The coloured rows live on the block,
so streaming, scrolling, and a theme switch never tokenize again; only the diff
tint is rebuilt from the new palette. Lexer lookups are cached because chroma's
file-name matcher walks every registered pattern.

## Configuration and the bridge

`pie` and Pie share every file in pi's agent directory
(`PI_CODING_AGENT_DIR`, default `~/.pi/agent`):

- `settings.json`, `models.json`, `auth.json`, `mcp.json`, and `AGENTS.md` are
  pi's own files.
- `pie-model-settings.json`, `pie-tool-presets.json`, and the session log's
  `pie:tool-selection` / `pie:work-mode` entries are Pie's files; the TUI reads
  and writes the same shapes.
- `pie-settings.json` holds terminal-only choices: theme, thinking-block
  visibility, tool expansion, the last working directory, and the last preset
  to seed a new session.

`internal/config` owns this layer. Documents keep object member order, JSONC
comments and trailing commas are accepted, writes are private (0600), atomic,
and serialized with a lock file beside the target, and a file that cannot be
parsed is backed up (`.corrupt-<timestamp>`) instead of being silently replaced.

`pi --mode rpc` does not expose tool switching, reload, or a system-prompt
read, so the binary embeds a small extension (`internal/bridge/pie-bridge.ts`),
writes it to `<state-dir>/bridge/`, and passes it with `-e`. The extension
registers `/pie-tools`, `/pie-mode`, `/pie-reload`, `/pie-publish`, and the
provider commands described below; the UI
drives them with ordinary `prompt` commands. Tool selections and work modes are
written as the same session entries Pie uses, so a session moved between the
clients keeps its preset and its Plan or Autonomous mode. If the extension
fails to load, the UI reports `unavailable` in Settings › General and refuses
preset changes rather than silently diverging.

The bridge also registers the `ask_user` tool. It reuses the extension dialog
channel: a question is a `select` whose last option is the
`Write my own answer…` sentinel. The client strips the sentinel and renders the
question and its options between the transcript and the composer, never as a
full-screen dialog: the conversation the question refers to has to stay
readable. The composer keeps its normal editing behavior and becomes the
"write my own answer" field; an option and a typed answer both travel back as
the same response, and dismissing the question returns the same "dismissed"
tool result as the web client. A prompt draft present when the question arrives
is stashed and restored when it closes. An open question sends only the
sentinel, and other hosts keep the normal select -> input fallback. No new RPC
command or session entry is involved.

Autonomous uses the same entry with the opposite rule. The mode selects the
full coding tools, the bridge adds Pie's self-directed guidelines before each
run, and `ask_user` is left out of that run's declared tools. Pie starts an
autonomous session without the question extension; the bridge registers the
tool once for every session, so it hides the declaration for the run instead of
reloading pi, and a nested or stale call is refused with a reason. The live
active set keeps the tool for the modes that allow questions. The mode does not
start or drive a goal: `/goal` and the installed goal package keep that role.

Provider sign-in is bridged the same way. `pi --mode rpc` has no provider list,
login, or logout command, and `get_available_models` only reports providers
that already have a credential, so the extension registers `/pie-providers`,
`/pie-login`, `/pie-auth-cancel`, and `/pie-logout`. The credential is written
by pi's own `ModelRuntime.login`, which keeps every OAuth flow, device code, and
the `auth.json` shape inside pi; the TUI never reimplements one. A login runs
detached and reports through `pie-auth ` notifications, because pi waits for a
command handler before it answers the prompt and a browser login can take
minutes. The UI turns those notifications into an overlay with the
verification URL or device code, and refreshes the provider snapshot and
available models when the flow ends.

Subscription usage is bridged too. `/pie-usage <provider> <path>` resolves the
provider's request auth through `ModelRuntime.getProviderAuth`, so OAuth
token refreshes and provider-scoped environment stay inside pi. It fetches only
the provider's official endpoint, rejects a custom origin the same way Pie
does, and normalizes the reply into rate-limit windows, balances, and metrics
for the Providers panel. The TUI never reads `auth.json` secrets for usage and
never stores the report: `internal/providerusage` parses the bridge's reply and
the UI keeps it in memory until the client exits.

`pi --mode rpc` does not persist the model or thinking level it changes, so
`pie` writes them itself: picking a model updates `defaultProvider` and
`defaultModel`, and a thinking-level change updates the current model's
`modelThinkingLevels` entry. pi then starts the next session on that model and
level, while a resumed session restores the pair recorded in its own log. The
save happens after the command succeeds, and an unreadable `settings.json` is
left alone with the error shown instead of being replaced.

`/fork` and `/clone` are RPC operations that replace the active session: after
the command the client refetches `get_messages`, state, stats, and entries, so
the transcript and header belong to the new session. A fork puts the chosen
prompt back in the editor, which is what the web UI does. `/tree` is read-only:
`get_tree` is printed into the transcript because the RPC has no command to make
an arbitrary node active; forking remains the way to branch. Enter-to-send is a
terminal-only preference because alt+enter is the only portable send chord when
Enter inserts newlines.

`/search` reads session files directly, newest first: a name or directory
match is checked before reading the body, and the transcript scan unmarshals
each matching line and walks its string values so the snippet reads as text.
The scan is capped per file so a huge session cannot stall the picker; the
result resumes the session through the existing `switch_session` path.

Both session pickers (resume and search results) delete with `ctrl+d` twice.
The first press arms the selected row for 1.5 seconds, matching the ctrl+c quit
window, and shows which session a second press would remove; a single stray
chord therefore never deletes a conversation. The active session is refused
because pi keeps appending to its open file. `session.Delete` is the only write
the client makes to session storage: it re-parents forks whose header names the
deleted file to that file's own parent, rewrites each child header through a
temporary file and rename so an interrupted write cannot truncate a
conversation, and then unlinks the target. Children that cannot be read are
left alone rather than blocking the delete the user asked for. The picker drops
the row in place, so deleting several sessions in a row needs no reopen.

`/context` is fed by `/pie-publish`, not by the UI guessing: the bridge reads
`getActiveTools`, `getAllTools`, `getSystemPrompt`, and the session's work mode,
and marks each tool active at publish time; autonomous mode hides `ask_user`
there too, because the run does not declare it. The panel lists the tools, offers
the system prompt through `$PAGER`, and refreshes on demand. A leadership
without the bridge shows why instead of an empty list. Tool presets and Plan
mode refuse with the reason as well: the binary always embeds the bridge, and
restarting without it would drop the current session instead of switching the
tool set in place.

`/stats` is a small settings-style panel over the `get_session_stats` payload.
The status bar's context meter reads the same payload. Both refresh when an
assistant message ends, on the one-second heartbeat while a run is active or
the panel is open, when the agent settles, and when Refresh is pressed, so the
two cannot disagree and the meter keeps up with a long tool-heavy turn. Replies
carry a request id: a slow read from an earlier turn is dropped instead of
overwriting a newer one, and a failed read keeps the last good numbers.

Images are attachments on the normal prompt path, not a separate tool:
`/image` reads one local file, checks the MIME type, caps it at 20 MB, and
sends `prompt` with an `images` array. A turn must be idle first, because the
RPC follow-up command cannot carry images. The transcript shows a text
placeholder, matching how the web composer labels an attachment.

The working directory is the child process's `Dir`, fixed for the life of one
pi process. `/cwd` therefore restarts the child: it closes the old stdin,
starts a fresh pi with the same binary, flags, and bridge extension but no
`--session`, and re-runs the handshake. The new session starts in the chosen
folder; the old transcript is not carried over. A stale `closed` event from the
replaced child is ignored by comparing the client identity. Recent projects are
derived from the `cwd` in session headers rather than a second index, and
`pie-settings.json` keeps the last choice only to seed the browser; the
process's own directory stays the default when no `--cwd` is given.

MCP servers are read from the agent's `mcp.json` and the project's
`.pi/mcp.json` with the same `mcpServers` shape pi uses. The panel edits only
three fields through `internal/config`: `enabled`, `exposure`, and removal; an
add goes through `pi mcp add` so the CLI validates transports, headers, and
OAuth settings exactly as it does for the web panel. Connection state comes from
`pi mcp list --json`, run on demand because it starts every enabled server.
Project files keep pi's trust rule at run time: the terminal writes them only
for the folder the person opened.

Code mode has one preference in `defaultTools` and one object in settings.
"always" appends a single `+codemode` after dropping every entry that names
codemode; "automatic" drops it and deletes the key when only modifiers would
remain, so pi's defaults are not read as "no tools". `codemode.mode` and
`codemode.inlineBudget` are edited in place, with "on" and a blank budget
deleting the key because those are pi's defaults.

Project writes are trust-gated. `internal/config/trust.go` reads pi's
`trust.json` and resolves the nearest decision, including inheritance from a
parent folder. MCP writes need an explicit decision even when the folder has no
project resources; plugin writes accept a fresh folder and require trust once
project resources exist.

Plugins are the `packages` array in `settings.json` and in the project's
`.pi/settings.json`. A string entry is enabled; an object whose four resource
lists are all empty is disabled. Disabling a filtered entry is refused because
the write would drop the filters, exactly as the web panel refuses it. Every
mutation goes through `internal/config` under the lock, so an entry keeps its
position, unknown keys (`autoload`, say) and the rest of the file. Installing,
removing, and updating shell out to `pi install/remove/update`, which writes the
same settings entry pi itself reads.

Skills are read with pi's own discovery rules: a `SKILL.md` directory is one
skill and is not recursed into, standalone `.md` children are skills, and
symlinks are followed. The roots are the agent directory's `skills/`, the
project's `.pi/skills/`, and the `skills` list in `settings.json`.
`disable-model-invocation` is edited line by line inside the frontmatter so the
rest of the file keeps its formatting, and the write follows symlinks (a global
skill installed by `npx skills` is a link into `~/.agents/skills`). Installing
and updating shell out to `npx skills`, matching the web panel's CLI, rather
than writing skill directories in Go.

Goals are the goal package's, not the client's. `internal/session` reads the
newest `custom` entry whose `customType` is `pi-better-goal` or
`pi-codex-goal`; `set` supplies the status, objective, and usage, and `clear`
retracts it. The `/goal` command opens a panel that only sends `/goal …`
prompts to the installed package, which owns continuations and completion. The
package is never bundled: availability is the `goal` command reported by
`get_commands`, and the terminal-only `goalEnabled` preference refuses to turn
on without it. `pie` writes no goal state of its own, so a goal started in
Pie appears in the header here and the reverse.

Settings › Models and Settings › Providers share one catalog without a second
cache: `models-store.json` (pi's catalog), `models.json` (custom providers,
models, and model overrides), and `get_available_models` (what the running
agent actually exposes). `internal/modelcatalog` owns the merge and the
minimal-edit rules for `enabledModels`: turning one model off expands only the
pattern that covers it, preserves `:thinking` pins, and never touches patterns
that match nothing. Writes go through `internal/config`, so a provider or
model added in the terminal appears in Pie and the reverse. Models owns startup
model and thinking defaults, the context cap, enabled patterns, and per-model
overrides; Providers owns `defaultProvider`, credentials, endpoints, and
usage. The context-window cap in `pie-model-settings.json` is shared, but only
Pie's server applies it to a runtime; the terminal client cannot re-clamp pi's
in-process model list.

## Startup and shutdown

1. Resolve `pi` (flag, environment, `PATH`). Missing binaries print install
   instructions and exit with code 2.
2. Start `pi --mode rpc` with the pass-through flags.
3. Handshake: `get_state`, `get_available_models`,
   `get_available_thinking_levels`, `get_commands`, `get_session_stats`, and
   `get_messages` when the session already has history.
4. Render the TUI on the alternate screen and pump events.
5. On exit: close stdin (orderly shutdown), wait 3 s, SIGTERM the process group,
   wait 2 s, then SIGKILL. The child is put in its own process group so a
   `SIGTERM` reaches subprocesses too.

If the child dies, the UI keeps the last stderr lines, shows them in an error
block, and refuses to send more commands.

## Testing strategy

- `internal/rpc/client_test.go` builds `testdata/fakepi` as a real child process
  and covers out-of-order responses, malformed lines, CRLF, 1 MiB records,
  oversized records, child crashes, request timeouts, slow consumers, graceful
  close, and SIGTERM escalation. The test binary itself is not used as the fake:
  modern Go testing captures `os.Stdout`, which delays protocol writes.
- `internal/rpc/e2e_test.go` runs against a real pi when `PIE_E2E_BIN` is set.
  `PIE_E2E_PROMPT=1` adds one model round trip.
- `internal/ui/*_test.go` drives the model with a fake client, so key handling,
  streaming, dialogs, and rendering are tested without a terminal.

```bash
make test
go test -race ./...
PIE_E2E_BIN=$(command -v pi) go test ./internal/rpc -run TestRealPi -v
```

## Known limitations

- No image or file attachments yet; prompts are text only.
- Extension `setWidget` output is folded into the status line instead of a
  dedicated panel.
- The diff view is prefix/suffix based. It is exact for edit tools' replacement
  snippets, but a full Myers diff is not implemented.
- Built-in TUI-only pi commands (`/hotkeys`, ...) do not exist in RPC mode and
  are not offered; the client implements its own `/settings` panel.
