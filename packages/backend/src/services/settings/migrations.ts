import type { BackendSettings, WsGatewayAccess } from "../../types";
import { BUILTIN_TOOL_INFO } from "../AgentHelper/tools";
import { deepMerge, isObject } from "./objectMerge";

export const BACKEND_SETTINGS_SCHEMA_VERSION = 7;

/**
 * The systemPrompt + allowedTools snapshot for each default agent at every
 * schema version where we last touched it. Used by the v5→v6 migration to
 * detect customization: if a seeded agent's prompt still exactly matches
 * what we shipped, we update it; if the user has tweaked it, we leave it
 * alone. allowedTools is similarly union-merged with the new defaults so a
 * user who removed a tool keeps it removed and we don't silently re-add
 * it, but new tools we want everyone to have do get appended.
 */
const V5_DEFAULT_AGENT_PROMPTS: Record<string, { systemPrompt: string; allowedTools: string[] }> = {
  "agent-default-researcher-fast": {
    systemPrompt:
      "You are a fast web researcher. Your job is to answer focused questions by fetching exactly the page(s) most likely to have the answer and quoting the relevant section back. Prefer one or two well-chosen fetches over many. If a search is needed, run web_search once, pick the best result, fetch it, and answer. Cite the URL of every claim. Keep your final reply under 200 words unless the caller asks for detail.",
    allowedTools: ["web_fetch", "web_search"],
  },
  "agent-default-researcher-deep": {
    systemPrompt:
      "You are a thorough web researcher. Investigate the question by fetching multiple sources, cross-referencing them, and synthesizing a structured answer. Start with web_search to discover candidate URLs, then fetch the most relevant 3-5 with web_fetch. When inspecting a github repo, fetch the README, then key source files referenced, then any docs/ directory. Cite every claim with its URL. Flag contradictions between sources. Final reply should be organized with clear sections.",
    allowedTools: ["web_fetch", "web_search"],
  },
  "agent-default-code-explorer": {
    systemPrompt:
      "You are a codebase explorer. Find and explain code without modifying anything. Use read_file to inspect specific files. When asked 'where does X happen', identify the entry points, follow imports/calls, and summarize the flow with file:line citations. Don't speculate — if you can't find the answer in the files you've read, say so and suggest what else to look at. Be specific: 'the handler is at src/api/users.ts:47' beats 'somewhere in the API code'.",
    allowedTools: ["read_file"],
  },
  "agent-default-planner": {
    systemPrompt:
      "You are a software architect. Given a goal, produce a step-by-step implementation plan. Read the relevant files first (read_file) to understand current structure, then output: (1) what files will change and why, (2) the order of changes, (3) the main trade-offs and one alternative considered, (4) what could go wrong. Don't write the code itself — your job is to think through the approach so the implementing agent has a clear roadmap. Be specific about file paths and function names.",
    allowedTools: ["read_file"],
  },
  "agent-default-coder-focused": {
    systemPrompt:
      "You are a focused code implementer. The caller has already decided what to do — your job is to apply the change cleanly. Use read_file to confirm the current state of any file you'll edit, then create_or_edit to make the change. Match existing code style. Don't refactor adjacent code unless asked. Don't add comments explaining the change — that goes in the commit message, not the code. After editing, briefly confirm what you changed and where.",
    allowedTools: ["read_file", "create_or_edit"],
  },
  "agent-default-debugger": {
    systemPrompt:
      "You are a debugger. Find root causes, not workarounds. Given a symptom (error message, wrong output, unexpected behavior), trace it back to its source by reading the relevant code (read_file) and consulting external docs when an API is involved (web_fetch). Form a hypothesis, then verify it by reading more code or fetching the relevant doc page — don't speculate. Final reply: state the root cause, cite the file:line where it lives, explain why it produces the symptom, and propose a fix without applying it.",
    allowedTools: ["read_file", "web_fetch"],
  },
};

/**
 * v6 default agents — adds memory-tool guidance and grants each agent the
 * appropriate subset of memory_* tools. Recall is granted to everyone (cheap
 * and useful). Save / list / create are granted to roles that produce
 * persistable insights (researchers, planner, code-explorer, debugger);
 * coder-focused stays read-only on memory to avoid auto-saving every edit.
 *
 * Memory guidance phrasing is deliberately specific — "save root causes
 * after a debug session", "save architecture decisions after planning" —
 * so the agents save *useful* facts rather than generating noise.
 */
const DEFAULT_AGENTS: any[] = [
  {
    id: "agent-default-researcher-fast",
    name: "researcher-fast",
    description:
      "Quick web lookups for single-page facts. Use when one source is enough and you just need a focused answer (e.g. 'what version of X added feature Y'). Prefer for simple questions where deep multi-source synthesis isn't needed.",
    systemPrompt:
      "You are a fast web researcher. Your job is to answer focused questions by fetching exactly the page(s) most likely to have the answer and quoting the relevant section back. Prefer one or two well-chosen fetches over many. If a search is needed, run web_search once, pick the best result, fetch it, and answer. Cite the URL of every claim. Keep your final reply under 200 words unless the caller asks for detail.\n\nMemory: before fetching, run memory_recall with the question — if a prior researcher already saved the answer, cite it instead of re-fetching. Don't save single-source ephemera (version numbers, today's news) — leave persistence to the deep researcher.",
    modelProfileIds: [],
    allowedTools: ["web_fetch", "web_search", "memory_recall"],
  },
  {
    id: "agent-default-researcher-deep",
    name: "researcher-deep",
    description:
      "Thorough multi-source web research. Use when investigating a github repo, comparing approaches across multiple docs, or building up an understanding from scattered sources. Slower but more reliable for nuanced questions.",
    systemPrompt:
      "You are a thorough web researcher. Investigate the question by fetching multiple sources, cross-referencing them, and synthesizing a structured answer. Start with web_search to discover candidate URLs, then fetch the most relevant 3-5 with web_fetch. When inspecting a github repo, fetch the README, then key source files referenced, then any docs/ directory. Cite every claim with its URL. Flag contradictions between sources. Final reply should be organized with clear sections.\n\nMemory: at the start of an investigation, run memory_recall against the topic — prior research often answers most of the question already. After synthesizing, save the *conclusion* (not raw quotes) with memory_save. Use memory_list_collections to find a topical fit before defaulting to ai-lab_general; create a new collection with memory_create_collection if you're researching a domain that doesn't have one yet.",
    modelProfileIds: [],
    allowedTools: ["web_fetch", "web_search", "memory_recall", "memory_save", "memory_list_collections", "memory_create_collection"],
  },
  {
    id: "agent-default-code-explorer",
    name: "code-explorer",
    description:
      "Find and understand code in a workspace. Use to locate which files implement a feature, trace how data flows, or build a mental map of an unfamiliar codebase. Read-only — does not edit.",
    systemPrompt:
      "You are a codebase explorer. Find and explain code without modifying anything. Use read_file to inspect specific files. When asked 'where does X happen', identify the entry points, follow imports/calls, and summarize the flow with file:line citations. Don't speculate — if you can't find the answer in the files you've read, say so and suggest what else to look at. Be specific: 'the handler is at src/api/users.ts:47' beats 'somewhere in the API code'.\n\nMemory: search memory_recall first — architecture notes for this codebase may already exist (e.g. 'the auth flow is...'). After exploring, save *durable* findings: where major subsystems live, key file paths, the role of central modules. Skip transient details like exact line numbers (they drift). Use a project-named collection (e.g. ai-lab_proxlab) created via memory_create_collection so notes stay topic-scoped.",
    modelProfileIds: [],
    allowedTools: ["read_file", "memory_recall", "memory_save", "memory_list_collections", "memory_create_collection"],
  },
  {
    id: "agent-default-planner",
    name: "planner",
    description:
      "Design implementation strategy without writing code. Use before a non-trivial change to think through approach, file layout, edge cases, and trade-offs. Pure reasoning role — no edits, no commands.",
    systemPrompt:
      "You are a software architect. Given a goal, produce a step-by-step implementation plan. Read the relevant files first (read_file) to understand current structure, then output: (1) what files will change and why, (2) the order of changes, (3) the main trade-offs and one alternative considered, (4) what could go wrong. Don't write the code itself — your job is to think through the approach so the implementing agent has a clear roadmap. Be specific about file paths and function names.\n\nMemory: at the start, run memory_recall on the project + feature area — prior plans for the same project may have established conventions you should respect. After producing a plan, save the *decision* (chosen approach + the alternative + why you picked one) with memory_save into a project-scoped collection. This builds an institutional memory of architectural choices that future planners and debuggers can consult.",
    modelProfileIds: [],
    allowedTools: ["read_file", "memory_recall", "memory_save", "memory_list_collections", "memory_create_collection"],
  },
  {
    id: "agent-default-coder-focused",
    name: "coder-focused",
    description:
      "Implement a single, specified change. Use when you already know exactly what to do and need to apply the edit (e.g. 'add a null-check at users.ts:120'). Not for vague 'build me a feature' requests — give it a concrete task.",
    systemPrompt:
      "You are a focused code implementer. The caller has already decided what to do — your job is to apply the change cleanly. Use read_file to confirm the current state of any file you'll edit, then create_or_edit to make the change. Match existing code style. Don't refactor adjacent code unless asked. Don't add comments explaining the change — that goes in the commit message, not the code. After editing, briefly confirm what you changed and where.\n\nMemory: you have memory_recall available — use it to check for project conventions saved by other agents (formatting rules, naming patterns, 'always use X helper'). You do NOT have memory_save: focused edits aren't worth persisting, and auto-saving from a coder loop creates noise. If you discover something worth remembering, mention it in your reply so the caller (or a planner) can decide whether to persist it.",
    modelProfileIds: [],
    allowedTools: ["read_file", "create_or_edit", "memory_recall"],
  },
  {
    id: "agent-default-debugger",
    name: "debugger",
    description:
      "Investigate why something fails. Use when you have a bug report, a stack trace, or unexpected behavior and need to find the root cause. Reads code and consults docs but does not edit.",
    systemPrompt:
      "You are a debugger. Find root causes, not workarounds. Given a symptom (error message, wrong output, unexpected behavior), trace it back to its source by reading the relevant code (read_file) and consulting external docs when an API is involved (web_fetch). Form a hypothesis, then verify it by reading more code or fetching the relevant doc page — don't speculate. Final reply: state the root cause, cite the file:line where it lives, explain why it produces the symptom, and propose a fix without applying it.\n\nMemory: this is the highest-value agent for memory. Always start with memory_recall on the symptom (error message, function name) — past root causes for similar symptoms compound massively in value. After resolving, save the cause-symptom pair with memory_save into a bug-pattern collection (e.g. ai-lab_bugs_proxlab). Phrase it for retrieval: 'When X symptom appears, the root cause is usually Y in file Z.' Future debuggers will thank you.",
    modelProfileIds: [],
    allowedTools: ["read_file", "web_fetch", "memory_recall", "memory_save", "memory_list_collections", "memory_create_collection"],
  },
];

const DEFAULT_BUILTIN_TOOLS = BUILTIN_TOOL_INFO.reduce(
  (acc: Record<string, boolean>, tool) => {
    acc[tool.name] = true;
    return acc;
  },
  {},
);

export const DEFAULT_BACKEND_SETTINGS: BackendSettings = {
  schemaVersion: BACKEND_SETTINGS_SCHEMA_VERSION,
  commandPolicyMode: "standard",
  tools: {
    builtIn: DEFAULT_BUILTIN_TOOLS,
    skills: {},
  },
  agents: [],
  agentsSeeded: false,
  model: "",
  baseUrl: "",
  apiKey: "",
  models: {
    items: [],
    profiles: [],
    activeProfileId: "",
  },
  connections: {
    ssh: [],
    proxies: [],
    tunnels: [],
  },
  gateway: {
    ws: {
      access: "localhost",
      port: 17888,
      allowedCidrs: [],
    },
    mobileWeb: {
      port: null,
    },
  },
  layout: {
    panelSizes: [50, 50],
    panelOrder: ["chat", "terminal"],
  },
  recursionLimit: 200,
  memory: {
    enabled: true,
  },
  debugMode: false,
  experimental: {
    runtimeThinkingCorrectionEnabled: true,
    taskFinishGuardEnabled: true,
    firstTurnThinkingModelEnabled: false,
    execCommandActionModelEnabled: true,
    writeStdinActionModelEnabled: true,
  },
};

function pickBackendSnapshot(raw: unknown): Partial<BackendSettings> {
  if (!isObject(raw)) return {};
  return {
    schemaVersion: raw.schemaVersion,
    commandPolicyMode: raw.commandPolicyMode,
    model: raw.model,
    baseUrl: raw.baseUrl,
    apiKey: raw.apiKey,
    models: raw.models,
    connections: raw.connections,
    tools: raw.tools,
    agents: raw.agents,
    agentsSeeded: raw.agentsSeeded,
    gateway: raw.gateway,
    layout: raw.layout,
    recursionLimit: raw.recursionLimit,
    memory: raw.memory,
    debugMode: raw.debugMode,
    experimental: raw.experimental,
  } as Partial<BackendSettings>;
}

function normalizeBackendSettings(settings: BackendSettings): BackendSettings {
  const next = deepMerge(DEFAULT_BACKEND_SETTINGS, settings);

  next.models.items = next.models.items.map((item) => ({
    ...item,
    maxTokens:
      typeof item.maxTokens === "number" && item.maxTokens > 0
        ? item.maxTokens
        : 200000,
    structuredOutputMode:
      item.structuredOutputMode === "on" || item.structuredOutputMode === "off"
        ? item.structuredOutputMode
        : "auto",
    supportsStructuredOutput: item.supportsStructuredOutput === true,
    supportsObjectToolChoice: item.supportsObjectToolChoice === true,
  }));

  const builtIn = { ...(next.tools?.builtIn ?? {}) };
  if (builtIn.send_char !== undefined && builtIn.write_stdin === undefined) {
    builtIn.write_stdin = builtIn.send_char;
  }
  delete builtIn.send_char;

  next.tools = {
    builtIn: {
      ...DEFAULT_BUILTIN_TOOLS,
      ...builtIn,
    },
    skills: {
      ...(next.tools?.skills ?? {}),
    },
  };

  if (!next.models.activeProfileId && next.models.profiles.length > 0) {
    next.models.activeProfileId = next.models.profiles[0].id;
  }

  const activeProfile = next.models.profiles.find(
    (profile) => profile.id === next.models.activeProfileId,
  );
  const activeModel = activeProfile
    ? next.models.items.find((item) => item.id === activeProfile.globalModelId)
    : undefined;

  next.model = activeModel?.model || "";
  next.baseUrl = activeModel?.baseUrl || "";
  next.apiKey = activeModel?.apiKey || "";

  next.recursionLimit =
    typeof next.recursionLimit === "number" &&
    Number.isFinite(next.recursionLimit) &&
    next.recursionLimit > 0
      ? next.recursionLimit
      : 200;

  next.memory = {
    enabled: next.memory?.enabled !== false,
  };

  next.debugMode = next.debugMode === true;

  next.experimental = {
    runtimeThinkingCorrectionEnabled:
      next.experimental?.runtimeThinkingCorrectionEnabled !== false,
    taskFinishGuardEnabled: next.experimental?.taskFinishGuardEnabled !== false,
    firstTurnThinkingModelEnabled:
      next.experimental?.firstTurnThinkingModelEnabled === true,
    execCommandActionModelEnabled:
      next.experimental?.execCommandActionModelEnabled !== false,
    writeStdinActionModelEnabled:
      next.experimental?.writeStdinActionModelEnabled !== false,
  };

  next.agents = Array.isArray(next.agents)
    ? next.agents
        .filter((a: any) => a && typeof a === "object")
        .map((a: any) => {
          // Migrate v4's single modelProfileId to v5's modelProfileIds array.
          // If both fields are present (transient state mid-migration) the
          // array wins; if only the legacy field is present, wrap it in an
          // array (filtering out the empty-string sentinel for "inherit").
          let modelProfileIds: string[];
          if (Array.isArray(a.modelProfileIds)) {
            modelProfileIds = a.modelProfileIds.filter((id: any) => typeof id === "string" && id.length > 0);
          } else if (typeof a.modelProfileId === "string" && a.modelProfileId.length > 0) {
            modelProfileIds = [a.modelProfileId];
          } else {
            modelProfileIds = [];
          }
          return {
            id: typeof a.id === "string" && a.id ? a.id : `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: typeof a.name === "string" ? a.name : "",
            description: typeof a.description === "string" ? a.description : "",
            systemPrompt: typeof a.systemPrompt === "string" ? a.systemPrompt : "",
            modelProfileIds,
            allowedTools: Array.isArray(a.allowedTools)
              ? a.allowedTools.filter((t: any) => typeof t === "string")
              : [],
          };
        })
    : [];

  next.agentsSeeded = next.agentsSeeded === true;

  const access = next.gateway?.ws?.access;
  const normalizedAccess: WsGatewayAccess =
    access === "disabled" ||
    access === "internet" ||
    access === "localhost" ||
    access === "lan" ||
    access === "custom"
      ? access
      : "localhost";
  const port = Number(next.gateway?.ws?.port);
  const allowedCidrs = Array.isArray(next.gateway?.ws?.allowedCidrs)
    ? (next.gateway!.ws.allowedCidrs as string[])
        .map((s) => (typeof s === "string" ? s.trim() : ""))
        .filter((s): s is string => s.length > 0)
    : [];

  const mobileWebPort = next.gateway?.mobileWeb?.port;
  const normalizedMobileWebPort =
    typeof mobileWebPort === "number" &&
    Number.isInteger(mobileWebPort) &&
    mobileWebPort > 0 &&
    mobileWebPort < 65536
      ? mobileWebPort
      : null;

  next.gateway = {
    ws: {
      access: normalizedAccess,
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 17888,
      allowedCidrs,
    },
    mobileWeb: {
      port: normalizedMobileWebPort,
    },
  };

  next.schemaVersion = BACKEND_SETTINGS_SCHEMA_VERSION;
  return next;
}

function migrateBackendToV3(
  settings: Partial<BackendSettings>,
): Partial<BackendSettings> {
  const next = { ...(settings as any) };
  delete (next as any).language;
  delete (next as any).themeId;
  delete (next as any).terminal;
  next.schemaVersion = 3;
  return next;
}

function migrateBackendToV4(
  settings: Partial<BackendSettings>,
): Partial<BackendSettings> {
  const next = { ...(settings as any) };
  if (!Array.isArray(next.agents)) {
    next.agents = [];
  }
  next.schemaVersion = 4;
  return next;
}

function migrateBackendToV7(
  settings: Partial<BackendSettings>,
): Partial<BackendSettings> {
  const next = { ...(settings as any) };
  // 1) Strip retired model-profile role fields. The agent system now handles
  // these specialties; only chat + coder remain as direct-routed roles, with
  // globalModelId as the catch-all default.
  if (next.models && Array.isArray(next.models.profiles)) {
    next.models.profiles = next.models.profiles.map((p: any) => {
      if (!p || typeof p !== "object") return p;
      const cleaned = { ...p };
      delete cleaned.actionModelId;
      delete cleaned.thinkingModelId;
      delete cleaned.compactionModelId;
      delete cleaned.creativeModelId;
      delete cleaned.architectModelId;
      delete cleaned.scoutModelId;
      // Prune per-role prompts that referenced retired roles.
      if (cleaned.rolePrompts && typeof cleaned.rolePrompts === "object") {
        const keep = ["chat", "coder"];
        const next: Record<string, string> = {};
        for (const [k, v] of Object.entries(cleaned.rolePrompts)) {
          if (keep.includes(k) && typeof v === "string") next[k] = v;
        }
        cleaned.rolePrompts = Object.keys(next).length > 0 ? next : undefined;
      }
      return cleaned;
    });
  }
  // 2) Blow away auto-discovered model items. Auto-discovery used a slot-based
  // id scheme (`proxlab-${slot}`) and slot numbers got reused as services
  // rotated, leaving the items array with duplicate ids. Discovery
  // repopulates within a poll cycle, so dropping them is safe and the
  // cleanest way to recover from the duplicate-id mess.
  if (next.models && Array.isArray(next.models.items)) {
    next.models.items = next.models.items.filter((m: any) => !m?._proxlabAutoDiscovered);
  }
  next.schemaVersion = 7;
  return next;
}

function migrateBackendToV6(
  settings: Partial<BackendSettings>,
): Partial<BackendSettings> {
  const next = { ...(settings as any) };
  // Default-id agents whose systemPrompt still matches the v5 seed get
  // upgraded to the v6 prompt (with memory guidance) and the merged tool
  // allowlist. Customized agents keep their prompts untouched, but we still
  // append any new memory tools we want them to have access to — the user
  // can remove them in the editor if they don't want them.
  if (Array.isArray(next.agents)) {
    next.agents = next.agents.map((a: any) => {
      if (!a || typeof a !== "object" || typeof a.id !== "string") return a;
      const v5 = V5_DEFAULT_AGENT_PROMPTS[a.id];
      const v6 = DEFAULT_AGENTS.find((d) => d.id === a.id);
      if (!v5 || !v6) return a;
      const promptUntouched = a.systemPrompt === v5.systemPrompt;
      const currentTools: string[] = Array.isArray(a.allowedTools) ? a.allowedTools : [];
      // Only promote allowedTools to the new defaults if the user kept the
      // original v5 set — if they removed something, respect that and just
      // union with the *added* memory tools. This keeps customized lists
      // close to what the user wants without losing the new capability.
      const v5Set = new Set(v5.allowedTools);
      const userRemovals = v5.allowedTools.filter((t) => !currentTools.includes(t));
      const newDefaults: string[] = v6.allowedTools;
      const additions = newDefaults.filter((t) => !v5Set.has(t));
      const mergedTools = Array.from(new Set([...currentTools, ...additions]))
        .filter((t) => !userRemovals.includes(t));
      return {
        ...a,
        systemPrompt: promptUntouched ? v6.systemPrompt : a.systemPrompt,
        allowedTools: mergedTools,
      };
    });
  }
  next.schemaVersion = 6;
  return next;
}

function migrateBackendToV5(
  settings: Partial<BackendSettings>,
): Partial<BackendSettings> {
  const next = { ...(settings as any) };
  // Convert legacy single-model field to array form on each agent.
  if (Array.isArray(next.agents)) {
    next.agents = next.agents.map((a: any) => {
      if (!a || typeof a !== "object") return a;
      if (Array.isArray(a.modelProfileIds)) return a;
      const single = typeof a.modelProfileId === "string" && a.modelProfileId.length > 0
        ? [a.modelProfileId]
        : [];
      const { modelProfileId: _legacy, ...rest } = a;
      return { ...rest, modelProfileIds: single };
    });
  } else {
    next.agents = [];
  }
  // First-time seed of default agents. Only fires when the user has zero
  // agents AND has never been seeded — so deleting a default keeps it deleted.
  if (next.agentsSeeded !== true && (!Array.isArray(next.agents) || next.agents.length === 0)) {
    next.agents = DEFAULT_AGENTS.map((a) => ({ ...a }));
    next.agentsSeeded = true;
  } else if (next.agentsSeeded !== true) {
    // User already has agents from v4 — mark as seeded to skip future seeding.
    next.agentsSeeded = true;
  }
  next.schemaVersion = 5;
  return next;
}

export function migrateBackendSettings(
  raw: unknown,
  legacyRaw?: unknown,
): BackendSettings {
  const legacySnapshot = pickBackendSnapshot(legacyRaw);
  const rawSnapshot = pickBackendSnapshot(raw);

  const rawVersion =
    isObject(raw) && typeof raw.schemaVersion === "number"
      ? raw.schemaVersion
      : 0;
  const legacyVersion =
    isObject(legacyRaw) && typeof legacyRaw.schemaVersion === "number"
      ? legacyRaw.schemaVersion
      : 0;

  let merged = deepMerge(DEFAULT_BACKEND_SETTINGS, legacySnapshot);
  merged = deepMerge(merged, rawSnapshot);

  let fromVersion = Math.max(rawVersion, legacyVersion);
  if (fromVersion < 3) {
    merged = deepMerge(merged, migrateBackendToV3(merged as any) as any);
    fromVersion = 3;
  }
  if (fromVersion < 4) {
    merged = deepMerge(merged, migrateBackendToV4(merged as any) as any);
    fromVersion = 4;
  }
  if (fromVersion < 5) {
    merged = deepMerge(merged, migrateBackendToV5(merged as any) as any);
    fromVersion = 5;
  }
  if (fromVersion < 6) {
    merged = deepMerge(merged, migrateBackendToV6(merged as any) as any);
    fromVersion = 6;
  }
  if (fromVersion < 7) {
    merged = deepMerge(merged, migrateBackendToV7(merged as any) as any);
    fromVersion = 7;
  }

  return normalizeBackendSettings(merged);
}
