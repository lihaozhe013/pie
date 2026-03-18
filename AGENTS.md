# Pie Repository Instructions

## Layout

- [`webui/`](webui/) is the browser client, server, and Tauri desktop shell. Read
  [`webui/AGENTS.md`](webui/AGENTS.md) before changing it.
- [`tui/`](tui/) is the Go terminal client. Read [`tui/AGENTS.md`](tui/AGENTS.md) before changing
  it.
- The root `README.md`, `docs/`, and `.github/` own repository-level concerns: layout, shared
  runtime context, and CI.

Each project owns its source, documentation, agent instructions, build, and dependencies. Do not
merge the two source trees or move project-specific files to the root without a clear repository
reason.

## Working rules

- Run project commands from the project directory. There is no root package manager workspace and no
  root Go module.
- Follow the selected project's `AGENTS.md`; it takes precedence for work inside that project.
- The two clients currently share one Pi configuration surface, including the agent-directory files,
  project `.pi` files, and shared session entries such as `pie:*` and goal state. Keep that surface
  shared, and align any change across `webui/` and `tui/`. See `tui/docs/settings.md` and
  `tui/docs/architecture.md` for the contract. They share no source code, and client-only
  preferences (such as the TUI's `pie-settings.json`) stay separate.
- Update root documentation and [CI documentation](docs/ci.md) when the layout, workflow, or release
  artifacts change.

## Verification

- Never run tests or manual checks in either client. The owner verifies every change manually.
- Do not add test files, test scripts, fixtures, or test frameworks. The web UI has no test runner
  by design; the TUI's Go tests belong to the owner.
- Compiling to confirm the code is well-formed is allowed (`go build ./...` in `tui/`, or a normal
  web build). That is not a license to exercise the running product.

## CI

- The workflow in `.github/workflows/ci.yml` is build-only. Keep it free of test, lint, and
  typecheck jobs unless the owner explicitly asks otherwise.
- It builds both clients from a push to the `ci` branch and replaces the `ci-latest` release.
  Preserve the single-release replacement behavior and update `docs/ci.md` with any artifact or job
  changes.

## Style

- Write code comments, documentation, and commit messages in English.
- Use Conventional Commits. Scope by area when useful: `feat(webui): ...`, `fix(tui): ...`,
  `docs(ci): ...`.
- Do not use emojis in logs or UI text.
