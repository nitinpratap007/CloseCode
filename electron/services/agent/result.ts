// Close Code — AI Agent Runtime — structured tool results (Phase 22)
//
// Phase 21 returned `{granted, text}` from every tool: a boolean the UI used to
// colour the call, and a string the model read. That is enough to render a tool
// call and not enough to *act* on one — a run record could not say whether a
// tool succeeded, was refused, or failed, and could not be retried or counted
// without re-parsing English.
//
// Every outcome now carries a `status` and, when it failed, a typed `error`.
// `text` remains the model-facing projection and is never rewritten here, so
// every Phase 11 and Phase 21 message — including the exact strings the existing
// tests assert — is preserved byte for byte.

import type { AgentToolOutcome, ToolError, ToolErrorCode, ToolResultMeta, ToolStatus } from "./types";

/**
 * Codes whose failure is worth retrying rather than reporting as final.
 *
 * `invalid_input` is the clearest case: the model sent something the schema
 * rejects, and resending something different is the *entire* remedy. Reporting
 * it as final is what makes a model give up on a tool it merely called wrongly.
 *
 * `tool_failed` is here because a thrown tool error is usually transient (a
 * locked file, a race), but it is separately marked `reportable` — "the model
 * could try again" and "the user should know" are different questions, and after
 * a genuine internal fault both are true.
 */
const RECOVERABLE: ReadonlySet<ToolErrorCode> = new Set<ToolErrorCode>([
  "invalid_input",
  "timeout",
  "unavailable",
  "not_found",
  "conflict",
  "limit_exceeded",
  "tool_failed",
  // Phase 24. A refused tool is not a dead end: the correct response is a
  // different tool, which is the one thing a model asked to plan rather than
  // write can still do. Reporting it as final is what makes it give up entirely.
  "agent_policy",
]);

export function isRecoverableCode(code: ToolErrorCode): boolean {
  return RECOVERABLE.has(code);
}

export interface ErrorExtra {
  hint?: string;
  data?: unknown;
  meta?: Partial<ToolResultMeta>;
  /**
   * Unexpected internal failure (a thrown bug, an unmapped system error) rather
   * than a rejected request. The runtime surfaces only these to the UI as a run
   * error, so a model mistake like a bad argument never raises a banner.
   */
  reportable?: boolean;
}

export function toolError(code: ToolErrorCode, message: string, extra: ErrorExtra = {}): ToolError {
  const err: ToolError = {
    code,
    message,
    recoverable: extra.reportable === true ? true : isRecoverableCode(code),
  };
  if (extra.hint) err.hint = extra.hint;
  if (extra.reportable) err.reportable = true;
  if (extra.data !== undefined) err.data = extra.data;
  return err;
}

/** A successful result. `data` is the structured payload; `text` stays optional. */
export function okResult(text: string, extra: { data?: unknown; meta?: Partial<ToolResultMeta> } = {}): AgentToolOutcome {
  const out: AgentToolOutcome = { granted: true, text, status: "ok" };
  if (extra.data !== undefined) out.data = extra.data;
  if (extra.meta) out.meta = extra.meta as ToolResultMeta;
  return out;
}

/**
 * A failed result that is not a permission refusal.
 *
 * `granted` stays `true`: the permission gate did allow the call, it just did not
 * work. That distinction is what the UI's red/amber colouring and the
 * "denied by policy or user" message depend on.
 */
export function errorResult(
  code: ToolErrorCode,
  message: string,
  extra: ErrorExtra & { text?: string } = {},
): AgentToolOutcome {
  const text = extra.text ?? `Error: ${message}`;
  const out: AgentToolOutcome = {
    granted: true,
    text,
    status: "error",
    error: toolError(code, message, extra),
  };
  if (extra.data !== undefined) out.data = extra.data;
  if (extra.meta) out.meta = extra.meta as ToolResultMeta;
  return out;
}

/** The permission gate refused. `granted: false` is the Phase 11 contract. */
export function deniedResult(message = "Permission denied by policy or user."): AgentToolOutcome {
  return {
    granted: false,
    text: message,
    status: "denied",
    error: toolError("permission_denied", message, { hint: "Change the tool's permission in AI settings to allow it." }),
  };
}

/**
 * Fill in what every outcome must have, without touching anything a tool set.
 *
 * `text` is copied through verbatim — that string is the model's view of the
 * call and several are asserted exactly by the existing suites. `data` is
 * passed through untouched, and `status` is derived from the parts that were
 * already there, so a tool written in the Phase 21 style (`{granted, text}`)
 * lands on a correct status without being rewritten.
 */
export function normalizeOutcome(
  outcome: AgentToolOutcome | null | undefined,
  tool: string,
  durationMs: number,
): AgentToolOutcome {
  const base: AgentToolOutcome = outcome && typeof outcome === "object"
    ? outcome
    : { granted: true, text: "", status: "error", error: toolError("tool_failed", `${tool} returned no result.`, { reportable: true }) };

  const text = typeof base.text === "string" ? base.text : String(base.text ?? "");

  const status: ToolStatus = base.status ?? deriveStatus(base);

  const out: AgentToolOutcome = { granted: base.granted !== false, text, status };
  if (base.error) out.error = base.error;
  if (base.data !== undefined) out.data = base.data;

  // The registry's measurement wins over a self-reported one: it is the only
  // clock that covers the whole call, including argument validation.
  out.meta = { ...(base.meta ?? {}), tool, durationMs } as ToolResultMeta;

  // A status and an error must never disagree: an "error" with no typed error
  // is exactly the unparseable case this phase removes, so one is derived.
  if (out.status === "error" && !out.error) {
    out.error = toolError("tool_failed", text.trim().slice(0, 300) || `${tool} failed without a message.`, {
      reportable: true,
    });
  }
  if (out.status === "denied") {
    out.granted = false;
    if (!out.error) out.error = toolError("permission_denied", "Permission denied by policy or user.");
  }
  return out;
}

function deriveStatus(outcome: AgentToolOutcome): ToolStatus {
  // `agent_policy` is a denial, not a failure. Phase 24 added it: an agent that
  // was never offered a tool and asked for one anyway has not had an error, it
  // has been refused, and reporting it as `error` would put a red banner in
  // front of the user for a refusal that was working exactly as designed.
  if (outcome.error) {
    return outcome.error.code === "permission_denied" || outcome.error.code === "agent_policy" ? "denied" : "error";
  }
  if (outcome.granted === false) return "denied";
  return "ok";
}
