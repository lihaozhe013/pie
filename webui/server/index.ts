import { serve } from '@hono/node-server';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from './app';
import { registerNodeInstrumentation } from './instrumentation';

const SHUTDOWN_GRACE_MS = 4_000;

function readPort(value: string | undefined): number {
  const port = Number(value ?? 30141);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

const hostname = process.env.PIE_HOSTNAME?.trim() || '127.0.0.1';
const port = readPort(process.env.PORT);
const distDir = process.env.PIE_DIST_DIR?.trim() || join(process.cwd(), 'dist');

if (!existsSync(distDir) && !process.env.PIE_DEV) {
  console.error(`The Pie interface is not built: ${distDir} is missing.`);
  process.exit(1);
}

registerNodeInstrumentation();

const server = serve({ fetch: createApp(distDir).fetch, hostname, port }, (info) => {
  // `bin/pie.js` waits for this line before it opens the browser.
  process.stdout.write(`Ready on http://${hostname}:${info.port}\n`);
});

let closing = false;

/**
 * A graceful close waits for every connection to end. SSE streams only end when the client
 * disconnects, so `registerNodeInstrumentation` closes them first; this handler closes the
 * listener and bounds the wait anyway.
 */
function shutdown(signal: string): void {
  if (closing) return;
  closing = true;
  server.close(() => process.exit(0));
  // An unbounded wait would hang on a client that never reads: exit anyway, the way the
  // launcher's own five-second escalation would.
  const timer = setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS);
  timer.unref();
  process.on('exit', () => clearTimeout(timer));
  process.stdout.write(`[pie] ${signal} received, shutting down\n`);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
