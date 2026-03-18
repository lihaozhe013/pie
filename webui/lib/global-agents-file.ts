import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { writePrivateFileAtomicSync } from './atomic-file';
import { readRegularFileText } from './regular-file';

/** The global context file is user instructions, not a data store. */
export const GLOBAL_AGENTS_MAX_BYTES = 1024 * 1024;

/** Pi loads this file from the agent directory for every project. */
export function getGlobalAgentsPath(agentDir = getAgentDir()): string {
  return join(agentDir, 'AGENTS.md');
}

export function readGlobalAgents(agentDir = getAgentDir()): {
  path: string;
  content: string;
  exists: boolean;
} {
  const path = getGlobalAgentsPath(agentDir);
  const content = readRegularFileText(path, GLOBAL_AGENTS_MAX_BYTES);
  return { path, content: content ?? '', exists: content !== undefined };
}

/** Create or replace the global AGENTS.md, creating the agent directory if needed. */
export function writeGlobalAgents(content: string, agentDir = getAgentDir()): string {
  const path = getGlobalAgentsPath(agentDir);
  mkdirSync(agentDir, { recursive: true });
  writePrivateFileAtomicSync(path, content);
  return path;
}
