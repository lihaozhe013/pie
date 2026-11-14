# Repository Guide

Pie is a monorepo with two independent clients for the Pi coding agent. This guide explains what
belongs where, what the clients share, and where to find the detailed documentation.

## Positioning

The two clients divide the work. `tui/` is the detail client and the fallback: it renders the
conversation with full fidelity in a terminal, and one static binary works over SSH, in tmux, on a
remote host, or on a machine without a browser. `webui/` is the orchestration client: parallel
conversations, per-project task queues, and work across projects, reachable from another device on
the LAN. Both are lightweight first.

Both are a UX layer over Pi. A feature may change how Pi's work is presented, scheduled, and driven;
it may not change how Pi executes it. Subagents, a second agent loop, a parallel tool or session
protocol, or any other new execution model are out of scope for both clients.

## Clients

| Directory | Responsibility                                            | Runtime                                     | Documentation                                                                  |
| --------- | --------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------ |
| `webui/`  | Browser interface, Hono server, and Tauri 2 desktop shell | Node.js, Bun, TypeScript, React, Vite, Rust | [Web UI README](../webui/README.md) and [docs index](../webui/docs/README.md)  |
| `tui/`    | Terminal client, settings panels, and bridge extension    | Go, Bubble Tea                              | [TUI README](../tui/README.md) and [architecture](../tui/docs/architecture.md) |

Both are presentation layers. Pi supplies the agent loop, tools, sessions, providers, extensions,
and configuration semantics. The web UI uses the Pi SDK in its Node.js server; the TUI starts the
installed `pi` binary in RPC mode and speaks newline-delimited JSON over stdin and stdout. Neither
project defines a second agent protocol.

## Boundaries

Keep these ownership rules when changing the repository:

- Both clients are a UX layer over Pi. Presentation, orchestration of ordinary Pi sessions, and
  configuration convenience are in scope; execution semantics are not. Do not add subagents, a
  second agent loop, or a parallel tool or session protocol to either client.
- `webui/` owns its package manifest, Bun lockfile, Vite configuration, server, components, styles,
  Tauri shell, packaging, and documentation.
- `tui/` owns its Go module, packages, Makefile, bridge extension, and documentation.
- The root owns repository navigation, agent routing, CI, and release documentation.
- The clients may link to each other in prose, but they do not import each other's code. There is no
  root workspace, shared package, shared Go package, or shared build script.
- Project-specific configuration stays inside the project. If a file is only read by one client's
  build, it does not belong at the root.

The agent instruction files follow the same boundary: root [`AGENTS.md`](../AGENTS.md) routes work,
while [`webui/AGENTS.md`](../webui/AGENTS.md) and [`tui/AGENTS.md`](../tui/AGENTS.md) contain the
project rules.

## Shared Pi state

The clients integrate through Pi, not through each other:

- The agent directory is `PI_CODING_AGENT_DIR` when set, otherwise `~/.pi/agent`.
- Sessions, `settings.json`, `models.json`, `auth.json`, `mcp.json`, global `AGENTS.md`, skills,
  plugins, the `pie-*` companion files, and `pie-plans/` are read and written there.
- A session started in one client can be resumed in the other because both use Pi's session format
  and the same `pie:*` session entries where applicable.
- The TUI's bridge extension adds the same hot tool switching, Plan mode, and reload entries the web
  UI uses. Plan mode also writes a durable `pie-plans/<session-id>.md` file in the agent directory;
  see [Plan mode](plan-mode.md). It is loaded into Pi; it is not shared code.

Treat those files as a public runtime contract. A change to one client's interpretation of a shared
file needs a matching check in the other client when the behavior overlaps, but not a shared code
module.

## Development

Each project is developed and built independently:

```sh
# Web UI
cd webui
bun install --frozen-lockfile
bun run dev

# TUI
cd tui
make build
./bin/pie
```

Use the project README and `AGENTS.md` for required tool versions, build commands, verification
rules, and platform notes. The web UI supports keyboard use, narrow screens, and reduced motion; use
semantic theme variables for appearance changes. The TUI keeps the process boundary and protocol
invariants described in its architecture document.

Verification is manual in both projects. Do not run or add automated tests. Compiling to confirm the
code is well-formed is allowed.

Both clients expose a command named `pie`. Keep only one on `PATH`, or install them under distinct
prefixes, when both are in use.

## CI and releases

The repository has one build-only workflow, [CI build](../.github/workflows/ci.yml). Pushing the
`ci` branch builds both clients and replaces the `ci-latest` release with the complete artifact set.
No tests, typecheck, lint, npm publication, or updater run. The full contract, including artifact
names and local equivalents, is in [CI and releases](ci.md).

## Documentation map

| Document                                        | Purpose                                                     |
| ----------------------------------------------- | ----------------------------------------------------------- |
| [Repository README](../README.md)               | Overview, quick start, layout, and license                  |
| [Repository guide](README.md)                   | This document: boundaries, shared state, and conventions    |
| [CI and releases](ci.md)                        | Workflow jobs, artifacts, checksums, and local builds       |
| [Plan mode](plan-mode.md)                       | The shared plan file, tool, session entry, and injection     |
| [Web UI docs](../webui/docs/README.md)          | Product direction, architecture, runtime, and desktop shell |
| [TUI architecture](../tui/docs/architecture.md) | Process boundary, protocol rules, and rendering             |
| [TUI settings](../tui/docs/settings.md)         | Row-by-row settings reference                               |
| [Agent instructions](../AGENTS.md)              | Repository-level rules for coding assistants                |

All documentation is maintained in English.

## License and attribution

The web UI is based on [Pi Web](https://github.com/agegr/pi-web) by agegr; its MIT license and
attribution remain in [`webui/LICENSE`](../webui/LICENSE). The TUI is MIT licensed in
[`tui/LICENSE`](../tui/LICENSE). The repository-level MIT license is in [`LICENSE`](../LICENSE).
