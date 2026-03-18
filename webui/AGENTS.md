# Pie — Agent Instructions

Pie is a personal, local GUI for Pi. Keep changes focused on making conversations and agent activity
clear and convenient. Pi owns agent capabilities; use the installed SDK rather than creating a
parallel protocol.

## Changes

- Read [project direction](docs/README.md) and [interface principles](docs/design.md) for product or
  UI work. Read [architecture](docs/architecture.md) and [runtime](docs/runtime.md) for runtime and
  API changes.
- Prefer simple solutions. Check consumers before removing shared behavior.
- Preserve user data, session history, conversation inputs, and security checks. Keep path and
  origin validation, credential isolation, and session shutdown intact.
- For UI changes, support keyboard use, visible focus, narrow screens, and reduced motion; use
  semantic theme variables.
- Write project documentation in English and update relevant docs with code changes.

## Development

- Bun manages dependencies and scripts; Node.js runs the app. Keep explicit `node` invocations.
- Install with `bun install --frozen-lockfile`. Use `bun run dev`, `bun run typecheck`, and
  `bun run lint` as relevant.
- **Never run tests, and never add test files, test scripts, fixtures, or test frameworks.** This
  project has none by design: the owner verifies every change manually. Do not run `node --test`,
  do not add a `test` script, and do not create `*.test.*` files. Report what you changed and what
  the owner should check by hand.
- Reuse a healthy development server. Do not start a second server in the same checkout or run a
  production build in an active development checkout; portable builds run in isolation. The desktop
  shell follows the same rule: `bun run desktop:dev` attaches to the running development server, and
  `bun run desktop:build` builds the payload in a temporary directory while writing the Rust binary
  to `src-tauri/target`. Read [desktop shell](docs/desktop.md) before changing
  `src-tauri/` or `packaging/desktop.mjs`; the shell has no Tauri IPC and must keep its navigation
  guard, payload extraction, and server shutdown intact.
- Report what you changed and the manual checks the owner should perform.

## Commits

- Use Conventional Commits: `<type>[optional scope]: <description>` (for example, `feat: add X` or
  `fix(api): handle Y`).
