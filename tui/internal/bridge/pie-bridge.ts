// pie bridge extension.
//
// pie loads this file with `pi -e`. It supplies the runtime commands the
// RPC protocol does not expose: hot tool switching, work-mode entries, reload,
// a tool/system-prompt snapshot for the settings UI, and provider sign-in.
// The entry shapes match Pie's web UI exactly, so a session moved between the
// clients keeps its tool selection and its Plan mode.
//
// This file is plain JavaScript with a .ts extension: pi transpiles extensions,
// so no build step is involved.

const TOOL_SELECTION_TYPE = "pie:tool-selection";
const WORK_MODE_TYPE = "pie:work-mode";

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

export default function (pi) {
  // Restore a pinned tool set when a session is resumed, the way pie's server
  // rebuilds the session from its own entries.
  pi.on("session_start", async (_event, ctx) => {
    const selection = readToolSelection(ctx.sessionManager.getEntries());
    if (selection) applyToolSelection(pi, selection);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (readWorkMode(ctx.sessionManager.getEntries()) !== "plan") return;
    if (!event.systemPromptOptions || !Array.isArray(event.systemPromptOptions.promptGuidelines)) return;
    event.systemPromptOptions.promptGuidelines.push(...PLAN_GUIDELINES);
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!PLAN_BLOCKED.has(event.toolName)) return;
    if (readWorkMode(ctx.sessionManager.getEntries()) !== "plan") return;
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
      const activeTools = pi.getActiveTools();
      const active = new Set(activeTools);
      const snapshot = {
        version: 1,
        activeTools,
        tools: pi.getAllTools().map((tool) => ({ ...tool, active: active.has(tool.name) })),
        systemPrompt: ctx.getSystemPrompt(),
        workMode: readWorkMode(ctx.sessionManager.getEntries()) ?? null,
        toolSelection: readToolSelection(ctx.sessionManager.getEntries()) ?? null,
      };
      fs.writeFileSync(path, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    },
  });
}
