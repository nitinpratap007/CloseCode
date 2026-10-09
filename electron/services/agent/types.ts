// Close Code — AI Agent Runtime — type contracts (Phase 21)
// Pure type module on purpose: it must not import `electron`, `fs`, or anything
// renderer-side, so the runtime can be unit-tested in a plain Node environment.
//
// The runtime is deliberately transport-agnostic. Everything that needs the
// outside world (HTTP, credentials, windows) arrives through an injected
// `AgentTransport` / `ToolRegistry`, which is what lets future agent types
// (build / plan / review / debug / subagents) be added as data instead of as
// new subsystems.

import type { Capability, Escalation, PermissionPolicy } from "./permissions";

// Phase 23. Re-exported from the pure permission model so the type contracts and
// the gate can never disagree about what a capability is. Every import above is
// type-only and erased at compile time, so this does not create a runtime cycle
// with `permissions.ts` — that module imports `AgentToolCategory` from here as a
// type and nothing more.
export type { Capability, PermissionMode, PermissionPolicy, PermissionScope, Escalation } from "./permissions";
/**
 * Phase 28. Declared in `compaction.ts` next to the engine that produces it, and
 * imported as a type only — the import is erased, so the two modules do not
 * depend on each other at runtime.
 */
import type { CompactionRecord } from "./compaction";
/**
 * Phase 32. The web research service's record shape, imported as a type only
 * (same erased-import rule as `CompactionRecord` above).
 */
import type { ResearchRecord } from "../webResearch";

/** Lifecycle of a single agent run. Transitions are validated by the runtime. */
export type AgentStatus =
  | "idle"
  | "starting"
  | "running"
  | "awaiting_approval"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "failed";

export const AGENT_TERMINAL_STATUSES: readonly AgentStatus[] = ["cancelled", "completed", "failed"];

export function isTerminalStatus(status: AgentStatus): boolean {
  return AGENT_TERMINAL_STATUSES.includes(status);
}

export function isActiveStatus(status: AgentStatus): boolean {
  return status === "starting" || status === "running" || status === "awaiting_approval" || status === "cancelling";
}

const TRANSITIONS: Record<AgentStatus, readonly AgentStatus[]> = {
  idle: ["starting"],
  starting: ["running", "cancelling", "cancelled", "failed"],
  running: ["awaiting_approval", "cancelling", "cancelled", "completed", "failed"],
  awaiting_approval: ["running", "cancelling", "cancelled", "completed", "failed"],
  // A run that was already finishing when cancel arrived may still land on a
  // real result rather than pretending it was stopped.
  cancelling: ["cancelled", "completed", "failed"],
  cancelled: [],
  completed: [],
  failed: [],
};

export function canTransition(from: AgentStatus, to: AgentStatus): boolean {
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: AgentStatus): readonly AgentStatus[] {
  return TRANSITIONS[from];
}

/** Failure taxonomy. `kind` is what the UI and future retry logic branch on. */
export type AgentErrorKind =
  | "config"
  | "network"
  | "auth"
  | "rate_limit"
  | "provider"
  | "timeout"
  | "aborted"
  | "budget"
  | "tool"
  | "internal";

export interface AgentErrorInfo {
  kind: AgentErrorKind;
  message: string;
  /** HTTP status, provider error code, or `ERR_*` code when available. */
  code?: string | number;
  tool?: string;
  /** True when retrying the same step could plausibly succeed. */
  recoverable: boolean;
  at: number;
}

/** Hard limits. The runtime refuses to exceed any of these. */
export interface AgentBudget {
  /** Model round-trips (thinking steps). */
  maxSteps: number;
  /** Total tool invocations across the whole run. */
  maxToolCalls: number;
  /** Wall-clock ceiling for the entire run. */
  maxDurationMs: number;
  /** Truncation limit for a single tool's stdout/result. */
  maxToolOutputChars: number;
}

export const DEFAULT_AGENT_BUDGET: AgentBudget = {
  maxSteps: 6,
  maxToolCalls: 24,
  maxDurationMs: 5 * 60 * 1000,
  maxToolOutputChars: 4000,
};

export interface AgentToolCall {
  id: string;
  name: string;
  /** Raw JSON string as produced by the provider. */
  arguments: string;
}

/** One turn in the agent's own conversation. Separate from the AI chat log. */
export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: AgentToolCall[];
}

/** Coarse progress narration, mapped from what the provider actually reported. */
export type AgentStatusKind = "starting" | "thinking" | "acting" | "observing" | "waiting";

export interface AgentTraceEntry {
  at: number;
  kind: "status" | "tool" | "error" | "compaction";
  step: number;
  level?: AgentStatusKind;
  text?: string;
  tool?: string;
  granted?: boolean;
  ms?: number;
}

export interface AgentResult {
  runId: string;
  agentId: string;
  status: "completed" | "cancelled" | "failed";
  text: string;
  steps: number;
  toolCalls: number;
  durationMs: number;
  cancelled: boolean;
  error?: AgentErrorInfo;
}

/** The tracked, inspectable record of one run. */
export interface AgentRun {
  id: string;
  agentId: string;
  task: string;
  workspace: string | null;
  status: AgentStatus;
  parentRunId: string | null;
  depth: number;
  /** Phase 27. The session this run was filed under, if any. */
  sessionId?: string | null;
  steps: number;
  toolCalls: number;
  messages: AgentMessage[];
  trace: AgentTraceEntry[];
  result?: AgentResult;
  error?: AgentErrorInfo;
  /**
   * Phase 26. What context this run was actually given, kept on the record so a
   * finished run stays inspectable. `undefined` means the run was started with
   * context disabled, which is different from "assembled and found nothing" —
   * that one is `{ status: "empty" }`.
   */
  contextSummary?: ContextSummary;
  /**
   * Phase 28. What happened to this run's context, kept on the record so a
   * finished run stays inspectable. `undefined` means the payload never went
   * over budget, which is different from "compacted and found nothing" — that
   * one is a record with `passes: 1` and no overflow.
   *
   * The run's own `messages` are never rewritten by compaction, so this record
   * describes what was *sent*, while `messages` remains what was *said*.
   */
  compaction?: CompactionRecord;
  createdAt: number;
  updatedAt: number;
}

export type AgentEvent =
  | { type: "state"; runId: string; status: AgentStatus; previous: AgentStatus; at: number; note?: string }
  | { type: "message"; runId: string; message: AgentMessage }
  | { type: "delta"; runId: string; step: number; delta: string }
  | { type: "status"; runId: string; step: number; level: AgentStatusKind; text: string }
  | {
      type: "tool";
      runId: string;
      step: number;
      tool: string;
      args: Record<string, unknown>;
      result: string;
      granted: boolean;
      ms: number;
      /**
       * Phase 22. The structured outcome, so the UI can colour and label a call
       * without parsing `result`, and so a run record can be stored and replayed
       * meaningfully later.
       */
      status: ToolStatus;
      error?: ToolError;
      /** True when this tool changes the workspace, repository or machine state. */
      destructive: boolean;
    }
  | {
      type: "approval";
      runId: string;
      id: string;
      tool: string;
      category: string;
      args: Record<string, unknown>;
      /**
       * Phase 22. The tool that is asking, not just the permission category, plus
       * whether it is destructive — so the prompt can say "overwrite this file"
       * instead of making the user judge a bare category name.
       */
      destructive: boolean;
      /**
       * Phase 23. The individual operations this call needs, so the prompt can
       * name them ("Delete files") rather than the tool, and so the UI can show
       * the user exactly which permission is being exercised.
       */
      capabilities: readonly Capability[];
      /**
       * Phase 23. Set when the call was escalated to `ask` despite a capability
       * being set to `allow` — because a command matched the destructive list,
       * or because the path is outside the workspace. This is the difference
       * between "this is what the tool does" and "this is why I am being asked
       * about a tool I already allowed", and the user is owed the second one.
       */
      escalation?: Escalation;
      /**
       * Phase 23. The same capabilities with their display names, so the prompt
       * says "Delete files" rather than making the user read `files.delete`.
       *
       * Sent instead of the renderer looking the labels up, because the labels
       * live next to the gate that enforces them. A second copy in the UI is a
       * copy that can say something the gate does not do.
       */
      capabilityLabels: string[];
    }
  | { type: "error"; runId: string; error: AgentErrorInfo }
  | {
      /**
       * Phase 28. A payload was compressed before it was sent.
       *
       * Emitted on every compacted pass rather than once, because each pass is
       * a real compression of a payload the model was about to receive; the
       * panel decides how many times to *show* it, and the run record keeps the
       * latest numbers plus the pass count.
       */
      type: "compaction";
      runId: string;
      step: number;
      record: CompactionRecord;
    }
  | { type: "result"; runId: string; result: AgentResult };

// ---------------------------------------------------------------------------
// Tool invocation architecture
// ---------------------------------------------------------------------------

/**
 * Maps 1:1 onto the AI permission categories the user already configures.
 *
 * Phase 22 added `web` and `browser`. They are separate categories, not part of
 * `search`, because those two are the only tools that send data off the
 * machine: folding them into `search` would let a user who has allowed in-workspace
 * search silently allow the agent to upload workspace content to any URL.
 */
export type AgentToolCategory = "files" | "terminal" | "search" | "git" | "agent" | "web" | "browser" | "tasks" | "mcp" | "skills";

/**
 * Why a tool call did not produce a result.
 *
 * The point of this list is that the runtime, the run record and any future
 * retry logic branch on a code instead of matching against English. Every code
 * here is a decision the model can act on, which is why the messages say what
 * the model should do differently rather than only what went wrong.
 */
export type ToolErrorCode =
  /** Arguments failed schema validation. Always recoverable — the model can resend. */
  | "invalid_input"
  /** The model asked for a tool this registry does not have. */
  | "unknown_tool"
  /** The permission gate or the user said no. */
  | "permission_denied"
  /**
   * Phase 24. The running agent's own tool policy forbids this tool, so it was
   * never offered it. Distinct from `permission_denied` on purpose: that one
   * means "your settings did not allow this", which the user can change in the
   * permission panel. This one means "this agent does not do this, whatever your
   * settings say" — a Plan agent asking to write a file is a bug in the run, not
   * a missing permission, and a user debugging it needs to be told which it is.
   */
  | "agent_policy"
  /**
   * Phase 31. The active skill's `allowed-tools` restriction forbids this
   * call. Distinct from `permission_denied` ("your settings said no") and from
   * `agent_policy` ("this agent never does this"): this one means "the skill
   * you approved narrows this run", and it lifts when the skill's work ends.
   */
  | "skill_restriction"
  /** The requested file, directory, branch or entry does not exist. */
  | "not_found"
  /** The path resolves outside the workspace (including through a link). */
  | "outside_workspace"
  /** No workspace folder is open, so there is nothing to act on. */
  | "no_workspace"
  /** The request conflicts with the current state (dirty file, branch checked out, …). */
  | "conflict"
  /** The environment genuinely lacks the capability (no git binary, no API key). */
  | "not_supported"
  /** A dependency the tool needs is configured but not reachable right now. */
  | "unavailable"
  /** The operation exceeded its own time budget. */
  | "timeout"
  /** A bound was reached and the result is partial rather than complete. */
  | "limit_exceeded"
  /** The run was stopped while the call was in flight. */
  | "aborted"
  /** An unexpected internal failure. The only kind the runtime shows as a run error. */
  | "tool_failed";

export interface ToolError {
  code: ToolErrorCode;
  message: string;
  /** True when the same call could succeed on a retry. */
  recoverable: boolean;
  /** What the caller should try instead. Shown to the model alongside the message. */
  hint?: string;
  /**
   * An unexpected internal failure rather than a rejected request. The runtime
   * raises a run-level error for these only, so a model sending bad arguments
   * never puts an error banner in front of the user.
   */
  reportable?: boolean;
  /**
   * Machine-readable facts about the failure, for the run record and the UI.
   *
   * `ErrorExtra` has carried a `data` field since Phase 22 without ever copying
   * it onto the error, so a caller passing one got it silently dropped. Phase 24
   * wired it up: an `agent_policy` refusal puts the agent id and the tool name
   * here, so the panel can say *which* agent tried *what* without matching on
   * the message text.
   */
  data?: unknown;
}

/** Machine-readable facts about a completed call, for the run record and the UI. */
export interface ToolResultMeta {
  tool: string;
  durationMs: number;
  path?: string;
  /** Number of results (search hits, git commits, diagnostics …). */
  count?: number;
  /** Size of the payload produced, when meaningful. */
  bytes?: number;
  /** The result is complete but bounded; there may be more. */
  truncated?: boolean;
}

export type ToolStatus = "ok" | "error" | "denied";

export interface AgentToolOutcome {
  /** False means the permission gate refused: policy denial or user "Deny". */
  granted: boolean;
  /**
   * The model-facing rendering. Authored by the tool and passed through
   * verbatim — several of these strings are asserted exactly by the existing
   * suites, and the model reads them verbatim too.
   */
  text: string;
  /**
   * Phase 22. Optional on the type so a tool written in the Phase 21 style still
   * compiles; `ToolRegistry.invoke` guarantees it is always present in what the
   * runtime receives.
   */
  status?: ToolStatus;
  error?: ToolError;
  /** Structured payload for callers that do not want to parse `text`. */
  data?: unknown;
  meta?: ToolResultMeta;
}

/**
 * Phase 23. A tool's per-call refinement of what it is about to do.
 *
 * The static `AgentTool.capabilities` describes what a tool *can* do; this
 * describes what *this* call does. `run_terminal` always needs `shell.exec`, but
 * a particular command may also need `shell.dangerous` — a fact that is only
 * knowable once the arguments are in hand, and which must not be guessed from
 * the tool name.
 */
export interface AgentPermissionRequest {
  /**
   * Capabilities this specific call needs, in addition to the tool's declared
   * ones. Added, never substituted: a tool that declares `files.read` and asks
   * for `files.write` needs both.
   */
  capabilities?: readonly Capability[];
  /**
   * The resolved absolute path the call will touch, when it touches one. Used to
   * apply a `path`-scoped rule and to require `external.*` for anything outside
   * the workspace.
   */
  path?: string | null;
  /**
   * Why this call needs a capability the tool did not declare, in the user's
   * words. Shown in the approval prompt, because "why is an `rm` asking about
   * reading" is otherwise unexplainable from the outside.
   */
  reason?: string;
}

export interface AgentToolContext {
  runId: string;
  agentId: string;
  workspace: string | null;
  signal: AbortSignal;
  /** Epoch ms after which the run's wall-clock budget is exhausted. */
  deadline: number;
  /** Per-run truncation limit for tool stdout/result text. */
  maxOutputChars: number;
  /**
   * The single permission gate. A tool MUST call this before any side effect.
   * Returns false when policy denies or the user declines.
   *
   * Phase 23 adds an optional third argument. It is optional and additive on
   * purpose: every Phase 21/22 tool keeps calling `authorize(category, args)`
   * and is gated by the category's capability set without being edited. A tool
   * whose real effect is narrower than its category — reading versus deleting,
   * `echo` versus `rm -rf` — passes the specific capabilities it needs and has
   * them checked individually.
   */
  authorize(
    category: AgentToolCategory,
    args: Record<string, unknown>,
    request?: AgentPermissionRequest,
  ): Promise<boolean>;
  /** Record a human-readable progress line in the run trace. */
  log(text: string, level?: AgentStatusKind): void;
  /**
   * Phase 31. Narrow the tools this run may call for the rest of its life.
   *
   * Narrow-only: `names` can remove tools, never add them — the permission
   * gate still runs for anything the skill names. `null` clears the
   * restriction. Used by `use_skill` to enforce a skill's `allowed-tools`;
   * the enforcement lives in the runtime's call loop, not in the tool.
   */
  restrictTools(names: string[] | null, skillName?: string): void;
  /**
   * Start a nested agent run. Depth is bounded by the parent definition, so a
   * subagent cannot spawn further children.
   */
  spawnChild(agentId: string, task: string): Promise<AgentResult>;
  /**
   * Phase 25. Start several sub-agents at once and get every answer back in the
   * order they were requested.
   *
   * "At once" is bounded: the runtime runs at most `SUBAGENT_CONCURRENCY` of a
   * batch simultaneously, and at most `MAX_CHILDREN_PER_RUN` children per
   * parent across the whole run. A model that asks for six reviewers therefore
   * gets three running and three queued, not six model calls and six terminals
   * competing for the same quota at the same instant.
   *
   * Results are returned positionally, so a partial failure is visible as a
   * failure in one slot rather than as a shorter list that silently shifts every
   * later answer onto the wrong task.
   */
  spawnChildren(tasks: Array<{ agentId: string; task: string }>): Promise<AgentResult[]>;
  /** Resolve `p` and reject anything outside the workspace root. */
  confine(p: string): string | null;
  /**
   * Phase 22. Credentials for the outbound-network tools, injected by the
   * process wiring so the runtime stays credential-free and unit-testable.
   * Absent in unit tests, which is why `web_search` treats a missing value as
   * "no key configured" and refuses rather than pretending to search.
   */
  webSearch?: AgentWebSearchConfig;
  /**
   * Phase 32. The web research pipeline, injected the same way. Absent in unit
   * tests, which is why `research_start` refuses with a typed `unavailable`
   * result instead of inventing research.
   */
  research?: ResearchFactory;
}

/**
 * Phase 32. Runs the bounded research pipeline for one question and returns the
 * finished record. `signal` is the run's own abort signal, so stopping the run
 * stops the research. The pipeline performs real model calls, searches and
 * fetches; a record it returns is the truth of what happened.
 */
export type ResearchFactory = (
  request: { question: string; focusUrls?: string[] },
  signal: AbortSignal,
) => Promise<ResearchRecord>;

/** Phase 22. How `web_search` reaches its real backend. */
export interface AgentWebSearchConfig {
  /** API key, or null when the user has not configured one. */
  apiKey: string | null;
  /** Backend endpoint. Overridable so the tool can be pointed at a stub. */
  endpoint?: string;
}

export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments, in OpenAI function-calling shape. */
  parameters: Record<string, unknown>;
  category: AgentToolCategory;
  /**
   * Read-only tools never mutate the workspace. Agents declared `readOnly` are
   * restricted to these, which is a hard guarantee rather than a prompt hint.
   */
  readOnly: boolean;
  /**
   * Phase 22. True when a successful call changes the workspace, the repository
   * or something outside the editor's state. This is what lets the approval
   * prompt say "this will overwrite a file" instead of asking the user to
   * approve a bare tool name, and it is why a user who set a category to `allow`
   * is still shown, in the trace, which calls were the ones that actually did
   * damage. It is a label, not a gate: the gate is `ctx.authorize`.
   */
  destructive?: boolean;
  /**
   * Phase 23. The operations this tool can actually perform.
   *
   * Optional, and when absent the gate falls back to `CATEGORY_CAPABILITIES` for
   * the tool's category — so this is a refinement, not a new requirement, and a
   * tool written before this phase is still gated correctly.
   *
   * Declared here rather than passed per call because most tools do exactly one
   * thing: `read_file` is always `files.read`, whatever path it is given. The
   * per-call refinement belongs in the third argument to `authorize`.
   */
  capabilities?: readonly Capability[];
  execute(ctx: AgentToolContext, args: Record<string, unknown>): Promise<AgentToolOutcome>;
}

/** A tool as reported to the UI and the IPC layer. Carries no executable code. */
export interface ToolDescriptor {
  name: string;
  description: string;
  category: AgentToolCategory;
  readOnly: boolean;
  destructive: boolean;
  /** Argument names, so a UI can show a signature without re-parsing the schema. */
  parameters: string[];
  required: string[];
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface AgentCompletionRequest {
  model: string;
  messages: AgentMessage[];
  /** OpenAI-compatible `tools` array, or undefined for a plain completion. */
  tools?: unknown[];
  temperature: number;
  stream: boolean;
  timeoutMs: number;
  signal: AbortSignal;
  /** Called with each streamed content fragment. */
  onDelta?: (delta: string) => void;
  /** Called when the provider exposes reasoning/thinking text. */
  onReasoning?: (text: string) => void;
}

export interface AgentCompletionResult {
  content: string;
  toolCalls: AgentToolCall[];
  reasoning?: string;
  /** True when at least one content delta actually arrived over SSE. */
  streamed: boolean;
}

export type AgentTransport = (req: AgentCompletionRequest) => Promise<AgentCompletionResult>;

// ---------------------------------------------------------------------------
// Definitions & run specification
// ---------------------------------------------------------------------------

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  /**
   * Phase 25. Whether this is an agent the *user* picks or one a parent model
   * delegates to.
   *
   * This is a real distinction, not a label. A primary agent appears in the
   * selector and is run directly by the user; a subagent is only ever reachable
   * through `delegate_task`, from a parent whose `delegates` list names it. If
   * the two shared one list, the Phase 24 selector would offer thirteen entries
   * where it is supposed to offer four, and "Explorer" would look like something
   * you can start — which is not a thing it can do.
   */
  kind?: "primary" | "subagent";
  /** Appended to the CloseCode base system prompt. */
  systemPrompt: string;
  /** Explicit allow-list of tool names. Omitted means "every registered tool". */
  tools?: string[];
  /** When true the agent may only use read-only tools. */
  readOnly?: boolean;
  /** Sub-agent ids this agent may delegate to. Empty disables delegation. */
  delegates?: string[];
  /** How deep delegation may nest. Defaults to 0 (no sub-agents). */
  maxDepth?: number;
  /** Per-definition step ceiling; the run budget can only lower it. */
  maxSteps?: number;
}

export type AgentPermissionMode = "ask" | "allow" | "deny";

/**
 * Phase 23. The scopes a run's permissions are resolved against.
 *
 * The run does not carry a mode map: it carries the *context* in which modes are
 * looked up. The policy itself is held by the injected resolver, so a run cannot
 * widen its own permissions by carrying a more permissive copy of them.
 */
export interface AgentPermissionContext {
  agentId: string;
  workspace: string | null;
  /**
   * Phase 23/25. True when the parent run is itself a sub-agent.
   *
   * Phase 23 declared this field and never constructed it, so for its whole
   * life it was a promise the type made and nothing kept. Phase 25 is the
   * phase that makes it mean something: a nested run resolves its permissions
   * as the *intersection* of its own scope and the parent run's, so it can be
   * narrower than its parent by its own choice but never wider. The flag is
   * what makes that decision auditable in a run record instead of implicit.
   */
  nested: boolean;
}

export interface AgentRunSpec {
  /** Reuse an existing id instead of generating one (the AI chat path does this). */
  runId?: string;
  agentId: string;
  /** The user task. This is the agent's first user message. */
  task: string;
  workspace: string | null;
  /** Extra context the renderer chose to share (may be empty). */
  context?: string;
  /**
   * Prior turns from the AI chat, so an agent can continue a conversation.
   *
   * Phase 21 declared this and nothing ever populated it — `buildRunSpec` wrote
   * `options.history ?? []` and no caller passed one, for six phases. Phase 27 is
   * what makes it reachable: `resumeHistory()` in `aiSessions.ts` turns a stored
   * session into exactly this shape.
   */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  /**
   * Phase 27. The session this run belongs to. Recorded on the run so a finished
   * run can be filed against the conversation it was part of, and so `close` can
   * report which sessions still have work in flight.
   */
  sessionId?: string | null;
  parentRunId?: string | null;
  depth?: number;
  budget?: Partial<AgentBudget>;
  /**
   * Resolved provider endpoint for this run. The runtime never reads settings
   * or credentials itself — the caller hands over a concrete endpoint and the
   * runtime builds a transport from it via the injected factory.
   */
  endpoint: { url: string; model: string; key: string | null };
  temperature: number;
  timeoutMs: number;
  stream: boolean;
  /**
   * Phase 11/22 category -> mode. Still honoured, and still the *floor* the gate
   * applies: a category set to `deny` denies every capability underneath it even
   * when a narrower capability scope says `allow`. This is what makes a category
   * setting still mean something after Phase 23 rather than becoming a dead
   * second system.
   */
  permissions: Record<string, AgentPermissionMode>;
  /**
   * Phase 23. Scoped rules for this run. Optional, and absent in every Phase
   * 21/22 call site, which is why the gate is written to work with only
   * `permissions` above.
   */
  policy?: PermissionPolicy;
  /** Phase 23. Which agent and project this run resolves permissions in. */
  permissionContext?: AgentPermissionContext;
  /**
   * Phase 25. The most permissive mode this run may be granted, per capability,
   * inherited from the run that spawned it.
   *
   * A sub-agent resolves permissions against *its own* agent id, and a role with
   * no rules of its own falls back to the project and then the global scope. That
   * is correct in isolation and wrong as a delegation story: a parent that the
   * user restricted with `agent:plan → files: deny` would spawn a child with no
   * `agent:coder` rules, which resolves `files` back to whatever global says,
   * and the child ends up strictly more powerful than the parent that spawned it.
   *
   * The ceiling closes that from the safe side. The parent's *effective* mode for
   * each capability becomes a hard bound, and a child may be narrower than that
   * but never wider. It is a ceiling and not a second opinion on purpose: taking
   * the min of the two is the only combination that cannot be made more
   * permissive by writing a new scope.
   *
   * Absent on a primary run, and the gate treats absent as "no ceiling", so a
   * top-level agent is entirely unaffected by this mechanism.
   */
  permissionCeiling?: Partial<Record<Capability, AgentPermissionMode>>;
  approvalTimeoutMs?: number;

  // -------------------------------------------------------------------------
  // Phase 26 — context engine
  // -------------------------------------------------------------------------

  /**
   * Phase 26. The renderer's view of the editor, sanitised at the IPC boundary.
   *
   * Kept on the spec, not just used and dropped, because `spawnChild` needs it:
   * a sub-agent's context is assembled for the *child's* task but has to describe
   * the same editor, and the renderer is not there to describe it a second time.
   */
  snapshot?: EditorSnapshot | null;
  /**
   * Phase 26. Whether the user wants project context at all. A `false` here is a
   * deliberate "send nothing", and it is inherited by sub-agents — a user who
   * turned context off must not get it back through delegation.
   */
  contextEnabled?: boolean;
  /**
   * Phase 26. What the engine actually assembled, so a finished run can be
   * inspected after the fact rather than only at the moment it started.
   */
  contextSummary?: ContextSummary;
}

// -------------------------------------------------------------------------
// Phase 26 — context engine contracts
//
// Declared here rather than in `context.ts` for the same reason this module
// exists: it is the contract surface, and it must stay free of `fs` and `electron`
// so the runtime stays unit-testable in a plain Node environment. `context.ts`
// imports from here; nothing here imports from there.
// -------------------------------------------------------------------------

export type ContextPartKind =
  | "preamble"
  | "instructions"
  | "documentation"
  | "selection"
  | "previousResults"
  | "currentFile"
  | "relevantCode"
  | "diagnostics"
  | "git"
  | "structure"
  | "openFiles";

/** One selected range, as the renderer saw it. */
export interface EditorSelectionSnapshot {
  text: string;
  startLine: number;
  endLine: number;
}

/** One live editor marker. See `context.ts` on why this is pushed, not read. */
export interface EditorDiagnosticSnapshot {
  file: string;
  line: number;
  severity: string;
  message: string;
}

/**
 * The renderer's view of the editor at the moment a run was asked for.
 *
 * Untrusted: it crosses `contextIsolation` from renderer code, so
 * `sanitizeSnapshot` clamps every field before anything reads it.
 */
export interface EditorSnapshot {
  activePath: string | null;
  /** The live buffer, which may differ from disk when the tab is dirty. */
  activeContent: string;
  activeDirty: boolean;
  selection: EditorSelectionSnapshot | null;
  openPaths: string[];
  diagnostics: EditorDiagnosticSnapshot[];
}

export interface ContextBudget {
  /** Hard ceiling on the whole serialised context block. */
  totalChars: number;
  maxSelectionChars: number;
  maxInstructionsChars: number;
  maxCurrentFileChars: number;
  maxRelevantFiles: number;
  maxRelevantFileChars: number;
  /** Phase 26. Ranked documentation is its own part, not a code excerpt. */
  maxDocFiles: number;
  maxDocFileChars: number;
  maxOpenFiles: number;
  maxOpenFileChars: number;
  maxGitFiles: number;
  maxDiagnostics: number;
  maxPreviousChars: number;
  maxPreviousRuns: number;
  maxStructureLines: number;
}

/** How one file fared. Shown in the panel whether or not it made the cut. */
export interface ContextFileSummary {
  path: string;
  score: number;
  chars: number;
  included: boolean;
  reason?: string;
}

/** A part as the renderer sees it: the same facts, plus a bounded excerpt. */
export interface ContextSummaryPart {
  kind: ContextPartKind;
  label: string;
  /** Serialised length, heading included, so the total is what actually ships. */
  chars: number;
  included: boolean;
  truncated: boolean;
  /** Why it was left out, or shortened, when it was. Never empty when set. */
  reason?: string;
  /** First 600 characters, so the user can judge it without the full payload. */
  preview: string;
  files?: ContextFileSummary[];
}

export type ContextStatus = "built" | "cancelled" | "empty";

export interface ContextSummary {
  status: ContextStatus;
  totalChars: number;
  budgetChars: number;
  /** Wall-clock cost of the assembly. Shown because it is a main-thread cost. */
  ms: number;
  builtAt: number;
  /** How much of the tree was examined, and how many files passed ranking. */
  filesScanned: number;
  filesRanked: number;
  /** One human-readable line for every part that did not make it. */
  dropped: string[];
  parts: ContextSummaryPart[];
}
