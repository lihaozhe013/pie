/**
 * The verification gate: the person's own commands, run after the agent exits.
 *
 * The command list is configuration, not user input, so this is not a validation
 * boundary. An empty list means "no gate": a clean exit is enough and the board
 * says so instead of implying verification happened.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { platform as processPlatform } from 'node:process';

export const GATE_OUTPUT_LIMIT = 8_000;

export interface GateResult {
  ok: boolean;
  /** Exit code of the failing command, or null when it timed out or never ran. */
  exitCode: number | null;
  /** Tail of the combined output. */
  output: string;
  failedCommand: string | null;
  timedOut: boolean;
}

export interface GateOptions {
  cwd: string;
  /** `null` runs the command without a timeout. */
  timeoutMs: number | null;
  platform?: NodeJS.Platform;
  spawnFn?: typeof spawn;
  env?: NodeJS.ProcessEnv;
}

interface CommandOutcome {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

function clip(text: string, limit = GATE_OUTPUT_LIMIT): string {
  return text.length <= limit ? text : `…${text.slice(text.length - limit)}`;
}

/**
 * The shell verification commands run in. Named here so the run prompt can tell
 * the agent the truth: on Windows it is cmd.exe even when the session's own bash
 * tool uses Git Bash.
 */
export function verificationShellName(platform: NodeJS.Platform = processPlatform): string {
  return platform === 'win32' ? 'cmd.exe' : '/bin/sh';
}

function shellInvocation(
  command: string,
  platform: NodeJS.Platform
): { file: string; args: string[]; windowsVerbatimArguments: boolean } {
  if (platform === 'win32') {
    // cmd.exe strips the first and last quote of `/s /c`, so the command needs
    // one pair around it and verbatim arguments: without both, every quoted
    // argument in a verification command (`node -e "..."`) loses its quotes.
    return {
      file: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${command}"`],
      windowsVerbatimArguments: true
    };
  }
  return { file: '/bin/sh', args: ['-c', command], windowsVerbatimArguments: false };
}

function killTree(child: ChildProcess, platform: NodeJS.Platform, spawnFn: typeof spawn): void {
  if (!child.pid) return;
  if (platform === 'win32') {
    try {
      spawnFn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      });
      return;
    } catch {
      // Fall through to a direct kill.
    }
  } else {
    try {
      // The command runs detached, so its pid is its process-group id.
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // Fall through to a direct kill.
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // Already gone.
  }
}

function runCommand(command: string, options: GateOptions): Promise<CommandOutcome> {
  const platform = options.platform ?? processPlatform;
  const spawnFn = options.spawnFn ?? spawn;
  const { file, args, windowsVerbatimArguments } = shellInvocation(command, platform);
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    let settled = false;
    const child = spawnFn(file, args, {
      cwd: options.cwd,
      windowsVerbatimArguments,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: platform !== 'win32',
      windowsHide: true
    });
    const collect = (chunk: string) => {
      output = clip(output + chunk);
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ exitCode, timedOut, output });
    };
    const timer =
      options.timeoutMs === null
        ? null
        : setTimeout(
            () => {
              timedOut = true;
              killTree(child, platform, spawnFn);
              // A killed tree may still take a moment to close; do not wait forever.
              setTimeout(() => finish(null), 2_000).unref?.();
            },
            Math.max(options.timeoutMs, 0)
          );
    timer?.unref?.();
    child.on('error', (error) => {
      collect(`${error.message}\n`);
      finish(null);
    });
    child.on('close', (code) => finish(code ?? null));
  });
}

/** Run every command in order. The first failure settles the gate. */
export async function runVerificationGate(
  commands: string[],
  options: GateOptions
): Promise<GateResult> {
  for (const command of commands) {
    const outcome = await runCommand(command, options);
    if (outcome.timedOut || outcome.exitCode !== 0) {
      return {
        ok: false,
        exitCode: outcome.exitCode,
        output: outcome.output,
        failedCommand: command,
        timedOut: outcome.timedOut
      };
    }
  }
  return { ok: true, exitCode: 0, output: '', failedCommand: null, timedOut: false };
}
