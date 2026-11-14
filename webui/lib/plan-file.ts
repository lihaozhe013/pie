import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  statSync
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { SessionManager } from '@earendil-works/pi-coding-agent';
import { writePrivateFileAtomicSync } from './atomic-file';
import type { SessionEntry } from './types';

export const PLAN_ENTRY_TYPE = 'pie:plan';
export const PLAN_TOOL_NAME = 'update_plan';
export const PLAN_DIRECTORY = 'pie-plans';
export const PLAN_MAX_BYTES = 256 * 1024;
export const PLAN_FACTS_MAX_BYTES = 64 * 1024;
export const PLAN_VIEW_MAX_BYTES = 1024 * 1024;
export const PLAN_CONTEXT_MAX_CHARS = 12_000;
export const PLAN_OUTLINE_MAX_CHARS = 4_000;

export const PLAN_STATUSES = ['draft', 'ready', 'in-progress', 'done'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export interface PlanEntryData {
  version: 1;
  path: string;
  updatedAt?: string;
  bytes?: number;
}

export interface PlanFacts {
  path: string;
  exists: boolean;
  title: string;
  status: PlanStatus | 'unknown';
  updatedAt?: string;
  bytes?: number;
  revision?: string;
}

export interface PlanSnapshot extends PlanFacts {
  exists: true;
  content: string;
  outline: string;
  truncated: boolean;
}

export interface EnsurePlanFileOptions {
  agentDir: string;
  sessionId: string;
  entries: readonly SessionEntry[];
  appendEntry: (data: PlanEntryData) => void;
}

export const PLAN_TEMPLATE = `# Plan

Status: draft

## Goal

## Constraints

## Steps

- [ ]

## Files

## Verification

## Risks and open questions
`;

export function isPlanStatus(value: unknown): value is PlanStatus {
  return typeof value === 'string' && (PLAN_STATUSES as readonly string[]).includes(value);
}

export function planDirectory(agentDir: string): string {
  return join(resolve(agentDir), PLAN_DIRECTORY);
}

export function planFilePath(agentDir: string, sessionId: string): string {
  return join(planDirectory(agentDir), safeSessionStem(sessionId) + '.md');
}

function safeSessionStem(sessionId: string): string {
  const text = String(sessionId || '').trim();
  if (/^[A-Za-z0-9_-]{1,128}$/.test(text)) return text;
  return createHash('sha256').update(text || 'session').digest('hex');
}

export function readPlanEntry(entries: readonly SessionEntry[]): PlanEntryData | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== 'custom' || entry.customType !== PLAN_ENTRY_TYPE) continue;
    if (typeof entry.data !== 'object' || entry.data === null || Array.isArray(entry.data)) {
      continue;
    }
    const data = entry.data as {
      version?: unknown;
      path?: unknown;
      updatedAt?: unknown;
      bytes?: unknown;
    };
    if (data.version !== 1 || typeof data.path !== 'string' || data.path === '') continue;
    return {
      version: 1,
      path: data.path,
      ...(typeof data.updatedAt === 'string' ? { updatedAt: data.updatedAt } : {}),
      ...(typeof data.bytes === 'number' ? { bytes: data.bytes } : {})
    };
  }
  return undefined;
}

export function planPathForSession(
  agentDir: string,
  sessionId: string,
  entries: readonly SessionEntry[]
): string {
  const entry = readPlanEntry(entries);
  if (entry && isPlanPathAllowed(agentDir, entry.path)) return entry.path;
  return planFilePath(agentDir, sessionId);
}

function resolvedForContainment(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    try {
      return join(realpathSync(dirname(path)), basename(path));
    } catch {
      return resolve(path);
    }
  }
}

/** A plan path is readable only below <agentDir>/pie-plans. */
export function isPlanPathAllowed(agentDir: string, path: string): boolean {
  try {
    const dir = resolvedForContainment(planDirectory(agentDir));
    const target = resolvedForContainment(path);
    const rel = relative(dir, target);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  } catch {
    return false;
  }
}

function ensurePlansDirectory(agentDir: string): string {
  const dir = planDirectory(agentDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('pie-plans must be a real directory');
  }
  return dir;
}

function readTextCapped(path: string, maxBytes: number) {
  const fd = openSync(path, 'r');
  try {
    const stat = statSync(path);
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.allocUnsafe(length);
    const read = readSync(fd, buffer, 0, length, 0);
    return {
      content: buffer.subarray(0, read).toString('utf8'),
      truncated: stat.size > read,
      bytes: stat.size,
      updatedAt: stat.mtime.toISOString()
    };
  } finally {
    closeSync(fd);
  }
}

function derivePlanStatus(lines: readonly string[]): PlanStatus {
  let unchecked = 0;
  let checked = 0;
  for (const line of lines) {
    if (/^\s*[-*]\s*\[\s\]\s*/.test(line)) unchecked += 1;
    else if (/^\s*[-*]\s*\[[xX]\]\s*/.test(line)) checked += 1;
  }
  if (checked === 0) return 'draft';
  if (unchecked === 0) return 'done';
  return 'in-progress';
}

function buildPlanOutline(lines: readonly string[]): string {
  const picked: string[] = [];
  let used = 0;
  let clipped = false;
  for (const line of lines) {
    const trimmed = line.trimEnd();
    const heading = /^#{1,3}\s+/.test(trimmed);
    const openStep = /^\s*[-*]\s*\[\s\]\s*/.test(trimmed);
    if (!heading && !openStep) continue;
    const next = heading ? trimmed : trimmed.trim();
    if (used + next.length + 1 > PLAN_OUTLINE_MAX_CHARS) {
      clipped = true;
      break;
    }
    picked.push(next);
    used += next.length + 1;
  }
  if (clipped) picked.push('… (outline truncated; read the plan file for the rest)');
  return picked.join('\n');
}

export function parsePlanContent(content: string) {
  const lines = content.split(/\r?\n/);
  let title = 'Plan';
  let status: PlanStatus | undefined;
  for (const line of lines) {
    const heading = line.match(/^#\s+(.+?)\s*$/);
    if (heading && title === 'Plan') title = heading[1].trim().slice(0, 200);
    const match = line.match(/^status:\s*(draft|ready|in-progress|done)\b/i);
    if (match) status = match[1].toLowerCase() as PlanStatus;
  }
  if (!status) status = derivePlanStatus(lines);
  return { title, status, outline: buildPlanOutline(lines) };
}

export function readPlanSnapshot(
  agentDir: string,
  path: string,
  maxBytes: number = PLAN_MAX_BYTES
): PlanSnapshot {
  if (!isPlanPathAllowed(agentDir, path)) throw new Error('plan path is outside pie-plans');
  if (lstatSync(path).isSymbolicLink()) throw new Error('plan file must not be a symbolic link');
  const read = readTextCapped(path, maxBytes);
  const parsed = parsePlanContent(read.content);
  return {
    path,
    exists: true,
    ...parsed,
    content: read.content,
    truncated: read.truncated,
    bytes: read.bytes,
    updatedAt: read.updatedAt,
    revision: read.truncated
      ? undefined
      : createHash('sha256').update(read.content).digest('hex')
  };
}

export function readPlanForSession(
  agentDir: string,
  sessionId: string,
  entries: readonly SessionEntry[],
  maxBytes: number = PLAN_MAX_BYTES
): PlanSnapshot | undefined {
  const path = planPathForSession(agentDir, sessionId, entries);
  if (!existsSync(path)) return undefined;
  try {
    return readPlanSnapshot(agentDir, path, maxBytes);
  } catch {
    return undefined;
  }
}

export function planFacts(snapshot: PlanSnapshot): PlanFacts {
  return {
    path: snapshot.path,
    exists: true,
    title: snapshot.title,
    status: snapshot.status,
    updatedAt: snapshot.updatedAt,
    bytes: snapshot.bytes,
    revision: snapshot.revision
  };
}

export function planEntryData(snapshot: PlanSnapshot): PlanEntryData {
  return {
    version: 1,
    path: snapshot.path,
    updatedAt: snapshot.updatedAt,
    bytes: snapshot.bytes
  };
}

export function ensurePlanFile(options: EnsurePlanFileOptions): PlanSnapshot {
  const expected = planFilePath(options.agentDir, options.sessionId);
  const entry = readPlanEntry(options.entries);
  let path =
    entry && isPlanPathAllowed(options.agentDir, entry.path) ? entry.path : expected;
  let changed = false;
  if (path !== expected) {
    if (existsSync(path) && !existsSync(expected)) {
      ensurePlansDirectory(options.agentDir);
      copyFileSync(path, expected);
      chmodSync(expected, 0o600);
      changed = true;
    }
    path = expected;
  }
  const existed = existsSync(path);
  if (!existed) {
    ensurePlansDirectory(options.agentDir);
    writePrivateFileAtomicSync(path, PLAN_TEMPLATE);
    changed = true;
  }
  const snapshot = readPlanSnapshot(options.agentDir, path);
  if (changed || !entry || entry.path !== path) {
    options.appendEntry(planEntryData(snapshot));
  }
  return snapshot;
}

/** Persist an entry from a server-owned session manager. */
export function appendPlanEntry(
  sessionManager: SessionManager,
  snapshot: PlanSnapshot
): void {
  sessionManager.appendCustomEntry(PLAN_ENTRY_TYPE, planEntryData(snapshot));
}

export function writePlanFile(
  agentDir: string,
  sessionId: string,
  content: string,
  baseRevision?: string
): PlanSnapshot {
  if (!content.trim()) throw new Error('update_plan needs non-empty content');
  if (Buffer.byteLength(content, 'utf8') > PLAN_MAX_BYTES) {
    throw new Error(`update_plan content exceeds ${PLAN_MAX_BYTES} bytes`);
  }
  const path = planFilePath(agentDir, sessionId);
  const existing = existsSync(path) ? readPlanSnapshot(agentDir, path) : undefined;
  if (baseRevision) {
    if (!existing || existing.revision !== baseRevision) {
      throw new Error(
        'The plan file changed on disk. Read it again and retry with the current revision.'
      );
    }
  }
  ensurePlansDirectory(agentDir);
  writePrivateFileAtomicSync(path, content);
  return readPlanSnapshot(agentDir, path);
}

export function renderPlanSection(snapshot: PlanSnapshot): string {
  return [
    `Path: ${snapshot.path}`,
    `Title: ${snapshot.title}`,
    `Status: ${snapshot.status}`,
    `Revision: ${snapshot.revision ? snapshot.revision.slice(0, 12) : 'unavailable for an oversized plan'}`,
    'The plan file is authoritative and survives context compaction.'
  ].join('\n');
}

export function renderPlanContext(snapshot: PlanSnapshot, compacted: boolean): string {
  const lines = [
    '[pie-plan-context, not a user request]',
    `Authoritative plan file: ${snapshot.path}`,
    `Title: ${snapshot.title}`,
    `Status: ${snapshot.status}`,
    `Revision: ${snapshot.revision ? snapshot.revision.slice(0, 12) : 'unavailable'}`,
    'The plan file is outside the conversation and survives context compaction.'
  ];
  if (compacted) {
    lines.push(
      'The conversation was compacted. Do not rely on the summary for plan details; the plan file below is authoritative.'
    );
  }
  if (!snapshot.truncated && snapshot.content.length <= PLAN_CONTEXT_MAX_CHARS) {
    lines.push('', snapshot.content);
  } else {
    const details = snapshot.outline.trim()
      ? snapshot.outline
      : snapshot.content.slice(0, PLAN_CONTEXT_MAX_CHARS);
    lines.push('', 'Plan outline (read the full file before acting):', details);
  }
  return lines.join('\n');
}
