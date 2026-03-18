// Development: Vite serves the interface on its own port and the built server answers the API.
// The server is rebuilt on change and restarted by `node --watch`, so the API uses the same
// compiled bundle a release ships instead of a separate TypeScript loader.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// `--lan` listens on every interface, the way `start:lan` does; the default is loopback only.
const hostname = process.argv.includes('--lan') ? '0.0.0.0' : (process.env.PIE_HOSTNAME ?? '127.0.0.1');
const viteBin = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const serverEntry = join(root, 'build', 'server', 'index.mjs');
const serverConfig = join(root, 'vite.server.config.mts');

const children = [];

function run(args, extraEnv = {}) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv }
  });
  children.push(child);
  return child;
}

function shutdown(code) {
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  process.exit(code);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => shutdown(0));
}

function buildServer({ watch }) {
  const args = [viteBin, 'build', '--config', serverConfig];
  if (watch) args.push('--watch');
  return run(args);
}

// A route file added since the last run would otherwise answer 404 until someone remembered to
// regenerate, so the registry is derived once at startup.
execFileSync(process.execPath, [join(root, 'scripts', 'generate-routes.mjs')], { stdio: 'inherit' });

// The first build has to finish before the server can start; later rebuilds are picked up by
// `node --watch`.
buildServer({ watch: false }).once('exit', (code) => {
  if (code !== 0) shutdown(code ?? 1);
  if (!existsSync(serverEntry)) shutdown(1);

  run(['--watch', serverEntry], {
    PIE_DEV: '1',
    PORT: process.env.PORT ?? '30142',
    PIE_HOSTNAME: hostname
  });
  buildServer({ watch: true });

  const viteArgs = [viteBin];
  if (hostname !== '127.0.0.1') viteArgs.push('--host', hostname);
  run(viteArgs);
});
