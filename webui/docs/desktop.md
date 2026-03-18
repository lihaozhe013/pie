# Desktop Shell

A Tauri 2 window around the existing Pie server. The shell starts the same launcher the portable
archive uses, waits for it, and shows it in the system webview. There is no separate desktop
frontend and no Electron, and Node.js is not bundled.

## Scope

Keep the shell small enough to audit in one sitting:

- Find a Node.js binary and start the Pie server as a child process.
- Give the webview a stable loopback URL and shut the server down on exit.
- Package the portable payload; no second build pipeline.

The shell does not reimplement configuration, credentials, sessions, or updates. It has no
auto-updater and no release channel.

## Architecture

```text
pie-desktop (Rust, Tauri 2)
  |-- resolve Node.js                  env -> desktop.json -> PATH -> known install dirs
  |-- resolve payload                  resources/payload.tar.gz -> app data runtime dir
  |-- choose a server                  adopt a recorded server, else a free port from 30141
  |-- spawn                            node bin/pie.js --no-open -H 127.0.0.1 -p <port>
  |-- wait                             GET / until it answers, log lines kept for errors
  |-- show                             webview navigates from the splash page to the server URL
  `-- stop                             close the server, then exit
```

The payload is the portable archive except for unrelated metadata: the built interface in `dist`,
the server bundle in `build/server`, production `node_modules`, and `public`, run by the same
`bin/pie.js` launcher. Run records, `pie status`, `pie stop`, signal forwarding, and preview-secret
rotation keep working because the launcher is unchanged.

On macOS the shell replaces Tauri's default menu so its About item opens the interface's own About
dialog instead of the native panel. The rest of that menu is the default one, so editing shortcuts,
Hide, and Quit keep working; the item only evaluates an event in the page (see Security).

## Paths

| Purpose           | Location                                                                        |
| ----------------- | ------------------------------------------------------------------------------- |
| Payload source    | `PIE_DESKTOP_PAYLOAD`, `<resources>/payload.tar.gz`, `<exe dir>/payload.tar.gz` |
| Extracted payload | `<app data>/runtime/<payload version>/pie`                                      |
| Shell settings    | `<app config>/desktop.json`                                                     |
| Server log        | `<app log>/pie-desktop.log`                                                     |
| Server state      | Pi's agent directory (`~/.pi/agent/pie-run`), written by the launcher           |

`<app data>` uses the platform convention for identifier `com.github.lihaozhe013.pie`:
`~/Library/Application Support/...` on macOS, `$XDG_DATA_HOME/...` on Linux, `%APPDATA%\...` on
Windows.

The payload is extracted instead of running from the bundle because the launcher writes run records
beside it and the server keeps its Pi runtime state under the same tree. macOS App Translocation and
machine-wide Windows installs are read-only, so an in-place bundle would fail on the first write.
Extraction also keeps Windows away from deep `node_modules` paths inside the installer.

`desktop.json` is written by hand and read on every launch:

```json
{ "nodePath": "/home/me/.nvm/versions/node/v24.4.0/bin/node" }
```

`PIE_DESKTOP_NODE` overrides it. Neither file is required when Node.js is on `PATH` or in a location
the shell already probes.

## Node.js

The shell needs a Node.js binary, not Bun or a dependency installation. It accepts a version that
satisfies the server's floor (`>= 22.14.0`, for `node:sqlite` and `module.findPackageJSON`).
Resolution order:

1. `PIE_DESKTOP_NODE`
2. `nodePath` in `desktop.json`
3. Every `PATH` entry (`node`, `node.exe`)
4. Known install locations: `/opt/homebrew/bin`, `/usr/local/bin`, Homebrew, volta, fnm, nvm,
   `%ProgramFiles%\nodejs`, `%LOCALAPPDATA%\nvm`, `%APPDATA%\nvm`
5. Nothing found: the splash page names the paths it tried and the two ways to point at a binary

The first candidate whose reported version is supported wins; a binary that exists but is too old is
reported with its version instead of being ignored.

## Environment

A window opened from Finder or the Start menu inherits the desktop session's environment, not a
shell's. On macOS that `PATH` is `/usr/bin:/bin:/usr/sbin:/sbin`, with no nvm, Homebrew, or
`~/.bun/bin`. Started from a terminal, Pie would find those; started from the desktop, it would
spawn no `npx`, `bunx`, or `#!/usr/bin/env node` MCP server, and the commands the model runs through
the bash tool would lose the same tools.

The shell therefore hands the server a `PATH` of its own, in this order:

1. the directory of the Node.js binary it resolved, so `node`, `npm`, and `npx` are the installation
   that runs Pie;
2. Pi's managed bin directory (`<agent dir>/bin`, which holds its `node` shim, `rg`, and `fd`);
3. `~/.bun/bin`, `~/.cargo/bin`, `~/.volta/bin`, `~/.asdf/shims`, `~/.local/bin`, `~/Library/pnpm`,
   `%APPDATA%\npm`, `%LOCALAPPDATA%\pnpm`, and the fixed Homebrew, MacPorts, and snap prefixes,
   skipping the ones that do not exist;
4. every entry the desktop session already had, unchanged and in order, each appearing once.

Only `PATH` is rewritten. The rest of the environment (credentials included) reaches the server as
the desktop had it, and `HOME` is what the shell itself uses. `${PATH}` in an MCP entry therefore
resolves to this widened value, not to the shell's. MCP entries still run from a project folder with
only this environment plus their own `env`, as before.

Programs a shell profile adds (a `PATH` line in `~/.zshrc` that no installer wrote, say) stay
invisible to the desktop app. Install through a package manager the list above covers, or point the
shell at a Node.js binary with `nodePath` and let that install's directory lead the `PATH`.

## Ports and origin

The shell prefers port `30141` and then walks upward, ending with an OS-assigned port. A stable port
matters: the browser UI stores theme, font, language, panel, and composer preferences in
`localStorage`, which is keyed by origin. Falling back to another port silently resets those
preferences, so the fallback is logged.

Before spawning, the shell looks for a server it can reuse:

- `<agent dir>/pie-run/*.json` records name the port, URL, and version of every running Pie server.
- A record is adopted only when its URL answers and its version matches the bundled payload.

An adopted server is shown and left running when the window closes. The shell never signals a
process it did not start. A port held by anything else is skipped, not killed.

A second desktop launch does not start a second server: the single-instance plugin focuses the
existing window.

## Lifecycle

Closing the window, quitting the app, or Ctrl-C in a terminal stops a server the shell started:

- Unix: `SIGTERM` to the launcher's process group, `SIGKILL` after 8 seconds. The launcher forwards
  the signal to the server, which closes its streams and waits for extensions to shut down.
- Windows: `taskkill /PID <pid> /T /F`, matching `pie stop`.

A crash of the shell leaves the server behind; the run record is what `pie status` and `pie stop`
use to recover. An unexpected server exit leaves the last rendered page in place and adds an overlay
saying so, instead of showing an empty frame.

## Security

- The webview loads `http://127.0.0.1:<port>`. The server binds loopback only, and no password is
  configured by the shell, so it is never reachable from the network.
- No Tauri IPC. `withGlobalTauri` is off, the shell defines no commands, and there is no
  capabilities directory, so the page has nothing to call even if it tried. The only plugin is
  single-instance, which is used from Rust only. The macOS menu's About item is the one message the
  shell sends into the page: it evaluates `window.dispatchEvent(new CustomEvent('pie:show-about'))`,
  which the interface turns into its own About dialog (`lib/about-request.ts`). It carries no data
  and opens no path back into Rust; a page that has not loaded yet ignores it.
- Navigation is guarded. Loopback pages of the running server stay in the window; `/api` paths,
  external links, OAuth sign-in pages, and anything else open in the system browser and are blocked
  in the window. A small initialization script routes `window.open` and `target="_blank"` anchors
  through the same guard, so session export and provider login still reach a real browser.
- Requested permissions stay unchanged: path authorization, origin validation, and credential
  handling remain in the server (`server/middleware/security.ts`).

## Payload

`packaging/portable.mjs` builds the payload, so the desktop build is the portable build plus a
shell. The app is rebuilt with `VITE_PIE_DESKTOP=1`, which keeps the service worker from
registering. A service worker in a webview caches by origin, survives port changes, and can serve a
stale shell after an update; the desktop shell does not need offline support.

Production dependencies are pruned of source maps before the archive is written. What remains is the
built interface (`dist`, about 11 MB), the server bundle (`build/server`, about 1 MB), the launcher
in `bin`, and Pi's provider SDKs with their native helpers.

## Build

Requirements: a Rust toolchain, the Tauri prerequisites for the host platform, the latest Bun
release, the latest Node.js LTS release, and network access. Linux also needs
`libwebkit2gtk-4.1-dev`, `librsvg2-dev`, and `patchelf` to build. Windows needs the Visual Studio
Build Tools with the "Desktop development with C++" workload, which provides the MSVC linker and the
Windows SDK; rustup alone is not enough.

Tauri shells out to `cargo` itself, so the build adds `$CARGO_HOME/bin` and `~/.cargo/bin`
(`%USERPROFILE%\.cargo\bin`) to `PATH` for that child process only. A terminal opened before rustup
modified the user `PATH` therefore still builds, and no other toolchain on the machine is touched.
When neither location holds a `cargo`, the build stops before compiling and names both the rustup
and the Windows prerequisites.

```sh
bun install --frozen-lockfile
bun run desktop:dev              # shell against an already running dev server
bun run desktop:build            # payload + release binary + platform package
```

`desktop:dev` attaches to the development server at `http://127.0.0.1:30141`; it never starts a
second server in the checkout. `PIE_DESKTOP_SERVER_URL` overrides the address.

Pushing the `ci` branch runs the repository workflow in `.github/workflows/ci.yml`; it is build-only
and covers both clients. For this client, a Windows x86-64 runner builds the NSIS installer — the
payload ships inside it, so the installer is the whole desktop product — and an Ubuntu runner builds
the portable archive with `bun run package:portable`, the same pipeline the desktop payload uses.
The workflow also cross-compiles the TUI and then replaces the `ci-latest` release with every
artifact. The complete job list, artifact names, and release contract live in
[repository CI](../../docs/ci.md).

The archive is the server-side build: it runs on Node.js alone (`>= 22.14`, for `node:sqlite` and
`module.findPackageJSON`) and needs network access for the `rg` and `fd` binaries Pi downloads on
first use. It carries nothing to compile on the target machine, and its production dependency tree
ships prebuilds for every supported platform, so one Linux-built archive starts on macOS and Windows
as well. The archive name therefore carries no platform (`pie-<version>-portable.tar.gz`);
`PORTABLE.json` records the build host.

`desktop:build` runs the portable pipeline, writes `build/desktop/payload.tar.gz` plus
`payload.json` (version, size, SHA-256), builds the release binary, and packages the host platform.
`--payload <archive>` reuses an existing archive and `--skip-payload` reuses `build/desktop`.

On Windows the payload step is what makes a build slow: both staging installs materialize tens of
thousands of files, and creating or reading them costs more there than the reflink on macOS or the
hardlink on Linux. Bun's default hardlink backend is still the fastest option, because a copied tree
is scanned again when the archive reads it and ends up slower overall. The effective fix is
excluding the Bun cache, the repository, and `%TEMP%` from real-time antivirus scanning, not
changing the installer backend. Use `--skip-payload` (or `--payload`) when only the shell changed.
The Rust binary is built in the checkout's `src-tauri/target`; only the payload is built in a
temporary directory.

| Platform | Output                                                               | Notes                                                                                             |
| -------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| macOS    | `.app` and `.dmg` in `src-tauri/target/release/bundle/`              | Ad-hoc signed, not notarized; minimum macOS 13                                                    |
| Windows  | NSIS installer in `src-tauri/target/release/bundle/nsis/`            | Per-user install; WebView2 bootstrapper downloads the runtime when missing                        |
| Linux    | `build/desktop/pie-desktop-<version>-linux-<arch>/` with a `.tar.gz` | No deb, rpm, or AppImage: the webview is a declared dependency, and an archive cannot declare one |

The Linux archive contains the binary, `payload.tar.gz`, `payload.json`, `README.txt`, and the
license. It requires `webkit2gtk-4.1` 2.44 or newer, GTK 3, and Node.js; a distribution older than
that opens a blank window, so the README states the floor.

Nothing bundles a webview, a Node.js runtime, or external agent tools. Git, shells, Python, and MCP
programs invoked by the agent remain the user's responsibility.

## Limitations

- Provider notifications: WebKitGTK has no window notification API and WKWebView does not run
  service workers, so extension attention notifications fall back to nothing there. The UI already
  degrades silently.
- Inline audio and video need GStreamer plugins on Linux.
- Linux WebKitGTK older than 2.44 lacks CSS the interface relies on.
- Unsigned macOS and Windows builds produce Gatekeeper and SmartScreen warnings; the build is for
  people who can clear them.

## Verification

Verification is manual; the project keeps no tests.

- From Finder or the Start menu (not a terminal), `ps eww -p <server pid>` shows the widened `PATH`,
  and both an `npx`-based MCP entry's Test button and `bun --version` in the bash tool work.
- On each platform: start, send a message, drag an attachment, sign in to a provider (system browser
  round-trip), view full history (system browser), close the window, then confirm `pie status` is
  empty.
