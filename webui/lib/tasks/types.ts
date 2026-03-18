/**
 * Shared shapes of the serial task queue.
 *
 * These types cross every boundary the queue owns: the database row mapper, the
 * queue controller, the HTTP routes, and the browser board. Nothing here knows
 * about Pi; the runner and the SDK session add that.
 */

export type TaskStatus = 'PENDING' | 'IN_PROGRESS' | 'DONE' | 'BLOCKED' | 'FAILED';

export type QueueState = 'IDLE' | 'RUNNING' | 'PAUSED';

/** A question asked by the running task's `ask_user` tool, kept across reloads. */
export interface PendingQuestion {
  /** The extension UI request id the answer must repeat. */
  requestId: string;
  question: string;
  /** The offered options without the "write my own answer" sentinel. */
  options: string[];
  /** False while the session waits for a free-form follow-up `input` request. */
  awaitingInput: boolean;
  askedAt: string;
}

export interface TaskRecord {
  id: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  rank: number;
  /** The normalized cwd identity every project-scoped query groups by. */
  projectKey: string;
  cwd: string;
  verifyCommands: string[] | null;
  sessionId: string | null;
  claimedToken: string | null;
  pendingQuestion: PendingQuestion | null;
  attempts: number;
  resultSummary: string | null;
  exitCode: number | null;
  verifyOutput: string | null;
  runStartedAt: string | null;
  /** The session that queued it, when an orchestrator did; null for the board. */
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface TaskRunRecord {
  id: number;
  taskId: number;
  attempt: number;
  status: TaskStatus;
  sessionId: string | null;
  exitCode: number | null;
  verifyExit: number | null;
  outputTail: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface QueueStateRecord {
  projectKey: string;
  cwd: string;
  state: QueueState;
  pausedReason: string | null;
  activeTaskId: number | null;
  updatedAt: string;
}

/** A running chat session in a project; chat work takes priority over queued work. */
export interface TaskActiveSession {
  sessionId: string;
  title: string;
  awaiting: boolean;
}

/** One project's queue as the board and the task sidebar read it. */
export interface TaskProjectSummary {
  projectKey: string;
  cwd: string;
  state: QueueState;
  pausedReason: string | null;
  activeTaskId: number | null;
  activeTaskTitle: string | null;
  /** Chat sessions currently running in this project, newest activity first. */
  activeSessions: TaskActiveSession[];
  /** True while this process is driving the project's loop. */
  running: boolean;
  pending: number;
  blocked: number;
  failed: number;
  done: number;
  total: number;
  updatedAt: string | null;
}

/** The model a task's session starts with; `null` keeps Pi's own default. */
export interface TaskModelSelection {
  provider: string;
  modelId: string;
}

export interface TaskConfig {
  /** Applies to the next task the queue starts, never to one already running. */
  model: TaskModelSelection | null;
  verifyCommands: string[];
  /** `null` runs each verification command without a timeout. */
  verifyTimeoutMs: number | null;
  /** `null` runs a task with no watchdog; only an abort or the session's own end stops it. */
  taskTimeoutMs: number | null;
  /** One global switch: use the Autonomous preset, ask nothing, and start a goal. */
  autonomous: boolean;
  /** Standing instructions appended to every task session's system prompt; empty for none. */
  instructions: string;
}

/** The activity vocabulary the board shows; the browser translates it. */
export type TaskActivityKind =
  'starting' | 'waiting' | 'thinking' | 'reading' | 'writing' | 'running';

export interface TaskActivity {
  taskId: number;
  kind: TaskActivityKind;
  /** A concrete detail such as a file name or a command. */
  detail: string | null;
  at: string;
}

export interface OrchestratorStatus {
  projectKey: string;
  cwd: string;
  state: QueueState;
  pausedReason: string | null;
  activeTaskId: number | null;
  /** Chat sessions currently running in this project, newest activity first. */
  activeSessions: TaskActiveSession[];
  /** True while the process loop is executing, as opposed to the stored state. */
  running: boolean;
  activity: TaskActivity | null;
}

/**
 * The decision points a queue reader can observe. Activity inside a run is
 * deliberately absent: only a transition another operator must know about is an
 * event.
 */
export type TaskEventKind = 'claimed' | 'settled' | 'question' | 'answered' | 'queue' | 'config';

/** One durable status change, appended inside the transaction that caused it. */
export interface TaskEvent {
  id: number;
  /** Null for a queue-level event such as a pause or a configuration write. */
  taskId: number | null;
  /** The project the event belongs to; null for global configuration writes. */
  projectKey: string | null;
  kind: TaskEventKind;
  /** The task's status at the time, so a digest needs no second read. */
  status: TaskStatus | null;
  summary: string | null;
  /** The session whose call caused it, so that session is not woken for its own work. */
  originSessionId: string | null;
  createdAt: string;
}

export interface TaskEventInput {
  kind: TaskEventKind;
  taskId?: number | null;
  projectKey?: string | null;
  status?: TaskStatus | null;
  summary?: string | null;
  originSessionId?: string | null;
}

/** The one watch row: at most one session actively watches the queue. */
export interface TaskWatchRecord {
  sessionId: string;
  startedAt: string;
  wakes: number;
}

export interface TaskCreateInput {
  /** A short label; omitted for board tasks, whose description supplies it. */
  title?: string;
  description?: string | null;
  cwd: string;
  verifyCommands?: string[] | null;
  /** Set by the orchestrator's tool, so the board can mark who queued the work. */
  createdBy?: string | null;
  /**
   * Record the directory as approved instead of refusing it. Set only by a tool
   * call, after the person named the directory; the board has its own picker.
   */
  authorizeCwd?: boolean;
}

export interface TaskUpdateInput {
  title?: string;
  description?: string | null;
  cwd?: string;
  verifyCommands?: string[] | null;
  /** As on create: approve a directory the person named. */
  authorizeCwd?: boolean;
}

export interface TaskMoveAction {
  direction?: 'up' | 'down';
  position?: number;
}

export interface TaskAnswerInput {
  answer?: string;
  cancelled?: boolean;
}

export interface TaskSettleInput {
  status: TaskStatus;
  resultSummary: string | null;
  exitCode: number | null;
  sessionId: string | null;
  verifyOutput?: string | null;
  verifyExit?: number | null;
  outputTail?: string | null;
  queueState?: Partial<Pick<QueueStateRecord, 'state' | 'pausedReason' | 'activeTaskId'>>;
}
