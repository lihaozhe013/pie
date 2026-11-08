# Pie

Pie is a local client for the [Pi](https://github.com/earendil-works/pi) coding agent. This
repository contains two independent clients that share Pi, not code:

| Directory          | Client                                 | Stack                                       |
| ------------------ | -------------------------------------- | ------------------------------------------- |
| [`webui/`](webui/) | Browser interface with a Tauri 2 shell | TypeScript, React, Hono, Vite, Bun, Node.js |
| [`tui/`](tui/)     | Terminal interface                     | Go, Bubble Tea                              |

Both clients are host shells. Pi owns the agent loop, tools, sessions, and providers; the clients
present that work and speak to the installed `pi` binary or SDK. Neither client embeds a second
agent or defines a parallel agent protocol. Both read the same Pi agent directory, so sessions,
settings, models, skills, plugins, and MCP servers are shared.

The two projects are intentionally independent. Each has its own `README.md`, `AGENTS.md`, `docs/`,
dependency manifest or Go module, build, and license. There is no root package-manager workspace, no
shared source tree, and no cross-project import.

## Positioning

Pie is a UX layer for Pi, not a replacement for it. Both clients make the installed agent easier to
drive; neither changes how it runs.

- `tui/` is the detail client and the fallback. It shows the conversation with full fidelity in a
  terminal: streaming output, tool calls, diffs, thinking blocks, and token and context statistics.
  One statically compiled binary works over SSH, in tmux, on a remote server, or on a machine
  without a browser.
- `webui/` is the orchestration client. It carries parallel conversations, one task queue per
  working directory, and work across projects, and it can be reached from another device on the
  LAN.
- Both stay lightweight first. A good default beats a speculative setting, and feature count never
  outranks clarity.

The boundary follows from that split: a feature may change how Pi's work is presented, scheduled,
and driven, but not how Pi executes it. Subagents, a second agent loop, a parallel tool or session
protocol, or any other new execution model are out of scope for both clients.

## Quick start

### Web UI

Requires Node.js 22.14 or newer and the latest Bun release.

```sh
cd webui
bun install --frozen-lockfile
bun run dev
```

Open <http://127.0.0.1:30141>. For a production build, run `bun run build` and `bun run start` from
`webui/`. The desktop shell uses the same payload; `bun run desktop:build` builds it. Read the
[web UI README](webui/README.md) before exposing the server to a network: without `PIE_PASSWORD`,
access is unauthenticated and can allow command execution.

### TUI

Requires Go 1.24 or newer and `pi` 1.5.0 or newer on `PATH`.

```sh
cd tui
make build
./bin/pie
```

Install it on `PATH` with `make install`. Read the [TUI README](tui/README.md) for flags, key
bindings, slash commands, and settings.

Both clients expose a command named `pie`. Keep only one on `PATH`, or install them under distinct
prefixes, when both are in use.

## Repository layout

```text
.
├── webui/                  Browser client, server, desktop shell, and its own docs
├── tui/                    Go terminal client and its own docs
├── docs/                   Repository-level guide and CI reference
├── .github/workflows/      Build-only repository CI
├── AGENTS.md               Repository-level agent routing
└── README.md               This file
```

Project-specific documentation stays inside each project. Start with
[`webui/docs/README.md`](webui/docs/README.md) or
[`tui/docs/architecture.md`](tui/docs/architecture.md). The repository guide explains the
boundaries.

## CI and releases

The only automated build is [`.github/workflows/ci.yml`](.github/workflows/ci.yml). Push the `ci`
branch to run it:

```sh
git push origin HEAD:ci
```

The workflow is build-only. It does not run tests, typecheck, or lint. It builds:

- the Windows x86-64 NSIS desktop installer from `webui/`;
- the portable web archive and its checksum from `webui/`;
- statically compiled TUI archives for Linux, macOS, and Windows on amd64 and arm64;
- one SHA-256 checksum file covering the release artifacts.

The release job replaces the `ci-latest` release and tag, so one tag always points at the newest
successful `ci` build. See [CI and releases](docs/ci.md) for job details, local equivalents,
artifact names, and requirements.

## Documentation

- [Repository guide](docs/README.md)
- [CI and releases](docs/ci.md)
- [Web UI README](webui/README.md) and [web UI documentation](webui/docs/README.md)
- [TUI README](tui/README.md) and [TUI architecture](tui/docs/architecture.md)
- [Coding agent instructions](AGENTS.md)

All repository documentation is maintained in English.

## Attribution and license

The web UI is based on [Pi Web](https://github.com/agegr/pi-web) by agegr, with agent capabilities
provided by [Pi](https://github.com/earendil-works/pi). Its original attribution and MIT license are
retained in [`webui/LICENSE`](webui/LICENSE). The TUI is MIT licensed under
[`tui/LICENSE`](tui/LICENSE). The repository-level license is in [`LICENSE`](LICENSE).

These independent personal versions do not represent the source projects.
