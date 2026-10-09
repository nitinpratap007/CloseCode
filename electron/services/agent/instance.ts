// Close Code — AI Agent Runtime — process wiring (Phase 21)
//
// Owns the single `AgentRuntime` instance and the two channels it speaks on:
//
//   * `agent:event`  — the full runtime event stream (new, Phase 21)
//   * `ai:event`     — the Phase 11 chat contract, derived from that stream
//
// Deriving the legacy events here (rather than inside the loop) is what lets the
// existing AI chat surface keep working unchanged while the loop underneath is
// a real runtime with lifecycle, budgets and cancellation.

import { BrowserWindow } from "electron";
import { getApiKey, loadAiConfig, WEB_SEARCH_KEY_ID, type AiConfig } from "../aiSettings";
import {
  createResearchRecord,
  createResearchServices,
  runResearchPipeline,
  saveResearchRecord,
  type ResearchPermissionMode,
  type ResearchRecord,
} from "../webResearch";
import { loadPermissionPolicy } from "../permissionStore";
import { AgentRuntime } from "./runtime";
import { createBuiltinRegistry, ToolRegistry } from "./tools";
import { createBrowserTool } from "./tools-browser";
import { getBrowserController } from "./browser-electron";
import { createTaskTools } from "./tools-tasks";
import { taskService } from "../aiTasks";
import { attachMcpRegistry } from "../mcp";
import { createSkillTools } from "./tools-skills";
import { readSkill, listSkills } from "../skills";
import { collectInstructions } from "../instructions";
import { createOpenAiTransport, resolveEndpoint } from "./transport";
import { toLegacyAiEvent, type LegacyAiEvent } from "./legacy";
import { DEFAULT_AGENT_ID, canonicalAgentId } from "./definitions";
import { ContextEngine } from "./context";
import { recordRun, type SessionRunRef } from "../aiSessions";
import type { AgentRunSpec, AgentWebSearchConfig, ContextSummary, EditorSnapshot } from "./types";

let runtime: AgentRuntime | null = null;

/**
 * Phase 26. The single context engine.
 *
 * It needs the runtime's run records — "earlier agent work" is one of the ten
 * signals, and only the runtime has them — but it is constructed *by* the
 * runtime's wiring. So the dependency is resolved lazily inside the closure
 * rather than captured at construction: reading `getAgentRuntime()` eagerly here
 * would return the half-built `null` during the runtime's own construction.
 */
let contextEngine: ContextEngine | null = null;

export function getContextEngine(): ContextEngine {
  if (contextEngine) return contextEngine;
  contextEngine = new ContextEngine({
    history: () => getAgentRuntime().listRuns(),
    // Phase 31. User and project instruction files land in the engine's
    // instructions part, so an agent run carries them the same way every run
    // carries AGENTS.md — through the one context pipeline, with its budgets.
    instructions: (workspace) => collectInstructions(workspace).map((f) => ({ name: f.name, text: f.text })),
  });
  return contextEngine;
}

/**
 * Where the capability rules live.
 *
 * Resolved once and injected, rather than read from `app` here, so this module
 * stays importable without an Electron app behind it. A caller that has not set a
 * directory gets no stored rules at all, which resolves to the built-in defaults
 * — every irreversible capability denied — so forgetting to call the setter fails
 * closed rather than open.
 */
let permissionPolicyDir: string | null = null;

export function setPermissionPolicyDir(dir: string): void {
  permissionPolicyDir = dir;
}

function readPermissionPolicy() {
  return permissionPolicyDir ? loadPermissionPolicy(permissionPolicyDir) : undefined;
}

function send(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try {
        win.webContents.send(channel, payload);
      } catch {
        // the window went away mid-broadcast
      }
    }
  }
}

export { toLegacyAiEvent, type LegacyAiEvent };

/**
 * Read the search credential for the `web_search` tool.
 *
 * Resolved here, per runtime, rather than read inside the tool: the tool stays
 * credential-free and unit-testable, and the key is only ever decrypted in the
 * main process. A missing key is passed as `null` rather than omitted, so the
 * tool can tell "not configured" from "not wired" and say so precisely.
 */
function readWebSearchConfig(): AgentWebSearchConfig {
  return { apiKey: getApiKey(WEB_SEARCH_KEY_ID) };
}

/**
 * Phase 32. Runs a research record against the real services: the same
 * OpenAI-compatible transport agent runs use, the encrypted Brave key, and the
 * capped fetcher behind `web_fetch`. The record is saved and broadcast before
 * and after, so agent-driven research appears in the panel's research store
 * exactly like panel-driven research.
 *
 * Permission is deliberately NOT re-checked here: the caller owns the gate. The
 * agent tool path comes through the runtime's `web` authorization; the panel
 * path comes through the IPC layer's `web`-category decision. Both record the
 * mode that was in force in the record itself.
 */
export function runResearchRecord(record: ResearchRecord, signal: AbortSignal): Promise<ResearchRecord> {
  const cfg = loadAiConfig();
  const services = createResearchServices(
    {
      provider: cfg.provider,
      baseUrl: cfg.baseUrl,
      localBaseUrl: cfg.localBaseUrl,
      model: cfg.model,
      localModel: cfg.localModel,
      temperature: cfg.temperature,
      timeoutMs: cfg.timeoutMs,
    },
    { apiKey: getApiKey(WEB_SEARCH_KEY_ID) },
    signal,
  );
  record.status = "running";
  saveResearchRecord(record);
  const done = runResearchPipeline(record, services, {
    signal,
    onUpdate: (r) => {
      saveResearchRecord(r);
      send("research:event", { type: "record", record: r });
    },
  });
  // The pipeline's final status change also fires onUpdate, so this is belt and
  // braces for the throw-path: a crash after the record was updated but before
  // the final broadcast still leaves the store and the panel consistent.
  void done.then((finished) => {
    saveResearchRecord(finished);
    send("research:event", { type: "record", record: finished });
  });
  return done;
}

function permissionOf(cfg: AiConfig): ResearchPermissionMode {
  const mode = cfg.permissions?.web;
  if (mode === "allow" || mode === "deny") return mode;
  return "ask";
}

/**
 * Phase 32. The agent-facing entry point: create a record for the question,
 * then run it. Used by the runtime's `research` factory (`research_start`).
 */
export function runResearchNow(
  request: { question: string; focusUrls?: string[] },
  signal: AbortSignal,
): Promise<ResearchRecord> {
  const record = createResearchRecord(request.question, request.focusUrls ?? [], permissionOf(loadAiConfig()), Date.now());
  return runResearchRecord(record, signal);
}

export function getAgentRuntime(): AgentRuntime {
  if (runtime) return runtime;
  runtime = new AgentRuntime({
    registry: createDefaultRegistry(),
    createTransport: (endpoint) => createOpenAiTransport(endpoint),
    webSearch: readWebSearchConfig(),
    // Phase 32. The research pipeline for `research_start`. Runs the real
    // services; the tool's `web` authorization is the only gate it passes.
    research: (request, signal) => runResearchNow(request, signal),
    // Phase 31. The skill index for the system prompt. Bodies load on
    // invocation through the tool; this is only names and descriptions.
    skills: (workspace) => listSkills(workspace).map((s) => ({ name: s.name, description: s.description, allowedTools: s.allowedTools })),
    // Phase 26. The engine is shared with the IPC layer and with `spawnChild`,
    // so all three see the same in-flight build, the same cache and the same
    // "what was actually sent" answer.
    contextEngine: getContextEngine(),
    onEvent: (ev) => {
      send("agent:event", ev);
      const legacy = toLegacyAiEvent(ev);
      if (legacy) send("ai:event", legacy);
      // Phase 27. A finished run is a session event, so it is written here rather
      // than by the renderer: the renderer only ever held a capped projection of
      // this run, and persisting the projection instead of the record would make
      // the durable copy quietly smaller than the real thing.
      if (ev.type === "result") fileRunIntoSession(ev.runId, runtime);
    },
  });
  return runtime;
}

/**
 * Copy a finished run into its session.
 *
 * Reads the run back out of the runtime rather than off the event, because the
 * `result` event carries the outcome but not the trace — and the tool history is
 * half of what makes a session worth keeping.
 *
 * A failure here is swallowed on purpose. Session persistence is a record-keeping
 * convenience; failing a finished run because its transcript could not be filed
 * would be trading real work for a bookkeeping error.
 */
function fileRunIntoSession(runId: string, rt: AgentRuntime | null): void {
  if (!rt) return;
  const run = rt.getRun(runId);
  if (!run) return;
  const sessionId = run.sessionId;
  if (!sessionId) return;
  const ref: SessionRunRef = {
    id: run.id,
    agentId: run.agentId,
    task: run.task,
    status: run.status,
    steps: run.steps,
    toolCalls: run.toolCalls,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    parentRunId: run.parentRunId,
    depth: run.depth,
    resultText: run.result?.text ?? "",
    ...(run.error?.message ? { error: run.error.message } : {}),
    tools: run.trace,
    ...(run.contextSummary
      ? { contextChars: run.contextSummary.totalChars, contextStatus: run.contextSummary.status }
      : {}),
  };
  try {
    recordRun(sessionId, ref);
  } catch {
    // see above — a bookkeeping failure must not surface as a run failure
  }
}

export interface BuildSpecOptions {
  agentId?: string;
  task: string;
  workspace: string | null;
  context?: string;
  /**
   * Phase 26. Whether the user wants project context. `false` is a decision, and
   * it is recorded as such rather than inferred from an empty `context` string:
   * "off" and "on but found nothing" must stay distinguishable, or a run cannot
   * report which of the two happened.
   */
  contextEnabled?: boolean;
  contextSummary?: ContextSummary;
  snapshot?: EditorSnapshot | null;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  /** Phase 27. The session this run should be filed under. */
  sessionId?: string | null;
  parentRunId?: string | null;
  depth?: number;
  /** Reuse an existing id so the legacy chat events correlate to this request. */
  runId?: string;
  config?: AiConfig;
}

/**
 * Turn AI settings into a concrete run specification. Kept beside the runtime
 * so provider/credential resolution happens in exactly one place.
 */
export function buildRunSpec(options: BuildSpecOptions): AgentRunSpec {
  const cfg = options.config ?? loadAiConfig();
  const endpoint = resolveEndpoint(cfg);
  // Phase 23. Read fresh for every run so a permission changed in the panel
  // applies to the next task rather than to the next launch. The coarse category
  // modes from Phase 11/22 keep working as a floor on top of this.
  const policy = readPermissionPolicy();
  return {
    ...(options.runId ? { runId: options.runId } : {}),
    // Phase 24. Canonicalised here as well as at the IPC boundary, because a
    // run spec can also be built by the chat path and by `delegate_task`, and
    // every route into a run should end up with the same id. The permission
    // context is derived from this value, so a non-canonical id would look up
    // per-agent rules under a key the user cannot see in the panel.
    agentId: canonicalAgentId(options.agentId ?? DEFAULT_AGENT_ID),
    task: options.task,
    workspace: options.workspace,
    context: options.context ?? "",
    // Phase 26. The three context fields are passed through rather than
    // re-derived: the engine is what decided what to include, and the spec is a
    // record of that decision. Defaulting `contextEnabled` to `true` here is
    // right because every existing call site (the chat path, `ai.ts`) never
    // mentioned context and must keep behaving exactly as it did.
    contextEnabled: options.contextEnabled !== false,
    ...(options.contextSummary ? { contextSummary: options.contextSummary } : {}),
    ...(options.snapshot ? { snapshot: options.snapshot } : {}),
    history: options.history ?? [],
    parentRunId: options.parentRunId ?? null,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    depth: options.depth ?? 0,
    endpoint: { url: endpoint.url, model: endpoint.model, key: endpoint.key },
    temperature: cfg.temperature,
    timeoutMs: cfg.timeoutMs,
    stream: cfg.stream,
    permissions: { ...cfg.permissions },
    // Phase 23. The coarse category modes from Phase 11/22 keep working as a
    // floor; this is the fine-grained layer on top, read fresh for every run so
    // a permission changed in the panel applies to the next task rather than to
    // the next launch.
    ...(policy ? { policy } : {}),
  };
}

/**
 * Build the tool registry the runtime actually uses.
 *
 * This is the single composition point for the whole tool set: every tool is
 * registered here and nowhere else, which is what makes "one central registry"
 * true rather than aspirational.
 *
 * The browser tool is created here rather than exported as a constant because it
 * is the one tool that needs a live Electron `BrowserWindow`. It is registered
 * unconditionally on purpose: a model must be able to see that browsing exists
 * and be told clearly why it cannot be used, rather than failing to find a tool
 * and silently substituting something else.
 */
export function createDefaultRegistry(): ToolRegistry {
  const registry = createBuiltinRegistry(true, [
    createBrowserTool(getBrowserController()),
    // Phase 29. The task tools bind the app's one real store, so a run's
    // task_create/task_update land in the same list the user's panel reads.
    ...createTaskTools(taskService),
    // Phase 31. One tool, bound to the real skill store: discovery happens
    // per invocation against the files as they are on disk right then.
    ...createSkillTools({ read: (workspace, name) => readSkill(workspace, name) }),
  ]);
  // Phase 30. MCP tools are dynamic — servers are added, connected, removed
  // while the app runs — so they are synced into this registry by the manager
  // rather than spread at construction. `resolveFor` reads the registry fresh
  // per run, so a server that connects mid-session appears in the next run's
  // tool list with no restart.
  attachMcpRegistry(registry);
  return registry;
}
