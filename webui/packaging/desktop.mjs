// Desktop shell packaging: the portable payload plus a Tauri 2 window.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildPortableArchive } from './portable.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktopDir = join(root, 'build', 'desktop');
const tauriDir = join(root, 'src-tauri');
const cliBuildConfig = join(tauriDir, 'tauri.build.conf.json');

/** The desktop payload is the portable payload, rebuilt without the service worker. */
export const DESKTOP_BUILD_ENV = { VITE_PIE_DESKTOP: '1' };

export function payloadKey(version, sha256) {
  if (!/^[\w.+-]+$/.test(version)) throw new Error('Invalid payload version');
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('Invalid payload checksum');
  return `${version}-${sha256.slice(0, 12)}`;
}

export function linuxDesktopName(version, arch = process.arch) {
  if (!/^[\w.+-]+$/.test(version)) throw new Error('Invalid payload version');
  if (!['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported Linux architecture: ${arch}`);
  return `pie-desktop-${version}-linux-${arch}`;
}

export function payloadManifest({ name, version, sha256, bytes, commit }) {
  return { name, version, sha256, bytes, commit, key: payloadKey(version, sha256) };
}

const linuxReadme = `Pie desktop shell

A window around the local Pie server. The server runs as a child process and
stops when the window closes. Node.js and the webview are not bundled.

Requirements
  Node.js 22.5.0 or newer on PATH, or a path in the desktop config file
  WebKitGTK 4.1 (webkit2gtk-4.1) 2.44 or newer, and GTK 3
  A graphical session (X11 or Wayland)

Run
  ./pie-desktop

First launch unpacks payload.tar.gz into the app data directory and starts the
server on 127.0.0.1:30141. Later launches reuse the unpacked payload. The data
directory keeps local interface preferences, which are tied to the server port.

If Node.js is not found, the window names the locations that were already
searched. Point the shell at a binary in the desktop config file:

  # Linux and macOS
  <config dir>/desktop.json      ~/.config/com.github.lihaozhe013.pie/desktop.json
  # Windows
  %APPDATA%\\com.github.lihaozhe013.pie\\desktop.json

  { "nodePath": "/home/me/.nvm/versions/node/v24.4.0/bin/node" }

PIE_DESKTOP_NODE overrides that file for a single launch.

Keep payload.tar.gz beside the binary; the shell reads it from there. To update,
replace the whole directory. Sessions, credentials, and Pi configuration live
outside this package in the usual Pi agent directory.

Do not run this package as root, and do not expose the server to the network:
the shell binds loopback only.
`;

function run(command, args, { cwd = root, env = process.env } = {}) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})`);
  return result;
}

/**
 * Directories a Rust installation puts `cargo` in. rustup does not always add the
 * directory to PATH (common on Windows), and Tauri shells out to `cargo` itself,
 * so the build passes an environment that can find it.
 */
export function rustBinDirs(env = process.env) {
  const home = env.USERPROFILE || env.HOME;
  const dirs = [];
  if (env.CARGO_HOME) dirs.push(join(env.CARGO_HOME, 'bin'));
  if (home) dirs.push(join(home, '.cargo', 'bin'));
  return [...new Set(dirs)];
}

/** The environment variable that holds PATH; Windows sets it as `Path`. */
function pathKey(env) {
  return Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
}

/**
 * Return `env` with a usable `cargo` on PATH. Child processes only: the caller's
 * PATH and any other toolchain on the machine stay untouched.
 */
export function withRustToolchain(
  env = process.env,
  { platform = process.platform, exists = existsSync } = {}
) {
  const key = pathKey(env);
  const separator = platform === 'win32' ? ';' : delimiter;
  const executable = platform === 'win32' ? 'cargo.exe' : 'cargo';
  const entries = (env[key] ?? '').split(separator).filter(Boolean);
  if (entries.some((dir) => exists(join(dir, executable)))) return env;

  const found = rustBinDirs(env).find((dir) => exists(join(dir, executable)));
  if (!found) {
    const where = platform === 'win32' ? '%USERPROFILE%\\.cargo\\bin' : '~/.cargo/bin';
    const tools =
      platform === 'win32'
        ? ' Windows builds also need the Visual Studio Build Tools with the "Desktop development ' +
          'with C++" workload.'
        : '';
    throw new Error(
      `Rust toolchain not found: install it from https://rustup.rs and reopen the terminal, ` +
        `or add ${where} to PATH.${tools}`
    );
  }
  return { ...env, [key]: [found, ...entries].join(separator) };
}

function resolveTauriCli() {
  const require = createRequire(import.meta.url);
  for (const candidate of ['@tauri-apps/cli/package.json', '@tauri-apps/cli']) {
    try {
      const pkgPath = require.resolve(candidate);
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const relative = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.tauri;
      if (relative) return resolve(dirname(pkgPath), relative);
    } catch {
      /* Try the next resolution strategy. */
    }
  }
  return null;
}

async function sha256File(file) {
  const hash = createHash('sha256');
  hash.update(await readFile(file));
  return hash.digest('hex');
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** Build or reuse the payload archive and write the manifest the shell verifies. */
export async function preparePayload({ payload, skipPayload = false, commit } = {}) {
  await mkdir(desktopDir, { recursive: true });
  const archive = join(desktopDir, 'payload.tar.gz');
  const manifestPath = join(desktopDir, 'payload.json');

  if (payload) {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const sha256 = await sha256File(payload);
    await cp(payload, archive);
    const manifest = payloadManifest({
      name: 'payload.tar.gz',
      version: pkg.version,
      sha256,
      bytes: (await stat(archive)).size,
      commit: commit ?? 'unknown'
    });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  }

  if (skipPayload) {
    if (!(await exists(archive)) || !(await exists(manifestPath))) {
      throw new Error('--skip-payload needs an existing build/desktop payload');
    }
    return JSON.parse(await readFile(manifestPath, 'utf8'));
  }

  // The desktop payload is the portable archive, so one pipeline produces both and the archive
  // that ships is the one the portable build wrote.
  const built = await buildPortableArchive({
    output: join(desktopDir, 'portable'),
    env: DESKTOP_BUILD_ENV
  });
  await cp(built.archive, archive);
  const sha256 = await sha256File(archive);
  const manifest = payloadManifest({
    name: built.name,
    version: built.version,
    sha256,
    bytes: (await stat(archive)).size,
    commit: built.commit
  });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function releaseBinary(candidates) {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Tauri did not produce a release binary (looked for ${candidates.join(', ')})`);
}

async function packageLinux(manifest) {
  const release = join(tauriDir, 'target', 'release');
  const binary = releaseBinary([join(release, 'pie-desktop'), join(release, 'Pie')]);
  // Keep the unpacked release tree runnable in place as well.
  await cp(join(desktopDir, 'payload.tar.gz'), join(release, 'payload.tar.gz'));
  await cp(join(desktopDir, 'payload.json'), join(release, 'payload.json'));

  const name = linuxDesktopName(manifest.version);
  const stage = join(desktopDir, name);
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  await cp(binary, join(stage, 'pie-desktop'));
  await cp(join(desktopDir, 'payload.tar.gz'), join(stage, 'payload.tar.gz'));
  await cp(join(desktopDir, 'payload.json'), join(stage, 'payload.json'));
  await cp(join(root, 'LICENSE'), join(stage, 'LICENSE'));
  await writeFile(join(stage, 'README.txt'), linuxReadme);

  const archive = join(desktopDir, `${name}.tar.gz`);
  await rm(archive, { force: true });
  run('tar', ['-czf', archive, '-C', desktopDir, name]);
  const sha256 = await sha256File(archive);
  await writeFile(`${archive}.sha256`, `${sha256}  ${name}.tar.gz\n`);
  return archive;
}

export async function buildDesktop({ payload, skipPayload = false } = {}) {
  if (!(await exists(join(tauriDir, 'Cargo.toml')))) {
    throw new Error('src-tauri is missing; the desktop shell is not checked out');
  }
  const cli = resolveTauriCli();
  if (!cli) throw new Error('Missing @tauri-apps/cli. Run: bun install --frozen-lockfile');

  const manifest = await preparePayload({ payload, skipPayload });
  console.log(`Desktop payload: ${manifest.name} ${manifest.version} (${manifest.bytes} bytes)`);

  const args = ['build', '--config', cliBuildConfig];
  // Linux ships a hand-made archive: no deb, rpm, or AppImage can declare the
  // webview dependency the shell needs.
  if (process.platform === 'linux') args.push('--no-bundle');
  run(process.execPath, [cli, ...args], { env: withRustToolchain() });

  const archive = process.platform === 'linux' ? await packageLinux(manifest) : null;
  return { manifest, archive };
}

export function devDesktop({ env = process.env } = {}) {
  const cli = resolveTauriCli();
  if (!cli) throw new Error('Missing @tauri-apps/cli. Run: bun install --frozen-lockfile');
  run(process.execPath, [cli, 'dev'], {
    env: {
      ...withRustToolchain(env),
      PIE_DESKTOP_SERVER_URL: env.PIE_DESKTOP_SERVER_URL ?? 'http://127.0.0.1:30141'
    }
  });
}

export function parseArguments(argv) {
  const options = { dev: false, payload: undefined, skipPayload: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dev') options.dev = true;
    else if (argument === '--skip-payload') options.skipPayload = true;
    else if (argument === '--payload') {
      const value = argv[index + 1];
      if (!value) throw new Error('--payload needs an archive path');
      options.payload = resolve(value);
      index += 1;
    } else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log(`Usage: node packaging/desktop.mjs [--dev] [--payload <archive>] [--skip-payload]

  --dev            Run the shell against the development server on 127.0.0.1:30141
  --payload <file> Package an existing portable archive instead of building one
  --skip-payload   Reuse build/desktop/payload.tar.gz from an earlier build`);
    } else if (options.dev) {
      devDesktop();
    } else {
      const result = await buildDesktop(options);
      if (result.archive) console.log(`Linux archive: ${result.archive}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
