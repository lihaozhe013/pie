// pie bridge extension.
//
// pie loads this file with `pi -e`. It supplies the runtime commands the
// RPC protocol does not expose: hot tool switching, work-mode entries, reload,
// a tool/system-prompt snapshot for the settings UI, and provider sign-in.
// The entry shapes match Pie's web UI exactly, so a session moved between the
// clients keeps its tool selection and its Plan or Autonomous mode.
//
// This file is plain JavaScript with a .ts extension: pi transpiles extensions,
// so no build step is involved.

import { Type } from "typebox";

const TOOL_SELECTION_TYPE = "pie:tool-selection";
const WORK_MODE_TYPE = "pie:work-mode";

const ASK_USER_TOOL_NAME = "ask_user";
// Keep this label in sync with internal/ui/ask_user.go: it is the marker the
// TUI uses to open its one-panel question dialog.
const ASK_USER_OTHER_LABEL = "Write my own answer…";
const ASK_USER_MAX_OPTIONS = 6;

const BUILTIN_TOOLS = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];
const CANONICAL_CODING_TOOLS = ["bash", "read", "edit", "write", "grep", "find", "ls"];
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

const PLAN_BLOCKED = new Set([
  "bash",
  "powershell",
  "edit",
  "write",
  "apply_patch",
  "multi_edit",
  "str_replace",
  "create_file",
]);

// Auth marker prefixed to an extension notification. pie parses the JSON body
// and renders its own overlay; every other notify stays a plain toast.
const AUTH_NOTIFY_PREFIX = "pie-auth ";

// One in-flight login per provider, so a second command cannot start a second
// flow against the same credential.
const activeLogins = new Map();

const PLAN_GUIDELINES = [
  "Plan mode is on: this is a read-only conversation. Explore the workspace freely, but do not modify files or run commands that change anything — the write and shell tools are blocked.",
  "Ask before assuming. When the request is ambiguous, a trade-off matters, or a decision changes what you would build, call ask_user with one focused question and 2-3 concrete options.",
  "Ask about intent, priorities, constraints, and choices the repository cannot answer; read the code instead of asking what it contains.",
  "When the direction is settled, summarize briefly: the goal, the steps, the files involved, and the risks. Then wait for the user to leave Plan mode before implementing.",
];

// Copied from Pie's autonomous-mode extension (webui/lib/autonomous-mode-extension.ts).
// Keep the wording in sync with the browser client.
const AUTONOMOUS_GUIDELINES = [
  "Autonomous mode is on: make the reasonable decision yourself instead of waiting for a person. Do not stop to ask a question; state the assumption you chose when it matters.",
  "Work through clear low-risk next steps until the objective is actually complete. A plan, a summary, or a partial implementation is not completion.",
  "Check the result before calling it done. When the session has an active goal, mark that goal complete only after the completion audit; otherwise report what changed and what is left.",
];

function sortToolNames(names) {
  const seen = new Set();
  const unique = [];
  for (const name of names) {
    if (!seen.has(name)) {
      seen.add(name);
      unique.push(name);
    }
  }
  const order = new Map(CANONICAL_CODING_TOOLS.map((name, index) => [name, index]));
  unique.sort((left, right) => {
    const leftIndex = order.get(left);
    const rightIndex = order.get(right);
    if (leftIndex !== undefined || rightIndex !== undefined) {
      return (leftIndex ?? Number.MAX_SAFE_INTEGER) - (rightIndex ?? Number.MAX_SAFE_INTEGER);
    }
    return left.localeCompare(right);
  });
  return unique;
}

function newestCustomEntry(entries, customType) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry && entry.type === "custom" && entry.customType === customType) return entry;
  }
  return undefined;
}

function readToolSelection(entries) {
  const entry = newestCustomEntry(entries, TOOL_SELECTION_TYPE);
  if (!entry || typeof entry.data !== "object" || entry.data === null) return undefined;
  const data = entry.data;
  if (data.version !== 1) return undefined;
  if (data.cleared === true) return undefined;
  if (!Array.isArray(data.tools) || data.tools.some((name) => typeof name !== "string")) {
    return undefined;
  }
  return {
    tools: sortToolNames(data.tools),
    extensionTools: data.extensionTools === "selected" ? "selected" : "all",
  };
}

function readWorkMode(entries) {
  const entry = newestCustomEntry(entries, WORK_MODE_TYPE);
  if (!entry || typeof entry.data !== "object" || entry.data === null) return undefined;
  if (entry.data.version !== 1) return undefined;
  return entry.data.mode === "plan" || entry.data.mode === "autonomous" || entry.data.mode === "orchestrator"
    ? entry.data.mode
    : undefined;
}

function activeExtensionTools(active) {
  const builtin = new Set(BUILTIN_TOOLS);
  return active.filter((name) => !builtin.has(name));
}

function authNotify(ctx, providerId, payload) {
  ctx.ui.notify(AUTH_NOTIFY_PREFIX + JSON.stringify({ provider: providerId, ...payload }), payload.ok === false ? "error" : "info");
}

function cancelledError() {
  return new Error("Login cancelled");
}

// Race a dialog against the prompt's abort signal. A login flow races a manual
// code prompt against its callback server, and the losing prompt must not keep
// the flow waiting.
function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(cancelledError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(cancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function providerAuthMethods(provider) {
  const apiKey = provider?.auth?.apiKey;
  const oauth = provider?.auth?.oauth;
  return {
    apiKey: apiKey ? { name: apiKey.name || "", login: typeof apiKey.login === "function" } : null,
    oauth: oauth
      ? {
          name: oauth.name || "",
          subscription: oauth.isSubscription === true,
          loginLabel: oauth.loginLabel || "",
        }
      : null,
  };
}

// Provider usage follows Pie's provider-usage module: the same endpoints,
// origin checks, and response shapes. The bridge resolves credentials through
// pi's ModelRuntime, so OAuth refreshes and provider-scoped env stay inside pi.
// Keep the keys in sync with tui/internal/providerusage.
const USAGE_ENDPOINTS = {
  "openai-codex": "https://chatgpt.com/backend-api/wham/usage",
  deepseek: "https://api.deepseek.com/user/balance",
  openrouter: "https://openrouter.ai/api/v1/key",
  moonshotai: "https://api.moonshot.ai/v1/users/me/balance",
  "moonshotai-cn": "https://api.moonshot.cn/v1/users/me/balance",
  minimax: "https://api.minimax.io",
  "minimax-cn": "https://api.minimaxi.com",
  "vercel-ai-gateway": "https://ai-gateway.vercel.sh/v1/credits",
  "opencode-go": "https://opencode.ai/zen/go/v1/usage",
  "kimi-coding": "https://api.kimi.com/coding/v1/usages",
};

const USAGE_PROVIDER_NAMES = {
  "openai-codex": "OpenAI Codex",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
  moonshotai: "Moonshot AI",
  "moonshotai-cn": "Moonshot AI CN",
  minimax: "MiniMax",
  "minimax-cn": "MiniMax CN",
  "vercel-ai-gateway": "Vercel AI Gateway",
  "opencode-go": "OpenCode Go",
  "kimi-coding": "Kimi For Coding",
};

const USAGE_CURRENCY = {
  moonshotai: "USD",
  "moonshotai-cn": "CNY",
  minimax: "USD",
  "minimax-cn": "CNY",
};

const USAGE_TIMEOUT_MS = 15_000;
const USAGE_MAX_BODY = 65_536;

function usageIsRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usageRecord(value) {
  return usageIsRecord(value) ? value : undefined;
}

function usageString(value) {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .trim()
    .slice(0, 80);
  return cleaned || undefined;
}

function usageNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function usageNonnegative(value) {
  const result = usageNumber(value);
  return result !== undefined && result >= 0 ? result : undefined;
}

function usageNonnegativeInteger(value) {
  const result = usageNonnegative(value);
  return result !== undefined && Number.isSafeInteger(result) ? result : undefined;
}

function usageDecimal(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) && value.length <= 64) {
    return value;
  }
  return undefined;
}

function usageEpochSeconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value >= 1_000_000_000_000 ? value / 1_000 : value);
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : undefined;
}

function usageClamp(value) {
  return Math.min(100, Math.max(0, value));
}

function usageBearerToken(value) {
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function usageWindowLabel(seconds) {
  if (!seconds || seconds <= 0) return "Limit";
  const minutes = Math.ceil(seconds / 60);
  if (minutes >= 10_080) return "Weekly";
  if (minutes >= 60) return `${Math.round(minutes / 60)}h`;
  return `${minutes}m`;
}

function isOfficialUsageOrigin(providerId, baseUrl) {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).origin === new URL(USAGE_ENDPOINTS[providerId]).origin;
  } catch {
    return false;
  }
}

async function fetchUsageJson(providerId, auth) {
  if (auth.baseUrl && !isOfficialUsageOrigin(providerId, auth.baseUrl)) {
    throw new Error("A custom provider origin cannot be used for official usage queries.");
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(auth.headers ?? {})) {
    if (typeof value === "string") headers.set(name, value);
  }
  if (!headers.has("authorization") && auth.apiKey) {
    headers.set("Authorization", `Bearer ${auth.apiKey}`);
  }

  let endpoint = USAGE_ENDPOINTS[providerId];
  if (providerId === "minimax" || providerId === "minimax-cn") {
    const token = usageBearerToken(headers.get("authorization")) ?? auth.apiKey;
    endpoint += token?.startsWith("sk-api-") ? "/account/query_balance" : "/v1/token_plan/remains";
  }
  const response = await fetch(endpoint, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
  });
  const body = await response.text();
  if (body.length > USAGE_MAX_BODY) throw new Error("Usage response was too large.");
  if (!response.ok) throw new Error(`Usage endpoint returned ${response.status}.`);
  const parsed = JSON.parse(body);
  if (!usageIsRecord(parsed)) throw new Error("Usage response was not an object.");
  return parsed;
}

async function queryProviderUsage(ctx, providerId) {
  if (!USAGE_ENDPOINTS[providerId]) {
    return { providerId, status: "query-failed", message: "Unsupported provider." };
  }
  const provider = ctx.modelRegistry.getProvider(providerId);
  let firstModel;
  try {
    firstModel = provider?.getModels?.()[0];
  } catch {
    firstModel = undefined;
  }
  const baseUrl = provider?.baseUrl ?? firstModel?.baseUrl;
  if (!provider || !isOfficialUsageOrigin(providerId, baseUrl)) {
    return { providerId, status: "query-failed", message: "The provider usage query failed." };
  }
  let resolved;
  try {
    resolved =
      typeof ctx.modelRegistry.getProviderAuth === "function"
        ? await ctx.modelRegistry.getProviderAuth(providerId)
        : await ctx.modelRegistry.runtime?.getAuth?.(providerId);
  } catch {
    return { providerId, status: "auth-unavailable", message: "Provider authentication is unavailable." };
  }
  if (!resolved) {
    return { providerId, status: "auth-unavailable", message: "Connect this provider before querying usage." };
  }
  try {
    const payload = await fetchUsageJson(providerId, resolved.auth);
    return { providerId, status: "ready", report: normalizeUsage(providerId, payload, Date.now()) };
  } catch {
    return { providerId, status: "query-failed", message: "The provider usage query failed." };
  }
}

function normalizeUsage(providerId, payload, capturedAt) {
  switch (providerId) {
    case "openai-codex":
      return normalizeCodexUsage(payload, capturedAt);
    case "deepseek":
      return normalizeDeepSeekUsage(payload, capturedAt);
    case "openrouter":
      return normalizeOpenRouterUsage(payload, capturedAt);
    case "vercel-ai-gateway":
      return normalizeVercelUsage(payload, capturedAt);
    case "moonshotai":
    case "moonshotai-cn":
      return normalizeMoonshotUsage(providerId, payload, capturedAt);
    case "opencode-go":
      return normalizeOpenCodeGoUsage(payload, capturedAt);
    case "kimi-coding":
      return normalizeKimiCodingUsage(payload, capturedAt);
    case "minimax":
    case "minimax-cn":
      return normalizeMiniMaxUsage(providerId, payload, capturedAt);
  }
  throw new Error("Unsupported provider.");
}

function normalizeCodexUsage(payload, capturedAt) {
  const buckets = [];
  const addGroup = (group, groupLabel, groupId) => {
    for (const [position, raw] of [
      ["primary", group.primary_window],
      ["secondary", group.secondary_window],
    ]) {
      const window = usageRecord(raw);
      const used = usageNumber(window?.used_percent);
      if (used === undefined) continue;
      const seconds = usageNumber(window?.limit_window_seconds);
      buckets.push({
        id: `${groupId}:${position}`,
        label: usageWindowLabel(seconds),
        ...(groupId === "codex" ? {} : { groupLabel }),
        used: usageClamp(used),
        remaining: 100 - usageClamp(used),
        limit: 100,
        unit: "percent",
        ...(seconds && seconds > 0 ? { windowMinutes: Math.ceil(seconds / 60) } : {}),
        ...(usageNumber(window?.reset_at) !== undefined
          ? { resetsAt: Math.floor(usageNumber(window?.reset_at)) }
          : {}),
      });
    }
  };
  const rateLimit = usageRecord(payload.rate_limit);
  if (rateLimit) addGroup(rateLimit, "Codex", "codex");
  const additional = Array.isArray(payload.additional_rate_limits) ? payload.additional_rate_limits : [];
  additional.forEach((item, index) => {
    const value = usageRecord(item);
    const rate = usageRecord(value?.rate_limit);
    if (rate) {
      addGroup(
        rate,
        usageString(value?.limit_name) ?? `Limit ${index + 1}`,
        usageString(value?.metered_feature) ?? `additional-${index}`,
      );
    }
  });
  const metrics = [];
  const credits = usageRecord(payload.credits);
  if (credits?.unlimited === true) {
    metrics.push({ id: "credits", label: "Credits", value: "Unlimited" });
  } else if (usageNumber(credits?.balance) !== undefined) {
    metrics.push({ id: "credits", label: "Credits", value: usageNumber(credits?.balance), unit: "count" });
  }
  if (!buckets.length && !metrics.length) throw new Error("Codex returned no usage data.");
  return {
    providerId: "openai-codex",
    providerName: USAGE_PROVIDER_NAMES["openai-codex"],
    capturedAt,
    buckets,
    metrics,
  };
}

function normalizeDeepSeekUsage(payload, capturedAt) {
  const metrics = [
    {
      id: "availability",
      label: "API calls",
      value: payload.is_available === true ? "Available" : "Unavailable",
    },
  ];
  const rows = Array.isArray(payload.balance_infos) ? payload.balance_infos : [];
  for (const row of rows) {
    const value = usageRecord(row);
    const currency =
      value?.currency === "CNY" || value?.currency === "USD" ? value.currency : undefined;
    if (!currency) continue;
    for (const [id, label, field] of [
      ["total", "Total balance", "total_balance"],
      ["granted", "Granted balance", "granted_balance"],
      ["topped-up", "Topped-up balance", "topped_up_balance"],
    ]) {
      const amount = usageDecimal(value?.[field]);
      if (amount !== undefined) {
        metrics.push({
          id: `${currency.toLowerCase()}-${id}`,
          label,
          value: amount,
          unit: "currency",
          currency,
        });
      }
    }
  }
  if (rows.length === 0) throw new Error("DeepSeek returned no balance data.");
  return {
    providerId: "deepseek",
    providerName: USAGE_PROVIDER_NAMES.deepseek,
    capturedAt,
    buckets: [],
    metrics,
  };
}

function normalizeOpenRouterUsage(payload, capturedAt) {
  const data = usageRecord(payload.data);
  if (!data) throw new Error("OpenRouter returned no key data.");
  const buckets = [];
  const limit = usageNonnegative(data.limit);
  const remaining = usageNonnegative(data.limit_remaining);
  if (limit !== undefined) {
    buckets.push({
      id: "key-limit",
      label: "Key limit",
      limit,
      ...(remaining !== undefined ? { remaining, used: Math.max(0, limit - remaining) } : {}),
      unit: "currency",
      currency: "USD",
      ...(usageString(data.limit_reset) ? { period: usageString(data.limit_reset) } : {}),
    });
  }
  const metrics = [];
  for (const [id, label, field] of [
    ["daily", "Usage today", "usage_daily"],
    ["weekly", "Usage this week", "usage_weekly"],
    ["monthly", "Usage this month", "usage_monthly"],
    ["total", "All-time usage", "usage"],
  ]) {
    const amount = usageNonnegative(data[field]);
    if (amount !== undefined) {
      metrics.push({ id, label, value: amount, unit: "currency", currency: "USD" });
    }
  }
  if (!buckets.length && !metrics.length) throw new Error("OpenRouter returned no usage data.");
  return {
    providerId: "openrouter",
    providerName: USAGE_PROVIDER_NAMES.openrouter,
    capturedAt,
    buckets,
    metrics,
  };
}

function normalizeVercelUsage(payload, capturedAt) {
  const balance = usageDecimal(payload.balance);
  const used = usageDecimal(payload.total_used);
  if (balance === undefined && used === undefined) {
    throw new Error("Vercel returned no credit data.");
  }
  const metrics = [];
  if (balance !== undefined) {
    metrics.push({ id: "balance", label: "Credit balance", value: balance, unit: "currency", currency: "USD" });
  }
  if (used !== undefined) {
    metrics.push({ id: "spent", label: "Lifetime spend", value: used, unit: "currency", currency: "USD" });
  }
  return {
    providerId: "vercel-ai-gateway",
    providerName: USAGE_PROVIDER_NAMES["vercel-ai-gateway"],
    capturedAt,
    buckets: [],
    metrics,
  };
}

function normalizeMoonshotUsage(providerId, payload, capturedAt) {
  const data = usageRecord(payload.data);
  if (payload.code !== 0 || payload.status !== true || !data) {
    throw new Error("Moonshot returned an unsuccessful response.");
  }
  const metrics = [
    ["available", "Available balance", data.available_balance],
    ["voucher", "Voucher balance", data.voucher_balance],
    ["cash", "Cash balance", data.cash_balance],
  ].flatMap(([id, label, value]) => {
    const amount = usageNumber(value);
    return amount === undefined
      ? []
      : [
          {
            id: String(id),
            label: String(label),
            value: String(amount),
            unit: "currency",
            currency: USAGE_CURRENCY[providerId],
          },
        ];
  });
  if (!metrics.length) throw new Error("Moonshot returned no balance data.");
  return {
    providerId,
    providerName: USAGE_PROVIDER_NAMES[providerId],
    capturedAt,
    buckets: [],
    metrics,
  };
}

function normalizeMiniMaxUsage(providerId, payload, capturedAt) {
  const base = usageRecord(payload.base_resp);
  if (base && base.status_code !== 0) throw new Error("MiniMax returned an unsuccessful response.");
  if (Array.isArray(payload.model_remains)) {
    const buckets = [];
    for (const [index, rowValue] of payload.model_remains.entries()) {
      const row = usageRecord(rowValue);
      if (!row) continue;
      const groupLabel = usageString(row.model_name) ?? `Quota ${index + 1}`;
      addMiniMaxUsageWindow(
        buckets,
        row,
        groupLabel,
        "interval",
        "current_interval_remaining_percent",
        "current_interval_usage_count",
        "current_interval_total_count",
        "end_time",
        "start_time",
      );
      addMiniMaxUsageWindow(
        buckets,
        row,
        groupLabel,
        "weekly",
        "current_weekly_remaining_percent",
        "current_weekly_usage_count",
        "current_weekly_total_count",
        "weekly_end_time",
        "weekly_start_time",
      );
    }
    if (!buckets.length) throw new Error("MiniMax returned no quota data.");
    return {
      providerId,
      providerName: USAGE_PROVIDER_NAMES[providerId],
      capturedAt,
      buckets,
      metrics: [],
    };
  }
  const metrics = [
    ["available", "Available balance", payload.available_amount],
    ["cash", "Cash balance", payload.cash_balance],
    ["voucher", "Voucher balance", payload.voucher_balance],
    ["credit", "Credit balance", payload.credit_balance],
  ].flatMap(([id, label, value]) => {
    const amount = usageDecimal(value);
    return amount === undefined
      ? []
      : [
          {
            id: String(id),
            label: String(label),
            value: amount,
            unit: "currency",
            currency: USAGE_CURRENCY[providerId],
          },
        ];
  });
  if (!metrics.length) throw new Error("MiniMax returned no balance data.");
  return {
    providerId,
    providerName: USAGE_PROVIDER_NAMES[providerId],
    capturedAt,
    buckets: [],
    metrics,
  };
}

function addMiniMaxUsageWindow(
  buckets,
  row,
  groupLabel,
  suffix,
  percentField,
  countField,
  totalField,
  endField,
  startField,
) {
  const status = usageNumber(
    row[`${suffix === "interval" ? "current_interval" : "current_weekly"}_status`],
  );
  const end = usageNumber(row[endField]);
  const start = usageNumber(row[startField]);
  const percent = usageNonnegative(row[percentField]);
  if (status === 3) {
    buckets.push({
      id: `${groupLabel}:${suffix}`,
      label: suffix === "weekly" ? "Weekly" : "Rolling",
      groupLabel,
      remaining: 100,
      unit: "percent",
      period: "Unlimited",
    });
    return;
  }
  const total = usageNonnegativeInteger(row[totalField]);
  const count = usageNonnegativeInteger(row[countField]);
  if (total === undefined && percent === undefined) return;
  const windowMinutes =
    end !== undefined && start !== undefined ? Math.max(1, Math.round((end - start) / 60_000)) : undefined;
  const resetsAt = end !== undefined ? Math.floor(end / 1_000) : undefined;
  if (total && count !== undefined) {
    let remaining = count;
    if (percent !== undefined) {
      const asRemaining = (count / total) * 100;
      const asUsed = ((total - count) / total) * 100;
      if (Math.abs(asUsed - percent) < Math.abs(asRemaining - percent)) remaining = total - count;
    }
    buckets.push({
      id: `${groupLabel}:${suffix}`,
      label: suffix === "weekly" ? "Weekly" : "Rolling",
      groupLabel,
      used: total - remaining,
      remaining,
      limit: total,
      unit: "count",
      ...(windowMinutes ? { windowMinutes } : {}),
      ...(resetsAt ? { resetsAt } : {}),
    });
    return;
  }
  if (percent === undefined) return;
  buckets.push({
    id: `${groupLabel}:${suffix}`,
    label: suffix === "weekly" ? "Weekly" : "Rolling",
    groupLabel,
    used: 100 - usageClamp(percent),
    remaining: usageClamp(percent),
    limit: 100,
    unit: "percent",
    ...(windowMinutes ? { windowMinutes } : {}),
    ...(resetsAt ? { resetsAt } : {}),
  });
}

function normalizeOpenCodeGoUsage(payload, capturedAt) {
  const usage = usageRecord(payload.usage) ?? payload;
  const labels = { rolling: "Rolling", weekly: "Weekly", monthly: "Monthly" };
  const buckets = [];
  for (const [id, raw] of Object.entries(usage)) {
    const window = usageRecord(raw);
    if (!window) continue;
    const percent = usageNonnegative(window.percent ?? window.usagePercent ?? window.usage_percent);
    if (percent === undefined) continue;
    const resetsAt = usageEpochSeconds(window.resetsAt ?? window.resetAt ?? window.resets_at ?? window.reset_at);
    buckets.push({
      id,
      label: labels[id] ?? id,
      used: usageClamp(percent),
      remaining: 100 - usageClamp(percent),
      limit: 100,
      unit: "percent",
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    });
  }
  if (!buckets.length) throw new Error("OpenCode Go returned no usage data.");
  return {
    providerId: "opencode-go",
    providerName: USAGE_PROVIDER_NAMES["opencode-go"],
    capturedAt,
    buckets,
    metrics: [],
  };
}

const USAGE_KIMI_TIME_UNITS = new Map([
  ["TIME_UNIT_SECOND", 1],
  ["TIME_UNIT_MINUTE", 60],
  ["TIME_UNIT_HOUR", 3_600],
  ["TIME_UNIT_DAY", 86_400],
]);

function normalizeKimiCodingUsage(payload, capturedAt) {
  const buckets = [];
  const addBucket = (id, label, detail, seconds) => {
    const limit = usageNonnegativeInteger(detail?.limit);
    const used = usageNonnegativeInteger(detail?.used);
    const remaining =
      usageNonnegativeInteger(detail?.remaining) ??
      (limit !== undefined && used !== undefined ? Math.max(0, limit - used) : undefined);
    if (limit === undefined || remaining === undefined) return;
    const resetsAt = usageEpochSeconds(detail?.resetTime);
    buckets.push({
      id,
      label,
      used: used ?? Math.max(0, limit - remaining),
      remaining,
      limit,
      unit: "count",
      ...(seconds ? { windowMinutes: Math.ceil(seconds / 60) } : {}),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    });
  };
  addBucket("usage", "Overall", usageRecord(payload.usage));
  const limits = Array.isArray(payload.limits) ? payload.limits : [];
  limits.forEach((item, index) => {
    const value = usageRecord(item);
    const window = usageRecord(value?.window);
    const duration = usageNonnegative(window?.duration);
    const unitSeconds = USAGE_KIMI_TIME_UNITS.get(usageString(window?.timeUnit) ?? "");
    const seconds = duration !== undefined && unitSeconds ? duration * unitSeconds : undefined;
    addBucket(`limit-${index}`, usageWindowLabel(seconds), usageRecord(value?.detail), seconds);
  });
  if (!buckets.length) throw new Error("Kimi returned no usage data.");
  const metrics = [];
  const parallel = usageNonnegativeInteger(usageRecord(payload.parallel)?.limit);
  if (parallel !== undefined) {
    metrics.push({ id: "parallel", label: "Parallel requests", value: parallel, unit: "count" });
  }
  const level = usageString(usageRecord(usageRecord(payload.user)?.membership)?.level);
  if (level) {
    metrics.push({ id: "membership", label: "Membership", value: level.replace(/^LEVEL_/u, "") });
  }
  return {
    providerId: "kimi-coding",
    providerName: USAGE_PROVIDER_NAMES["kimi-coding"],
    capturedAt,
    buckets,
    metrics,
  };
}

function authStatusSnapshot(status) {
  if (!status) return null;
  return {
    configured: status.configured === true,
    source: status.source || "",
    label: status.label || "",
  };
}

function providerIds(ctx) {
  const ids = new Set();
  try {
    for (const model of ctx.modelRegistry.getAll()) {
      if (model && model.provider) ids.add(model.provider);
    }
  } catch {
    // A broken catalog must not empty the provider list.
  }
  try {
    for (const id of ctx.modelRegistry.getRegisteredProviderIds()) ids.add(id);
  } catch {
    // Older registries had no extension provider listing.
  }
  // The runtime's own set also covers providers that currently expose no chat
  // model; it is an internal field, so keep it optional.
  try {
    const runtimeIds = ctx.modelRegistry.runtime?.providerIds?.();
    if (runtimeIds) for (const id of runtimeIds) ids.add(id);
  } catch {
    // Optional path.
  }
  return [...ids].filter((id) => typeof id === "string" && id !== "").sort();
}

function loginInteraction(ctx, providerId, flowSignal) {
  return {
    signal: flowSignal,
    prompt: async (prompt) => {
      // pi resolves a dialog with undefined when its signal aborts, which is how
      // a prompt that lost a race is cleaned up instead of dangling.
      const signal = prompt.signal ?? flowSignal;
      const opts = signal ? { signal } : undefined;
      if (prompt.type === "select") {
        const labels = prompt.options.map((option) =>
          option.description ? option.label + " — " + option.description : option.label,
        );
        const picked = await raceAbort(ctx.ui.select(prompt.message, labels, opts), signal);
        if (picked === undefined) throw cancelledError();
        const index = labels.indexOf(picked);
        const option = prompt.options[index] || prompt.options.find((entry) => entry.label === picked);
        return option ? option.id : picked;
      }
      const value = await raceAbort(ctx.ui.input(prompt.message, prompt.placeholder, opts), signal);
      if (value === undefined) throw cancelledError();
      return prompt.type === "manual_code" ? value.trim() : value;
    },
    notify: (event) => {
      if (event.type === "auth_url") {
        authNotify(ctx, providerId, {
          kind: "url",
          url: event.url,
          instructions: event.instructions || "",
        });
      } else if (event.type === "device_code") {
        authNotify(ctx, providerId, {
          kind: "device",
          code: event.userCode,
          url: event.verificationUri,
          expiresIn: event.expiresInSeconds || 0,
        });
      } else if (event.type === "info") {
        authNotify(ctx, providerId, {
          kind: "info",
          message: event.message || "",
          links: Array.isArray(event.links) ? event.links : [],
        });
      } else {
        authNotify(ctx, providerId, { kind: "progress", message: event.message || "" });
      }
    },
  };
}

// Login options carry the installation ID providers use as a stable client
// identity. The setting is shared with pi itself, so read and write the same
// file through the SDK rather than inventing a second ID.
async function loginOptions() {
  try {
    const { SettingsManager, getAgentDir } = await import("@earendil-works/pi-coding-agent");
    const agentDir = getAgentDir();
    const settings = SettingsManager.create(agentDir, agentDir, { projectTrusted: false });
    return { getDeviceId: () => settings.getOrCreateDeviceId() };
  } catch {
    return {};
  }
}

// The host runtime owns the session's credential state, so a login through it
// needs no follow-up reload. It is an internal field; when it is missing, a
// second runtime that shares auth.json performs the same flow and the host is
// refreshed afterwards.
async function performLogin(ctx, provider, type, interaction, options) {
  const hostRuntime = ctx.modelRegistry.runtime;
  if (hostRuntime && typeof hostRuntime.login === "function") {
    return await hostRuntime.login(provider.id, type, interaction, options);
  }
  const { ModelRuntime, getAgentDir } = await import("@earendil-works/pi-coding-agent");
  const path = await import("node:path");
  const runtime = await ModelRuntime.create({
    authPath: path.join(getAgentDir(), "auth.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  if (!runtime.getProvider(provider.id)) runtime.registerNativeProvider(provider);
  return await runtime.login(provider.id, type, interaction, options);
}

async function refreshProvider(ctx, providerId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    await ctx.modelRegistry.refresh({ providers: [providerId], allowNetwork: true, signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function authMethod(provider, type) {
  const methods = providerAuthMethods(provider);
  return type === "oauth" ? methods.oauth : methods.apiKey;
}

async function startLogin(ctx, providerId, requestedType) {
  const provider = ctx.modelRegistry.getProvider(providerId);
  if (!provider) {
    authNotify(ctx, providerId, { kind: "done", ok: false, message: "unknown provider: " + providerId });
    return;
  }
  const controller = new AbortController();
  activeLogins.set(providerId, { controller });
  const name = provider.name || providerId;
  try {
    const methods = providerAuthMethods(provider);
    const oauthLabel = methods.oauth ? methods.oauth.loginLabel || methods.oauth.name || "Sign in with an account" : "";
    const apiKeyLabel = methods.apiKey ? methods.apiKey.name || "Sign in with an API key" : "";

    let type = requestedType;
    if (type !== "oauth" && type !== "api_key") {
      if (!methods.oauth) type = "api_key";
      else if (!methods.apiKey) type = "oauth";
      else {
        const picked = await ctx.ui.select("Sign in to " + name, [oauthLabel, apiKeyLabel], {
          signal: controller.signal,
        });
        if (picked === undefined) {
          authNotify(ctx, providerId, { kind: "done", ok: false, cancelled: true, message: "sign-in cancelled" });
          return;
        }
        type = picked === apiKeyLabel ? "api_key" : "oauth";
      }
    }

    const method = authMethod(provider, type);
    const usable = type === "oauth" ? Boolean(method) : Boolean(method && method.login);
    if (!usable) {
      const reason = type === "oauth" ? "does not support OAuth sign-in" : "does not support API key sign-in";
      authNotify(ctx, providerId, { kind: "done", ok: false, message: name + " " + reason });
      return;
    }

    ctx.ui.setStatus("pie-auth", "Signing in to " + name + "…");
    const options = await loginOptions();
    const interaction = loginInteraction(ctx, providerId, controller.signal);
    const credential = await performLogin(ctx, provider, type, interaction, options);
    const refreshed = await refreshProvider(ctx, providerId);
    authNotify(ctx, providerId, {
      kind: "done",
      ok: true,
      authType: type,
      credentialType: credential && credential.type ? credential.type : type,
      refreshed,
      message: type === "oauth" ? "signed in" : "API key saved",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cancelled = /cancel/i.test(message) || controller.signal.aborted;
    authNotify(ctx, providerId, {
      kind: "done",
      ok: false,
      cancelled,
      message: cancelled ? "sign-in cancelled" : message,
    });
  } finally {
    activeLogins.delete(providerId);
    ctx.ui.setStatus("pie-auth", undefined);
  }
}

async function performLogout(ctx, providerId) {
  const hostRuntime = ctx.modelRegistry.runtime;
  if (hostRuntime && typeof hostRuntime.logout === "function") {
    await hostRuntime.logout(providerId);
    return;
  }
  const { ModelRuntime, getAgentDir } = await import("@earendil-works/pi-coding-agent");
  const path = await import("node:path");
  const runtime = await ModelRuntime.create({
    authPath: path.join(getAgentDir(), "auth.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  await runtime.logout(providerId);
}

function applyToolSelection(pi, selection) {
  const named = selection.tools.filter((name) => TOOL_NAME.test(name));
  if (selection.extensionTools === "selected") {
    pi.setActiveTools(sortToolNames(named));
    return;
  }
  const extras = activeExtensionTools(pi.getActiveTools());
  pi.setActiveTools(sortToolNames([...named, ...extras]));
}

function askUserDetails(question, options, answer, answerSource) {
  return { question, options, answer, answerSource };
}

function askUserText(text, value) {
  return { content: [{ type: "text", text }], details: value };
}

function askUserAnswered(question, options, answer, answerSource) {
  const prefix = answerSource === "typed" ? "The user wrote" : "The user selected";
  return askUserText(`${prefix}: ${answer}`, askUserDetails(question, options, answer, answerSource));
}

function askUserCancelled(question, options) {
  return askUserText(
    "The user dismissed the question without answering. Do not ask it again: continue with a stated assumption, or wait for the user to say how to proceed.",
    askUserDetails(question, options, null, null),
  );
}

function normalizeAskUserOptions(options) {
  const seen = new Set();
  const result = [];
  for (const option of options ?? []) {
    if (typeof option !== "string") continue;
    const label = option.trim();
    // The sentinel belongs to the answer field, so the model cannot also use
    // it as a selectable option.
    if (!label || label === ASK_USER_OTHER_LABEL || seen.has(label) || result.length >= ASK_USER_MAX_OPTIONS) {
      continue;
    }
    seen.add(label);
    result.push(label);
  }
  return result;
}

export default function (pi) {
  pi.registerTool({
    name: ASK_USER_TOOL_NAME,
    label: "Ask user",
    description:
      "Ask the user a question and wait for the answer. Use it when their intent, priorities, constraints, or a trade-off is unclear and guessing would change the result.",
    promptSnippet: "Ask the user a focused question",
    // A script must not answer for the user, and a question is not an approval.
    exposure: "model-only",
    // One question at a time: parallel questions would compete for attention.
    executionMode: "sequential",
    promptGuidelines: [
      "Ask one focused question at a time. Offer 2–3 concrete options when the choice is enumerable, and let the user write their own answer.",
      "Prefer reading the workspace over asking what it contains; ask about intent, priorities, and choices the repository cannot answer.",
      "If the user dismisses the question, do not ask it again: continue with a stated assumption, or wait for their direction.",
    ],
    parameters: Type.Object({
      question: Type.String({
        description: "The question to show the user, in their language.",
      }),
      options: Type.Optional(
        Type.Array(Type.String(), {
          description: `Selectable answers, in the user's language. Omit for an open question. At most ${ASK_USER_MAX_OPTIONS}.`,
          maxItems: ASK_USER_MAX_OPTIONS,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const question = String(params?.question ?? "").trim();
      const options = normalizeAskUserOptions(params?.options);
      if (!question) {
        return askUserText(
          "ask_user needs a non-empty question.",
          askUserDetails("", options, null, null),
        );
      }
      if (!ctx.hasUI) {
        return askUserText(
          "This session has no interactive UI, so the question cannot be shown. Continue without asking.",
          askUserDetails(question, options, null, null),
        );
      }

      // The sentinel is the presentation marker. pie's TUI strips it and shows
      // one panel with the options and an answer field; other hosts keep the
      // normal select -> input fallback. An open question sends only the
      // sentinel, which the TUI renders as a text-only question panel.
      const choice = await ctx.ui.select(question, [...options, ASK_USER_OTHER_LABEL], { signal });
      if (choice === undefined) return askUserCancelled(question, options);
      if (choice === ASK_USER_OTHER_LABEL) {
        const typed = await ctx.ui.input(question, "", { signal });
        const answer = typed?.trim();
        return answer
          ? askUserAnswered(question, options, answer, "typed")
          : askUserCancelled(question, options);
      }
      const answer = String(choice).trim();
      if (!answer) return askUserCancelled(question, options);
      return askUserAnswered(question, options, answer, options.includes(answer) ? "option" : "typed");
    },
  });

  // Restore a pinned tool set when a session is resumed, the way pie's server
  // rebuilds the session from its own entries.
  pi.on("session_start", async (_event, ctx) => {
    const selection = readToolSelection(ctx.sessionManager.getEntries());
    if (selection) applyToolSelection(pi, selection);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const mode = readWorkMode(ctx.sessionManager.getEntries());
    if (mode !== "plan" && mode !== "autonomous") return;
    const options = event.systemPromptOptions;
    if (!options) return;
    if (Array.isArray(options.promptGuidelines)) {
      options.promptGuidelines.push(...(mode === "plan" ? PLAN_GUIDELINES : AUTONOMOUS_GUIDELINES));
    }
    if (mode === "autonomous" && Array.isArray(options.selectedTools)) {
      // Pie starts an autonomous session without the question extension. The
      // bridge registers ask_user once for every session, so leave it out of
      // this run's declared tools instead of reloading pi; the tool_call guard
      // below still refuses a nested or stale call. The live active set is
      // untouched, so leaving the mode restores the tool.
      options.selectedTools = options.selectedTools.filter((name) => name !== ASK_USER_TOOL_NAME);
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    const mode = readWorkMode(ctx.sessionManager.getEntries());
    if (mode === "autonomous" && event.toolName === ASK_USER_TOOL_NAME) {
      return {
        block: true,
        reason:
          'Autonomous mode does not ask the user, so "' +
          event.toolName +
          '" is blocked. Decide from the workspace and state your assumption in the result.',
      };
    }
    if (mode !== "plan" || !PLAN_BLOCKED.has(event.toolName)) return;
    return {
      block: true,
      reason:
        'Plan mode is read-only, so "' +
        event.toolName +
        '" is blocked. Read the workspace and ask the user with ask_user instead; they leave Plan mode when they want changes made.',
    };
  });

  pi.registerCommand("pie-tools", {
    description: "Apply a tool selection (pie internal)",
    handler: async (args, ctx) => {
      const text = String(args || "").trim();
      if (text === "" || text === "configured") {
        pi.appendEntry(TOOL_SELECTION_TYPE, { version: 1, cleared: true });
        await ctx.reload();
        return;
      }
      const tokens = text.split(/\s+/);
      let policy = "all";
      if (tokens[0] === "all" || tokens[0] === "selected") {
        policy = tokens.shift();
      }
      const names = tokens.join(" ").split(",").map((name) => name.trim()).filter(Boolean);
      if (names.some((name) => !TOOL_NAME.test(name))) {
        ctx.ui.notify("pie-tools: invalid tool list", "error");
        return;
      }
      const tools = sortToolNames(names);
      applyToolSelection(pi, { tools, extensionTools: policy });
      pi.appendEntry(TOOL_SELECTION_TYPE, { version: 1, tools, extensionTools: policy });
    },
  });

  pi.registerCommand("pie-mode", {
    description: "Set the work mode (pie internal)",
    handler: async (args) => {
      const text = String(args || "").trim();
      const mode = text === "plan" || text === "autonomous" || text === "orchestrator" ? text : null;
      pi.appendEntry(WORK_MODE_TYPE, { version: 1, mode });
    },
  });

  pi.registerCommand("pie-reload", {
    description: "Reload pi resources (pie internal)",
    handler: async (_args, ctx) => {
      await ctx.reload();
    },
  });

  pi.registerCommand("pie-providers", {
    description: "Write the provider and auth snapshot (pie internal)",
    handler: async (args, ctx) => {
      const path = String(args || "").trim();
      if (!path || path.includes("\n")) {
        ctx.ui.notify("pie-providers: expected a file path", "error");
        return;
      }
      const fs = await import("node:fs");
      const counts = new Map();
      try {
        for (const model of ctx.modelRegistry.getAll()) {
          counts.set(model.provider, (counts.get(model.provider) || 0) + 1);
        }
      } catch {
        // Keep the provider list even when the catalog cannot be read.
      }
      const providers = [];
      for (const id of providerIds(ctx)) {
        const provider = ctx.modelRegistry.getProvider(id);
        if (!provider) continue;
        const methods = providerAuthMethods(provider);
        let status = null;
        try {
          status = authStatusSnapshot(ctx.modelRegistry.getProviderAuthStatus(id));
        } catch {
          status = null;
        }
        providers.push({
          id,
          name: provider.name || id,
          apiKey: methods.apiKey,
          oauth: methods.oauth,
          status,
          modelCount: counts.get(id) || 0,
        });
      }
      fs.writeFileSync(path, JSON.stringify({ version: 1, providers }, null, 2), { mode: 0o600 });
    },
  });

  pi.registerCommand("pie-usage", {
    description: "Query a provider's subscription usage (pie internal)",
    handler: async (args, ctx) => {
      const text = String(args || "").trim();
      const split = text.indexOf(" ");
      const providerId = split < 0 ? text : text.slice(0, split);
      const path = split < 0 ? "" : text.slice(split + 1).trim();
      if (!providerId || !path || path.includes("\n") || !USAGE_ENDPOINTS[providerId]) {
        ctx.ui.notify("pie-usage: expected a supported provider and a file path", "error");
        return;
      }
      const result = await queryProviderUsage(ctx, providerId);
      const fs = await import("node:fs");
      fs.writeFileSync(path, JSON.stringify(result, null, 2), { mode: 0o600 });
    },
  });

  pi.registerCommand("pie-login", {
    description: "Sign in to a provider (pie internal)",
    handler: async (args, ctx) => {
      const [providerId, requestedType] = String(args || "").trim().split(/\s+/);
      if (!providerId) {
        ctx.ui.notify("pie-login: expected a provider id", "error");
        return;
      }
      if (activeLogins.has(providerId)) {
        authNotify(ctx, providerId, {
          kind: "progress",
          message: "a sign-in for this provider is already running",
        });
        return;
      }
      // The login takes minutes and pi waits for a command handler before it
      // answers the prompt, so the flow runs detached and reports through the
      // extension UI instead of holding the RPC response open.
      void startLogin(ctx, providerId, requestedType).catch((error) => {
        activeLogins.delete(providerId);
        authNotify(ctx, providerId, {
          kind: "done",
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    },
  });

  pi.registerCommand("pie-auth-cancel", {
    description: "Cancel a provider sign-in (pie internal)",
    handler: async (args, ctx) => {
      const providerId = String(args || "").trim();
      const entry = activeLogins.get(providerId);
      if (!entry) return;
      entry.controller.abort(cancelledError());
      authNotify(ctx, providerId, { kind: "progress", message: "cancelling sign-in…" });
    },
  });

  pi.registerCommand("pie-logout", {
    description: "Sign out of a provider (pie internal)",
    handler: async (args, ctx) => {
      const providerId = String(args || "").trim();
      if (!providerId) {
        ctx.ui.notify("pie-logout: expected a provider id", "error");
        return;
      }
      const provider = ctx.modelRegistry.getProvider(providerId);
      const name = provider?.name || providerId;
      if (activeLogins.has(providerId)) {
        authNotify(ctx, providerId, { kind: "done", ok: false, message: "finish the sign-in before signing out" });
        return;
      }
      try {
        await performLogout(ctx, providerId);
        const refreshed = await refreshProvider(ctx, providerId);
        authNotify(ctx, providerId, {
          kind: "done",
          ok: true,
          signedOut: true,
          refreshed,
          message: "signed out of " + name,
        });
      } catch (error) {
        authNotify(ctx, providerId, {
          kind: "done",
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });

  pi.registerCommand("pie-publish", {
    description: "Write a tool and prompt snapshot (pie internal)",
    handler: async (args, ctx) => {
      const path = String(args || "").trim();
      if (!path || path.includes("\n")) {
        ctx.ui.notify("pie-publish: expected a file path", "error");
        return;
      }
      const fs = await import("node:fs");
      const workMode = readWorkMode(ctx.sessionManager.getEntries()) ?? null;
      const active = new Set(pi.getActiveTools());
      // Autonomous runs do not declare ask_user (see before_agent_start), so the
      // snapshot reports what the model can actually call.
      if (workMode === "autonomous") active.delete(ASK_USER_TOOL_NAME);
      const snapshot = {
        version: 1,
        activeTools: [...active],
        tools: pi.getAllTools().map((tool) => ({ ...tool, active: active.has(tool.name) })),
        systemPrompt: ctx.getSystemPrompt(),
        workMode,
        toolSelection: readToolSelection(ctx.sessionManager.getEntries()) ?? null,
      };
      fs.writeFileSync(path, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    },
  });
}
