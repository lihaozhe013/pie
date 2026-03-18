#!/usr/bin/env node
'use strict';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require('child_process');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('path');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getHelpText, parseCommandLine } = require('./pie-options');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { wireChildProcessLifecycle } = require('./process-lifecycle');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { openInBrowser } = require('./browser-opener');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createRunRecordTracker, getOpenUrl, getRunDir } = require('./run-records');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getPackageVersion, runCommand } = require('./pie-commands');

let launchOptions;
try {
  launchOptions = parseCommandLine();
} catch (error) {
  fs.writeSync(process.stderr.fd, `${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

if (launchOptions.help) {
  fs.writeSync(process.stdout.fd, getHelpText());
  process.exit(0);
}

if (launchOptions.command === 'start') {
  startServer(launchOptions);
} else {
  runCommand(launchOptions).then(exitWhenIdle, (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    exitWhenIdle(1);
  });
}

// Leave once the event loop drains instead of calling process.exit() right
// after a fetch(): on Windows, Node.js 23 up to 24.19 / 26.6 can then abort
// with a libuv assertion (UV_HANDLE_CLOSING, win/async.c) while background
// work from the fetch is still winding down (#1174, nodejs/node#56645). The
// unref'd timer only fires if something still holds the loop open.
function exitWhenIdle(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 2_000).unref();
}

function startServer({ port, hostname, openBrowser }) {
  const pkgDir = path.join(__dirname, '..');
  const serverEntry = path.join(pkgDir, 'build', 'server', 'index.mjs');

  const loopbackHostnames = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
  const passwordEnabled = Boolean(process.env.PIE_PASSWORD);

  if (!fs.existsSync(serverEntry)) {
    console.error('Build artifacts not found. Please report this issue.');
    process.exit(1);
  }

  if (!loopbackHostnames.has(hostname)) {
    if (passwordEnabled) {
      console.warn(
        `Warning: pie is listening on ${hostname} with password authentication over HTTP. Use HTTPS or a trusted VPN to protect the password in transit.`
      );
    } else {
      console.warn(
        `Warning: pie is listening on ${hostname} without authentication. Only use this on a trusted network.`
      );
    }
  }

  // Run the built server entry with node directly — avoids .bin symlink issues and
  // path-with-spaces problems on Windows when shell: true is used. The port and host
  // travel as environment variables so the server needs no argument parsing.
  const child = spawn(process.execPath, [serverEntry], {
    cwd: pkgDir,
    stdio: ['inherit', 'pipe', 'inherit'],
    env: { ...process.env, PIE_HOSTNAME: hostname, PORT: String(port) }
  });
  wireChildProcessLifecycle(child);

  // Port 0 lets the OS pick a port we never learn, so such a server gets no record.
  const runRecord = createRunRecordTracker({
    dir: getRunDir,
    record: {
      pid: process.pid,
      serverPid: child.pid,
      port: Number(port),
      hostname,
      url: getOpenUrl(hostname, port),
      version: getPackageVersion(pkgDir),
      startedAt: new Date().toISOString()
    }
  });

  let serverReady = false;
  const url = `http://${hostname}:${port}`;

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    if (!serverReady && text.includes('Ready')) {
      serverReady = true;
      if (port !== '0') runRecord.markReady();
      if (openBrowser) openInBrowser(url);
    }
  });
}
