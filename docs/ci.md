# CI and Releases

The repository has one automated workflow, [CI build](../.github/workflows/ci.yml). It is
build-only: it compiles and packages both clients, publishes a replaced `ci-latest` release, and
does nothing else. There are no tests, typecheck, lint, or `go vet` jobs.

## Trigger

Push the `ci` branch:

```sh
git push origin HEAD:ci
```

The workflow listens only for pushes to `ci`. A new push to the same branch cancels an in-progress
run through the `ci-${{ github.ref }}` concurrency group. The default token permission is read-only;
only the release job requests `contents: write`.

## Jobs

| Job       | Runner                            | Purpose                                                                         |
| --------- | --------------------------------- | ------------------------------------------------------------------------------- |
| `web`     | `ubuntu-latest`                   | Builds the portable web archive with Bun and Node.js.                           |
| `desktop` | `windows-latest`                  | Builds the Windows x86-64 desktop installer with Bun, Node.js, Rust, and Tauri. |
| `tui`     | `ubuntu-latest`, six-entry matrix | Cross-compiles the TUI for Linux, macOS, and Windows on amd64 and arm64.        |
| `release` | `ubuntu-latest`                   | Collects every artifact, writes checksums, and replaces the release.            |

`release` needs all three build jobs. If any build fails, the existing `ci-latest` release is left
untouched.

### Web archive

The job runs from `webui/`:

1. `bun install --frozen-lockfile`
2. `bun run package:portable`

The packager copies Git-tracked files into a temporary source tree, builds the interface and server
bundle there, installs production dependencies, prunes source maps, and writes
`build/portable/pie-<version>-portable.tar.gz` plus its `.sha256`. The archive is built on Linux and
runs on Node.js 22.14 or newer on Linux, macOS, and Windows; it contains no Node.js runtime and no
compilation step.

Because the packager reads `git ls-files`, new files must be tracked before a local packaging run.
CI always checks out a commit, so its source list is complete.

### Windows desktop installer

The job runs from `webui/` on a Windows x86-64 runner:

1. Install Bun, Node.js 24, the Rust stable toolchain, and the `x86_64-pc-windows-msvc` target.
2. Restore the Cargo cache for `webui/src-tauri`.
3. `bun install --frozen-lockfile`
4. `bun run desktop:build`

The desktop build runs the same portable pipeline with `VITE_PIE_DESKTOP=1`, then builds the Tauri
shell and the NSIS installer. The payload ships inside the installer, so the installer is the whole
desktop product. The job locates the single `.exe` in `webui/src-tauri/target/release/bundle/nsis/`
and uploads it. Tauri names it from the product name and version, for example
`Pie_0.1.0_x64-setup.exe`.

The installer needs Windows x64, Node.js 22.14 or newer, and the WebView2 runtime. It is per-user
and does not bundle Node.js or a webview.

### TUI archives

The matrix builds these targets on an Ubuntu runner:

| GOOS      | GOARCH  |
| --------- | ------- |
| `linux`   | `amd64` |
| `linux`   | `arm64` |
| `darwin`  | `amd64` |
| `darwin`  | `arm64` |
| `windows` | `amd64` |
| `windows` | `arm64` |

Each entry runs from `tui/` with `CGO_ENABLED=0`, so the result is a static binary with no C
toolchain or libc dependency. The command is equivalent to:

```sh
go build -trimpath -ldflags "-s -w -X main.version=<version>" -o <output> ./cmd/pie
```

The version is the `webui/package.json` version plus `+<short-sha>`, the same identity the web build
reports. Unix binaries are packed as `pie-tui-<short-sha>-<goos>-<goarch>.tar.gz`; Windows binaries
are packed as `pie-tui-<short-sha>-<goos>-<goarch>.zip`. Each archive contains a `pie` binary
(`pie.exe` on Windows). The archives preserve the executable bit on Unix.

The TUI needs `pi` 1.5.0 or newer on `PATH` at runtime. The archive itself does not include Node.js,
Go, or a C runtime.

The macOS and Windows binaries are unsigned. macOS may require clearing the quarantine attribute
after extraction; Windows may show a SmartScreen prompt.

## Release artifacts

The release job downloads every uploaded artifact into `dist/`, writes `SHA256SUMS`, and replaces
the `ci-latest` release. The asset set is:

| Asset                                             | Source                                                        |
| ------------------------------------------------- | ------------------------------------------------------------- |
| `Pie_<version>_x64-setup.exe` (name set by Tauri) | Windows desktop installer                                     |
| `pie-<version>-portable.tar.gz`                   | Portable web archive                                          |
| `pie-<version>-portable.tar.gz.sha256`            | Packager checksum                                             |
| `pie-tui-<short-sha>-linux-amd64.tar.gz`          | TUI, Linux x86-64                                             |
| `pie-tui-<short-sha>-linux-arm64.tar.gz`          | TUI, Linux arm64                                              |
| `pie-tui-<short-sha>-darwin-amd64.tar.gz`         | TUI, macOS Intel                                              |
| `pie-tui-<short-sha>-darwin-arm64.tar.gz`         | TUI, macOS Apple silicon                                      |
| `pie-tui-<short-sha>-windows-amd64.zip`           | TUI, Windows x86-64                                           |
| `pie-tui-<short-sha>-windows-arm64.zip`           | TUI, Windows arm64                                            |
| `SHA256SUMS`                                      | Checksums for every asset above except the packager `.sha256` |

`SHA256SUMS` is generated with GNU `sha256sum` over the downloaded files. It excludes itself and the
archive's existing `.sha256` file to avoid checksums of checksums. Verify a download with:

```sh
sha256sum -c SHA256SUMS
```

or on macOS:

```sh
shasum -a 256 -c SHA256SUMS
```

### Replacement behavior

The release job deletes the previous `ci-latest` release and its tag, deletes the tag ref as a
fallback, and creates a new release from the workflow commit:

```sh
gh release delete ci-latest --yes --cleanup-tag
gh release create ci-latest dist/* --target "$GITHUB_SHA"
```

The tag is a moving build pointer, not a versioned release. The title includes the package version
and short commit. The `GITHUB_TOKEN` is the only credential; no additional secret is required.

## Local equivalents

Run these from the repository root. They reproduce the CI steps without publishing.

### Portable web archive

```sh
cd webui
bun install --frozen-lockfile
bun run package:portable
```

Output is in `webui/build/portable/`. Commit or stage new files first; the packager uses
`git ls-files`.

### Windows desktop installer

On Windows with the Tauri prerequisites, Visual Studio Build Tools, and Rust installed:

```sh
cd webui
bun install --frozen-lockfile
bun run desktop:build
```

The installer is written under `webui/src-tauri/target/release/bundle/nsis/`. On other host
platforms `bun run desktop:build` produces that platform's package instead; CI builds only the
Windows target.

### TUI binary

```sh
cd tui
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build -trimpath -ldflags "-s -w -X main.version=dev" -o /tmp/pie ./cmd/pie
```

Compiling to confirm the code is well-formed is allowed. Running the binary is manual verification
owned by the human user and is not part of CI.

## Requirements and maintenance

- Runners use the GitHub-hosted `ubuntu-latest` and `windows-latest` images.
- The web jobs use the latest Bun release and Node.js 24.
- The TUI job uses the Go version in `tui/go.mod` and caches modules through `tui/go.sum`.
- The desktop job caches Cargo under `webui/src-tauri`.
- Keep every action path relative to the repository root. Only `run` steps use
  `defaults.run.working-directory`; `upload-artifact` paths are still workspace-relative.

When adding a target or changing an artifact:

1. Update the workflow matrix or packaging step.
2. Update this document and the artifact table.
3. Update the CI paragraph in the affected project's README or docs if it changes the contract.
4. Keep the workflow build-only. Do not add test, lint, and typecheck jobs unless the owner
   explicitly asks for them.
