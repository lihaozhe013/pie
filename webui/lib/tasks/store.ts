/**
 * SQLite storage for the serial task queue.
 *
 * This is the only module in `lib/tasks` that contains SQL. The queue
 * controller composes these methods; every state guard that must survive a race
 * is inside a statement here, so a stale caller cannot win a claim it lost.
 *
 * The database lives at `<agentDir>/pie-tasks.db`: next to Pie's other state and
 * never inside a user's repository. `DatabaseSync` comes from Node's built-in
 * `node:sqlite`, so both storage and the CLI need no extra dependency.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { projectIdentityKey } from '../project-identity';
import { getAgentDir } from '../session-reader';
import type {
  PendingQuestion,
  QueueState,
  QueueStateRecord,
  TaskEvent,
  TaskEventInput,
  TaskEventKind,
  TaskProjectSummary,
  TaskRecord,
  TaskRunRecord,
  TaskSettleInput,
  TaskStatus,
  TaskWatchRecord
} from './types';

export const TASK_DATABASE_FILE = 'pie-tasks.db';

/** How many finished runs the board keeps in its history payload. */
export const TASK_RUN_HISTORY_LIMIT = 50;

/** How many events one read returns before the reader must ask again. */
export const TASK_EVENT_PAGE_LIMIT = 200;

/** A durable event is a digest line, not a log file. */
export const TASK_EVENT_SUMMARY_MAX_LENGTH = 4_000;

type Row = Record<string, unknown>;

interface TaskRowInsert {
  title: string;
  description: string | null;
  projectKey: string;
  cwd: string;
  rank: number;
  verifyCommands: string[] | null;
  createdBy?: string | null;
  now: string;
}

export interface TaskFieldUpdate {
  title?: string;
  description?: string | null;
  cwd?: string;
  projectKey?: string;
  verifyCommands?: string[] | null;
  sessionId?: string | null;
  claimedToken?: string | null;
  pendingQuestion?: PendingQuestion | null;
  attempts?: number;
  rank?: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseCommands(value: unknown): string[] | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string') : null;
  } catch {
    return null;
  }
}

function parseQuestion(value: unknown): PendingQuestion | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as PendingQuestion;
    return parsed && typeof parsed.question === 'string' && typeof parsed.requestId === 'string'
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function serialize(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function clipSummary(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length > TASK_EVENT_SUMMARY_MAX_LENGTH
    ? value.slice(0, TASK_EVENT_SUMMARY_MAX_LENGTH)
    : value;
}

/** One sentence a digest can quote without reading the queue again. */
export function describeQueueState(state: Pick<QueueStateRecord, 'state' | 'pausedReason'>): string {
  return state.pausedReason ? `${state.state}: ${state.pausedReason}` : state.state;
}

function taskFromRow(row: Row): TaskRecord {
  return {
    id: Number(row.id),
    title: String(row.title),
    description: row.description === null ? null : String(row.description),
    status: String(row.status) as TaskStatus,
    rank: Number(row.rank),
    projectKey: row.project_key === null || row.project_key === undefined ? '' : String(row.project_key),
    cwd: String(row.cwd),
    verifyCommands: parseCommands(row.verify_commands),
    sessionId: row.session_id === null ? null : String(row.session_id),
    claimedToken: row.claimed_token === null ? null : String(row.claimed_token),
    pendingQuestion: parseQuestion(row.pending_question),
    attempts: Number(row.attempts),
    resultSummary: row.result_summary === null ? null : String(row.result_summary),
    exitCode: row.exit_code === null ? null : Number(row.exit_code),
    verifyOutput: row.verify_output === null ? null : String(row.verify_output),
    runStartedAt: row.run_started_at === null ? null : String(row.run_started_at),
    createdBy: row.created_by === null || row.created_by === undefined ? null : String(row.created_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at)
  };
}

function runFromRow(row: Row): TaskRunRecord {
  return {
    id: Number(row.id),
    taskId: Number(row.task_id),
    attempt: Number(row.attempt),
    status: String(row.status) as TaskStatus,
    sessionId: row.session_id === null ? null : String(row.session_id),
    exitCode: row.exit_code === null ? null : Number(row.exit_code),
    verifyExit: row.verify_exit === null ? null : Number(row.verify_exit),
    outputTail: row.output_tail === null ? null : String(row.output_tail),
    startedAt: String(row.started_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at)
  };
}

function queueStateFromRow(row: Row): QueueStateRecord {
  return {
    projectKey: String(row.project_key),
    cwd: row.cwd === null || row.cwd === undefined ? '' : String(row.cwd),
    state: String(row.state) as QueueState,
    pausedReason: row.paused_reason === null ? null : String(row.paused_reason),
    activeTaskId: row.active_task_id === null ? null : Number(row.active_task_id),
    updatedAt: String(row.updated_at)
  };
}

function eventFromRow(row: Row): TaskEvent {
  return {
    id: Number(row.id),
    taskId: row.task_id === null ? null : Number(row.task_id),
    projectKey: row.project_key === null || row.project_key === undefined ? null : String(row.project_key),
    kind: String(row.kind) as TaskEventKind,
    status: row.status === null ? null : (String(row.status) as TaskStatus),
    summary: row.summary === null ? null : String(row.summary),
    originSessionId: row.origin_session_id === null ? null : String(row.origin_session_id),
    createdAt: String(row.created_at)
  };
}

function watchFromRow(row: Row): TaskWatchRecord {
  return {
    sessionId: String(row.session_id),
    startedAt: String(row.started_at),
    wakes: Number(row.wakes)
  };
}

/** Legacy rows without a project key still belong to their cwd's project. */
function projectKeyOf(task: Pick<TaskRecord, 'projectKey' | 'cwd'>): string {
  return task.projectKey || projectIdentityKey(task.cwd);
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as Row | undefined;
  return Boolean(row);
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
  return rows.some((entry) => entry.name === column);
}

const MIGRATIONS: Array<(db: DatabaseSync) => void> = [
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        title            TEXT NOT NULL,
        description      TEXT,
        status           TEXT NOT NULL DEFAULT 'PENDING'
                           CHECK (status IN ('PENDING','IN_PROGRESS','DONE','BLOCKED','FAILED')),
        rank             INTEGER NOT NULL,
        cwd              TEXT NOT NULL,
        allow_ask_user   INTEGER,
        verify_commands  TEXT,
        auto_commit      INTEGER,
        session_id       TEXT,
        claimed_token    TEXT,
        pending_question TEXT,
        attempts         INTEGER NOT NULL DEFAULT 0,
        result_summary   TEXT,
        exit_code        INTEGER,
        verify_output    TEXT,
        commit_sha       TEXT,
        run_started_at   DATETIME,
        created_at       DATETIME NOT NULL,
        updated_at       DATETIME NOT NULL,
        finished_at      DATETIME
      );

      CREATE INDEX IF NOT EXISTS tasks_queue ON tasks (status, rank, id);

      CREATE TABLE IF NOT EXISTS task_runs (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id        INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        attempt        INTEGER NOT NULL,
        status         TEXT NOT NULL,
        session_id     TEXT,
        exit_code      INTEGER,
        verify_exit    INTEGER,
        output_tail    TEXT,
        commit_sha     TEXT,
        started_at     DATETIME NOT NULL,
        finished_at    DATETIME
      );

      CREATE TABLE IF NOT EXISTS queue_state (
        id              INTEGER PRIMARY KEY CHECK (id = 1),
        state           TEXT NOT NULL,
        paused_reason   TEXT,
        active_task_id  INTEGER,
        updated_at      DATETIME NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO queue_state (id, state, paused_reason, active_task_id, updated_at)
       VALUES (1, 'IDLE', NULL, NULL, ?)
       ON CONFLICT(id) DO NOTHING`
    ).run(nowIso());
  },
  // Committing belongs to the agent prompt, not to the queue. The columns were
  // never optional data: the queue wrote them, so dropping them loses nothing a
  // person entered.
  (db) => {
    db.exec(`
      ALTER TABLE tasks DROP COLUMN auto_commit;
      ALTER TABLE tasks DROP COLUMN commit_sha;
      ALTER TABLE task_runs DROP COLUMN commit_sha;
    `);
  },
  // A task queued from a chat session is marked, so the board can say who asked
  // for the work without parsing the description.
  (db) => {
    // A database restored from a newer backup may already carry it; adding a
    // duplicate column would fail the whole migration.
    const columns = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name?: unknown }>;
    if (!columns.some((column) => column.name === 'created_by')) {
      db.exec('ALTER TABLE tasks ADD COLUMN created_by TEXT;');
    }
  },
  // Status changes outlive the process that made them, so an operator session
  // can catch up after a reload or a restart.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_events (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id           INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
        kind              TEXT NOT NULL
                            CHECK (kind IN ('claimed','settled','question','answered','queue','config')),
        status            TEXT,
        summary           TEXT,
        origin_session_id TEXT,
        created_at        DATETIME NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_event_cursors (
        session_id    TEXT PRIMARY KEY,
        last_event_id INTEGER NOT NULL,
        updated_at    DATETIME NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_manager_watch (
        session_id TEXT PRIMARY KEY,
        started_at DATETIME NOT NULL,
        wakes      INTEGER NOT NULL DEFAULT 0
      );
    `);
  },
  // Per-project queues. The project key is the same normalized cwd identity the
  // session sidebar uses, so a task's cwd is its queue. Ranks are rewritten
  // inside each project; the old global queue state is mapped to the project
  // that owned its active task, and every other project starts IDLE.
  (db) => {
    if (!hasColumn(db, 'tasks', 'project_key')) {
      db.exec("ALTER TABLE tasks ADD COLUMN project_key TEXT NOT NULL DEFAULT '';");
    }
    const tasks = db.prepare('SELECT id, cwd FROM tasks').all() as Row[];
    const setProject = db.prepare('UPDATE tasks SET project_key = ? WHERE id = ?');
    for (const task of tasks) {
      setProject.run(projectIdentityKey(String(task.cwd)), Number(task.id));
    }

    const ordered = db
      .prepare('SELECT id, project_key FROM tasks ORDER BY rank, id')
      .all() as Row[];
    const rankByProject = new Map<string, number>();
    const setRank = db.prepare('UPDATE tasks SET rank = ? WHERE id = ?');
    for (const task of ordered) {
      const key = String(task.project_key);
      const rank = (rankByProject.get(key) ?? 0) + 10;
      rankByProject.set(key, rank);
      setRank.run(rank, Number(task.id));
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS project_queue_state (
        project_key    TEXT PRIMARY KEY,
        cwd            TEXT NOT NULL DEFAULT '',
        state          TEXT NOT NULL DEFAULT 'IDLE'
                         CHECK (state IN ('IDLE','RUNNING','PAUSED')),
        paused_reason  TEXT,
        active_task_id INTEGER,
        updated_at     DATETIME NOT NULL
      );
    `);

    const insertState = db.prepare(
      `INSERT INTO project_queue_state (project_key, cwd, state, paused_reason, active_task_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_key) DO NOTHING`
    );
    const projectCwd = (key: string): string => {
      const row = db
        .prepare('SELECT cwd FROM tasks WHERE project_key = ? ORDER BY id LIMIT 1')
        .get(key) as Row | undefined;
      return row ? String(row.cwd) : '';
    };

    if (tableExists(db, 'queue_state')) {
      const old = db.prepare('SELECT * FROM queue_state WHERE id = 1').get() as Row | undefined;
      if (old) {
        const state = String(old.state);
        const reason = old.paused_reason === null ? null : String(old.paused_reason);
        const activeId = old.active_task_id === null ? null : Number(old.active_task_id);
        const updatedAt = String(old.updated_at);
        if (activeId !== null) {
          const active = db
            .prepare('SELECT project_key, cwd FROM tasks WHERE id = ?')
            .get(activeId) as Row | undefined;
          if (active) {
            const key = String(active.project_key);
            insertState.run(key, String(active.cwd), state, reason, activeId, updatedAt);
          }
        } else if (state === 'PAUSED') {
          const pending = db
            .prepare("SELECT DISTINCT project_key FROM tasks WHERE status = 'PENDING'")
            .all() as Row[];
          for (const row of pending) {
            const key = String(row.project_key);
            insertState.run(key, projectCwd(key), 'PAUSED', reason, null, updatedAt);
          }
        }
      }
    }

    const projects = db.prepare('SELECT DISTINCT project_key FROM tasks').all() as Row[];
    for (const row of projects) {
      const key = String(row.project_key);
      insertState.run(key, projectCwd(key), 'IDLE', null, null, nowIso());
    }

    if (!hasColumn(db, 'task_events', 'project_key')) {
      db.exec('ALTER TABLE task_events ADD COLUMN project_key TEXT;');
    }
    db.exec(`
      UPDATE task_events
         SET project_key = (SELECT project_key FROM tasks WHERE tasks.id = task_events.task_id)
       WHERE project_key IS NULL AND task_id IS NOT NULL;

      DROP INDEX IF EXISTS tasks_queue;
      CREATE INDEX IF NOT EXISTS tasks_project_queue ON tasks (project_key, status, rank, id);
      CREATE INDEX IF NOT EXISTS tasks_project ON tasks (project_key);
      CREATE INDEX IF NOT EXISTS task_events_project ON task_events (project_key, id);
    `);
    if (tableExists(db, 'queue_state')) db.exec('DROP TABLE queue_state;');
  },
  // The question policy is now one global mode: full (ask_user available) or
  // autonomous (no questions, goal-driven). The per-task override has no reader.
  (db) => {
    if (hasColumn(db, 'tasks', 'allow_ask_user')) {
      db.exec(`ALTER TABLE tasks DROP COLUMN allow_ask_user;`);
    }
  },
  // An intermediate build advanced user_version without dropping the column;
  // this idempotent step repairs that database. Fresh and v5 databases have
  // already lost it and make this a no-op.
  (db) => {
    if (hasColumn(db, 'tasks', 'allow_ask_user')) {
      db.exec(`ALTER TABLE tasks DROP COLUMN allow_ask_user;`);
    }
  }
];

export class TaskStore {
  readonly path: string;
  private readonly db: DatabaseSync;
  private transactionDepth = 0;

  constructor(path: string) {
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA synchronous = NORMAL');
    const requested = path === ':memory:' ? 'memory' : 'wal';
    let mode = 'unknown';
    try {
      const row = this.db.prepare(`PRAGMA journal_mode = ${requested}`).get() as Row | undefined;
      mode = row ? String(row.journal_mode).toLowerCase() : 'unknown';
    } catch (error) {
      console.warn('[pie] task database could not enable WAL:', error);
    }
    if (requested === 'wal' && mode !== 'wal') {
      try {
        const row = this.db.prepare('PRAGMA journal_mode = delete').get() as Row | undefined;
        mode = row ? String(row.journal_mode).toLowerCase() : 'unknown';
      } catch {
        // Keep the default journal mode.
      }
      console.warn(
        `[pie] task database WAL unavailable (journal_mode is ${mode}); continuing without it`
      );
    }
    this.migrate();
  }

  get journalMode(): string {
    const row = this.db.prepare('PRAGMA journal_mode').get() as Row | undefined;
    return row ? String(row.journal_mode).toLowerCase() : 'unknown';
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Already closed.
    }
  }

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as Row | undefined;
    let version = row ? Number(row.user_version) : 0;
    // Project queues rewrite ranks and drop the old queue_state table, and the
    // autonomous-mode migration drops a per-task column. Keep a complete copy
    // before any pending one-way step; a fresh database has nothing to preserve.
    // `VACUUM INTO` is safe with WAL and produces one usable file.
    if (version > 0 && version < MIGRATIONS.length) {
      this.backupBeforeMigration(version);
    }
    for (let index = version; index < MIGRATIONS.length; index++) {
      this.transaction(() => {
        MIGRATIONS[index](this.db);
        this.db.exec(`PRAGMA user_version = ${index + 1}`);
      });
      version = index + 1;
    }
  }

  private backupBeforeMigration(version: number): void {
    if (this.path === ':memory:') return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = `${this.path}.v${version}-${stamp}.bak`;
    try {
      this.db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
      console.log(`[pie] backed up the task database to ${target}`);
    } catch (error) {
      // A failed backup must not stop the migration: the person can copy the
      // database by hand before upgrading.
      console.warn('[pie] could not back up the task database before migration:', error);
    }
  }

  /**
   * Run `body` inside one transaction. `BEGIN IMMEDIATE` takes the write lock at
   * the start, so a concurrent process cannot interleave a claim between the
   * guard and the update. Nested calls join the outer transaction.
   */
  transaction<T>(body: () => T): T {
    if (this.transactionDepth > 0) {
      this.transactionDepth += 1;
      try {
        return body();
      } finally {
        this.transactionDepth -= 1;
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth = 1;
    try {
      const result = body();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // The transaction may already be gone; the original error is what matters.
      }
      throw error;
    } finally {
      this.transactionDepth = 0;
    }
  }

  // ---------------------------------------------------------------- queue state

  getQueueState(projectKey: string, cwd = ''): QueueStateRecord {
    const row = this.db
      .prepare('SELECT * FROM project_queue_state WHERE project_key = ?')
      .get(projectKey) as Row | undefined;
    if (!row) {
      return {
        projectKey,
        cwd,
        state: 'IDLE',
        pausedReason: null,
        activeTaskId: null,
        updatedAt: nowIso()
      };
    }
    return queueStateFromRow(row);
  }

  setQueueState(
    projectKey: string,
    cwd: string,
    patch: Partial<Pick<QueueStateRecord, 'state' | 'pausedReason' | 'activeTaskId'>>,
    originSessionId?: string | null
  ): QueueStateRecord {
    const current = this.getQueueState(projectKey, cwd);
    const next = {
      cwd: cwd || current.cwd,
      state: patch.state ?? current.state,
      pausedReason: patch.pausedReason !== undefined ? patch.pausedReason : current.pausedReason,
      activeTaskId: patch.activeTaskId !== undefined ? patch.activeTaskId : current.activeTaskId
    };
    const exists =
      this.db
        .prepare('SELECT 1 AS present FROM project_queue_state WHERE project_key = ?')
        .get(projectKey) !== undefined;
    if (
      exists &&
      next.state === current.state &&
      next.pausedReason === current.pausedReason &&
      next.activeTaskId === current.activeTaskId &&
      next.cwd === current.cwd
    ) {
      return current;
    }
    return this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO project_queue_state
             (project_key, cwd, state, paused_reason, active_task_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_key) DO UPDATE SET
             cwd = excluded.cwd,
             state = excluded.state,
             paused_reason = excluded.paused_reason,
             active_task_id = excluded.active_task_id,
             updated_at = excluded.updated_at`
        )
        .run(
          projectKey,
          next.cwd,
          next.state,
          next.pausedReason,
          next.activeTaskId,
          nowIso()
        );
      // The active task is already announced by `claimed`; only a change a reader
      // cannot see elsewhere becomes an event.
      if (
        next.state !== current.state ||
        next.pausedReason !== current.pausedReason
      ) {
        this.appendEvent({
          kind: 'queue',
          projectKey,
          summary: describeQueueState(next),
          originSessionId
        });
      }
      return this.getQueueState(projectKey, next.cwd);
    });
  }

  /** One row per project that has tasks or a saved queue state. */
  listProjectSummaries(): TaskProjectSummary[] {
    const taskRows = this.db
      .prepare(
        `SELECT project_key,
                MAX(cwd) AS cwd,
                MAX(updated_at) AS updated_at,
                SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN status = 'IN_PROGRESS' THEN 1 ELSE 0 END) AS running,
                SUM(CASE WHEN status = 'BLOCKED' THEN 1 ELSE 0 END) AS blocked,
                SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed,
                SUM(CASE WHEN status = 'DONE' THEN 1 ELSE 0 END) AS done,
                COUNT(*) AS total
           FROM tasks
          GROUP BY project_key`
      )
      .all() as Row[];
    const stateRows = this.db.prepare('SELECT * FROM project_queue_state').all() as Row[];
    const activeRows = this.db
      .prepare(`SELECT id, title, project_key FROM tasks WHERE status = 'IN_PROGRESS'`)
      .all() as Row[];

    const states = new Map(stateRows.map((row) => [String(row.project_key), queueStateFromRow(row)]));
    const active = new Map(
      activeRows.map((row) => [
        String(row.project_key),
        { id: Number(row.id), title: String(row.title) }
      ])
    );
    const taskByProject = new Map(taskRows.map((row) => [String(row.project_key), row]));
    const keys = new Set([...taskByProject.keys(), ...states.keys()]);

    return [...keys].map((key) => {
      const tasks = taskByProject.get(key);
      const state = states.get(key);
      const runningTask = active.get(key);
      const updatedAt = state?.updatedAt || (tasks ? String(tasks.updated_at) : '');
      return {
        projectKey: key,
        cwd: state?.cwd || (tasks ? String(tasks.cwd) : ''),
        state: state?.state ?? 'IDLE',
        pausedReason: state?.pausedReason ?? null,
        activeTaskId: runningTask?.id ?? state?.activeTaskId ?? null,
        activeTaskTitle: runningTask?.title ?? null,
        activeSessions: [],
        running: false,
        pending: tasks ? Number(tasks.pending) : 0,
        blocked: tasks ? Number(tasks.blocked) : 0,
        failed: tasks ? Number(tasks.failed) : 0,
        done: tasks ? Number(tasks.done) : 0,
        total: tasks ? Number(tasks.total) : 0,
        updatedAt: updatedAt || null
      };
    });
  }

  // -------------------------------------------------------------------- events

  /**
   * Append one durable status change. Callers that already hold a transaction
   * inherit it, so an event never survives without the row it describes.
   */
  appendEvent(input: TaskEventInput, at: string = nowIso()): TaskEvent {
    const status = input.status ?? null;
    const summary = clipSummary(input.summary);
    const origin = input.originSessionId ?? null;
    const projectKey = input.projectKey ?? null;
    const result = this.db
      .prepare(
        `INSERT INTO task_events
           (task_id, project_key, kind, status, summary, origin_session_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(input.taskId ?? null, projectKey, input.kind, status, summary, origin, at);
    return {
      id: Number(result.lastInsertRowid),
      taskId: input.taskId ?? null,
      projectKey,
      kind: input.kind,
      status,
      summary,
      originSessionId: origin,
      createdAt: at
    };
  }

  lastEventId(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM task_events').get() as Row;
    return Number(row.id);
  }

  listEventsSince(
    afterId: number,
    limit = TASK_EVENT_PAGE_LIMIT,
    projectKey?: string | null
  ): TaskEvent[] {
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), TASK_EVENT_PAGE_LIMIT);
    const rows =
      projectKey === undefined || projectKey === null
        ? (this.db
            .prepare('SELECT * FROM task_events WHERE id > ? ORDER BY id LIMIT ?')
            .all(Math.max(Math.trunc(afterId), 0), bounded) as Row[])
        : (this.db
            .prepare('SELECT * FROM task_events WHERE id > ? AND project_key = ? ORDER BY id LIMIT ?')
            .all(Math.max(Math.trunc(afterId), 0), projectKey, bounded) as Row[]);
    return rows.map(eventFromRow);
  }

  getEventCursor(sessionId: string): number {
    const row = this.db
      .prepare('SELECT last_event_id FROM task_event_cursors WHERE session_id = ?')
      .get(sessionId) as Row | undefined;
    return row ? Number(row.last_event_id) : 0;
  }

  /** A cursor only moves forward, so a replayed page cannot hide newer events. */
  setEventCursor(sessionId: string, lastEventId: number): void {
    this.db
      .prepare(
        `INSERT INTO task_event_cursors (session_id, last_event_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           last_event_id = MAX(task_event_cursors.last_event_id, excluded.last_event_id),
           updated_at = excluded.updated_at`
      )
      .run(sessionId, Math.max(Math.trunc(lastEventId), 0), nowIso());
  }

  /**
   * The events a session has not seen, without moving its cursor. A watcher
   * peeks first so a wake it decides not to send cannot consume an event.
   */
  peekSessionEvents(
    sessionId: string,
    limit = TASK_EVENT_PAGE_LIMIT,
    projectKey?: string | null
  ): TaskEvent[] {
    return this.listEventsSince(this.getEventCursor(sessionId), limit, projectKey);
  }

  /**
   * Read what a session has not seen yet and advance its cursor in the same
   * transaction, so two concurrent reads never deliver the same event twice.
   */
  readSessionEvents(
    sessionId: string,
    limit = TASK_EVENT_PAGE_LIMIT,
    projectKey?: string | null
  ): { events: TaskEvent[]; cursor: number } {
    return this.transaction(() => {
      const cursor = this.getEventCursor(sessionId);
      const events = this.listEventsSince(cursor, limit, projectKey);
      if (events.length > 0) this.setEventCursor(sessionId, events[events.length - 1].id);
      return { events, cursor };
    });
  }

  // --------------------------------------------------------------- watch state

  getWatch(): TaskWatchRecord | null {
    const row = this.db.prepare('SELECT * FROM task_manager_watch LIMIT 1').get() as
      | Row
      | undefined;
    return row ? watchFromRow(row) : null;
  }

  /** Replace the watch row; a new watch always starts with a zero budget. */
  setWatch(sessionId: string, startedAt: string = nowIso()): TaskWatchRecord {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM task_manager_watch').run();
      this.db
        .prepare('INSERT INTO task_manager_watch (session_id, started_at, wakes) VALUES (?, ?, 0)')
        .run(sessionId, startedAt);
      return { sessionId, startedAt, wakes: 0 };
    });
  }

  bumpWatchWakes(): TaskWatchRecord | null {
    this.db.prepare('UPDATE task_manager_watch SET wakes = wakes + 1').run();
    return this.getWatch();
  }

  /** Clear every watch, or only the one owned by `sessionId`. */
  clearWatch(sessionId?: string): void {
    if (sessionId === undefined) this.db.prepare('DELETE FROM task_manager_watch').run();
    else
      this.db.prepare('DELETE FROM task_manager_watch WHERE session_id = ?').run(sessionId);
  }

  // --------------------------------------------------------------------- tasks

  listTasks(projectKey?: string): TaskRecord[] {
    const rows = projectKey
      ? (this.db
          .prepare('SELECT * FROM tasks WHERE project_key = ? ORDER BY rank, id')
          .all(projectKey) as Row[])
      : (this.db.prepare('SELECT * FROM tasks ORDER BY project_key, rank, id').all() as Row[]);
    return rows.map(taskFromRow);
  }

  getTask(id: number): TaskRecord | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return row ? taskFromRow(row) : null;
  }

  pendingTasks(projectKey: string): TaskRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks WHERE project_key = ? AND status = 'PENDING' ORDER BY rank, id`
      )
      .all(projectKey) as Row[];
    return rows.map(taskFromRow);
  }

  inProgressTask(projectKey?: string): TaskRecord | null {
    const row = projectKey
      ? (this.db
          .prepare(
            `SELECT * FROM tasks WHERE project_key = ? AND status = 'IN_PROGRESS' ORDER BY id LIMIT 1`
          )
          .get(projectKey) as Row | undefined)
      : (this.db
          .prepare(`SELECT * FROM tasks WHERE status = 'IN_PROGRESS' ORDER BY id LIMIT 1`)
          .get() as Row | undefined);
    return row ? taskFromRow(row) : null;
  }

  insertTask(input: TaskRowInsert): TaskRecord {
    const result = this.db
      .prepare(
        `INSERT INTO tasks (title, description, status, rank, project_key, cwd,
                            verify_commands, created_by, created_at, updated_at)
         VALUES (?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.title,
        input.description,
        input.rank,
        input.projectKey,
        input.cwd,
        serialize(input.verifyCommands),
        input.createdBy ?? null,
        input.now,
        input.now
      );
    const task = this.getTask(Number(result.lastInsertRowid));
    if (!task) throw new Error('the task row disappeared after insert');
    return task;
  }

  nextRank(projectKey: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(rank), 0) AS rank FROM tasks WHERE project_key = ?')
      .get(projectKey) as Row;
    return Number(row.rank) + 10;
  }

  /**
   * Update editable fields, refusing a running task in the statement itself.
   * Returns null when the guard rejected the write. A cwd change carries its
   * project key with it, so the row moves to the new project's queue.
   */
  updateTaskFields(id: number, fields: TaskFieldUpdate): TaskRecord | null {
    const assignments: string[] = [];
    const values: Array<string | number | null> = [];
    const push = (column: string, value: string | number | null) => {
      assignments.push(`${column} = ?`);
      values.push(value);
    };
    if (fields.title !== undefined) push('title', fields.title);
    if (fields.description !== undefined) push('description', fields.description);
    if (fields.cwd !== undefined) push('cwd', fields.cwd);
    const nextProject =
      fields.projectKey ??
      (fields.cwd !== undefined ? projectIdentityKey(fields.cwd) : undefined);
    if (nextProject !== undefined) push('project_key', nextProject);
    if (fields.verifyCommands !== undefined)
      push('verify_commands', serialize(fields.verifyCommands));
    if (fields.rank !== undefined) push('rank', fields.rank);
    if (assignments.length === 0) return this.getTask(id);

    push('updated_at', nowIso());
    const result = this.db
      .prepare(
        `UPDATE tasks SET ${assignments.join(', ')}
         WHERE id = ? AND status <> 'IN_PROGRESS'`
      )
      .run(...values, id);
    return Number(result.changes) === 1 ? this.getTask(id) : null;
  }

  /** Store the session id of the current attempt without touching the lock guard. */
  attachSession(id: number, sessionId: string): void {
    this.db
      .prepare('UPDATE tasks SET session_id = ?, updated_at = ? WHERE id = ?')
      .run(sessionId, nowIso(), id);
  }

  setPendingQuestion(id: number, question: PendingQuestion | null): void {
    const task = this.getTask(id);
    const projectKey = task ? projectKeyOf(task) : null;
    this.transaction(() => {
      this.db
        .prepare('UPDATE tasks SET pending_question = ?, updated_at = ? WHERE id = ?')
        .run(serialize(question), nowIso(), id);
      if (question) {
        this.appendEvent({
          kind: 'question',
          taskId: id,
          projectKey,
          status: 'IN_PROGRESS',
          summary: question.question
        });
      }
    });
  }

  /**
   * Clear the pending question and record who answered it. The answer text is
   * kept short: it is a digest line, and the run already received the full one.
   */
  resolveQuestion(
    id: number,
    input: { answer?: string; cancelled?: boolean; originSessionId?: string | null }
  ): TaskEvent {
    const task = this.getTask(id);
    const projectKey = task ? projectKeyOf(task) : null;
    return this.transaction(() => {
      this.db
        .prepare('UPDATE tasks SET pending_question = NULL, updated_at = ? WHERE id = ?')
        .run(nowIso(), id);
      const answer = input.answer?.trim();
      return this.appendEvent({
        kind: 'answered',
        taskId: id,
        projectKey,
        status: 'IN_PROGRESS',
        summary: input.cancelled ? 'question dismissed' : (answer ?? 'question answered'),
        originSessionId: input.originSessionId
      });
    });
  }

  deleteTask(id: number): boolean {
    return this.transaction(() => {
      const task = this.getTask(id);
      if (!task) return false;
      const result = this.db
        .prepare(`DELETE FROM tasks WHERE id = ? AND status <> 'IN_PROGRESS'`)
        .run(id);
      if (Number(result.changes) !== 1) return false;
      this.clearProjectStateIfEmpty(projectKeyOf(task), task.cwd);
      return true;
    });
  }

  /**
   * A project with nothing left to review is idle; deleting the only failed
   * task should not leave the project paused forever.
   */
  clearProjectStateIfEmpty(projectKey: string, cwd = ''): void {
    if (!projectKey) return;
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM tasks
          WHERE project_key = ? AND status IN ('PENDING','IN_PROGRESS','BLOCKED','FAILED')`
      )
      .get(projectKey) as Row;
    if (Number(row.count) > 0) return;
    const state = this.getQueueState(projectKey, cwd);
    this.setQueueState(projectKey, state.cwd || cwd, {
      state: 'IDLE',
      pausedReason: null,
      activeTaskId: null
    });
  }

  /** Rewrite one project's pending segment as 10, 20, 30, ... */
  rewritePendingRanks(projectKey: string, orderedIds: number[]): void {
    this.transaction(() => {
      const statement = this.db.prepare(
        `UPDATE tasks SET rank = ?, updated_at = ?
          WHERE id = ? AND project_key = ? AND status = 'PENDING'`
      );
      const now = nowIso();
      orderedIds.forEach((id, index) => {
        statement.run((index + 1) * 10, now, id, projectKey);
      });
    });
  }

  /**
   * Claim the next pending task in one project. The whole operation is one
   * `BEGIN IMMEDIATE` transaction: assert that no row in this project is
   * running, then flip its lowest rank/id pending row while it is still pending.
   * A task running in another project is not this project's concern.
   */
  claimNextPending(projectKey: string, token: string, sessionId: string): TaskRecord | null {
    return this.transaction(() => {
      const running = this.db
        .prepare(
          `SELECT id FROM tasks WHERE project_key = ? AND status = 'IN_PROGRESS' LIMIT 1`
        )
        .get(projectKey) as Row | undefined;
      if (running) {
        throw new Error(`task ${String(running.id)} is already in progress in this project`);
      }

      const candidate = this.db
        .prepare(
          `SELECT id FROM tasks
            WHERE project_key = ? AND status = 'PENDING'
            ORDER BY rank, id LIMIT 1`
        )
        .get(projectKey) as Row | undefined;
      if (!candidate) return null;

      const id = Number(candidate.id);
      const now = nowIso();
      const result = this.db
        .prepare(
          `UPDATE tasks
              SET status = 'IN_PROGRESS', claimed_token = ?, session_id = ?, attempts = attempts + 1,
                  pending_question = NULL, result_summary = NULL, exit_code = NULL,
                  verify_output = NULL, finished_at = NULL,
                  run_started_at = ?, updated_at = ?
            WHERE id = ? AND project_key = ? AND status = 'PENDING'`
        )
        .run(token, sessionId, now, now, id, projectKey);
      if (Number(result.changes) !== 1) {
        throw new Error(`task ${id} could not be claimed`);
      }
      const claimed = taskFromRow(this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row);
      this.appendEvent({
        kind: 'claimed',
        taskId: id,
        projectKey,
        status: 'IN_PROGRESS',
        summary: claimed.title
      });
      return claimed;
    });
  }

  /**
   * Write a terminal state, its run record, and the project queue state in one
   * transaction. The task update only applies while the caller still owns the
   * claim, so a late writer cannot overwrite a newer attempt.
   */
  settleTask(id: number, token: string, input: TaskSettleInput): TaskRecord | null {
    return this.transaction(() => {
      const current = this.getTask(id);
      if (!current || current.claimedToken !== token || current.status !== 'IN_PROGRESS') {
        return null;
      }
      const projectKey = projectKeyOf(current);
      const now = nowIso();
      const updated = this.db
        .prepare(
          `UPDATE tasks
              SET status = ?, result_summary = ?, exit_code = ?, verify_output = ?,
                  claimed_token = NULL, pending_question = NULL,
                  finished_at = ?, updated_at = ?
            WHERE id = ? AND status = 'IN_PROGRESS' AND claimed_token = ?`
        )
        .run(
          input.status,
          input.resultSummary,
          input.exitCode,
          input.verifyOutput ?? null,
          now,
          now,
          id,
          token
        );
      if (Number(updated.changes) !== 1) return null;

      this.db
        .prepare(
          `INSERT INTO task_runs (task_id, attempt, status, session_id, exit_code, verify_exit,
                                 output_tail, started_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          current.attempts,
          input.status,
          input.sessionId,
          input.exitCode,
          input.verifyExit ?? null,
          input.outputTail ?? null,
          current.runStartedAt ?? now,
          now
        );

      this.appendEvent({
        kind: 'settled',
        taskId: id,
        projectKey,
        status: input.status,
        summary: input.resultSummary
      });

      if (input.queueState) {
        this.setQueueState(projectKey, current.cwd, input.queueState);
      }
      return this.getTask(id);
    });
  }

  listRuns(projectKey?: string, limit = TASK_RUN_HISTORY_LIMIT): TaskRunRecord[] {
    const rows = projectKey
      ? (this.db
          .prepare(
            `SELECT r.* FROM task_runs r
               JOIN tasks t ON t.id = r.task_id
              WHERE t.project_key = ?
              ORDER BY r.id DESC LIMIT ?`
          )
          .all(projectKey, limit) as Row[])
      : (this.db
          .prepare('SELECT * FROM task_runs ORDER BY id DESC LIMIT ?')
          .all(limit) as Row[]);
    return rows.map(runFromRow);
  }

  listRunsForTask(taskId: number): TaskRunRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY id')
      .all(taskId) as Row[];
    return rows.map(runFromRow);
  }

  markTaskDone(id: number, summary: string | null, originSessionId?: string | null): TaskRecord | null {
    const task = this.getTask(id);
    const projectKey = task ? projectKeyOf(task) : null;
    return this.transaction(() => {
      const now = nowIso();
      const result = this.db
        .prepare(
          `UPDATE tasks SET status = 'DONE', result_summary = ?, claimed_token = NULL,
                            pending_question = NULL, finished_at = ?, updated_at = ?
            WHERE id = ? AND status <> 'IN_PROGRESS'`
        )
        .run(summary, now, now, id);
      if (Number(result.changes) !== 1) return null;
      this.appendEvent({
        kind: 'settled',
        taskId: id,
        projectKey,
        status: 'DONE',
        summary,
        originSessionId
      });
      return this.getTask(id);
    });
  }

  retryTask(id: number, originSessionId?: string | null): TaskRecord | null {
    const task = this.getTask(id);
    const projectKey = task ? projectKeyOf(task) : null;
    return this.transaction(() => {
      const now = nowIso();
      const result = this.db
        .prepare(
          `UPDATE tasks SET status = 'PENDING', result_summary = NULL, exit_code = NULL,
                            verify_output = NULL, finished_at = NULL,
                            claimed_token = NULL, pending_question = NULL, updated_at = ?
            WHERE id = ? AND status IN ('BLOCKED','FAILED')`
        )
        .run(now, id);
      if (Number(result.changes) !== 1) return null;
      this.appendEvent({
        kind: 'settled',
        taskId: id,
        projectKey,
        status: 'PENDING',
        summary: 'returned to the queue',
        originSessionId
      });
      return this.getTask(id);
    });
  }

  /**
   * At start-up, a row left running belongs to a session that died with the old
   * server. It never becomes DONE: the run did not survive. Only this project's
   * rows and state are touched.
   */
  recoverInterrupted(projectKey: string, summary: string): TaskRecord[] {
    const now = nowIso();
    const rows = this.db
      .prepare(`SELECT * FROM tasks WHERE project_key = ? AND status = 'IN_PROGRESS'`)
      .all(projectKey) as Row[];
    if (rows.length === 0) return [];
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE tasks SET status = 'BLOCKED', result_summary = ?, claimed_token = NULL,
                            pending_question = NULL, finished_at = ?, updated_at = ?
            WHERE project_key = ? AND status = 'IN_PROGRESS'`
        )
        .run(summary, now, now, projectKey);
      const first = rows[0];
      this.setQueueState(projectKey, String(first.cwd), {
        state: 'PAUSED',
        pausedReason: summary,
        activeTaskId: null
      });
    });
    return rows.map(taskFromRow);
  }

  /** Whether a session id belongs to a task row the queue still owns. */
  taskForSession(sessionId: string): TaskRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM tasks WHERE session_id = ? AND status = 'IN_PROGRESS' LIMIT 1`)
      .get(sessionId) as Row | undefined;
    return row ? taskFromRow(row) : null;
  }
}

export function newClaimToken(): string {
  return randomUUID();
}

export function defaultTaskDatabasePath(agentDir: string = getAgentDir()): string {
  return join(agentDir, TASK_DATABASE_FILE);
}

declare global {
  var __pieTaskStore: TaskStore | undefined;
  var __pieTaskStorePath: string | undefined;
}

/**
 * The per-process store. Route handlers are bundled separately and hot reload
 * re-evaluates modules, so a single `globalThis` instance keeps one connection
 * to one database.
 */
export function getTaskStore(path: string = defaultTaskDatabasePath()): TaskStore {
  if (globalThis.__pieTaskStore && globalThis.__pieTaskStorePath === path && existsSync(path)) {
    return globalThis.__pieTaskStore;
  }
  globalThis.__pieTaskStore?.close();
  globalThis.__pieTaskStore = new TaskStore(path);
  globalThis.__pieTaskStorePath = path;
  return globalThis.__pieTaskStore;
}

/** Only tests reset this; a running server keeps one store for its lifetime. */
export function resetTaskStore(): void {
  globalThis.__pieTaskStore?.close();
  globalThis.__pieTaskStore = undefined;
  globalThis.__pieTaskStorePath = undefined;
}
