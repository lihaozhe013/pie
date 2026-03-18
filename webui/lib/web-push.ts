import { existsSync, mkdirSync, readFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import webpush from 'web-push';
import { writePrivateFileAtomicSync } from './atomic-file';
import { enLocale } from './i18n/messages/en';
import { zhCNLocale } from './i18n/messages/zh-CN';
import { getAgentDir } from './session-reader';

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  locale: string;
}

interface PushStateFile {
  vapidKeys: { publicKey: string; privateKey: string };
  subscriptions: PushSubscriptionRecord[];
}

interface WebPushEnvironment {
  send: (
    subscription: PushSubscriptionRecord,
    payload: string,
    vapidKeys: PushStateFile['vapidKeys']
  ) => Promise<void>;
  loadState: () => PushStateFile | null;
  saveState: (state: PushStateFile) => void;
  generateVapidKeys: () => PushStateFile['vapidKeys'];
}

export interface WebPushNotifier {
  getVapidPublicKey: () => string;
  addSubscription: (subscription: PushSubscriptionRecord) => void;
  /** `sessionName` titles the notification; without one it reads "Session complete". */
  notifySessionComplete: (sessionId: string, sessionName?: string) => Promise<void>;
  /** Queue events: complete, done, blocked, failed, and a waiting question. */
  notifyTask: (notification: TaskPushNotification) => Promise<void>;
}

/** Structural mirror of the queue's notification, so Web Push imports no queue code. */
export interface TaskPushNotification {
  kind: 'complete' | 'done' | 'blocked' | 'failed' | 'question';
  task: { id: number; title: string } | null;
  /** The project whose queue produced the event. */
  project?: { projectKey: string; cwd: string } | null;
  reason?: string;
}

function stateFilePath(): string {
  return join(getAgentDir(), 'web-push.json');
}

/**
 * VAPID subject must be a valid `mailto:` or `https:` URL. Apple's push
 * service rejects requests whose subject is not a syntactically valid URL
 * (e.g. the previously used `mailto:pie@localhost`, which Apple answers
 * with 403 BadJwtToken), so default to the project homepage and let operators
 * override it via PIE_PUSH_SUBJECT.
 */
export function vapidSubject(): string {
  const configured = process.env.PIE_PUSH_SUBJECT?.trim();
  if (configured) return configured;
  return 'https://github.com/lihaozhe013/pie';
}

// Ask the push service to deliver immediately. Lower urgencies let idle
// devices (especially iOS) defer delivery to an arbitrary later window.
export const PUSH_OPTIONS = { TTL: 2419200, urgency: 'high' as const };

function getDefaultEnvironment(): WebPushEnvironment {
  return {
    async send(subscription, payload, vapidKeys) {
      await webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: subscription.keys },
        payload,
        {
          vapidDetails: {
            subject: vapidSubject(),
            publicKey: vapidKeys.publicKey,
            privateKey: vapidKeys.privateKey
          },
          TTL: PUSH_OPTIONS.TTL,
          urgency: PUSH_OPTIONS.urgency
        }
      );
    },
    loadState() {
      const path = stateFilePath();
      if (!existsSync(path)) return null;
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as PushStateFile;
      } catch {
        return null;
      }
    },
    saveState(state) {
      const path = stateFilePath();
      mkdirSync(dirname(path), { recursive: true });
      writePrivateFileAtomicSync(path, JSON.stringify(state));
    },
    generateVapidKeys: () => webpush.generateVAPIDKeys()
  };
}

function pushStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return undefined;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' ? statusCode : undefined;
}

/**
 * Locale lookup for push payloads. The browser reports its UI locale when it
 * subscribes; unknown locales fall back to English.
 */
export type PushTextKey =
  | 'sessionComplete'
  | 'taskFinished'
  | 'taskQueueComplete'
  | 'taskDone'
  | 'taskBlocked'
  | 'taskFailed'
  | 'taskQuestion';

const PUSH_TEXT_MESSAGES: Record<PushTextKey, string> = {
  sessionComplete: 'i18n.sessionComplete',
  taskFinished: 'i18n.taskFinished',
  taskQueueComplete: 'i18n.taskQueueComplete',
  taskDone: 'i18n.taskDone',
  taskBlocked: 'i18n.taskBlocked',
  taskFailed: 'i18n.taskFailed',
  taskQuestion: 'i18n.taskQuestion'
};

const PUSH_TEXT_FALLBACK: Record<PushTextKey, string> = {
  sessionComplete: 'Session complete',
  taskFinished: 'Task finished.',
  taskQueueComplete: 'Task queue complete',
  taskDone: 'Task finished successfully.',
  taskBlocked: 'A task is blocked.',
  taskFailed: 'A task failed.',
  taskQuestion: 'A task is waiting for your answer.'
};

function messageFor(locale: string, key: PushTextKey): string {
  const messages = locale === 'zh-CN' ? zhCNLocale.messages : enLocale.messages;
  return messages[PUSH_TEXT_MESSAGES[key]] ?? PUSH_TEXT_FALLBACK[key];
}

export function localeText(locale: string, key: PushTextKey): string {
  if (locale === 'zh-CN') {
    const message = zhCNLocale.messages[PUSH_TEXT_MESSAGES[key]];
    if (message) return message;
  }
  return messageFor(locale, key);
}

function taskPushPayload(
  locale: string,
  notification: TaskPushNotification
): { title: string; body: string; url: string; tag: string } {
  const label = notification.task?.title ?? null;
  const projectName = notification.project?.cwd
    ? basename(notification.project.cwd) || notification.project.cwd
    : null;
  const projectQuery = notification.project?.cwd
    ? `&cwd=${encodeURIComponent(notification.project.cwd)}`
    : '';
  if (notification.kind === 'complete') {
    return {
      title: localeText(locale, 'taskQueueComplete'),
      body: projectName
        ? `${projectName} · ${localeText(locale, 'taskFinished')}`
        : localeText(locale, 'taskFinished'),
      url: `/?mode=tasks${projectQuery}`,
      tag: notification.project
        ? `pie-task-queue:${notification.project.projectKey}`
        : 'pie-task-queue'
    };
  }
  const bodyKey: PushTextKey =
    notification.kind === 'done'
      ? 'taskDone'
      : notification.kind === 'blocked'
        ? 'taskBlocked'
        : notification.kind === 'failed'
          ? 'taskFailed'
          : 'taskQuestion';
  const taskId = notification.task?.id ?? 0;
  return {
    title: label ?? localeText(locale, bodyKey),
    body: projectName
      ? `${projectName} · ${localeText(locale, bodyKey)}`
      : localeText(locale, bodyKey),
    url: `/?mode=tasks${projectQuery}&task=${encodeURIComponent(String(taskId))}`,
    tag: `pie-task-${notification.kind}:${taskId}`
  };
}

export function createWebPushNotifier(environment: WebPushEnvironment): WebPushNotifier {
  const state: PushStateFile = (() => {
    const loaded = environment.loadState();
    if (loaded?.vapidKeys?.publicKey && loaded.vapidKeys.privateKey) return loaded;
    return { vapidKeys: environment.generateVapidKeys(), subscriptions: [] };
  })();
  const saveState = () => {
    environment.saveState(state);
  };

  return {
    getVapidPublicKey() {
      saveState();
      return state.vapidKeys.publicKey;
    },
    addSubscription(subscription) {
      state.subscriptions = [
        ...state.subscriptions.filter((s) => s.endpoint !== subscription.endpoint),
        subscription
      ];
      saveState();
    },
    async notifySessionComplete(sessionId, sessionName) {
      if (state.subscriptions.length === 0) return;
      const payloadFor = (locale: string) => ({
        title: sessionName ?? localeText(locale, 'sessionComplete'),
        body: localeText(locale, 'taskFinished'),
        url: `/?session=${encodeURIComponent(sessionId)}`,
        tag: `pi-session-complete:${sessionId}`
      });

      let pruned = false;
      for (const subscription of [...state.subscriptions]) {
        try {
          await environment.send(
            subscription,
            JSON.stringify(payloadFor(subscription.locale)),
            state.vapidKeys
          );
        } catch (error) {
          const statusCode = pushStatusCode(error);
          if (statusCode === 404 || statusCode === 410) {
            state.subscriptions = state.subscriptions.filter(
              (s) => s.endpoint !== subscription.endpoint
            );
            pruned = true;
          }
        }
      }
      if (pruned) saveState();
    },
    async notifyTask(notification) {
      if (state.subscriptions.length === 0) return;
      let pruned = false;
      for (const subscription of [...state.subscriptions]) {
        try {
          await environment.send(
            subscription,
            JSON.stringify(taskPushPayload(subscription.locale, notification)),
            state.vapidKeys
          );
        } catch (error) {
          const statusCode = pushStatusCode(error);
          if (statusCode === 404 || statusCode === 410) {
            state.subscriptions = state.subscriptions.filter(
              (s) => s.endpoint !== subscription.endpoint
            );
            pruned = true;
          }
        }
      }
      if (pruned) saveState();
    }
  };
}

declare global {
  var __piePushNotifier: Promise<WebPushNotifier> | undefined;
}

function getNotifier(): Promise<WebPushNotifier> {
  if (!globalThis.__piePushNotifier) {
    globalThis.__piePushNotifier = Promise.resolve().then(() =>
      createWebPushNotifier(getDefaultEnvironment())
    );
  }
  return globalThis.__piePushNotifier;
}

export function getVapidPublicKey(): Promise<string> {
  return getNotifier().then((notifier) => notifier.getVapidPublicKey());
}

export function addSubscription(subscription: PushSubscriptionRecord): Promise<void> {
  return getNotifier().then((notifier) => notifier.addSubscription(subscription));
}

export async function notifySessionComplete(
  sessionId: string,
  sessionName?: string
): Promise<void> {
  const notifier = await getNotifier();
  await notifier.notifySessionComplete(sessionId, sessionName);
}

export async function notifyTaskEvent(notification: TaskPushNotification): Promise<void> {
  const notifier = await getNotifier();
  await notifier.notifyTask(notification);
}
