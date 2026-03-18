Pie portable package

Personal-use build of a minimal GUI for the Pi coding agent. There is no
automated release service or self-updater.

Prerequisite: Node.js 22.14.0 or newer on PATH. Bun is needed to build, not to
run this archive. The archive is not tied to a build host: its production
dependencies carry prebuilds for macOS, Linux, and Windows on x64 and arm64.
Linux hosts need glibc, not musl. Cross-platform use is not certified: verify
this copy on the platform you ship it to. Native dependencies may require system
libraries.

From the extracted directory:
  node bin/pie.js --no-open
  node bin/pie.js --no-open --port 30141 --hostname 127.0.0.1
  node bin/pie.js --help

The application directory must be writable (Pie keeps run records there).
Keep the complete directory, including build/server, dist and node_modules. Do
not mix node_modules from another build. Build with the latest Bun release and
the latest Node.js LTS release.

For remote access, prefer SSH forwarding:
  ssh -N -L 30141:127.0.0.1:30141 user@server
Then visit http://127.0.0.1:30141 locally. Do not expose an unauthenticated
server to the public internet.

To update, stop the old process, extract a replacement archive into a new
directory, and start it there. Back up Pi configuration and sessions first;
they remain outside this package in the normal user data directory.

Git, shells, Python, npm/npx, and external MCP tools are not bundled. Features
that need them require those tools to be installed separately.

PORTABLE.json records the build platform, runtime versions, and source commit.
