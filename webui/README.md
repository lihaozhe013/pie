# Pie

A minimal GUI for Pi: talk to the agent, follow its work, and continue the conversation in a clear,
polished browser interface.

This is an independently maintained project for personal, local use. It no longer tracks or merges
its source project. It is not an IDE or an all-in-one manager.

This is the orchestration client in Pie: parallel conversations, one task queue per working
directory, and an Orchestrator preset that drives a queue from a session. The terminal client in
`../tui` is the detail client and the fallback on machines without a browser. Both stay lightweight
first, and both are a UX layer over Pi: orchestration here schedules ordinary Pi sessions; it is not
multi-agent orchestration and adds no second agent runtime.

This directory is the browser client in the Pie monorepo. It is independent of the terminal client
in `../tui`: the two share Pi's configuration files, but no code, dependencies, or build pipeline.

## Scope

- Choose a working directory and create or resume sessions.
- Send messages, attachments, and file references.
- Read streaming replies and inspect tool execution, results, and errors.
- Discuss a change in Plan, a read-only mode where the agent asks you questions before anything is
  written.
- Access the controls and information needed for the conversation.

Pi provides the agent capabilities; this project provides their presentation and interaction.
Visualizing the CLI does not mean building a management panel for every CLI feature. The queue and
the Orchestrator preset stay inside that rule: they schedule ordinary Pi SDK sessions and add one
tool, not an execution model.

Pie does not provide built-in subagents or an agent-orchestration runtime, Git/worktree management,
file browsing, file previews, or terminal tabs. Sessions are grouped by their working directories,
not by Git repositories. Installed Pi extensions still load according to Pi semantics; Pie does not
add an agent-management layer around them.

Historical subagent sessions and settings from the original Pi Web project have no compatibility or
migration layer here. Existing files are not deleted automatically. Historical settings modules for
other features are not commitments to retain those features.

## Run locally

Use the latest Node.js LTS release and the latest Bun release. Run these commands from `webui/`.

```sh
bun install --frozen-lockfile
bun run dev
```

Open <http://127.0.0.1:30141>. Vite serves the interface on that port and proxies `/api` to the Node
server on 30142. The app uses local Pi configuration and credentials. Sessions default to
`~/.pi/agent/sessions/`. Existing sessions can be browsed without model credentials; sending prompts
requires a configured provider.

For a production build, run `bun run build` followed by `bun run start`. The production server
listens on all IPv4 interfaces by default, so other devices can connect at
`http://<server-lan-ip>:30141`. Use `bun run start:local` to listen only on loopback. The
development server remains loopback-only by default; `bun run dev:lan` enables LAN access.

Bun manages dependencies and invokes scripts. Node.js remains the runtime.

```sh
bun run typecheck
bun run lint
```

This project has no tests and no test runner: verification is manual, by running the build and using
the interface. See [local packaging](packaging/README.md) for portable builds and
[desktop shell](docs/desktop.md) for the Tauri window. The repository's build-only CI workflow
builds this client and the TUI on pushes to the `ci` branch; see [CI](../docs/ci.md). There is no
npm publication workflow and no automated update channel.

## Version

The package version stays at `0.1.0` for personal use, so builds identify themselves by the short
commit appended as SemVer build metadata. The configuration reads `HEAD` at dev and build time; a
portable build runs in a copy without `.git` and receives the commit through `PIE_COMMIT`, which
also overrides the commit for any other build.

The sidebar's mark opens About, which shows the full version (`0.1.0+1c02256`), the Pi release in
use, the license, and links to the source and to Pi.

## Security

This interface controls an agent that can read and write files and execute commands. It is not a
read-only website. `bun run start` exposes it to any device that can reach the server, including
potentially the internet. Without `PIE_PASSWORD`, access is unauthenticated and can allow command
execution and access to local files. Use `bun run start:local` and prefer SSH forwarding for remote
access:

```sh
ssh -N -L 30141:127.0.0.1:30141 user@server
```

Do not expose it directly to the internet. Network access requires appropriate access controls and
encrypted transport. `PIE_PASSWORD` enables login but does not encrypt traffic. Back up Pi data
before deleting sessions or changing configuration.

## Desktop shell

A Tauri 2 shell starts the same server in a window instead of a browser. It does not bundle Node.js
or a webview: it needs a Node.js release (`>= 22`), the system webview, and nothing else. Build it
locally with `bun run desktop:build`.

```sh
bun run desktop:dev     # window against the development server on 127.0.0.1:30141
bun run desktop:build   # payload, release binary, and the host platform package
```

See [desktop shell](docs/desktop.md) for runtime paths, port handling, and per-platform notes.

## Documentation

- [Project direction and documentation index](docs/README.md)
- [Interface principles](docs/design.md)
- [Architecture](docs/architecture.md)
- [Desktop shell](docs/desktop.md)
- [Coding agent instructions](AGENTS.md)
- [Repository CI](../docs/ci.md)

All project documentation is maintained in English.

## Attribution and license

Based on [Pi Web](https://github.com/agegr/pi-web) by agegr, with agent capabilities provided by
[Pi](https://github.com/earendil-works/pi). Thanks to the original authors and contributors.

This independent personal version does not represent the source project. The [MIT license](LICENSE)
and original copyright notice are retained. Source-project release checks and updater commands have
been removed.
