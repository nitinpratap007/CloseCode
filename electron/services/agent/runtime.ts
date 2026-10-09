// Close Code — AI Agent Runtime (Phase 21)
//
// The first-class execution runtime for CloseCode agents. Phase 11 had a
// tool-calling loop that was a private method on `AiService`: a hard-coded
// 6-step bound, six tools behind a `switch`, no cancellation, no lifecycle,
// no state, and no way to run anything other than one hard-coded agent. This
// module replaces all of that with a runtime that owns:
//
//   * lifecycle   - idle -> starting -> running -> (awaiting_approval) ->
//                   completed | cancelled | failed, with validated transitions
//   * state       - an inspectable `AgentRun` record (messages, trace, counters)
//   * the loop    - bounded by step / tool-call / wall-clock budgets
//   * cancellation- one AbortController per run, plumbed into the transport so
//                   an in-flight HTTP request is really aborted
//   * errors      - every failure is normalized to a typed `AgentErrorInfo`
//   * streaming   - content and provider reasoning are forwarded as events
//   * tools       - delegated to a `ToolRegistry`; the loop knows no tool names
//   * context     - a single `AgentRunSpec` / `AgentToolContext` pair
//   * results     - a structured `AgentResult`, never a bare string
//
// All of it runs in the main process and is fully async, so the renderer is
// never blocked: the UI only ever receives events.

import { AgentRuntimeError, isAbortLike, toAgentError } from "./errors";
import { BASE_SYSTEM_PROMPT, DEFAULT_AGENT_ID, getAgentDefinition, listAgentDefinitions } from "./definitions";
import { DELEGATE_TOOL_NAME, ToolRegistry, confineToWorkspace } from "./tools";
// Phase 26. The only reason the runtime touches the context engine's module at
// all is the sub-agent budget: `context.ts` already sits in the same dependency
// graph as `./tools`, which imports `fs`, so this adds no new burden to the
// runtime's testability.
import { CHILD_CONTEXT_BUDGET } from "./context";
// Phase 28. The compaction engine is imported rather than inlined for the same
// reason the context engine is: it is pure, it is separately testable, and the
// runtime only needs to know *when* a payload had to be compressed and what the
// compression did.
import { compactMessages, DEFAULT_COMPACTION_BUDGET, type CompactionBudget, type CompactionRecord } from "./compaction";
import { toolError } from "./result";
import type { ToolError } from "./types";
import {
  CAPABILITY_LABELS,
  CATEGORY_CAPABILITIES,
  ALL_CAPABILITIES,
  categoryCanWiden,
  clampToCeiling,
  detectDangerousCommand,
  emptyPolicy,
  escalateMode,
  isOutsideWorkspace,
  resolveCapabilityDetailed,
  strictestMode,
  type Capability,
  type Escalation,
  type PermissionMode,
  type PermissionPolicy,
} from "./permissions";
import {
  DEFAULT_AGENT_BUDGET,
  canTransition,
  isTerminalStatus,
  type AgentBudget,
  type AgentDefinition,
  type AgentErrorInfo,
  type AgentEvent,
  type AgentMessage,
  type AgentResult,
  type AgentRun,
  type AgentPermissionRequest,
  type AgentRunSpec,
  type AgentStatus,
  type AgentStatusKind,
  type AgentTool,
  type AgentToolCategory,
  type AgentToolContext,
  type AgentToolOutcome,
  type AgentTraceEntry,
  type AgentTransport,
  type AgentWebSearchConfig,
  type ContextBudget,
  type ContextSummary,
  type EditorSnapshot,
  type ResearchFactory,
} from "./types";

/**
 * Phase 11 emitted this exact note when agent mode engaged, and the renderer
 * prefixes it to the assistant bubble. It is kept verbatim so the existing
 * chat surface is unchanged.
 */
export const AGENT_START_NOTE = "Agent mode enabled — the assistant may use approved tools.";

const DEFAULT_APPROVAL_TIMEOUT_MS = 90_000;
const DEFAULT_RETAINED_RUNS = 40;
const MAX_TRACE_ENTRIES = 200;
const MAX_RUN_MESSAGES = 120;
const TOOL_EVENT_SUMMARY_CHARS = 800;
const TOOL_MESSAGE_CHARS = 20_000;
/** Ceiling for a sub-agent's own step budget, so a child can never outlive a long parent. */
const MAX_SUBAGENT_STEPS = 4;

/**
 * Phase 25. How many children one parent run may start, in total, across its
 * whole life.
 *
 * Depth was already bounded, which stops a chain but not a fan-out: a parent with
 * a step budget of 8 could delegate once per step and end eight children deep in
 * wall-clock time while still sitting inside every other limit. This is the
 * bound on breadth, and it is deliberately small — delegation is for handing off
 * one piece of work, not for splitting a task into a workforce.
 */
const MAX_CHILDREN_PER_RUN = 4;

/**
 * Phase 25. How many children of a single parent may run at the same instant.
 *
 * Without this, a batch of four is four concurrent model streams and — for the
 * roles that carry a shell — four processes competing for the same CPU, which is
 * how a fan-out turns a fast answer into a hung machine. Three is enough to feel
 * parallel and low enough that the queue is real.
 */
const SUBAGENT_CONCURRENCY = 3;

/**
 * Phase 25. Ceiling on runs alive at once across the whole runtime.
 *
 * The per-parent caps bound one parent; this bounds the app. It is checked when a
 * child is about to start, and the failure is reported to the model as a typed
 * budget error rather than thrown, so the parent can carry on with the work it
 * already has.
 */
const MAX_CONCURRENT_RUNS = 8;

/**
 * Rule 1 of the gate: the category setting acts as a floor, in both directions.
 *
 *   * `deny` is absolute. A category the user blocked blocks every tool in it,
 *     whatever any narrower scope says — otherwise a per-agent `allow` would
 *     un-deny a category the user had turned off.
 *
 *   * `allow` is a bulk edit, not an override. It fills in capabilities the user
 *     has no opinion about and stands aside where they do have one, so a
 *     per-project `ask` on `files.write` is not overwritten by a global
 *     `files: allow`. It also cannot reach the irreversible operations or
 *     anything outside the category's own set — which is why `terminal: allow`
 *     does not permit a silent `rm -rf`.
 *
 * Phase 25 calls this from two places — the gate, and the ceiling a parent hands
 * to a child. They must agree: if the ceiling were computed with only the `deny`
 * half, a child would inherit a ceiling stricter than its parent and a role
 * allowed to write would silently stop being able to.
 */
function applyCategoryFloor(
  mode: PermissionMode,
  resolved: { mode: PermissionMode; explicit: boolean },
  capability: Capability,
  category: AgentToolCategory,
  categoryMode: PermissionMode | undefined,
): PermissionMode {
  if (categoryMode === "deny") return "deny";
  if (categoryMode === "allow" && !resolved.explicit && categoryCanWiden(category, capability)) {
    return "allow";
  }
  return mode;
}

/**
 * Reverse index of `CATEGORY_CAPABILITIES`: capability -> the categories that
 * cover it. Built once at module load from the permission model's own table, so
 * it cannot fall out of step with it.
 */
const CATEGORY_FOR_CAPABILITY: ReadonlyMap<Capability, AgentToolCategory[]> = (() => {
  const map = new Map<Capability, AgentToolCategory[]>();
  for (const [category, capabilities] of Object.entries(CATEGORY_CAPABILITIES)) {
    for (const capability of capabilities) {
      const existing = map.get(capability as Capability);
      if (existing) existing.push(category as AgentToolCategory);
      else map.set(capability as Capability, [category as AgentToolCategory]);
    }
  }
  return map;
})();

export interface AgentRuntimeOptions {
  registry: ToolRegistry;
  /**
   * Builds the transport for a single run. Credentials and endpoint selection
   * stay outside the runtime, which is why the runtime is trivially testable.
   */
  createTransport: (endpoint: { url: string; model: string; key: string | null }) => AgentTransport;
  onEvent: (ev: AgentEvent) => void;
  approvalTimeoutMs?: number;
  maxRetainedRuns?: number;
  /**
   * Phase 22. Credentials for the outbound-network tools, resolved by the
   * process wiring rather than by the runtime — the same rule the model
   * endpoint already follows. Absent means "no key configured", which
   * `web_search` reports as a typed failure rather than inventing results.
   */
  webSearch?: AgentWebSearchConfig;
  /**
   * Phase 32. The web research pipeline, injected like `webSearch`: the runtime
   * never performs network I/O for research itself, it hands tools a factory.
   * Absent means `research_start` reports a typed `unavailable` refusal.
   */
  research?: ResearchFactory;
  now?: () => number;
  /**
   * Phase 31. The skill index for the system prompt, injected for the same
   * reason the transport is: the runtime does not read disks. Names and
   * descriptions only — bodies are loaded by the `use_skill` tool on
   * invocation, so a run carries the index, not every skill ever written.
   */
  skills?: (workspace: string | null) => Array<{ name: string; description: string; allowedTools: string[] | null }>;
  /**
   * Phase 26. The context engine, injected rather than imported.
   *
   * `context.ts` reaches for `fs` and shells out to git, and this runtime is
   * unit-tested in a plain Node environment with a fake transport. An engine
   * that can assemble nothing is a legitimate configuration — it is what every
   * test outside the context suite uses — so this is optional and a run with no
   * engine simply receives no context, exactly as it did through Phase 25.
   */
  contextEngine?: ContextEngineLike;
  /**
   * Phase 28. The ceiling applied to every payload this runtime ships.
   *
   * Optional so a test can drive a small budget without the app having a
   * setting for it: this is a safety bound, not a preference, so the shipped
   * runtime simply does not pass one and gets `DEFAULT_COMPACTION_BUDGET`.
   */
  compactionBudget?: CompactionBudget;
}

/**
 * Phase 26. The slice of the context engine the runtime needs.
 *
 * A structural type rather than `ContextEngine` on purpose: it keeps
 * `runtime.ts` from importing `context.ts`, so the runtime keeps no dependency
 * on the filesystem and a test can supply a three-line fake.
 */
export interface ContextEngineLike {
  build(request: ContextBuildRequest): Promise<ContextBuildResult>;
}

/** What the runtime asks the engine for. Mirrors `ContextRequest` in `context.ts`. */
export interface ContextBuildRequest {
  agentId: string;
  task: string;
  workspace: string | null;
  snapshot?: EditorSnapshot | null;
  budget?: ContextBudget;
  childOf?: string | null;
  signal?: AbortSignal;
}

/** What the runtime uses from the answer. The full bundle never leaves the engine. */
export interface ContextBuildResult {
  text: string;
  summary: ContextSummary;
}

interface PendingApproval {
  runId: string;
  category: AgentToolCategory;
  args: Record<string, unknown>;
  /** Phase 23. Kept so `pendingApprovals` can describe a prompt it did not emit. */
  tool: string;
  capabilities: readonly Capability[];
  destructive: boolean;
  escalation?: Escalation;
  finish: (approved: boolean) => void;
}

/**
 * Phase 23. Everything the gate worked out about one call, kept together so the
 * decision and the prompt cannot describe different things.
 */
interface PermissionVerdict {
  /** False when the call is refused outright — policy denial, no prompt shown. */
  allowed: boolean;
  /** What to ask the user, when a prompt is warranted. */
  mode: PermissionMode;
  /** The operations this call needs, resolved. Deduplicated. */
  capabilities: Capability[];
  /** Set when a capability set to `allow` was pulled back to `ask`. */
  escalation?: Escalation;
  /**
   * Human-readable explanation of a refusal. The model sees this, so it says
   * what to do instead rather than only what went wrong — a bare "denied" makes
   * a model retry the identical call.
   */
  reason?: string;
}

interface InternalRun {
  run: AgentRun;
  spec: AgentRunSpec;
  budget: AgentBudget;
  controller: AbortController;
  cancelReason: string | null;
  /** Callbacks that unblock anything currently awaiting the user. */
  onCancel: Array<() => void>;
  messages: AgentMessage[];
  currentStep: number;
  toolCallCount: number;
  stepCount: number;
  /** Monotonic creation order, so runs started in the same millisecond still sort. */
  order: number;
  /** Ids of sub-agent runs this run spawned, so cancelling cascades to them. */
  childRunIds: Set<string>;
  /**
   * Phase 25. How many children this run has started, including ones that have
   * already finished.
   *
   * Deliberately a count of *starts* rather than of live children: a parent that
   * finishes three children one after another has spent three delegations, and
   * letting the budget refill as they land turns a bounded run into one whose
   * total cost depends on how fast its children happen to be.
   */
  childrenSpawned: number;
  /**
   * Phase 28. Tool results whose status was not `ok`.
   *
   * A `WeakSet` of the very message objects in `messages`, so compaction can be
   * told "this result matters" with ground truth instead of guessing from the
   * wording. It is keyed on identity rather than on an index because
   * `syncMessages` shifts the array under it and an index would drift.
   */
  salient: WeakSet<AgentMessage>;
  /**
   * Phase 23. Why the most recent gate call refused, or null when the last one
   * passed. Lives on the run rather than as a runtime field so two concurrent
   * runs cannot attribute a refusal to each other.
   */
  denialReason: string | null;
  /**
   * Phase 31. The active skill's tool restriction, or null when unrestricted.
   *
   * Narrow-only by construction: a skill can *remove* tools from what the run
   * may call next, never add any — the permission gate still runs for every
   * tool the skill names, so a skill that names a denied tool has simply named
   * a tool that will be denied. Per-run state: a restriction cannot leak into
   * another run, and sub-agents get their own.
   */
  skillRestriction: { name: string; tools: Set<string> } | null;
}

/**
 * Reject as soon as `signal` aborts, even if `work` never settles on its own.
 *
 * Without this, a tool that hangs (a terminal command that never returns, a
 * delegated sub-agent still working) would leave `cancel()` reporting success
 * while the run sat in `cancelling` indefinitely — i.e. Stop would be a no-op.
 * The losing promise is left to settle on its own; nothing awaits it, and every
 * tool in the registry is written to tolerate an abandoned caller.
 */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function abortError(): Error {
  const err = new Error("The agent run was stopped.");
  err.name = "AbortError";
  return err;
}

function parseArgs(raw: string): { args: Record<string, unknown>; parseError?: string } {
  const text = (raw ?? "").trim();
  if (!text) return { args: {} };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { args: parsed as Record<string, unknown> };
    }
    return { args: {}, parseError: "Tool arguments were not a JSON object." };
  } catch (err) {
    return { args: {}, parseError: `Tool arguments were not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function firstLine(text: string, max = 160): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function mergeBudget(agent: AgentDefinition, override?: Partial<AgentBudget>): AgentBudget {
  const merged: AgentBudget = { ...DEFAULT_AGENT_BUDGET, ...(override ?? {}) };
  if (agent.maxSteps) merged.maxSteps = Math.min(merged.maxSteps, agent.maxSteps);
  return merged;
}

/**
 * Phase 28. The sentence a compaction trace line carries. Lives beside the
 * runtime rather than in the renderer's `lib/compaction.ts` because that module
 * belongs to the UI; the two are pinned together by a unit test that feeds the
 * same record to both and expects identical text, so the wording cannot drift.
 */
function compactionNotice(record: CompactionRecord): string {
  const fmt = (n: number) => n.toLocaleString("en-US");
  const passes = record.passes > 1 ? ` (${record.passes} passes)` : "";
  return (
    `Context compacted${passes}: ${fmt(record.beforeChars)} → ${fmt(record.afterChars)} chars, ` +
    `${record.beforeMessages} → ${record.afterMessages} messages.` +
    (record.overflow ? " The system prompt and active task alone still exceed the budget." : "")
  );
}

export class AgentRuntime {
  private readonly runs = new Map<string, InternalRun>();
  private readonly approvals = new Map<string, PendingApproval>();
  /**
   * `webSearch` is deliberately outside the `Required<…>` group: it is a
   * Phase 22 addition and is genuinely optional, so a runtime built without it
   * still type-checks and simply has no search key. Every other option has a
   * sensible default and is required to be resolved here. Phase 32's `research`
   * follows the same absent-optional rule.
   */
  private readonly opts: Required<
    Omit<
      AgentRuntimeOptions,
      "createTransport" | "registry" | "webSearch" | "contextEngine" | "compactionBudget" | "skills" | "research"
    >
  > &
    Pick<
      AgentRuntimeOptions,
      "createTransport" | "registry" | "webSearch" | "contextEngine" | "compactionBudget" | "skills" | "research"
    >;
  private seq = 0;

  constructor(options: AgentRuntimeOptions) {
    this.opts = {
      registry: options.registry,
      createTransport: options.createTransport,
      onEvent: options.onEvent,
      approvalTimeoutMs: options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
      maxRetainedRuns: options.maxRetainedRuns ?? DEFAULT_RETAINED_RUNS,
      now: options.now ?? (() => Date.now()),
      ...(options.webSearch ? { webSearch: options.webSearch } : {}),
      // Phase 26. Absent, not defaulted: `buildChildContext` treats a missing
      // engine as "no context", and stubbing one in here would make it
      // indistinguishable from an engine that legitimately found nothing.
      ...(options.contextEngine ? { contextEngine: options.contextEngine } : {}),
      // Phase 28. A budget override is the only knob compaction takes; like the
      // context engine it is absent-optional, so a caller that set one actually
      // gets it (the tests caught the previous plumbing gap: it was type-safe
      // and silently dead).
      ...(options.compactionBudget ? { compactionBudget: options.compactionBudget } : {}),
      // Phase 31. Absent, not defaulted: no skills function means no skill
      // index in the prompt, which is the honest state for a runtime built in
      // a test with no skill store behind it.
      ...(options.skills ? { skills: options.skills } : {}),
      // Phase 32. Absent, not defaulted: a runtime without the research factory
      // has `research_start` refuse with a typed unavailable result.
      ...(options.research ? { research: options.research } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  definitions(): AgentDefinition[] {
    return listAgentDefinitions();
  }

  hasAgent(id: string): boolean {
    return getAgentDefinition(id) !== undefined;
  }

  getRun(runId: string): AgentRun | undefined {
    const internal = this.runs.get(runId);
    return internal ? this.snapshot(internal) : undefined;
  }

  /** Newest first. */
  listRuns(): AgentRun[] {
    return [...this.runs.values()]
      .sort((a, b) => b.run.createdAt - a.run.createdAt || b.order - a.order)
      .map((i) => this.snapshot(i));
  }

  activeRuns(): AgentRun[] {
    return this.listRuns().filter((r) => !isTerminalStatus(r.status));
  }

  /**
   * Phase 25. Live runs, counted without building snapshots.
   *
   * Separate from `activeRuns` because the concurrency guard calls this on every
   * delegation, and `listRuns` maps every run in the history through `snapshot`
   * to answer a question that only needs the status field.
   */
  private activeRunCount(): number {
    let n = 0;
    for (const internal of this.runs.values()) {
      if (!isTerminalStatus(internal.run.status)) n += 1;
    }
    return n;
  }

  /** Drop every finished run. Active runs are kept. */
  clearFinished(): number {
    let removed = 0;
    for (const [id, internal] of [...this.runs]) {
      if (isTerminalStatus(internal.run.status)) {
        this.runs.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  /** Reject any approval id that is no longer meaningful. */
  hasApproval(id: string): boolean {
    return this.approvals.has(id);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start a run. Returns immediately with the run id plus a promise for the
   * final result; the caller may ignore the promise (that is how the IPC
   * layer starts fire-and-forget runs) and can cancel through `cancel()`.
   * `start` never rejects: failures surface as a failed `AgentResult`.
   */
  start(spec: AgentRunSpec): { runId: string; done: Promise<AgentResult> } {
    const now = this.opts.now();
    this.seq += 1;
    const runId = spec.runId ?? `run-${now.toString(36)}-${this.seq}`;
    const internal: InternalRun = {
      run: {
        id: runId,
        agentId: spec.agentId,
        task: spec.task ?? "",
        workspace: spec.workspace ?? null,
        status: "idle",
        parentRunId: spec.parentRunId ?? null,
        depth: spec.depth ?? 0,
        // Phase 27. Carried onto the run so a finished run can be filed against
        // the session it was part of. `spawnChild` inherits the parent's value, so
        // a sub-agent's work lands in the same session as the run that asked for it.
        ...(spec.sessionId ? { sessionId: spec.sessionId } : {}),
        steps: 0,
        toolCalls: 0,
        messages: [],
        trace: [],
        // Phase 26. Copied, not referenced, so a later rebuild of the engine's
        // bundle cannot rewrite the record of what *this* run was actually given.
        ...(spec.contextSummary ? { contextSummary: { ...spec.contextSummary } } : {}),
        createdAt: now,
        updatedAt: now,
      },
      spec,
      budget: mergeBudget(getAgentDefinition(spec.agentId) ?? { id: spec.agentId, name: spec.agentId, description: "", systemPrompt: "" }, spec.budget),
      controller: new AbortController(),
      cancelReason: null,
      onCancel: [],
      messages: [],
      currentStep: 0,
      toolCallCount: 0,
      stepCount: 0,
      order: this.seq,
      childRunIds: new Set<string>(),
      childrenSpawned: 0,
      // Phase 28. Nothing is salient at the start of a run.
      salient: new WeakSet<AgentMessage>(),
    denialReason: null,
      // Phase 31. No skill is active when a run begins.
      skillRestriction: null,
    };
    this.runs.set(runId, internal);
    this.enforceRetention();
    const done = this.execute(internal);
    return { runId, done };
  }

  /** Await a run's result. */
  async run(spec: AgentRunSpec): Promise<AgentResult> {
    return this.start(spec).done;
  }

  /**
   * Request cancellation. Safe to call at any point, including while the run is
   * blocked on a user approval. Returns false when the run is unknown or
   * already finished.
   */
  cancel(runId: string, reason = "Cancelled by user"): boolean {
    const internal = this.runs.get(runId);
    if (!internal) return false;
    if (isTerminalStatus(internal.run.status)) return false;
    if (internal.cancelReason === null) internal.cancelReason = reason;
    if (canTransition(internal.run.status, "cancelling")) this.setStatus(internal, "cancelling", reason);
    internal.controller.abort();
    for (const fn of internal.onCancel.splice(0)) {
      try {
        fn();
      } catch {
        // an unblocker must never break cancellation
      }
    }
    // Cascade: a sub-agent the user never asked for directly must not keep
    // running (and keep spending provider quota) after its parent was stopped.
    for (const childId of [...internal.childRunIds]) {
      internal.childRunIds.delete(childId);
      const child = this.runs.get(childId);
      if (child && !isTerminalStatus(child.run.status)) this.cancel(childId, `Parent run was stopped (${reason})`);
    }
    return true;
  }

  /** Cancel every active run. Used when the workspace closes. */
  cancelAll(reason = "Cancelled"): number {
    let n = 0;
    for (const internal of [...this.runs.values()]) {
      if (!isTerminalStatus(internal.run.status) && this.cancel(internal.run.id, reason)) n += 1;
    }
    return n;
  }

  /** Resolve an outstanding approval. Returns false when the id is unknown. */
  resolveApproval(id: string, approved: boolean): boolean {
    const pending = this.approvals.get(id);
    if (!pending) return false;
    this.approvals.delete(id);
    pending.finish(approved);
    return true;
  }

  /** Approvals still waiting on the user, for the UI. */
  pendingApprovals(): Array<{
    id: string;
    runId: string;
    category: AgentToolCategory;
    args: Record<string, unknown>;
    /**
     * Phase 23. The tool and the operations, so a panel can re-render a pending
     * prompt from a fresh query instead of relying on having caught the event.
     */
    tool: string;
    capabilities: readonly Capability[];
    capabilityLabels: string[];
    destructive: boolean;
    escalation?: Escalation;
  }> {
    return [...this.approvals.entries()].map(([id, a]) => ({
      id,
      runId: a.runId,
      category: a.category,
      args: a.args,
      tool: a.tool,
      capabilities: a.capabilities,
      capabilityLabels: a.capabilities.map((c) => CAPABILITY_LABELS[c] ?? c),
      destructive: a.destructive,
      ...(a.escalation ? { escalation: a.escalation } : {}),
    }));
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private emit(ev: AgentEvent): void {
    try {
      this.opts.onEvent(ev);
    } catch {
      // A detached or destroyed window must never break an agent run.
    }
  }

  private snapshot(internal: InternalRun): AgentRun {
    return { ...internal.run, messages: [...internal.run.messages], trace: [...internal.run.trace] };
  }

  private setStatus(internal: InternalRun, next: AgentStatus, note?: string): void {
    const previous = internal.run.status;
    if (previous === next) return;
    const legal = canTransition(previous, next);
    if (!legal) {
      // Record the violation instead of throwing: a lifecycle bug must not
      // destroy the run the user is watching.
      this.trace(internal, { kind: "error", step: internal.currentStep, text: `Illegal transition ${previous} -> ${next}` });
    }
    internal.run.status = next;
    internal.run.updatedAt = this.opts.now();
    this.emit({ type: "state", runId: internal.run.id, status: next, previous, at: internal.run.updatedAt, note });
  }

  private trace(internal: InternalRun, entry: Omit<AgentTraceEntry, "at">): void {
    internal.run.trace.push({ at: this.opts.now(), ...entry });
    if (internal.run.trace.length > MAX_TRACE_ENTRIES) {
      internal.run.trace.splice(0, internal.run.trace.length - MAX_TRACE_ENTRIES);
    }
    internal.run.updatedAt = this.opts.now();
  }

  private status(internal: InternalRun, step: number, level: AgentStatusKind, text: string): void {
    this.trace(internal, { kind: "status", step, level, text });
    this.emit({ type: "status", runId: internal.run.id, step, level, text });
  }

  private syncMessages(internal: InternalRun): void {
    const all = internal.messages;
    internal.run.messages = all.length > MAX_RUN_MESSAGES ? all.slice(all.length - MAX_RUN_MESSAGES) : [...all];
    internal.run.steps = internal.stepCount;
    internal.run.toolCalls = internal.toolCallCount;
    internal.run.updatedAt = this.opts.now();
  }

  private enforceRetention(): void {
    const limit = this.opts.maxRetainedRuns;
    if (this.runs.size <= limit) return;
    const finished = [...this.runs.values()]
      .filter((i) => isTerminalStatus(i.run.status))
      .sort((a, b) => a.run.updatedAt - b.run.updatedAt);
    let excess = this.runs.size - limit;
    for (const internal of finished) {
      if (excess <= 0) break;
      this.runs.delete(internal.run.id);
      excess -= 1;
    }
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  private async execute(internal: InternalRun): Promise<AgentResult> {
    const startedAt = this.opts.now();
    const runId = internal.run.id;
    let watchdog: NodeJS.Timeout | null = null;
    try {
      const agent = getAgentDefinition(internal.spec.agentId);
      if (!agent) {
        throw new AgentRuntimeError(
          "config",
          `Unknown agent "${internal.spec.agentId}". Available: ${listAgentDefinitions().map((a) => a.id).join(", ")}.`,
        );
      }
      if (!internal.spec.task.trim()) {
        throw new AgentRuntimeError("config", "An agent run needs a task.");
      }

      this.setStatus(internal, "starting", `${agent.name} started`);
      this.status(internal, 0, "starting", AGENT_START_NOTE);
      this.emit({ type: "agent:started", runId: internal.run.id, agentId: internal.spec.agentId, task: internal.spec.task ?? "", at: this.opts.now() });

      const budget = mergeBudget(agent, internal.spec.budget);
      internal.budget = budget;

      const deadline = startedAt + budget.maxDurationMs;
      watchdog = setTimeout(() => {
        this.cancel(runId, `Wall-clock budget of ${Math.round(budget.maxDurationMs / 1000)}s exhausted`);
      }, budget.maxDurationMs);
      if (typeof watchdog.unref === "function") watchdog.unref();

      const result = await this.loop(internal, agent, budget, deadline);
      return this.finish(internal, result, startedAt);
    } catch (err) {
      const info: AgentErrorInfo = toAgentError(err, "internal");
      this.emit({ type: "error", runId, error: info });
      this.trace(internal, { kind: "error", step: internal.currentStep, text: info.message });
      // A cancellation that surfaced as an exception is still a cancellation.
      if (internal.controller.signal.aborted && (info.kind === "aborted" || info.kind === "timeout")) {
        return this.finish(
          internal,
          {
            runId,
            agentId: internal.spec.agentId,
            status: "cancelled",
            text: "",
            steps: internal.stepCount,
            toolCalls: internal.toolCallCount,
            durationMs: this.opts.now() - startedAt,
            cancelled: true,
            error: info,
          },
          startedAt,
        );
      }
      return this.finish(
        internal,
        {
          runId,
          agentId: internal.spec.agentId,
          status: "failed",
          text: "",
          steps: internal.stepCount,
          toolCalls: internal.toolCallCount,
          durationMs: this.opts.now() - startedAt,
          cancelled: false,
          error: info,
        },
        startedAt,
      );
    } finally {
      if (watchdog) clearTimeout(watchdog);
    }
  }

  private finish(internal: InternalRun, result: AgentResult, startedAt: number): AgentResult {
    const finalised: AgentResult = { ...result, durationMs: result.durationMs || this.opts.now() - startedAt };
    this.syncMessages(internal);
    this.setStatus(internal, finalised.status);
    internal.run.result = finalised;
    if (finalised.error) internal.run.error = finalised.error;
    internal.run.updatedAt = this.opts.now();
    this.emit({ type: "result", runId: internal.run.id, result: finalised });
      this.emit({ type: "agent:stopped", runId: internal.run.id, agentId: internal.spec.agentId, at: this.opts.now(), reason: finalised.error?.message ?? undefined });
      this.enforceRetention();
      return finalised;
  }

  /**
   * Phase 28. Compress what is about to be shipped, if and only if it is over
   * budget — and never touch the log.
   *
   * The distinction is the point of the phase: `messages` is the run's record of
   * what was said, and it is what `AgentRun.messages` and the session store keep,
   * while the array this returns is only what one HTTP request will carry. A
   * compacted run therefore loses nothing it can be held accountable for — the
   * run record still has every message, and `run.compaction` says exactly what
   * was sent instead and why.
   *
   * Emitted on every compacted pass rather than once, because each pass is a
   * real compression of a payload the model was about to receive. The panel
   * decides how many times to show it; `passes` on the record keeps the count.
   */
  private compactForTransport(internal: InternalRun, messages: AgentMessage[], step: number): AgentMessage[] {
    const result = compactMessages(messages, {
      budget: this.opts.compactionBudget ?? DEFAULT_COMPACTION_BUDGET,
      salient: internal.salient,
      now: this.opts.now,
    });
    if (!result.compacted) return messages;

    const previous = internal.run.compaction;
    const record: CompactionRecord = {
      ...result.record,
      at: previous?.at ?? result.record.at,
      passes: (previous?.passes ?? 0) + 1,
      step,
    };
    internal.run.compaction = record;
    if (!previous) {
      // Phase 28. One trace line per run, not per pass — the record's `passes`
      // keeps the count, and the panel shows the same sentence the renderer
      // would write. Recorded on the run record itself (not only emitted) so
      // every snapshot carries it no matter how events and the run list
      // interleave; the renderer's event handler appends the same line on first
      // sight, guarded by the identical `!existing.compaction` condition, so the
      // two paths can never double it.
      this.trace(internal, { kind: "compaction", step, text: compactionNotice(record) });
    }
    this.emit({ type: "compaction", runId: internal.run.id, step, record });
    return result.messages;
  }

  private buildInitialMessages(internal: InternalRun, agent: AgentDefinition): AgentMessage[] {
    const extras: string[] = [];
    extras.push(
      `Active agent: ${agent.name} (id: ${agent.id}).` +
        (agent.readOnly ? " You are read-only and must not attempt to change anything." : ""),
    );
    if (agent.systemPrompt.trim()) extras.push(agent.systemPrompt.trim());
    // Phase 31. The skill index: what workflows exist, one line each, so the
    // model can ask for one by name instead of being told to use one it has
    // never heard of. Bodies are loaded on invocation, never here.
    if (this.opts.skills) {
      const skills = this.opts.skills(internal.spec.workspace);
      if (skills.length > 0) {
        const lines = skills.map(
          (s) =>
            `- ${s.name}: ${s.description || "(no description)"}` +
            (s.allowedTools ? ` [restricted to: ${s.allowedTools.join(", ")}]` : ""),
        );
        extras.push(`Available skills (invoke with the use_skill tool to load one):\n${lines.join("\n")}`);
      }
    }
    const ctx = (internal.spec.context ?? "").trim();
    if (ctx) {
      extras.push(
        `CloseCode is sharing editor context with you. Use it to answer precisely:\n\n${ctx}\n\n[end of context]`,
      );
    }
    const system = extras.length > 0 ? `${BASE_SYSTEM_PROMPT}\n\n${extras.join("\n\n")}` : BASE_SYSTEM_PROMPT;

    const messages: AgentMessage[] = [{ role: "system", content: system }];
    for (const turn of internal.spec.history ?? []) {
      if (!turn.content) continue;
      messages.push({ role: turn.role, content: turn.content });
    }
    if (internal.spec.task) messages.push({ role: "user", content: internal.spec.task });
    return messages;
  }

  private async loop(
    internal: InternalRun,
    agent: AgentDefinition,
    budget: AgentBudget,
    deadline: number,
  ): Promise<AgentResult> {
    const runId = internal.run.id;
    const spec = internal.spec;
    const signal = internal.controller.signal;

    // The run is genuinely working from here on, so the lifecycle must say so.
    // Without this the run sits in `starting` for its whole life and a run that
    // is blocked on an approval can never legally reach `awaiting_approval`.
    this.setStatus(internal, "running", `${agent.name} is working`);

    const messages = this.buildInitialMessages(internal, agent);
    internal.messages = messages;
    this.syncMessages(internal);

    const resolved = this.opts.registry.resolveFor(agent);
    const transport = this.opts.createTransport({
      url: spec.endpoint.url,
      model: spec.endpoint.model,
      key: spec.endpoint.key,
    });

    const maxSteps = budget.maxSteps;
    let finalText = "";

    for (let step = 0; step < maxSteps; step += 1) {
      if (signal.aborted) return this.cancelledResult(internal, finalText);
      internal.currentStep = step;
      this.status(internal, step, "thinking", `Step ${step + 1} of ${maxSteps}: deciding what to do.`);

      // Phase 28. Compaction is applied at the *shipping point*, never to the
      // log: `messages` stays the full record of what was said, and only the
      // array handed to the transport is compressed.
      const outbound = this.compactForTransport(internal, messages, step);

      const completion = await transport({
        model: spec.endpoint.model,
        messages: outbound.map((m) => ({ ...m })),
        tools: resolved.tools.length > 0 ? resolved.tools : undefined,
        temperature: spec.temperature,
        stream: spec.stream,
        timeoutMs: spec.timeoutMs,
        signal,
        onDelta: (delta) => this.emit({ type: "delta", runId, step, delta }),
        onReasoning: (text) => this.status(internal, step, "thinking", firstLine(text) || "Thinking…"),
      });

      if (signal.aborted) return this.cancelledResult(internal, finalText);
      internal.stepCount = step + 1;

      if (completion.reasoning) {
        this.status(internal, step, "thinking", firstLine(completion.reasoning));
      }
      if (completion.content) finalText = completion.content;

      if (completion.toolCalls.length === 0) {
        const text = completion.content || "(empty response)";
        this.status(internal, step, "observing", "Run finished.");
        return {
          runId,
          agentId: agent.id,
          status: "completed",
          text,
          steps: internal.stepCount,
          toolCalls: internal.toolCallCount,
          durationMs: 0,
          cancelled: false,
        };
      }

      messages.push({ role: "assistant", content: completion.content || "", tool_calls: completion.toolCalls });
      this.emit({ type: "message", runId, message: messages[messages.length - 1] });
      this.syncMessages(internal);

      for (const call of completion.toolCalls) {
        if (signal.aborted) return this.cancelledResult(internal, finalText);
        if (internal.toolCallCount >= budget.maxToolCalls) {
          throw new AgentRuntimeError(
            "budget",
            `The agent exceeded its budget of ${budget.maxToolCalls} tool calls. Ask for a narrower task.`,
          );
        }

        const { args, parseError } = parseArgs(call.arguments);
        this.status(internal, step, "acting", `Running ${call.name}…`);
        this.emit({ type: "tool:started", runId: internal.run.id, step, tool: call.name, at: this.opts.now() });

        const toolCtx = this.makeToolContext(internal, agent, budget, deadline, call.name);
        const startedTool = this.opts.now();
        let outcome: AgentToolOutcome;
        // Set when the run was stopped while the tool was still running. The tool
        // is recorded as denied, then the loop unwinds — a stopped run must not
        // carry on talking to the model.
        let stoppedMidTool = false;

        // Phase 24. The agent's own tool policy, checked *here*, before the
        // registry is asked to find the tool at all.
        //
        // `resolveFor` decides which tools a model is *shown*, and until now
        // that was the only thing it decided. A model is not obliged to call
        // from the list it was given: it can name any tool it has seen in
        // training, and `registry.invoke` would look it up and run it. So
        // `readOnly: true` was a suggestion in a system prompt, and the Plan
        // agent — documented as unable to change anything, so that "a plan can
        // never be half-applied" — could be talked into writing a file by
        // simply asking for one. With `files: allow` it did so with no prompt
        // at all.
        //
        // A permission the model can talk its way past is not a permission, so
        // the policy is now enforced at the one door every call already goes
        // through. This sits *above* the Phase 23 capability gate on purpose:
        // that gate asks "may this operation be permitted?", this asks "is this
        // operation one this agent does at all?". A read-only agent must not be
        // able to reach the prompt for a write by asking for a write, and it
        // must not be able to reach a tool it was never offered.
        const policyRefusal = this.agentPolicyRefusal(agent, resolved.names, call.name);
        // Phase 31. The active skill's restriction sits *beside* the agent
        // policy: the policy asks "is this the agent's tool?", the restriction
        // asks "is this tool in the skill the user approved?", and both must
        // pass. Narrow-only — a restriction cannot un-refuse anything either
        // the policy or the gate refuses. `use_skill` itself stays reachable
        // so the model can switch skills or clear the restriction.
        const skillRefusal =
          !policyRefusal && internal.skillRestriction && call.name !== "use_skill" && !internal.skillRestriction.tools.has(call.name)
            ? ({
                granted: false,
                status: "denied",
                text:
                  `The active skill "${internal.skillRestriction.name}" does not include "${call.name}" in its allowed tools, so that call did not run. ` +
                  `Work within: ${[...internal.skillRestriction.tools].join(", ")} — or finish the skill's workflow first.`,
                error: toolError("skill_restriction", `"${call.name}" is outside the active skill's allowed tools.`, {
                  hint: `The skill allows: ${[...internal.skillRestriction.tools].join(", ")}`,
                  data: { skill: internal.skillRestriction.name, tool: call.name },
                }),
              } as AgentToolOutcome)
            : null;
        if (policyRefusal) {
          outcome = policyRefusal;
        } else if (skillRefusal) {
          outcome = skillRefusal;
        } else {
          try {
            // `ToolRegistry.invoke` is the validated, timed, error-contained door
            // every tool call goes through; `raceAbort` on top of it is what makes
            // Stop immediate even for a tool that ignores its own signal.
            outcome = await raceAbort(this.opts.registry.invoke(call.name, args, toolCtx), signal);
          } catch (err) {
            if (signal.aborted) {
              stoppedMidTool = true;
              outcome = { granted: false, text: internal.cancelReason ?? "Stopped while the tool was running." };
            } else {
              // Reaching here means the registry itself failed, not the tool:
              // `invoke` contains a throwing tool. So this *is* an internal
              // failure and is reportable.
              const info = toAgentError(err, "tool", call.name);
              outcome = { granted: true, text: `Error in ${call.name}: ${info.message}` };
              this.emit({ type: "error", runId, error: info });
            }
          }
        }
        const elapsed = this.opts.now() - startedTool;
        internal.toolCallCount += 1;

        // Phase 22. A tool that failed because the model called it wrongly —
        // bad arguments, no such file, a branch that does not exist — is
        // feedback *for the model*, not something wrong with the app. Those
        // outcomes arrive here already contained by `ToolRegistry.invoke`, and
        // raising a run-level error for them would put a red banner in front of
        // the user every time the model made an ordinary mistake. Only a genuine
        // internal failure, which the registry marks `reportable`, surfaces.
        if (outcome.error?.reportable === true) {
          this.emit({ type: "error", runId, error: toAgentError(new Error(outcome.error.message), "tool", call.name) });
          this.emit({ type: "tool:failed", runId, step, tool: call.name, error: { code: "tool_error", message: outcome.error.message, recoverable: true }, at: this.opts.now() });
        }

        // Phase 23. A refusal carries the reason on the event rather than in
        // `result`: the tool authored `result`, several Phase 21/22 strings are
        // asserted byte-for-byte, and the model already has a truthful "denied"
        // to work from. The *user* is the one who needs "which permission, and
        // enable it where" — and the run record needs it to be replayable.
        //
        // The gate's reason wins over the generic "Permission denied by policy
        // or user." the tool emits, but only the message is replaced: the code
        // and hint come from the tool, so a denial stays a `permission_denied`
        // rather than being reclassified here.
        //
        // Phase 24 widened the condition. This used to attach an error *only*
        // when the gate had spoken, which was correct while the gate was the only
        // thing that could refuse a call — but the agent-policy refusal never
        // goes near the gate, so its `agent_policy` code and the `data` naming
        // the agent and the tool were reaching the model and nothing else. The
        // UI and a stored run record would have shown a bare "denied" for a
        // refusal the app can describe precisely. So the outcome's own error is
        // now carried whenever there is one. A granted call still carries none,
        // which is the case the Phase 23 suite pins: a stale reason must not leak
        // onto a later success.
        //
        // Built with an `if` rather than a spread of a conditional object, so
        // `message` stays required in the type instead of becoming optional.
        let toolEventError: ToolError | undefined;
        if (!outcome.granted) {
          // A denial with no error of its own is a tool that only returned
          // `granted: false`. Its own text is then the most honest message
          // available; if the gate spoke, this is replaced just below.
          const base: ToolError = outcome.error ?? { code: "permission_denied", recoverable: true, message: outcome.text };
          toolEventError = internal.denialReason ? { ...base, message: internal.denialReason } : base;
        }

        this.emit({
          type: "tool",
          runId,
          step,
          tool: call.name,
          args,
          result: outcome.text.slice(0, TOOL_EVENT_SUMMARY_CHARS),
          granted: outcome.granted,
          ms: elapsed,
          status: outcome.status ?? (outcome.granted ? "ok" : "denied"),
          ...(toolEventError ? { error: toolEventError } : {}),
          destructive: this.opts.registry.get(call.name)?.destructive === true,
        });
        this.emit({ type: "tool:completed", runId, step, tool: call.name, result: outcome.text, granted: outcome.granted, ms: elapsed, at: this.opts.now() });
        if (!outcome.granted) {
          this.emit({ type: "tool:failed", runId, step, tool: call.name, error: { code: "permission_denied", message: outcome.text || "Tool denied", recoverable: true }, at: this.opts.now() });
        }
        this.trace(internal, {
          kind: "tool",
          step,
          tool: call.name,
          granted: outcome.granted,
          ms: elapsed,
          text: this.summarizeTool(call.name, outcome, parseError),
        });
        this.syncMessages(internal);
        if (stoppedMidTool) return this.cancelledResult(internal, finalText);

        const toolContent = parseError
          ? `Error: ${parseError}`
          : JSON.stringify(outcome.text).slice(0, TOOL_MESSAGE_CHARS);
        const toolMessage: AgentMessage = {
          role: "tool",
          tool_call_id: call.id,
          name: call.name,
          content: toolContent,
        };
        messages.push(toolMessage);
        // Phase 28. A result that was not a clean `ok` is the one thing in the
        // live window compaction must not summarise its way past — a denied or
        // failed call is usually the reason the next step happened. Marked on
        // the message object itself so the mark survives `syncMessages`
        // re-slicing the array.
        const toolStatus = outcome.status ?? (outcome.granted ? "ok" : "denied");
        if (toolStatus !== "ok" || parseError) internal.salient.add(toolMessage);
        this.emit({ type: "message", runId, message: messages[messages.length - 1] });
      }
    }

    throw new AgentRuntimeError(
      "budget",
      `The agent reached its limit of ${maxSteps} steps without finishing. Ask it to continue or narrow the task.`,
    );
  }

  private summarizeTool(name: string, outcome: AgentToolOutcome, parseError?: string): string {
    if (parseError) return `${name}: ${parseError}`;
    if (!outcome.granted) return "denied by permission.";
    const head = outcome.text.trim().split("\n")[0] ?? "";
    const clipped = head.length > 120 ? `${head.slice(0, 119)}…` : head;
    return clipped || "done.";
  }

  private cancelledResult(internal: InternalRun, text: string): AgentResult {
    return {
      runId: internal.run.id,
      agentId: internal.spec.agentId,
      status: "cancelled",
      text,
      steps: internal.stepCount,
      toolCalls: internal.toolCallCount,
      durationMs: 0,
      cancelled: true,
      error: {
        kind: "aborted",
        message: internal.cancelReason ?? "The agent run was cancelled.",
        recoverable: true,
        at: this.opts.now(),
      },
    };
  }

  private makeToolContext(
    internal: InternalRun,
    agent: AgentDefinition,
    budget: AgentBudget,
    deadline: number,
    toolName: string,
  ): AgentToolContext {
    const run = internal;
    // Phase 22. The tool name is resolved here, once, so the permission request
    // can name the actual operation ("write_file — overwrites a file") rather
    // than only the category. The gate itself is untouched: same policy, same
    // timeout, same cancellation. This only improves what the user is asked to
    // judge, which is the difference between an informed "Approve" and a blind
    // one.
    const descriptor = this.opts.registry.get(toolName);
    return {
      runId: internal.run.id,
      agentId: agent.id,
      workspace: internal.spec.workspace,
      signal: internal.controller.signal,
      deadline,
      maxOutputChars: budget.maxToolOutputChars,
      authorize: async (category, args, request) =>
        this.authorize(
          run,
          category,
          args,
          descriptor?.name ?? toolName,
          descriptor?.destructive === true,
          descriptor,
          request,
        ),
      log: (text, level) => this.status(run, run.currentStep, level ?? "acting", text),
      spawnChild: (agentId, task) => this.spawnChild(run, agent, agentId, task),
      spawnChildren: (batch) => this.spawnChildren(run, agent, batch),
      confine: (p) => confineToWorkspace(p, internal.spec.workspace),
      // Phase 31. A skill narrows the run's remaining calls. This writes run
      // state; the enforcement lives in the loop (see `skillRefusal`), so a
      // tool cannot "restrict" anything without the run recording it.
      restrictTools: (names, skillName) => {
        internal.skillRestriction = names ? { name: skillName ?? "the active skill", tools: new Set(names) } : null;
        this.trace(internal, {
          kind: "status",
          step: run.currentStep,
          text: names
            ? `Skill "${internal.skillRestriction?.name}" restricts this run to: ${names.join(", ")}`
            : "Skill restriction cleared.",
        });
      },
      // Phase 22: injected, never read from disk here. A unit test that builds a
      // runtime without it gets `web_search` refusing with "no key configured",
      // which is the honest behaviour and is exercised by the suites.
      ...(this.opts.webSearch ? { webSearch: this.opts.webSearch } : {}),
      // Phase 32: the research pipeline, injected the same way — absent means
      // `research_start` refuses rather than pretending to research.
      ...(this.opts.research ? { research: this.opts.research } : {}),
    };
  }

  /**
   * The single permission gate.
   *
   * Phase 11 shape, unchanged in outcome: `allow` passes, `deny` refuses, `ask`
   * blocks on the user (with a timeout that resolves to a refusal so an
   * unattended run can never hang forever).
   *
   * Phase 23 narrows *what* is being allowed. The mode is now resolved per
   * capability rather than per category, so a call needs every capability it
   * touches to pass and one refusal to fail. Three rules hold no matter how the
   * policy is configured, and each has a test that fails if it regresses:
   *
   *   1. A category set to `deny` still denies every capability under it. The
   *      Phase 11/22 category map is a floor, not a legacy path — otherwise
   *      adding scopes would quietly un-deny things the user had blocked.
   *   2. A capability set to `allow` can still be escalated to `ask` by a
   *      destructive command, a path outside the workspace, or a destructive
   *      tool. Escalation only ever narrows.
   *   3. Irreversible capabilities default to `deny`, so a capability nobody has
   *      an opinion about is blocked rather than assumed safe.
   */
  /**
   * Phase 24. Refuse a tool this agent was never offered, or return `null` to let
   * the call proceed to the capability gate.
   *
   * One question only: **is this tool part of the agent's job at all?**
   * `resolveFor` already decided that, from the definition's `tools` allow-list,
   * `readOnly` flag and `delegates`. A Plan agent has no `write_file`; a Debug
   * agent has no `git_commit`. That is a property of the agent, not of the
   * user's settings, so it is checked before the capability gate and cannot be
   * prompted past. Phase 23's gate then asks the separate question "may this
   * operation be permitted?", and runs only if this one passed.
   *
   * A *nonexistent* tool is deliberately not handled here. `ToolRegistry.invoke`
   * already answers that, with the wording the existing suites assert, and
   * duplicating it in the runtime would mean two owners for one question — and
   * would change a message that was already right. So an unknown name falls
   * through to the registry, and this method only speaks about tools that exist
   * but were withheld from this agent.
   *
   * The refusal is marked recoverable on purpose: a model reaching for a tool it
   * was not offered has usually simply guessed (models are trained on tool names
   * from elsewhere), so telling it what it *does* have lets it correct itself on
   * the next step instead of abandoning the task.
   */
  private agentPolicyRefusal(agent: AgentDefinition, allowed: readonly string[], toolName: string): AgentToolOutcome | null {
    if (allowed.includes(toolName)) return null;
    // Not this agent's tool, or not a tool at all. The registry owns the second.
    if (!this.opts.registry.names().includes(toolName)) return null;

    const readOnlyNote = agent.readOnly
      ? ` The ${agent.name} is read-only, so it cannot make changes.`
      : ` The ${agent.name} does not use this tool.`;
    const allowedHint = allowed.slice(0, 24).join(", ");
    return {
      granted: false,
      status: "denied",
      text:
        `The ${agent.name} cannot use "${toolName}", so that call did not run.${readOnlyNote} ` +
        `Work within the tools you have: ${allowedHint}. ` +
        `If the task genuinely needs this tool, stop and tell the user which one is missing.`,
      error: toolError("agent_policy", `The ${agent.name} is not allowed to use "${toolName}".`, {
        hint: `This agent can use: ${allowedHint}`,
        // Enough to tell the user *which* agent and *which* tool, without
        // pretending the run failed for an unrelated reason.
        data: { agentId: agent.id, tool: toolName, readOnly: agent.readOnly === true, allowed: allowedHint },
      }),
    };
  }

  private async authorize(
    internal: InternalRun,
    category: AgentToolCategory,
    args: Record<string, unknown>,
    toolName: string,
    destructive: boolean,
    descriptor?: AgentTool,
    request?: AgentPermissionRequest,
  ): Promise<boolean> {
    if (internal.controller.signal.aborted) return false;

    const verdict = this.evaluate(internal, category, args, toolName, destructive, descriptor, request);
    if (!verdict.allowed) {
      // Recorded on the run, not on a tool result: the gate is called from inside
      // a tool, so the tool's own denial text is already fixed by the time the
      // runtime sees the outcome. The next tool event for this run carries the
      // explanation.
      internal.denialReason = verdict.reason ?? `Permission denied for ${category}.`;
      return false;
    }
    internal.denialReason = null;
    if (verdict.mode === "allow") return true;
    return this.requestApproval(
      internal,
      category,
      args,
      toolName,
      destructive,
      verdict.capabilities,
      verdict.escalation,
    );
  }

  /**
   * Work out what a call needs and what it gets. Pure with respect to the
   * outside world — no prompt, no side effect — so it is the half of the gate
   * that can be tested directly.
   */
  private evaluate(
    internal: InternalRun,
    category: AgentToolCategory,
    args: Record<string, unknown>,
    toolName: string,
    destructive: boolean,
    descriptor?: AgentTool,
    request?: AgentPermissionRequest,
  ): PermissionVerdict {
    const capabilities = this.capabilitiesFor(
      category,
      toolName,
      args,
      descriptor,
      request,
      internal.spec.workspace,
    );

    // The category mode is a floor applied first, so a scoped rule can never
    // re-enable something the user's category-level setting blocked.
    const categoryMode = internal.spec.permissions?.[category] ?? "ask";

    const policy: PermissionPolicy = internal.spec.policy ?? emptyPolicy();
    const ctx = {
      agentId: internal.run.agentId,
      workspace: internal.spec.workspace,
      path: request?.path ?? null,
    };

    let denied: Capability | null = null;
    let asked: Capability | null = null;
    let escalation: Escalation | undefined;

    for (const capability of capabilities) {
      const resolved = resolveCapabilityDetailed(policy, capability, ctx);
      let mode = resolved.mode;

      // Rule 1: the category floor, in both directions. Shared with
      // `effectiveCeiling` so a child's inherited ceiling is computed from the
      // same rule the gate applies — see `applyCategoryFloor` for why each
      // direction is what it is.
      mode = applyCategoryFloor(mode, resolved, capability, category, categoryMode);

      // Rule 1b, Phase 25: the ceiling inherited from the run that spawned this
      // one. A nested run may be narrower than its parent by its own tool policy
      // and by the user's settings, but never wider than the parent actually was.
      //
      // Placed after the category floor so a child cannot use an inherited
      // ceiling to *raise* a category the user blocked, and before escalation so
      // that an `allow` which survives the ceiling still gets its irreversible-
      // operation check.
      const ceiling = internal.spec.permissionCeiling?.[capability];
      if (ceiling !== undefined && mode !== "deny") mode = clampToCeiling(mode, ceiling);

      // Rule 2: escalation. A capability that destroys data or leaves the
      // workspace is never allowed silently, however it was configured. Only
      // applied to a capability that would otherwise have passed, which is the
      // whole point of it — and it can only narrow.
      if (mode === "allow") {
        const why = this.escalationReason(capability, args, toolName, internal.spec.workspace);
        if (why) {
          escalation = { capability, mode: "ask", reason: why };
          mode = escalateMode(mode, escalation);
        }
      }

      if (mode === "deny" && denied === null) denied = capability;
      else if (mode === "ask" && asked === null) asked = capability;
    }

    if (denied) {
      return {
        allowed: false,
        mode: "deny",
        capabilities,
        reason:
          `"${denied}" is not permitted for the ${category} category, so ${toolName} cannot run. ` +
          // Named on purpose: a model that only knows "denied" will either retry
          // or give up, and a user reading the transcript has no way to act on
          // it. Saying where the switch lives is the difference between a
          // blocked operation and an unexplained one.
          `Ask the user to allow "${denied}" under Agent permissions, or use a different approach. ` +
          `Do not retry this call unchanged.`,
      };
    }
    if (asked) {
      return { allowed: true, mode: "ask", capabilities, escalation };
    }
    return { allowed: true, mode: "allow", capabilities };
  }

  /**
   * The full capability set for one call: the tool's declared ones, the
   * category's defaults if it declares none, plus whatever this specific call
   * adds.
   *
   * All three sources are unioned, never intersected. A tool that declares
   * `files.read` and asks for `files.write` is checked for both; dropping the
   * declaration because a call added something would be a silent under-check.
   */
  private capabilitiesFor(
    category: AgentToolCategory,
    toolName: string,
    args: Record<string, unknown>,
    descriptor: AgentTool | undefined,
    request: AgentPermissionRequest | undefined,
    workspace: string | null,
  ): Capability[] {
    const declared = descriptor?.capabilities ?? CATEGORY_CAPABILITIES[category] ?? [];
    const extra = request?.capabilities ?? [];
    const seen = new Set<Capability>();
    const out: Capability[] = [];
    for (const c of [...declared, ...extra]) {
      if (seen.has(c)) continue;
      seen.add(c);
      out.push(c);
    }
    // A terminal command is inspected here rather than in the tool, so the
    // detection is a property of the *gate* and cannot be skipped by a tool that
    // forgets to check. A tool whose own category is not terminal is left alone.
    if (category === "terminal" && !seen.has("shell.dangerous")) {
      const hit = detectDangerousCommand(String(args.command ?? ""));
      if (hit) {
        seen.add("shell.dangerous");
        out.push("shell.dangerous");
      }
    }
    // Reading or writing outside the workspace needs its own permission, and the
    // path is only known per call.
    if (request?.path && isOutsideWorkspace(request.path, workspace)) {
      const askedFor = request.capabilities ?? [];
      // Deleting counts as a write outside the workspace; there is no
      // `external.delete`, because the write is the thing being permitted.
      const mutating = askedFor.includes("files.write") || askedFor.includes("files.delete");
      const needed: Capability = mutating ? "external.write" : "external.read";
      if (!seen.has(needed)) {
        seen.add(needed);
        out.push(needed);
      }
    }
    return out;
  }

  /**
   * Why an otherwise-allowed capability still needs a human.
   *
   * Only consulted for capabilities that resolved to `allow`, so these are
   * exactly the calls a user would otherwise never be asked about.
   *
   * The trigger is the *capability*, not the tool's `destructive` flag. That flag
   * describes the tool in general; escalating on it would mean `files: allow`
   * still prompted for every ordinary `write_file`, which is the user being
   * told their own setting is being ignored. What genuinely warrants a prompt is
   * an operation that destroys data or leaves the workspace — and those are
   * named capabilities, so the rule is checkable rather than a judgement call.
   */
  private escalationReason(
    capability: Capability,
    args: Record<string, unknown>,
    toolName: string,
    workspace: string | null,
  ): string | null {
    if (capability === "shell.dangerous") {
      const hit = detectDangerousCommand(String(args.command ?? ""));
      if (hit) return `The command ${hit.why} (\`${hit.sample}\`).`;
      return "The command matches the destructive-command list.";
    }
    if (capability === "files.delete") return `${toolName} deletes files, which cannot be undone from here.`;
    if (capability === "git.history") return `${toolName} discards git work that cannot be recovered.`;
    if (capability === "external.read") return `This reads outside the workspace (${workspace ?? "no workspace open"}).`;
    if (capability === "external.write") return `This writes outside the workspace (${workspace ?? "no workspace open"}).`;
    return null;
  }

  private requestApproval(
    internal: InternalRun,
    category: AgentToolCategory,
    args: Record<string, unknown>,
    toolName: string,
    destructive: boolean,
    capabilities: readonly Capability[] = [],
    escalation?: Escalation,
  ): Promise<boolean> {
    const id = `appr-${this.opts.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.setStatus(internal, "awaiting_approval", `Waiting for your approval to use ${category}`);
    this.status(internal, internal.currentStep, "waiting", `Approval required for ${category}.`);

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (approved: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.approvals.delete(id);
        const idx = internal.onCancel.indexOf(unblock);
        if (idx >= 0) internal.onCancel.splice(idx, 1);
        if (internal.run.status === "awaiting_approval") this.setStatus(internal, "running");
        if (!approved) this.status(internal, internal.currentStep, "observing", `You denied ${category}.`);
        resolve(approved);
      };
      const unblock = (): void => finish(false);
      const timer = setTimeout(() => finish(false), this.opts.approvalTimeoutMs);
      if (typeof timer.unref === "function") timer.unref();

      this.approvals.set(id, {
        runId: internal.run.id,
        category,
        args,
        tool: toolName,
        capabilities,
        destructive,
        ...(escalation ? { escalation } : {}),
        finish,
      });
      internal.onCancel.push(unblock);
      // `tool` is the tool's real name, not the category. Phase 21 put the
      // category in both fields, which made the UI prompt read "wants to use
      // files" — technically true and useless to the person being asked.
      this.emit({
        type: "approval",
        runId: internal.run.id,
        id,
        tool: toolName,
        category,
        args,
        destructive,
        capabilities,
        // Resolved here, from the same table the gate reads, so the words on the
        // prompt are the words the policy is written in.
        capabilityLabels: capabilities.map((c) => CAPABILITY_LABELS[c] ?? c),
        ...(escalation ? { escalation } : {}),
      });
    });
  }

  /**
   * The most permissive mode this run could ever obtain, per capability, computed
   * exactly the way the gate computes it for a call the user never sees — but
   * without the per-call escalation check.
   *
   * Escalation is left out on purpose: it depends on a specific call's arguments
   * (`rm -rf` versus `echo`), so it cannot be collapsed into a per-capability
   * number. Omitting it makes the ceiling *more* permissive than the parent in
   * exactly the cases the child will re-check for itself anyway, so nothing is
   * lost by leaving it out.
   *
   * This is what stops a sub-agent from being more capable than the parent that
   * spawned it. Without it, a child resolves against its own agent id — which has
   * no rules of its own — and falls back to the project and global scopes, where
   * the parent's agent-specific restriction may simply not exist.
   *
   * The category floor is applied here for the same reason the gate applies it:
   * it is part of what the parent was actually allowed, so it is part of what the
   * child may inherit. A capability covered by more than one category takes the
   * strictest, matching the gate's single-category case.
   */
  private effectiveCeiling(internal: InternalRun): Partial<Record<Capability, PermissionMode>> {
    const policy: PermissionPolicy = internal.spec.policy ?? emptyPolicy();
    const ctx = {
      agentId: internal.run.agentId,
      workspace: internal.spec.workspace,
      path: null,
    };
    const ceiling: Partial<Record<Capability, PermissionMode>> = {};
    for (const capability of ALL_CAPABILITIES) {
      const resolved = resolveCapabilityDetailed(policy, capability, ctx);
      let mode = resolved.mode;
      for (const category of CATEGORY_FOR_CAPABILITY.get(capability) ?? []) {
        mode = applyCategoryFloor(mode, resolved, capability, category, internal.spec.permissions?.[category]);
      }
      ceiling[capability] = mode;
    }
    return ceiling;
  }

  /**
   * Start a nested run. Depth, the parent's `delegates` allow-list, the parent's
   * permission ceiling and three separate resource caps are all enforced here.
   */
  private async spawnChild(
    parent: InternalRun,
    parentAgent: AgentDefinition,
    agentId: string,
    task: string,
  ): Promise<AgentResult> {
    const child = getAgentDefinition(agentId);
    if (!child) {
      throw new AgentRuntimeError("config", `Unknown sub-agent "${agentId}".`);
    }
    // Phase 25. A subagent may not itself delegate. Depth already stops the
    // nesting, but refusing at the definition is the honest statement of intent
    // rather than a consequence of an integer: no role in `subagents.ts` sets
    // `delegates`, and this is what makes that stay true.
    if (child.kind === "subagent" && (child.delegates ?? []).length > 0) {
      throw new AgentRuntimeError(
        "config",
        `"${agentId}" is a sub-agent and is not allowed to delegate further.`,
      );
    }
    const allowed = parentAgent.delegates ?? [];
    if (!allowed.includes(agentId)) {
      throw new AgentRuntimeError(
        "config",
        `The ${parentAgent.name} is not allowed to delegate to "${agentId}". Allowed: ${allowed.join(", ") || "none"}.`,
      );
    }
    const maxDepth = Math.max(1, parentAgent.maxDepth ?? 0);
    const depth = (parent.run.depth || 0) + 1;
    if (depth > maxDepth) {
      throw new AgentRuntimeError("budget", `Sub-agent nesting is limited to ${maxDepth} level(s).`);
    }
    if (!task.trim()) {
      throw new AgentRuntimeError("config", "A delegated sub-task must not be empty.");
    }
    if (parent.childrenSpawned >= MAX_CHILDREN_PER_RUN) {
      throw new AgentRuntimeError(
        "budget",
        `This run has already started its maximum of ${MAX_CHILDREN_PER_RUN} sub-agents. ` +
          `Do the remaining work yourself, or report what is left.`,
      );
    }
    if (this.activeRunCount() >= MAX_CONCURRENT_RUNS) {
      throw new AgentRuntimeError(
        "budget",
        `CloseCode already has ${MAX_CONCURRENT_RUNS} agent runs in flight. ` +
          `Wait for the current ones to finish before starting another.`,
      );
    }

    // Phase 25. Freeze the parent's permissions as this child's ceiling. Taken
    // once, at spawn time, so the ceiling describes what the parent was allowed
    // when it decided to delegate rather than drifting if the user edits policy
    // mid-run.
    const ceiling = this.effectiveCeiling(parent);

    // Phase 26. A sub-agent gets its *own* context, assembled for its own task
    // rather than a copy of the parent's. The parent's block was ranked against
    // the parent's request, so handing it over unchanged would give the child the
    // parent's five most relevant files instead of its own — which is how a
    // reviewer ends up reviewing the wrong file. It shares the editor snapshot,
    // because there is one editor and both are looking at it.
    //
    // Failure here must never fail the delegation: context is an improvement, a
    // child that cannot assemble any is still a working child.
    const childContext = await this.buildChildContext(parent, agentId, task);
    if (childContext) {
      this.status(parent, parent.currentStep, "thinking", `Assembled ${childContext.summary.totalChars} characters of context for ${agentId}.`);
    }

    const childSpec: AgentRunSpec = {
      ...parent.spec,
      runId: undefined,
      agentId,
      task,
      // Phase 26. Was `undefined` from Phase 25 to Phase 26, which is why a
      // delegated sub-agent had no project context at all.
      context: childContext?.text ?? "",
      ...(childContext ? { contextSummary: childContext.summary } : {}),
      history: [],
      parentRunId: parent.run.id,
      depth,
      // `maxSteps` can only ever go down for a child: a definition may ask for
      // more than the parent had, and the parent's own budget stays the bound.
      budget: { ...parent.budget, maxSteps: Math.min(parent.budget.maxSteps, MAX_SUBAGENT_STEPS) },
      permissionCeiling: ceiling,
      permissionContext: { agentId, workspace: parent.spec.workspace, nested: true },
    };
    const { runId: childId, done } = this.start(childSpec);
    parent.childRunIds.add(childId);
    parent.childrenSpawned += 1;
    // Drop the reference once the child lands, so a long-lived parent does not
    // accumulate ids for runs that finished long ago.
    void done.catch(() => undefined).finally(() => parent.childRunIds.delete(childId));
    return done;
  }

  /**
   * Phase 26. Assemble a sub-agent's context.
   *
   * Returns `null` — never throws — when there is nothing to do, so that a
   * delegation is never lost to a context failure. Three cases produce `null`:
   *
   *   * no engine is wired, which is the normal case in unit tests;
   *   * the user turned context off for the parent, and that choice is inherited
   *     rather than quietly reversed by delegating;
   *   * the engine produced nothing worth sending (`status: "empty"`), or the
   *     parent was cancelled mid-assembly.
   *
   * The parent controller is *not* passed as the signal. A sub-agent outlives
   * individual parent steps, and the parent's `AbortController` belongs to the
   * parent's run: binding a child's assembly to it would abandon the child
   * whenever the parent's transport call that spawned it returned. The parent
   * cancelling does stop the child — that is handled by the cancel cascade — but
   * through a different mechanism and on purpose.
   */
  private async buildChildContext(
    parent: InternalRun,
    agentId: string,
    task: string,
  ): Promise<ContextBuildResult | null> {
    const engine = this.opts.contextEngine;
    if (!engine) return null;
    if (parent.spec.contextEnabled === false) return null;
    try {
      const bundle = await engine.build({
        agentId,
        task,
        workspace: parent.spec.workspace,
        snapshot: parent.spec.snapshot ?? null,
        budget: CHILD_CONTEXT_BUDGET,
        childOf: parent.run.id,
      });
      if (bundle.summary.status !== "built" || !bundle.text.trim()) return null;
      return { text: bundle.text, summary: bundle.summary };
    } catch (err) {
      // Recorded on the parent's trace rather than swallowed silently, so a
      // sub-agent that ran without context is explainable after the fact.
      this.trace(parent, {
        kind: "error",
        step: parent.currentStep,
        text: `Context assembly for ${agentId} failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return null;
    }
  }

  /**
   * Phase 25. Run a batch of delegations with a bounded number in flight.
   *
   * Results come back in the order they were requested, including for the slots
   * that failed. That matters more than it looks: a shorter array would shift
   * every later answer onto the wrong task, and a parent that trusted the
   * positional order would act on a review as if it were a test report.
   */
  private async spawnChildren(
    parent: InternalRun,
    parentAgent: AgentDefinition,
    tasks: Array<{ agentId: string; task: string }>,
  ): Promise<AgentResult[]> {
    const results = new Array<AgentResult>(tasks.length);
    let next = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= tasks.length) return;
        const { agentId, task } = tasks[index];
        try {
          results[index] = await this.spawnChild(parent, parentAgent, agentId, task);
        } catch (err) {
          // A child that cannot start must not take the batch down with it. The
          // failure is reported in that slot, in the model's own words, so the
          // parent can finish the rest of the work.
          results[index] = failedChildResult(
            agentId,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    };

    const workers = Array.from({ length: Math.min(SUBAGENT_CONCURRENCY, tasks.length) }, () => worker());
    await Promise.all(workers);
    return results;
  }
}

/**
 * A slot in a batch whose child never started.
 *
 * Shaped like a real failed result — including the `error` field — because the
 * caller reads `result.error.message` to decide whether to retry, and a plain
 * string in that position would be silently treated as success.
 *
 * `runId` is the empty string rather than a fabricated id, and `status` is
 * `"failed"`. A slot with no run id is one a caller can recognise as "this was
 * refused before it ever started", which is a different thing from a child that
 * ran and failed, and inventing an id would erase the difference.
 */
function failedChildResult(agentId: string, message: string): AgentResult {
  return {
    runId: "",
    agentId,
    status: "failed",
    text: "",
    steps: 0,
    toolCalls: 0,
    durationMs: 0,
    cancelled: false,
    error: {
      kind: "config",
      message,
      recoverable: true,
      at: Date.now(),
    },
  };
}

export { DELEGATE_TOOL_NAME, isAbortLike };
