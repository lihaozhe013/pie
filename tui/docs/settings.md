# Settings reference

`pie` splits configuration the way Claude Code does: `/settings` holds the
general settings, and every resource domain is a page with its own command.
The pages share one interaction model, so learning one teaches the rest.

| Command | Page | Owns |
| --- | --- | --- |
| `/settings` (`/config`, `/prefs`) | Settings | General, Instructions, Tools |
| `/model-settings` | Model settings | Startup model and thinking level, enabled models, context windows, catalog |
| `/providers` | Providers | Credentials, sign-in, compatible endpoints, usage limits |
| `/skills` | Skills | Discovery, install, frontmatter toggles |
| `/mcp` | MCP | Servers, transports, connection checks |
| `/plugins` | Plugins | Pi packages |

`/settings models`, `/settings providers`, `/settings skills`, `/settings mcp`,
and `/settings plugins` redirect to the matching page. `/model` remains the
quick model picker; `/model-settings` is the page where models are enabled.

If pi advertises a command with the same name, pi's command wins, so an
extension's own `/mcp` handler is never shadowed. The page stays reachable as
`/settings mcp` in that case.

Every page reads the same files as the Pie web UI, so a change made in either
client is visible to the other after a reload. The web UI still presents the
surfaces in one nine-section panel; the TUI entry points differ, the files do
not. Shared files are written immediately, with a lock and an atomic replace.
The TUI never drops JSON keys it does not understand.

## Using a page

The filter is always visible. Typing any printable character, including a
space, appends to the query; there is no prefix key and no separate search
dialog. Matches span every category on the page and are grouped under their
section headings, best rows first inside a group. The right edge of the filter
line shows `matches / total`.

| Key | Action |
| --- | --- |
| printable characters, `space` | filter the page |
| `backspace`, `ctrl+w`, `ctrl+u` | delete a character, delete a word, clear the filter |
| `up` / `down`, `ctrl+p` / `ctrl+n` | move between rows |
| `pgup` / `pgdn`, `home` / `end` | move a page, jump to the first or last row |
| `tab` / `shift+tab`, `left` / `right` | switch category on the Settings page |
| `enter` | change the row; while a filter is active, first jump to the matched row |
| `esc` | clear the filter, then return one panel, then close the page |
| `ctrl+r` | reread the shared files |

`enter` on a filtered row clears the query and leaves the cursor on that row;
a second `enter` performs the change. A search cannot write a setting by
accident. While a query is active the list spans every section, so the category
keys wait until the query is cleared; the category bar follows the selected
match. Values paint as `true`/`false` for toggles, and rows that open something
carry a trailing `›`.

Rows with a text editor open an inline field; `enter` saves and `esc` cancels.
Every other write applies immediately and reports `saved`, or the error, in the
status line under the selected row's description.

## Settings › General

Terminal-only preferences that a browser does not have come first, then the
shared `settings.json` values.

| Row | File | Notes |
| --- | --- | --- |
| Enter sends | `pie-settings.json` | When off, enter inserts a newline and alt+enter sends. |
| Thinking blocks | `pie-settings.json` | Same as `ctrl+t`; visible thinking keeps its newest three rows, and hidden thinking does not render at all. |
| Expand output | `pie-settings.json` | Same as `ctrl+o`; expands thinking, tool output, and diffs. Collapsed cards always keep a fixed preview. |
| Cache-miss notices | `settings.json` (`showCacheMissNotices`) | pi reads it on start or reload. |
| Session directory | `settings.json` (`sessionDir`) | Blank uses pi's default under the agent directory. |
| Agent directory | read-only | `PI_CODING_AGENT_DIR` or `~/.pi/agent`. |
| Settings file | read-only | The agent `settings.json` in use. |
| Bridge extension | read-only | `ready` when pi advertises `pie-tools`. |
| Goal controls | `pie-settings.json` | Enabling requires the `pi-better-goal` package. |
| Reload pi | session prompt `/pie-reload` | Rereads settings and instructions; needs the bridge. |

## Settings › Instructions

Edits the global `AGENTS.md` in the agent directory with a multi-line editor.
`ctrl+s` saves. With the bridge, the save sends `/pie-reload` so pi rereads the
file without a restart; otherwise the change applies to the next pi run.

## Settings › Tools

- Current applies `defaultTools` through the bridge. Presets are the built-in
  configured, plan, autonomous, chat-only, read-only, default, and full sets
  plus custom entries from `pie-tool-presets.json`. The last applied preset is
  stored in `pie-settings.json` (`toolPreset`) and reapplied to a new session;
  a resumed session keeps the selection recorded in its own log. Plan and
  autonomous carry a work mode: plan keeps the project read-only, activates
  `update_plan`, and writes a durable plan file under the agent directory;
  autonomous omits `ask_user` from each run and adds guidance to decide and
  keep working. After approval, `update_plan` stays available for a
  status-only `done` update; plan content is read-only until Plan mode is
  re-entered. `/artifact` opens the plan artifact (`/plan` is an alias):
  `a` approves and starts implementation, `r` rejects and requests changes,
  `m` switches the model before approval, `y` copies, and `esc` closes.
- Code mode: automatic or always writes `+codemode` into `defaultTools` with the
  smallest edit; code-mode tools choose `on` or `only`; the inline result budget
  edits `codemode.inlineBudget`.
- PowerShell tool (Windows only) swaps `powershell` for `bash` in the resolved
  tool list.

## Model settings

The Model settings page owns model selection and metadata. It shares
`models.json`, `settings.json`, `models-store.json`, and
`pie-model-settings.json` with Pie:

- Defaults: the startup model and thinking level. Picking a model in the TUI
  writes `defaultProvider` and `defaultModel`, and every thinking-level change
  is written to `modelThinkingLevels` for the current model, so the next launch
  starts where the last one ended. A resumed session still restores the model
  and level recorded in its own log.
- Context-window cap: blank stores an explicit no-cap in
  `pie-model-settings.json`. The cap also feeds the context meter in the header
  and `/stats`: a model with a larger native window is shown as the cap size, as
  in Pie.
- Enabled models: patterns and per-model switches; edits expand only the
  pattern that covers the changed model and keep `:level` pins and unmatched
  patterns intact.
- Per-model thinking levels: `modelThinkingLevels` for the session model picker.
- Per-model context windows: writes `providers.<id>.modelOverrides.<model>.contextWindow`
  in `models.json`, keeping other override keys and removing empty objects.
- Catalog: the merged provider and model count, plus `Refresh model catalog`,
  which runs `pi update --models`.

## Providers

The Providers page owns credentials, endpoints, and subscription usage:

- Default provider: `defaultProvider` in `settings.json`. Picking a model in
  Models also writes this key.
- Credentials: every built-in provider, including ones with no credential yet,
  with its sign-in state and model count. `Add provider` defines a compatible
  endpoint in `models.json`, with an option to automatically discover and enable
  all available models on save.
- Provider entries: credential state, OAuth and API-key sign-in, base URL, API,
  and the provider's models. `Edit provider` exposes the compatibility
  endpoint, API key, and a `pi auth check` readiness test. `Fetch models` queries
  the provider's endpoint, adds all discovered models to `models.json`, enables
  them by default in `settings.json`, and tells the running pi to reload without
  restarting. A custom provider or model opens its editor; a catalog model opens
  a read-only summary with its context window, output limit, reasoning support,
  and cost.
- Usage limits: rate-limit windows and balances queried from the provider's own
  endpoint. Supported providers are OpenAI Codex (5-hour and weekly windows),
  DeepSeek, OpenRouter, Moonshot AI and Moonshot AI CN, MiniMax and MiniMax CN
  (rolling and weekly quotas or balance), Vercel AI Gateway, OpenCode Go, and
  Kimi For Coding. A panel shows each window's remaining percentage or count,
  its reset time, and balance metrics. The first open queries automatically;
  `Refresh usage` queries again. Reports stay in memory and are not written to
  disk. The bridge resolves the credential through pi's `ModelRuntime`, so
  OAuth refreshes and provider-scoped environment stay inside pi, and only the
  provider's official origin receives it.

Provider sign-in runs through the bridge extension, so the OAuth flows and
`auth.json` writes are pi's own. `Sign in to a provider` and `/login` list every
provider and the methods it offers; a provider that supports both appears once
as OAuth and once as API key. `/logout`, the page's `Sign out`, and `Sign out of
a provider` delete a stored credential. While a flow runs, the TUI shows the
verification URL or device code in an overlay: `o` or `enter` opens the page in
the platform browser, `c` copies the code or URL, `ctrl+x` cancels the flow, and
`esc` hides the overlay without cancelling. A finished sign-in refreshes the
provider list and the available models, and a session with no model adopts the
new provider's first one.

## Skills

Discovers agent, project, settings, `~/.agents/skills`, and installed-package
skills. The detail panel toggles `disable-model-invocation` in the frontmatter,
opens the file in `$VISUAL`/`$EDITOR`, and shows that changes apply on the next
pi start or reload. Search and install use the same `npx skills` commands as
Pie.

## Plugins

Lists packages from the global `settings.json` and the project's
`.pi/settings.json`. Install, remove, and update shell out to `pi install`,
`pi remove`, and `pi update`. Disabling writes all four resource lists empty and
refuses packages that carry their own filters; enabling removes only those
empty lists, preserving `autoload` and unknown keys. Reload from the detail
panel or General to apply.

## MCP

Reads and writes `mcp.json` and a trusted project `.pi/mcp.json`. Servers show
transport, exposure, enabled state, and env/header names with values masked.
Connection checks use `pi mcp list --json`; add, login, logout, and remove use
the matching `pi mcp` commands so validation stays identical to Pie. Project
servers are read-only without an explicit trust decision for the folder, and a
project package can only be changed once its resources are trusted; the TUI
reads the nearest decision from `trust.json`, inherited from a parent folder.

## Goal

A separate panel opened by `/goal` (or Settings › General). It reports the
installed goal package's status, objective, and token usage and sends
`/goal start|pause|resume|complete|clear`. The package must be installed
manually with `pi install npm:pi-better-goal`; the TUI never bundles or installs
it.

## Terminal-only preferences

`pie-settings.json` holds choices a browser does not have:
`enterToSend`, `goalEnabled`, `lastCwd`, `toolPreset`, `showThinking`, and
`expandTools`. `toolPreset` seeds a new session with the last preset chosen in
the terminal; everything shared stays in pi's files. Model and thinking-level
choices are not stored here because they are shared: they go to
`defaultProvider`/`defaultModel` and `modelThinkingLevels` in `settings.json`.
