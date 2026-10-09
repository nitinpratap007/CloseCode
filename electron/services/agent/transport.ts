// Close Code — AI Agent Runtime — OpenAI-compatible transport (Phase 21)
//
// This is the only place inside the agent package that performs network I/O.
// The runtime talks to an injected `AgentTransport`; in production that is
// this implementation, which speaks the OpenAI `/chat/completions` contract and
// therefore also works against Ollama, LM Studio, Jan and any compatible
// gateway. It is deliberately a separate module (rather than a method on
// `AiService`) so the runtime can be exercised in unit tests against any
// transport, and so credentials never enter the runtime.

import { getApiKey } from "../aiSettings";
import { AgentRuntimeError, classifyHttpStatus, classifyNetworkError, isAbortLike } from "./errors";
import type { AgentCompletionRequest, AgentCompletionResult, AgentToolCall } from "./types";

/** Prefix shared by Phase 11's simple/streaming chat path and the agent loop. */
export const DEFAULT_AI_BASE_URL = "https://api.openai.com/v1";

export interface ResolvedEndpoint {
  url: string;
  model: string;
  key: string | null;
}

export function resolveEndpoint(cfg: {
  provider: "local" | "openai" | "custom";
  baseUrl: string;
  localBaseUrl: string;
  model: string;
  localModel: string;
}): ResolvedEndpoint {
  if (cfg.provider === "local") {
    return {
      url: (cfg.localBaseUrl || cfg.baseUrl).replace(/\/+$/, ""),
      model: cfg.localModel || "",
      key: getApiKey("local"),
    };
  }
  return {
    url: (cfg.baseUrl || "").replace(/\/+$/, ""),
    model: cfg.model || "",
    key: getApiKey(cfg.provider),
  };
}

/**
 * OpenAI-compatible base URL normalization: endpoints live under /v1.
 * If the configured base URL already ends in /v1 (OpenAI-style), use it as-is;
 * otherwise append /v1 (Ollama/LM Studio/Jan-style "http://host:port").
 */
export function apiUrl(base: string, suffix: string): string {
  const u = base.trim().replace(/\/+$/, "");
  return (/\/v1$/i.test(u) ? u : `${u}/v1`) + suffix;
}

interface StreamDelta {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }> | null;
}

interface CompletionMessage {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> | null;
}

interface CompletionBody {
  choices?: Array<{ message?: CompletionMessage; delta?: StreamDelta }>;
}

let callSeq = 0;

function normalizeToolCalls(
  raw: CompletionMessage["tool_calls"],
): AgentToolCall[] {
  return (raw ?? [])
    .map((tc, i) => ({
      id: tc.id || `call-${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 8)}`,
      name: tc.function?.name ?? "",
      arguments: tc.function?.arguments ?? "{}",
    }))
    .filter((tc) => tc.name.length > 0);
}

/** Merge a streamed tool_calls fragment into the accumulator, keyed by index. */
function mergeToolCallFragment(
  acc: Map<number, { id: string; name: string; args: string }>,
  fragments: NonNullable<StreamDelta["tool_calls"]>,
): void {
  fragments.forEach((frag, fallbackIndex) => {
    const idx = typeof frag.index === "number" ? frag.index : fallbackIndex;
    const existing = acc.get(idx) ?? { id: "", name: "", args: "" };
    if (frag.id) existing.id = frag.id;
    if (frag.function?.name) existing.name += frag.function.name;
    if (frag.function?.arguments) existing.args += frag.function.arguments;
    acc.set(idx, existing);
  });
}

function toolCallsFrom(acc: Map<number, { id: string; name: string; args: string }>): AgentToolCall[] {
  return [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, v], i) => ({
      id: v.id || `call-${Date.now().toString(36)}-${idx}-${i}-${Math.random().toString(36).slice(2, 8)}`,
      name: v.name,
      arguments: v.args || "{}",
    }))
    .filter((tc) => tc.name.length > 0);
}

/**
 * Build a real transport bound to a specific provider/model.
 * `url` and `key` are captured once, which is why the runtime must be handed a
 * freshly built transport whenever the user changes provider settings.
 */
export function createOpenAiTransport(endpoint: { url: string; model: string; key: string | null }): (
  req: AgentCompletionRequest,
) => Promise<AgentCompletionResult> {
  return async function agentTransport(req: AgentCompletionRequest): Promise<AgentCompletionResult> {
    const { url, key } = endpoint;
    if (!url) throw new AgentRuntimeError("config", "No AI endpoint configured. Open AI settings and set a base URL.");
    if (!req.model || !endpoint.model) {
      throw new AgentRuntimeError("config", "No model configured. Open AI settings and set a model id.");
    }

    callSeq += 1;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.max(1000, req.timeoutMs));

    // Honour an outer cancellation (user pressed Stop) as well as our timeout.
    const onOuterAbort = (): void => controller.abort();
    if (req.signal.aborted) controller.abort();
    else req.signal.addEventListener("abort", onOuterAbort, { once: true });

    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      temperature: req.temperature,
      stream: req.stream,
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools;
      body.tool_choice = "auto";
    }

    try {
      const res = await fetch(`${apiUrl(url, "/chat/completions")}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw classifyHttpStatus(res.status, res.statusText, text);
      }
      if (!res.body) throw new AgentRuntimeError("provider", "The endpoint did not return a response body.");

      const contentType = (res.headers.get("content-type") || "").toLowerCase();
      // Some OpenAI-compatible gateways answer a `stream: true` request with a
      // single JSON document. Detect that from the header instead of guessing.
      if (contentType.includes("application/json") && !contentType.includes("event-stream")) {
        const json = (await res.json()) as CompletionBody;
        const msg = json?.choices?.[0]?.message;
        const reasoning = msg?.reasoning_content ?? msg?.reasoning ?? undefined;
        if (reasoning) req.onReasoning?.(reasoning);
        return {
          content: typeof msg?.content === "string" ? msg.content : "",
          toolCalls: normalizeToolCalls(msg?.tool_calls),
          reasoning,
          streamed: false,
        };
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let full = "";
      let reasoning = "";
      let gotDelta = false;
      const toolAcc = new Map<number, { id: string; name: string; args: string }>();

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const payload = t.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let json: CompletionBody;
          try {
            json = JSON.parse(payload) as CompletionBody;
          } catch {
            continue; // malformed keep-alive line
          }
          const delta = json?.choices?.[0]?.delta;
          if (!delta) continue;
          const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
          if (typeof reasoningDelta === "string" && reasoningDelta) {
            reasoning += reasoningDelta;
            req.onReasoning?.(reasoningDelta);
          }
          if (typeof delta.content === "string" && delta.content) {
            full += delta.content;
            gotDelta = true;
            req.onDelta?.(delta.content);
          }
          if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
            mergeToolCallFragment(toolAcc, delta.tool_calls);
          }
        }
      }

      // Non-streaming fallback: the body may have been one JSON document with
      // no `data:` prefixes (Phase 11's chat path has the same fallback).
      if (!gotDelta && toolAcc.size === 0 && buf.trim().startsWith("{")) {
        try {
          const json = JSON.parse(buf) as CompletionBody;
          const msg = json?.choices?.[0]?.message;
          const r = msg?.reasoning_content ?? msg?.reasoning ?? undefined;
          if (r) {
            reasoning = r;
            req.onReasoning?.(r);
          }
          if (typeof msg?.content === "string" && msg.content) {
            full = msg.content;
            gotDelta = true;
            req.onDelta?.(msg.content);
          }
          return {
            content: full,
            toolCalls: normalizeToolCalls(msg?.tool_calls),
            reasoning: reasoning || undefined,
            streamed: false,
          };
        } catch {
          // fall through to the streamed result
        }
      }

      if (toolAcc.size > 0) {
        return { content: full, toolCalls: toolCallsFrom(toolAcc), reasoning: reasoning || undefined, streamed: gotDelta };
      }
      if (!gotDelta) {
        throw new AgentRuntimeError(
          "provider",
          `The endpoint returned no usable content (content-type: ${contentType || "unknown"}).`,
        );
      }
      return { content: full, toolCalls: [], reasoning: reasoning || undefined, streamed: true };
    } catch (err) {
      if (err instanceof AgentRuntimeError) throw err;
      if (isAbortLike(err)) {
        throw new AgentRuntimeError(
          timedOut ? "timeout" : "aborted",
          timedOut
            ? "The AI request timed out. Increase the timeout in AI settings and try again."
            : "The agent run was cancelled.",
          { cause: err },
        );
      }
      // A refused connection or a DNS failure arrives as an opaque `fetch failed`
      // TypeError. `toAgentError` short-circuits on AgentRuntimeError, so the
      // network classification has to happen here or the user only ever sees
      // "provider" for what is actually an unreachable endpoint.
      const net = classifyNetworkError(err);
      if (net) throw net;
      const message = err instanceof Error ? err.message : String(err);
      throw new AgentRuntimeError("provider", message || "The AI request failed.", { cause: err });
    } finally {
      clearTimeout(timer);
      req.signal.removeEventListener("abort", onOuterAbort);
    }
  };
}
