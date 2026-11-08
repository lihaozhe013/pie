# pie

A thin terminal client for the [`pi`](https://github.com/earendil-works/pi) coding
agent, written in Go with [Bubble Tea](https://github.com/charmbracelet/bubbletea).

`pie` is a host shell only. It contains no TypeScript or Node.js SDK: it starts
the globally installed `pi` binary in RPC mode and talks to it over JSONL on
stdin/stdout. The agent owns the conversation, tools, sessions, and providers; the
client owns pixels and keys.

This directory is the terminal client in the Pie monorepo. It is independent of
the browser client in `../webui`: the two share Pi's configuration files, but no
code, dependencies, or build pipeline.

```
pie (Go, Bubble Tea)  ⇄  stdin/stdout JSONL  ⇄  pi --mode rpc (host binary)
```

## Features

- Header line with the current directory (`~`-collapsed), model, thinking
  level, and session name
- Streaming assistant output with incremental Markdown rendering
- Mouse editing in the composer: click to place the caret, drag to select, and
  release to copy the selection through the same clipboard path as the
  transcript
- Mouse selection in the transcript: drag to highlight, release to copy plain
  text through OSC52 and the platform clipboard; `shift+drag` keeps the
  terminal's native selection, and `/mouse` toggles capture at runtime
- A live blue activity bar above the composer names the current wait, thinking
  block, tool call, retry, or compaction, with a pulsing marker, an `Elapsed`
  clock, a `~N tokens` estimate of the block being written, and a live `t/s`
  rate
- Tool calls rendered as compact lines; shell commands and `edit`/`write`
  diffs are syntax-highlighted from the tool's file type, with added and
  removed diff rows tinted green and red
- Thinking blocks (collapsible), follow-up queueing, steering, and abort
- Model picker, thinking-level cycling, session rename/resume/new, compaction,
  HTML export, and token/context statistics. The chosen model is saved to pi's
  startup defaults and each thinking level is saved per model, so the next
  launch starts where the last one ended
- A command palette (`ctrl+p`) that searches and runs client or pi commands
  without clearing the composer draft
- A settings panel (`/settings`) with the same tabs as the Pie web UI and a `/`
  search that jumps across every tab, sharing pi's files: `settings.json`,
  `models.json`, `AGENTS.md`, and the `pie-*` companion files in the agent
  directory
- Tool presets (`/preset`): the built-in configured, plan, chat-only,
  read-only, default, and full sets, plus custom presets stored in
  `pie-tool-presets.json` and editable from Settings › Tools. The last preset
  is remembered in the terminal-only preferences and reused for new sessions;
  a resumed session keeps its own recorded selection
- A Models tab that merges pi's catalog with `models.json`: context-window
  limit, startup defaults, enabled-model patterns, per-model thinking levels,
  provider credentials with `pi auth check` readiness, per-model context
  windows, and custom provider and model editors (including compatibility
  endpoints, costs, and thinking maps)
- Code mode controls in Settings › Tools: automatic or always-on (writes
  `+codemode` to `defaultTools` minimally), the `codemode.mode` choice, and the
  inline result budget
- A Skills tab that discovers the agent, project, settings, `~/.agents/skills`,
  and installed-package paths with
  pi's layout rules, shows model-invocation state, toggles
  `disable-model-invocation` in the frontmatter, opens the skill file in
  `$VISUAL`/`$EDITOR`, and searches or installs from skills.sh with the
  `npx skills` CLI
- A Plugins tab that reads pi packages from `settings.json` and the project's
  `.pi/settings.json`, installs globally or locally, updates one package or
  all, and enables or disables entries. Disabling keeps unknown keys and
  refuses filtered entries instead of silently dropping their filters
- A statistics panel from `/stats` with message counts, a token breakdown,
  cost, context usage, and the session file, refreshed while it is open
- Plan mode shows a `plan` chip in the header and a "writes blocked" hint;
  project MCP and package writes follow pi's `trust.json`, inherited from a
  parent folder, and refuse to edit untrusted project resources
- An unnamed session is titled automatically from its first accepted prompt,
  with retries when the first turn settles (even if it was aborted), and from
  history when it is resumed, attached, forked, or cloned. The generation runs
  as a one-shot background `pi --print` and writes the name through
  `set_session_name`, the same `session_info` record the Web UI reads. A running
  TUI watches the session file for titles written by the Web UI, and the resume
  picker reads the newest name even when a long conversation pushed it far from
  the end of the file. Failures stay out of the transcript
- Branch tools: `/fork` lists forkable user messages and restores the chosen
  prompt to the editor, `/clone` duplicates the branch, and `/tree` prints the
  session tree with the current leaf marked
- An Appearance toggle for whether Enter sends or inserts a newline
  (alt+enter sends when Enter is a newline)
- Session search from `/search [query]`: names, working directories, and
  transcript text across the session store, with a snippet and resume action
- A Context panel from `/context` fed by the bridge: the live tool list with
  active state and descriptions, system-prompt size, work mode, and a pager
  view of the prompt
- Image attachments through `/image <path> [prompt]`: the file is read,
  base64-encoded, and sent with the prompt through pi's existing image support
- Project switching with `/cwd [dir]`: a recent-project picker derived from
  session headers, a directory browser, and `/cwd <path>` for direct entry.
  Switching restarts pi in the new folder and starts a fresh session there.
  `/resume` lists the current folder's sessions and offers "Show all
  directories" for the rest
- An MCP tab that lists the agent and project `mcp.json` servers, checks
  connections with `pi mcp list --json`, toggles `enabled`, sets the exposure
  mode, shows env and header names with values masked, adds servers through
  `pi mcp add`, and signs in, signs out, or removes through the same CLI
- Goal controls through a manually installed goal package: `/goal` shows the
  status, objective, token usage, and the start, pause, resume, complete, and
  clear actions; the header carries the status. `pie` never bundles the
  package. Enable the panel in Settings › General after installing
  `pi-better-goal`; enabling it without the package is refused with the install
  command
- Pie's 18 color themes, applied instantly and saved to the terminal-only
  preferences file
- A bundled bridge extension (loaded with `-e`) that adds hot tool switching,
  Plan mode, and reload over RPC, using the same `pie:*` session entries as the
  web UI
- Extension UI support: confirm/select/input/editor dialogs, notifications,
  status entries, window titles, and editor prefills
- Survives upgrades: unknown protocol records are ignored rather than fatal

## Requirements

- `pi` 1.5.0 or newer on `PATH` (or `--pi <path-to-pi>`, or `PIE_PI`)
- Go 1.24 or newer to build

## Install

```bash
git clone https://github.com/lihaozhe013/pie.git
cd pie/tui
make build
./bin/pie
```

Install on `PATH` as `pie`:

```bash
make install
```

## Usage

```bash
pie                           # resume is offered from the picker
pie --model anthropic/claude-sonnet-4
pie --no-session              # ephemeral, nothing is written to disk
pie --session ~/.pi/agent/sessions/--Users-me-proj--/2024_x.jsonl
pie --cwd ~/src/project       # start in another working directory
pie --no-mouse                # let the terminal handle selection natively
pie --debug                   # protocol log in ~/.local/state/pie/
```

The agent directory is `PI_CODING_AGENT_DIR` when set, otherwise
`~/.pi/agent`; the client and pi always read the same one.

Flags are forwarded to pi where they overlap (`--provider`, `--model`, `--name`,
`--session`, `--session-dir`, `--no-session`).

Mouse capture is on by default. `shift+drag` uses the terminal's native
selection, and `/mouse` toggles capture. Clicking inside the composer places
the caret, and dragging there copies the highlighted prompt text on release. In
tmux, OSC52 copying needs `set-clipboard on`; the platform clipboard command is
the fallback when `pie` runs locally.

## Key bindings

| Key | Action |
|---|---|
| `enter` | send the prompt (queues a follow-up while a turn is running) |
| `alt+enter`, `ctrl+j`, `\` then `enter` | insert a newline |
| `ctrl+s` | steer the running turn |
| `esc` | interrupt the running turn (queues are restored to the editor) |
| `ctrl+c` | interrupt; clear the prompt (press `up` to restore it); on an empty prompt, press twice to quit |
| `ctrl+d` | delete the character under the cursor; quit when the editor is empty |
| `ctrl+k` | pick a model |
| `ctrl+g` | pick a tool preset |
| `shift+left` / `shift+right` | cycle tool presets |
| `ctrl+p` | open the command palette |
| `shift+up` / `shift+down` | raise or lower the reasoning level |
| `shift+tab` | toggle plan mode and restore the previous preset |
| `ctrl+t` | show/hide thinking blocks |
| `ctrl+o` | expand or collapse tool output and diffs |
| `ctrl+l` | clear the scrollback |
| `tab` | accept a slash-command completion |
| `up` / `down` | move inside the prompt; prompt history from the first or last row |
| click | place the caret in the prompt |
| drag in the prompt / transcript, release | select text and copy it |
| `left` / `right`, `ctrl+b` / `ctrl+f` | move by one character |
| `alt+left` / `alt+right`, `ctrl+left` / `ctrl+right` | move by one word |
| `home` / `end`, `ctrl+a` / `ctrl+e` | start or end of the current line |
| `ctrl+home` / `ctrl+end` | start or end of the whole prompt |
| `ctrl+w`, `alt+backspace` | delete the previous word |
| `pgup` / `pgdn`, `ctrl+u` | scroll the transcript |
| `shift+drag` | use the terminal's native selection |

## Slash commands

Each client-side command also answers to the aliases listed below, so muscle
memory from other CLIs keeps working.

| Command | Aliases | Description |
|---|---|---|
| `/settings` | `/config`, `/prefs` | open the settings panel; `/settings models` opens a tab |
| `/preset` | `/tools` | change the tool preset (`/preset plan`, `/preset configured`, or a custom name) |
| `/model` | `/models` | switch model |
| `/login` | | sign in to a provider with OAuth or an API key |
| `/logout` | | sign out of a provider and delete its stored credential |
| `/think` | | cycle the thinking level |
| `/new` | | start a new session |
| `/resume` | `/continue`, `/sessions` | resume another session |
| `/compact` | `/compress` | compact the conversation |
| `/name` | `/rename` | rename this session |
| `/title` | | regenerate the title from the transcript with a one-shot model call |
| `/cwd` | `/dir`, `/project` | switch working directory; no argument opens the project picker |
| `/image` | | attach a local image to a prompt (`/image shot.png what is this?`) |
| `/context` | `/tools-view` | system prompt and tool definitions published by the bridge |
| `/search` | | search session names, folders, and transcripts |
| `/fork` | | fork from a user message; the prompt returns to the editor |
| `/clone` | | clone the current branch into a new session |
| `/tree` | | print the session tree with the current leaf marked |
| `/goal` | | goal status and controls; arguments are forwarded to the goal package |
| `/export` | | export the session as HTML |
| `/stats` | `/status`, `/usage` | show the statistics panel (messages, tokens, cost, context) |
| `/clear` | `/cls` | clear the scrollback |
| `/mouse` | | toggle mouse capture; off leaves selection to the terminal |
| `/help` | `/keys` | show key bindings and commands |
| `/quit` | `/exit`, `/q` | exit pie |

Anything else starting with `/` is forwarded to pi unchanged, so extension
commands, prompt templates, and skills (`/skill:name`) work as they do in the
native TUI. Aliases never take precedence over pi: if pi advertises a command
with the same name, that name is forwarded instead of being treated as an alias.

## Design notes

See [docs/settings.md](docs/settings.md) for a row-by-row settings reference and
[docs/architecture.md](docs/architecture.md) for the process boundary, the
protocol invariants (LF-only framing, permissive parsing, `agent_settled` as the
end of a run), the rendering budget, and the shutdown escalation.

## Development

```bash
make test                     # unit tests, includes a compiled fake pi
make vet
go test -race ./...
PIE_E2E_BIN=$(command -v pi) go test ./internal/rpc -run TestRealPi -v
```

CI builds the six supported targets with `CGO_ENABLED=0`; it does not run the
test suite. See `../docs/ci.md` for the repository workflow and local
equivalents.

## License

MIT
