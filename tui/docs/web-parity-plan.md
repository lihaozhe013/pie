# Pie Web UI Parity Plan

This document plans the work that brings `pie` to feature parity with the Pie
web UI ([`webui/`](../../webui/)), excluding the task workspace and drag-and-drop
attachments. It records the assessment, the shared configuration contract, the
runtime gaps and their agreed solutions, and a phased implementation order.

Parity covers the conversation and configuration surface, not the orchestration
surface: the web UI remains the orchestration client, with parallel work and
task queues, while `pie` remains the detail client and the terminal fallback.

Status: implemented. Every phase below landed; `settings.md` is the
delivered settings reference and `../README.md` lists the final commands. The
bridge-extension approach in section 6.4 is what shipped.

## 1. Goal

`pie` must offer the same conversation features and the same configuration
surfaces as Pie, and must read and write the same files in the same agent
directory. A change made in one client is visible in the other. Parity stops at
the orchestration surface: queues and the Orchestrator preset stay with the
browser client.

- Settings mirrors Pie's configuration surfaces: General, Instructions,
  Appearance, Models and Providers (Pie keeps these in one Models view),
  Tools, Skills, Plugins, MCP.
- The Models and Providers tabs reproduce Pie's model sections: General,
  Defaults, Model reasoning, and Providers.
- Composer features match: tool presets, Plan mode, goal, model and thinking
  selection, title generation.
- Working directory handling matches: a project is a folder, sessions are grouped
  by folder, and a new session chooses its folder.
- Configuration is shared, never duplicated: `settings.json`, `models.json`,
  `pie-model-settings.json`, `pie-tool-presets.json`, `AGENTS.md`, `mcp.json`,
  `auth.json`, and the session log's `pie:*` entries.

## 2. Scope

### 2.1 In scope

- The Settings tabs and their contents.
- Tool presets: built-in presets, custom presets, the composer selector, Plan
  mode, and the preset editor.
- Session title generation.
- Goal support through a manually installed goal package.
- Model management: providers, credentials, models, enabled-model filtering,
  reasoning defaults, context limit.
- Skills, plugins (Pi packages), and MCP server management.
- Working-directory and project handling.
- Remaining conversation surfaces: branches/forks, session search, statistics,
  image attachments, system prompt and tool definitions.

### 2.2 Out of scope

- The task workspace: task queue, orchestrator, autonomous preset, task
  database, task sidebar.
- Drag-and-drop file and image attachment.
- Browser-only surfaces: PWA push notifications, web login/logout, fonts, font
  sizes, content width, chat minimap, Mermaid rendering.
- Provider OAuth sign-in and subscription usage/quota reporting (see section 8).

## 3. Where the two projects stand

### 3.1 Pie's three layers

| Layer | How Pie does it | What pie can do |
| --- | --- | --- |
| Agent runtime | In-process SDK plus Pie's own command adapter (`lib/rpc-manager.ts`) | Partly. `pi --mode rpc` exposes fewer commands than the SDK. |
| Configuration and resources | Direct file access, plus SDK resource loaders | Fully. The TUI reads and writes the same files. |
| Interface | React components | Term-equivalent components, with browser-only parts omitted. |

The web UI's extra runtime commands are `set_tools`, `reload`, tool inventory,
system-prompt reads, and title generation. Pi's RPC mode (1.5.0) has none of
them; the TUI must supply its own channels (section 6).

### 3.2 pie today

- RPC client, streaming transcript, tool rendering, diffs, thinking blocks.
- Model picker, thinking cycling, session rename/resume/new, compaction, HTML
  export, token and context statistics.
- Extension UI dialogs, notifications, status entries, widgets, window titles.
- No configuration layer, no settings UI, no presets, no title generation, no
  goal, no model or provider management, no skills/plugins/MCP management, no
  working-directory picker.
- The session directory is hard-coded to `~/.pi/agent/sessions` and does not
  honor `PI_CODING_AGENT_DIR` or `settings.json`'s `sessionDir`.

## 4. Feature parity matrix

Sizes: S under a day-equivalent, M a day-equivalent, L several, XL the largest.

| Area | Pie reference | pie today | Approach | Size |
| --- | --- | --- | --- | --- |
| Settings shell | `components/SettingsPanel.tsx`, `lib/settings-navigation.ts`, `lib/settings-search.ts` | none | Modal with tab rail, detail pane, field widgets, search | L |
| General | `components/SettingsPanel.tsx` (`GeneralSettings`) | none | `settings.json` plus TUI preferences | S |
| Instructions | `components/GlobalAgentsConfig.tsx` | none | Read/write `AGENTS.md`, reload after save | S |
| Appearance | `components/AppearanceSettings.tsx`, `lib/theme.mts` | fixed palette | Map Pie's theme palettes to TUI themes | M |
| Models | `components/ModelsConfig.tsx` and model sections | model picker only | New catalog layer plus four sections | XL |
| Tools / presets | `components/ToolPresetsSettings.tsx`, `lib/tool-presets.ts`, `lib/custom-tool-presets-shared.ts` | none | Preset layer, composer selector, editor | M |
| Plan mode | `lib/plan-mode-extension.ts`, `lib/work-mode.ts` | none | Bridge extension, matching Pie's rules | S |
| Title generation | `lib/session-title.ts`, `/api/sessions/[id]/auto-name` | manual `/name` only | One-shot `pi --print` subprocess | S |
| Goal | `lib/goal-driver.ts`, `lib/goal-package.ts`, `components/GoalSection.tsx` | none | Read goal entries, send `/goal` commands | M |
| Skills | `components/SkillsConfig.tsx`, `/api/skills/*` | none | Directory scanning, frontmatter toggles, `npx skills` | L |
| Plugins | `components/PluginsConfig.tsx`, `/api/plugins` | none | `settings.json` packages, `pi` package commands | L |
| MCP | `components/McpConfig.tsx`, `/api/mcp/*` | none | `mcp.json` editing, `pi mcp` subcommands | L |
| Working directory | `components/ProjectPicker.tsx`, `DirectoryPicker.tsx` | process cwd | `--cwd`, `/cwd`, directory browser, child restart | M |
| Branches and forks | `components/BranchNavigator.tsx`, `SessionTree.tsx` | none | RPC already has `get_tree`, `fork`, `clone` | M |
| Session search | `components/SessionSearch.tsx` | none | Local scan plus filter | S |
| Statistics | `components/SessionStatsModal.tsx` | `/stats` text | Dedicated panel | S |
| Image attachments | `lib/image-attachments.ts` | protocol supports images | `/image` command | S |
| System prompt, tool definitions | `SystemPromptPanel.tsx`, `ToolDefinitionsPanel.tsx` | none | Bridge extension publish command | M |
| Tasks, queue, autonomous | task workspace | none | Excluded | - |
| Drag and drop | `hooks/useDragDrop.ts` | none | Excluded | - |

## 5. Shared configuration and working directory

### 5.1 Agent directory

All shared files live in Pi's agent directory:

- `PI_CODING_AGENT_DIR` when set;
- otherwise `~/.pi/agent`.

The TUI must use this one root for every path and must not keep a second copy.
`internal/session/scan.go` currently bypasses it and must be corrected.

### 5.2 Files

| File | Content | TUI access |
| --- | --- | --- |
| `settings.json` | `enabledModels`, `modelThinkingLevels`, `showCacheMissNotices`, `defaultTools`, `packages`, default provider/model/thinking level, compaction | Read/write, minimal edits, unknown keys preserved |
| `models.json` | Custom providers and models | Read/write |
| `pie-model-settings.json` | Global context-window limit (Pie-owned) | Read/write |
| `pie-tool-presets.json` | Custom tool presets (Pie-owned) | Read/write |
| `AGENTS.md` | Global instructions | Read/write |
| `mcp.json` and `.pi/mcp.json` | MCP servers, global and project | Read/write; project file requires trust |
| `auth.json` | Provider credentials | Read all; write API keys directly, and every method through the bridge extension |
| `models-store.json` | Provider model catalog cache | Read; refresh through `pi update --models` |
| `pie-session-state.json` | Sidebar pins, archive, project order and names | Optional read later; not required for parity targets |
| Session `.jsonl` entries | `pie:tool-selection`, `pie:work-mode`, goal entries | Read; write through the bridge extension |
| `pie-settings.json` | TUI-only preferences: theme, send key, goal enabled, last working directory | Read/write (new file) |

The TUI-only file exists because a terminal has preferences a browser does not.
Everything the two clients genuinely share stays in Pi's files.

### 5.3 Write discipline

Every shared write follows the rules Pie already implements:

- Read JSONC leniently: UTF-8 BOM, `//` comments, trailing commas, empty file.
  A file that cannot be parsed is never overwritten.
- Write atomically: temp file in the same directory, then rename.
- Write private files with mode `0600`, parent directory `0700`.
- Serialize in-process and take a cross-process lock (lock file beside the
  target, stale after about 10 seconds, retry for about 3 seconds).
- Preserve unknown keys and ordering; edit the document minimally.
- Set an unparsable file aside as `<name>.corrupt-<timestamp>` before the first
  replacement, as Pie does for presets and session state.
- `models.json` may be a symbolic link: resolve it and write through the target.
- Normalize partial `cost` groups to include all four keys, as
  `lib/models-config-store.ts` does.

### 5.4 Resolution order to match Pi

- Session directory: `--session-dir`, then `PI_CODING_AGENT_SESSION_DIR`, then
  `settings.json` `sessionDir`, then `<agent-dir>/sessions`.
- Working directory: `--cwd`, then the last TUI choice, then the process
  directory. Resuming a session uses the directory Pi recorded for it.

### 5.5 Working directory changes

`rpc.Options` already carries `Dir`. Changing directory for a new session means
restarting the child in the new directory; resuming keeps Pi's own behavior. The
project list is derived from the working directories recorded in session files,
so both clients list the same projects without a second index.

## 6. Runtime gaps and channels

### 6.1 RPC commands absent from pi 1.5.0

`set_tools`, `reload`, tool inventory, system-prompt read, and title generation.
Pie gets them from the in-process SDK, not from the RPC protocol.

### 6.2 Channel: CLI subprocesses

Work that Pi's CLI can do outside a session runs as a child process:

| Need | Command |
| --- | --- |
| Refresh model catalog | `pi update --models` |
| Provider readiness | `pi auth check --provider <id> --json` |
| Provider list, sign-in, sign-out | `/pie-providers`, `/pie-login`, `/pie-logout` in the bridge extension |
| MCP listing and testing | `pi mcp list --json` |
| MCP sign-in and sign-out | `pi mcp login <server>` / `pi mcp logout <server>` |
| Package install, remove, update | `pi install` / `pi remove` / `pi update --extensions` |
| Skill search, install, update | `npx skills ...` (same commands Pie runs) |
| Title generation | one-shot `pi --print --no-session --no-tools` |

### 6.3 Channel: child restart

Changing the tool set, settings-owned behavior, or `AGENTS.md` can restart the
`pi` child with the same session file and new flags. Pie also rebuilds its
session for tool changes, so the semantics match. The TUI must:

1. Close stdin and wait for exit with the existing escalation ladder.
2. Spawn with `--session <file>` (or the original flags when no file exists yet).
3. Re-run the handshake and restore transcript, queues, and overlay state.
4. Keep extension UI requests from the old child out of the new queue.

### 6.4 Channel: bundled bridge extension (chosen)

A small extension ships inside the binary and is loaded with `-e`. It closes the
remaining gaps and gives exact session-log compatibility with Pie.

**Distribution.** `internal/bridge/bridge.js`, embedded with `go:embed`, written
at startup to `<state-dir>/bridge/pie-bridge-<content-hash>.js` with mode `0600`.
The hash in the name makes upgrades self-cleaning and allows several versions to
coexist.

**Commands** (sent as `prompt`; the response disposition is `handled`):

| Command | Behavior |
| --- | --- |
| `/pie-tools <a,b,c>` | Validate names, `pi.setActiveTools(names)`, append `pie:tool-selection` `{version:1, tools, extensionTools}` |
| `/pie-tools configured` | Append `{version:1, cleared:true}`, then `ctx.reload()` so `defaultTools` resolve |
| `/pie-mode plan\|none` | Append `pie:work-mode` `{version:1, mode}` |
| `/pie-reload` | `ctx.reload()` |
| `/pie-publish <path>` | Write `getAllTools()` and `ctx.getSystemPrompt()` as JSON for the TUI to read |
| `/pie-providers <path>` | Write every provider with its auth methods, status, and model count as JSON |
| `/pie-login <provider> [oauth\|api_key]` | Run pi's own `ModelRuntime.login` detached and report through `pie-auth ` notifications |
| `/pie-auth-cancel <provider>` | Abort the running sign-in through its abort signal |
| `/pie-logout <provider>` | Delete the stored credential and refresh the provider's models |
| `/pie-usage <provider> <path>` | Resolve the provider credential, fetch its official usage endpoint, and write the normalized windows and balances as JSON |

`/pie-publish` writes to a caller-supplied path instead of appending entries, so
the session log is not bloated by snapshots. The sign-in commands need the same
out-of-band channel: a login outlives the prompt response, so its progress and
result travel as `pie-auth ` notifications that the TUI renders as an overlay.

**Plan mode parity.** The extension injects plan guidelines in
`before_agent_start` and blocks `bash`, `powershell`, `edit`, `write`, and
`apply_patch` in `tool_call`, matching `lib/plan-mode-extension.ts`. Because the
mode lives in the session log, a Plan session started in Pie behaves as Plan in
the TUI and the reverse.

**Availability and fallback.** Availability is `get_commands` reporting
`pie-tools`. If loading fails (`extension_error`) or the command is absent, the
TUI shows a warning and falls back to: presets applied by restarting the child
with `--tools` plus a TUI preference file, and Plan mode via `--tools` plus
`--append-system-prompt`. No other feature depends on the bridge.

### 6.5 Preset application flow

1. Resolve the selection to tool names and an extension-tools policy using the
   same rules as `lib/tool-presets.ts`.
2. Send `/pie-tools` (or `/pie-tools configured`).
3. Send `/pie-mode` when the work mode changes.
4. Refresh state, tool inventory, and header.
5. On bridge failure, use the fallback path from section 6.4.

## 7. Phase plan

Every phase ends with `go build ./...`, then `make build` and a manual walk
through the TUI in tmux. Pure logic (JSONC parsing, preset validation,
enabled-model editing, goal facts, title transcript) gets focused unit tests;
the full suite is not run.

### P0: Configuration foundation

- `internal/config`: paths, JSONC reader, atomic and locked writes, typed
  accessors for every shared file, TUI preferences.
- `internal/session`: honor the agent directory and `settings.json`
  `sessionDir`; expose session metadata (name, cwd, tool selection, work mode,
  goal facts) parsed from entries.
- `cmd/pie`: agent-dir wiring, `--cwd`, restart support in the RPC client.
- Acceptance: building and opening a session writes nothing; a save round-trips
  every shared file without dropping unknown keys; corrupt-file behavior is
  covered by tests.

### P1: Settings shell and the first three tabs

- `internal/ui/settings.go`: modal shell, tab rail, focus management, dirty
  tracking, save/cancel, settings search.
- `internal/ui/widgets.go`: switch, radio row, text field, number field,
  multi-line editor, list, status line.
- General: transcript tool display, enter-send mode, diff layout, cache-miss
  notices (`settings.json`), and the browser-only entries omitted.
- Instructions: `AGENTS.md` editor; save then reload through the bridge or a
  restart.
- Appearance: theme picker that reproduces Pie's palette names with terminal
  colors.
- Acceptance: all tabs are reachable, three have real content, and the
  remaining tabs show a placeholder.

### P2a: Bridge extension

- `internal/bridge`: embedded asset, extraction, command constants,
  availability probe, publish-file reader, fallback switch.
- Load with `-e`; initial publish after the handshake.
- Acceptance: `/pie-tools` changes the active tools without a restart, the
  session log gains a `pie:tool-selection` entry, Pie reads it, and
  `/pie-reload` picks up an edited `settings.json`.

### P2b: Tools and presets

- `internal/presets`: built-in presets (`configured`, `plan`, `chat-only`,
  `read-only`, `default`, `full`), custom presets from `pie-tool-presets.json`,
  Pie's validation rules (`version: 1`, at most 20, unique case-insensitive ids
  and names, non-empty tool lists, `powershell` stored as `bash`,
  `includeExtensions` default true).
- Composer preset selector, key binding, and `/preset`.
- Settings, Tools tab: built-in reference list and custom preset editor with
  per-tool toggles and availability from `/pie-publish`.
- Plan mode: read-only tools plus the work-mode entry.
- Acceptance: the same `pie-tool-presets.json` is offered by both clients; a
  preset chosen in one is reflected in the other; Plan blocks writes.

### P3: Models and Providers tabs

- `internal/catalog`: merge `models-store.json`, `models.json`, `auth.json`, and
  `settings.json`; enabled-model pattern matching (globs, `provider/model`,
  `:thinking` pins); minimal-edit operations for enable, disable, pin, prune,
  clear; provider ordering.
- Sections:
  - Models, general: global context limit from `pie-model-settings.json`; blank
    means explicit no cap; first-install default 350,000; default model and
    thinking level.
  - Models, defaults: enabled models with per-model switches, pin, prune, clear,
    and catalog refresh through `pi update --models`.
  - Models, reasoning: per-model `modelThinkingLevels` and context-window
    overrides with the supported levels from the catalog.
  - Providers: `defaultProvider`, every provider with its OAuth and API-key
    methods and sign-in state, API-key readiness via `pi auth check`, sign-in
    and sign-out through the bridge extension, custom providers with their
    models, add, edit, and delete, and subscription usage windows and balances
    through `/pie-usage`.
- Session model picker honors enabled models, per-model reasoning defaults, and
  the context limit.
- Acceptance: changes written by the TUI appear in Pie's Models panel and the
  reverse; the model picker only offers enabled models and uses the configured
  reasoning level.

### P4: Title generation

- `internal/title`: transcript selection and caps matching
  `lib/session-title.ts` (per-message caps, 6,000-character budget with 40%
  reserved for the opening turns, images as placeholders), the title prompt and
  its language and length rules, the lowest supported thinking level, a
  256-token limit, and a 90-second timeout.
- Run a one-shot `pi --print --no-session --no-tools --model <provider/id>`,
  parse the last non-empty line, trim, cap at 80 characters, then
  `set_session_name`.
- Commands: `/title` and `/name` manual rename.
- Automatic naming: an unnamed session is named from its first accepted prompt,
  retried when a turn settles (including aborted turns), and named from history
  when it is resumed, attached, forked, or cloned. A running client watches the
  session file for a title written by the Web UI. The resume picker reads the
  newest `session_info` name from anywhere in the file, not just a fixed tail
  probe.
- Acceptance: titles are generated for both English and CJK sessions; manual
  failures surface as an error block while automatic failures stay silent;
  titles written by either client are visible to the other.

### P5: Goal

- `internal/goal`: read `pi-better-goal` / `pi-codex-goal` entries from
  `get_entries` and `entry_appended`; parse status, objective, tokens used, and
  budget; treat unknown statuses as waiting; expose start, pause, resume,
  complete, clear mapped to `/goal ...` prompts.
- Availability is the `goal` command reported by `get_commands`.
- Preference `goal.enabled` in `pie-settings.json`. Enabling it without the
  extension is refused with install instructions
  (`pi install npm:pi-better-goal`); no partial state is written.
- Goal panel: status, objective (locked while running), token usage and budget,
  and a stop action; the status also appears in the header.
- Acceptance: enabling without the package errors; installing the package and
  starting a goal works and agrees with Pie.

### P6: Skills and plugins

- `internal/skills`: discover global, project, `~/.agents/skills`, settings
  paths, and package skills; parse frontmatter name and description; toggle
  `disable-model-invocation`; open the skill file; search, install, check, and
  update through `npx skills` (`SKILLS_API_URL`, default `https://skills.sh`).
- `internal/plugins`: list `settings.json` packages per scope with their
  resources; disable by writing the all-empty resource lists and enable by
  removing only those lists; install, remove, and update through the `pi`
  commands; mark reload required after changes.
- Acceptance: lists match Pie's; toggling a skill changes its
  `SKILL.md` frontmatter; disabling a package survives a restart.

### P7: MCP

- `internal/mcp`: read and write global `mcp.json` and trusted project
  `.pi/mcp.json`; list servers with transport, command or URL, exposure, and
  state; add (stdio or HTTP), edit, remove, enable, disable; test through
  `pi mcp list --json`; sign in and out through `pi mcp login` / `logout`.
- Secrets: environment variables and headers are stored in `mcp.json`; values
  are masked in lists as Pie does.
- Acceptance: both clients show the same servers, and a server added in the TUI
  is visible in Pie and usable.

### P8: Working directory parity

- `--cwd`, `/cwd` with a directory browser (path entry plus list navigation),
  recent projects derived from session files, session list filter by directory
  with a show-all toggle.
- New sessions start in the chosen directory; switching directories or projects
  restarts the child. `--cwd` wins; otherwise the process directory is the
  default and the last choice only seeds the picker.
- Acceptance: a session created in the TUI appears under the same project group
  in Pie.

### P9: Remaining conversation surfaces

- Branch and tree navigation through `get_tree`, `fork`, `clone`.
- Session search and a statistics panel.
- `/image` attachment through the existing image prompt support.
- System prompt and tool definitions panel fed by `/pie-publish`.
- Acceptance: manual walkthrough of each surface.

## 8. Not reproducible one to one

- Appearance fonts, font sizes, content width, and browser theme tiles: only a
  terminal palette and density mapping.
- General language switching, PWA push, and web login/logout: not applicable.
  Quote-selection, transcript tool cards, and side-by-side diff become terminal
  equivalents only: ctrl+o expands tool output and diffs in place.
- Provider sign-in is bridged through the extension, so the TUI runs the same
  OAuth and API-key flows as Pie and writes the same `auth.json`. Subscription
  usage and quota use the same bridge: `/pie-usage` resolves auth through pi
  and reads the provider's official endpoint, so the panel matches Pie's usage
  view.
- Online model discovery and connectivity tests: reduced to
  `pi update --models` and `pi auth check`.
- Task workspace, queue, orchestrator, autonomous preset, and drag-and-drop:
  out of scope by request.
- Mermaid diagrams and chat minimap: no terminal equivalent.

## 9. Risks

- **Concurrent writes.** The TUI and Pie may write the same file at once. The
  lock, atomic replace, minimal edits, and preserve-unknown-keys rules are the
  mitigation and must be centralized in `internal/config`, not repeated.
- **Pi version drift.** RPC behavior is implemented against 1.5.0. Capability
  probes decide whether a command exists; anything unavailable falls back to
  the CLI or a restart. Unknown events already degrade safely.
- **Terminal form complexity.** The settings surface needs focus management,
  text editing in fields, and scrolling. It is the largest UI work and should
  land as reusable widgets rather than per-tab code.
- **Bridge extension API.** The bridge depends on `setActiveTools`,
  `appendEntry`, `ctx.reload`, `getAllTools`, `getSystemPrompt`, `tool_call`,
  and `before_agent_start`. Every use is probed, and the documented fallback
  keeps presets usable if the extension fails to load.
- **Session log compatibility.** `pie:tool-selection` and `pie:work-mode` must
  match Pie's shapes exactly or the clients will disagree. The parsers are
  covered by unit tests built from Pie's fixtures.

## 10. Verification and documentation

- Build: `go build ./...` after each change; `make build` before manual checks.
- Manual: drive the TUI in tmux for each phase's acceptance items, including a
  round trip with Pie for the shared files.
- Unit tests only for pure logic; the automated suite is not run as part of
  normal work, per the repository instructions.
- Documentation: update `../README.md` (commands, key bindings, requirements),
  `architecture.md` (configuration layer, bridge extension, restart behavior),
  and `settings.md` (the settings reference).

## 11. Decisions

- The bridge extension is included and loaded with `-e`; it is the primary
  mechanism for tool switching, reload, Plan mode, and publishing tool and
  system-prompt snapshots. Restart and CLI fallbacks remain.
- The TUI keeps one extra preferences file, `pie-settings.json`, for
  terminal-only choices. All shared configuration stays in Pi's files.
- Tasks, orchestration, and drag-and-drop are excluded.
