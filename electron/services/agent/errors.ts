// Close Code — AI Agent Runtime — error taxonomy (Phase 21)
// One place that turns anything thrown inside a run into a structured
// `AgentErrorInfo`, so the UI, the run record and future retry logic all agree
// on *what kind* of failure happened instead of parsing strings.

import type { AgentErrorInfo, AgentErrorKind } from "./types";

/** The single error type thrown across the runtime's own modules. */
export class AgentRuntimeError extends Error {
  readonly kind: AgentErrorKind;
  readonly code?: string | number;
  readonly tool?: string;
  readonly recoverable: boolean;

  constructor(
    kind: AgentErrorKind,
    message: string,
    opts: { code?: string | number; tool?: string; recoverable?: boolean; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "AgentRuntimeError";
    this.kind = kind;
    this.code = opts.code;
    this.tool = opts.tool;
    this.recoverable = opts.recoverable ?? isRecoverableKind(kind);
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }
}

/** `fetch` reports user cancellation and timeouts with the same name. */
export function isAbortLike(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") return true;
    const code = (err as { code?: string }).code;
    if (code === "ABORT_ERR" || code === "ERR_CANCELED") return true;
  }
  return false;
}

const RECOVERABLE: ReadonlySet<AgentErrorKind> = new Set<AgentErrorKind>([
  "network",
  "timeout",
  "rate_limit",
  "provider",
  "budget",
]);

export function isRecoverableKind(kind: AgentErrorKind): boolean {
  return RECOVERABLE.has(kind);
}

/**
 * Map an HTTP failure onto a kind. Status ranges are the only signal available
 * for an OpenAI-compatible endpoint, so they get a fixed, documented mapping.
 */
export function classifyHttpStatus(status: number, statusText: string, body: string): AgentRuntimeError {
  const detail = body ? body.slice(0, 300) : "";
  const suffix = `${status} ${statusText}`.trim() + (detail ? ` — ${detail}` : "");
  if (status === 401 || status === 403) {
    return new AgentRuntimeError("auth", "The AI service rejected the API key (authentication failed).", {
      code: status,
      recoverable: false,
    });
  }
  if (status === 429) {
    return new AgentRuntimeError("rate_limit", `The AI service is rate limiting this key. ${suffix}`, { code: status });
  }
  if (status === 408 || status === 504) {
    return new AgentRuntimeError("timeout", `The AI service timed out. ${suffix}`, { code: status });
  }
  if (status >= 500) {
    return new AgentRuntimeError("provider", `The AI service reported a server error. ${suffix}`, { code: status });
  }
  return new AgentRuntimeError("provider", `The AI request was rejected. ${suffix}`, {
    code: status,
    recoverable: false,
  });
}

/** Classify a low-level socket/DNS failure from `fetch`. */
export function classifyNetworkError(err: unknown): AgentRuntimeError | null {
  const message = err instanceof Error ? err.message : String(err);
  if (!/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EPIPE|network|socket/i.test(message)) return null;
  return new AgentRuntimeError(
    "network",
    "Could not connect to the AI endpoint. Check the base URL and that the service is running.",
    { code: (err as { code?: string })?.code, cause: err },
  );
}

/**
 * Normalize any thrown value into `AgentErrorInfo`.
 * `fallback` is used when the value carries no recognisable signal.
 */
export function toAgentError(err: unknown, fallback: AgentErrorKind = "internal", tool?: string): AgentErrorInfo {
  const at = Date.now();
  if (err instanceof AgentRuntimeError) {
    return {
      kind: err.kind,
      message: err.message,
      code: err.code,
      tool: err.tool ?? tool,
      recoverable: err.recoverable,
      at,
    };
  }
  if (isAbortLike(err)) {
    return { kind: "aborted", message: "The agent run was cancelled.", tool, recoverable: true, at };
  }
  const net = classifyNetworkError(err);
  if (net) {
    return { kind: net.kind, message: net.message, code: net.code, tool, recoverable: true, at };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { kind: fallback, message: message || "Unknown agent failure.", tool, recoverable: isRecoverableKind(fallback), at };
}
