// pie bridge extension.
//
// pie loads this file with `pi -e`. It supplies the runtime commands the
// RPC protocol does not expose: hot tool switching, work-mode entries, reload,
// and a tool/system-prompt snapshot for the settings UI. The entry shapes match
// Pie's web UI exactly, so a session moved between the clients keeps its tool
// selection and its Plan mode.
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
