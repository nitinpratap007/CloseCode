// Close Code — AI service (Phase 11/12, agent path delegated in Phase 21)
// OpenAI-compatible HTTP transport lives ONLY in the main process:
//   - renderer never performs network calls for AI (CSP-friendly, key stays in main)
//   - streaming SSE support, timeouts, friendly errors
//   - plain chat and streaming paths
//
// The tool-calling agent loop is no longer implemented here. Phase 21 moved it
// into a first-class runtime (electron/services/agent) that owns lifecycle,
// state, budgets, cancellation, typed errors and a pluggable tool registry.
// `runAgentLoop` below is a thin adapter that hands the chat turn to that
// runtime and translates the result back into the Phase 11 chat contract.

import fs from "fs";
import path from "path";
import { exec } from "child_process";
import type { AiConfig } from "./aiSettings";
import { getApiKey } from "./aiSettings";
import { getAgentRuntime, buildRunSpec } from "./agent/instance";
import { compactMessages } from "./agent/compaction";
import { DEFAULT_AGENT_ID } from "./agent/definitions";
import { apiUrl } from "./agent/transport";
import { renderInstructionBlock } from "./instructions";

export interface AiTurnMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{ id: string; name: string; arguments: string }>;
}

export interface AiChatRequest {
  /** Renderer-generated id used to correlate stream events. */
  id: string;
  messages: Array<{ role: string; content: string }>;
  context: string;
  workspace: string | null;
}

export interface AiChatOutcome {
  ok: boolean;
  text?: string;
  toolSteps?: number;
  error?: string;
}

export interface AiLocalRuntime {
  name: string;
  baseUrl: string;
  models: string[];
}

export interface AiApprovalRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

type EmitFn = (channel: string, payload: unknown) => void;

const LOCAL_RUNTIMES: Array<{ name: string; url: string }> = [
  { name: "Ollama", url: "http://127.0.0.1:11434" },
  { name: "LM Studio", url: "http://127.0.0.1:1234" },
  { name: "Jan", url: "http://127.0.0.1:1337" },
];

function visibleError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "AbortError") return "The AI request timed out. Increase the timeout in AI settings and try again.";
    const m = err.message;
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|network/i.test(m)) {
      return "Could not connect to the AI endpoint. Check the base URL and that the service is running.";
    }
    if (/401|403/.test(m)) return "The AI service rejected the API key (authentication failed).";
    return m;
  }
  return String(err);
}

function resolveEndpoint(cfg: AiConfig): { url: string; model: string; key: string | null } {
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
 * OpenAI-compatible base URL normalization lives in the agent transport
 * (exported as `apiUrl`) so the chat path and the agent loop cannot drift.
 */
function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

export class AiService {
  constructor(private emit: EmitFn) {}

  private broadcast(channel: string, payload: unknown): void {
    try {
      this.emit(channel, payload);
    } catch {
      // no window attached yet
    }
  }

  /** Probe well-known local runtimes (or a single specific base URL for testing). */
  async detectLocal(specificUrl?: string): Promise<{ found: boolean; runtimes: AiLocalRuntime[] }> {
    const targets = specificUrl
      ? [{ name: "Custom", url: specificUrl }]
      : LOCAL_RUNTIMES;
    const runtimes: AiLocalRuntime[] = [];
    for (const t of targets) {
      try {
        const res = await fetchWithTimeout(`${apiUrl(t.url, "/models")}`, { headers: { "Content-Type": "application/json" } }, 2500);
        if (res.ok) {
          const json = (await res.json()) as { data?: Array<{ id?: string }> };
          const models = Array.isArray(json?.data)
            ? json.data.map((d) => d.id).filter((x): x is string => typeof x === "string" && x.length > 0)
            : [];
          runtimes.push({ name: t.name, baseUrl: t.url, models: models.slice(0, 50) });
        }
      } catch {
        // runtime not reachable — ignored
      }
    }
    return { found: runtimes.length > 0, runtimes };
  }

  async listModels(cfg: AiConfig): Promise<{ ok: boolean; models?: string[]; error?: string }> {
    const { url, key } = resolveEndpoint(cfg);
    if (!url) return { ok: false, error: "No AI endpoint configured." };
    try {
      const res = await fetchWithTimeout(
        `${apiUrl(url, "/models")}`,
        { headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) } },
        8000,
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { ok: false, error: `Models endpoint responded ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}` };
      }
      const json = (await res.json()) as { data?: Array<{ id?: string }> };
      const models = Array.isArray(json?.data)
        ? json.data.map((d) => d.id).filter((x): x is string => typeof x === "string" && x.length > 0)
        : [];
      return { ok: true, models };
    } catch (err) {
      return { ok: false, error: visibleError(err) };
    }
  }

  async chat(req: AiChatRequest, cfg: AiConfig): Promise<AiChatOutcome> {
    const id = req.id || `req-${Date.now()}`;
    try {
      if (!req.messages || req.messages.length === 0) throw new Error("No messages to send.");
      const { url, model } = resolveEndpoint(cfg);
      if (!url) throw new Error("No AI endpoint configured. Open AI settings and set a base URL.");
      if (!model) throw new Error("No model configured. Open AI settings and set a model id.");

      const base: AiTurnMessage[] = req.messages.map((m) => ({
        role: m.role === "system" || m.role === "assistant" || m.role === "user" || m.role === "tool" ? (m.role as AiTurnMessage["role"]) : "user",
        content: m.content,
      }));
      if (req.context && req.context.trim()) {
        base.unshift({
          role: "system",
          content: `CloseCode is sharing editor context with you. Use it to answer precisely:\n\n${req.context.trim()}\n\n[end of context]`,
        });
      }
      // Phase 31. User and project instruction files ride the same system
      // prompt the agent path's context engine already carries, so "follow the
      // project's rules" is one fact across chat and agent, not two.
      if (req.workspace) {
        const block = renderInstructionBlock(req.workspace);
        if (block.text) {
          base.unshift({ role: "system", content: block.text });
        }
      }

      let outcome: AiChatOutcome;
      if (cfg.toolMode === "agent" && req.workspace) {
        outcome = await this.runAgentLoop(cfg, req, id);
      } else {
        // Phase 28. The agent path budgets its own payload at its shipping
        // point inside the runtime; this path has no runtime, so it budgets
        // here. Same engine, same rules — there is exactly one notion of "over
        // budget" in the app, and a chat without a workspace open is still a
        // conversation that can outgrow a context window.
        const compacted = compactMessages(base, { now: () => Date.now() });
        if (compacted.compacted) {
          // Sent before the request rather than after it: the renderer has
          // already recorded `activeRequestId` synchronously, so the notice
          // lands on the message it belongs to.
          this.broadcast("ai:event", { type: "compaction", payload: { id, record: compacted.record } });
        }
        if (cfg.stream) {
          outcome = await this.streamChat(url, model, cfg, compacted.messages, id);
        } else {
          outcome = await this.simpleChat(url, model, cfg, compacted.messages);
          this.broadcast("ai:event", { type: "done", payload: { id, text: outcome.text ?? "", toolSteps: 0 } });
        }
      }
      return outcome;
    } catch (err) {
      const message = visibleError(err);
      this.broadcast("ai:event", { type: "error", payload: { id, message } });
      return { ok: false, error: message };
    }
  }

  private buildSystemPrompt(base: AiTurnMessage[]): AiTurnMessage[] {
    const extras: string[] = [];
    for (const m of base) {
      if (m.role === "system") extras.push(m.content);
    }
    const sysText =
      `You are the AI assistant built into CloseCode, a desktop code editor. ` +
      `Be concise and accurate. When the user asks you to modify a file, respond with the ` +
      `complete new file content inside a single fenced code block labelled with the file's language ` +
      `(e.g. \`\`\`js). Never truncate output with placeholder comments. If you are used as an agent, ` +
      `call tools instead of guessing about file contents.` +
      (extras.length > 0 ? `\n\n${extras.join("\n\n")}` : "");
    const sys: AiTurnMessage = { role: "system", content: sysText };
    return [sys, ...base.filter((m) => m.role !== "system")];
  }

  /**
   * Plain (non-streaming) completion. Only the plain chat path still uses this —
   * the agent path builds its requests inside the agent runtime, which owns the
   * tool definitions through the tool registry.
   */
  private async postCompletion(
    url: string,
    model: string,
    cfg: AiConfig,
    messages: AiTurnMessage[],
  ): Promise<{ content: string; toolCalls: Array<{ id: string; name: string; arguments: string }> }> {
    const { key } = resolveEndpoint(cfg);
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: cfg.temperature,
      stream: false,
    };
    const res = await fetchWithTimeout(
      `${apiUrl(url, "/chat/completions")}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(body),
      },
      cfg.timeoutMs,
    );
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw new Error(`${res.status} ${res.statusText}`.trim() + (bodyText ? ` — ${bodyText.slice(0, 300)}` : ""));
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>;
    };
    const msg = json?.choices?.[0]?.message;
    return {
      content: typeof msg?.content === "string" ? msg.content : "",
      toolCalls: (msg?.tool_calls ?? []).map((tc) => ({
        id: tc.id || `call-${Math.random().toString(36).slice(2, 10)}`,
        name: tc.function?.name ?? "",
        arguments: tc.function?.arguments ?? "{}",
      })),
    };
  }

  private async simpleChat(url: string, model: string, cfg: AiConfig, messages: AiTurnMessage[]): Promise<AiChatOutcome> {
    const res = await this.postCompletion(url, model, cfg, this.buildSystemPrompt(messages));
    return { ok: true, text: res.content || "(empty response)", toolSteps: 0 };
  }

  private async streamChat(url: string, model: string, cfg: AiConfig, messages: AiTurnMessage[], id: string): Promise<AiChatOutcome> {
    const { key } = resolveEndpoint(cfg);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    let full = "";
    let gotDelta = false;
    try {
      const res = await fetch(`${apiUrl(url, "/chat/completions")}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model, messages: this.buildSystemPrompt(messages), temperature: cfg.temperature, stream: true }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        throw new Error(`${res.status} ${res.statusText}`.trim() + (bodyText ? ` — ${bodyText.slice(0, 300)}` : ""));
      }
      if (!res.body) throw new Error("The endpoint did not return a response body.");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      const emitDelta = (text: string): void => {
        full += text;
        gotDelta = true;
        this.broadcast("ai:event", { type: "stream", payload: { id, delta: text } });
      };

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
          const data = t.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const json = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
            const delta = json?.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta) emitDelta(delta);
          } catch {
            // ignore malformed keep-alive lines
          }
        }
      }

      // Non-streaming fallback: some endpoints ignore `stream` and return JSON.
      if (buf.trim().startsWith("{")) {
        try {
          const json = JSON.parse(buf) as { choices?: Array<{ message?: { content?: string } }> };
          const text = json?.choices?.[0]?.message?.content;
          if (typeof text === "string" && text) {
            full = text;
            gotDelta = true;
            this.broadcast("ai:event", { type: "stream", payload: { id, delta: text } });
          }
        } catch {
          // not valid JSON either
        }
      }

      const text = gotDelta ? full : "(empty response)";
      this.broadcast("ai:event", { type: "done", payload: { id, text, toolSteps: 0 } });
      return { ok: true, text, toolSteps: 0 };
    } catch (err) {
      clearTimeout(timer);
      const message = visibleError(err);
      this.broadcast("ai:event", { type: "error", payload: { id, message } });
      return { ok: false, error: message };
    } finally {
      clearTimeout(timer);
    }
  }

  // ------------------------------------------------------------------
  // Agent path (Phase 21: delegated to the agent runtime)
  // ------------------------------------------------------------------

  /**
   * Hand this chat turn to the Phase 21 agent runtime.
   *
   * The runtime emits the legacy `ai:event` stream itself (see
   * electron/services/agent/instance.ts), so this method only has to translate
   * the finished run back into the `AiChatOutcome` the chat contract expects.
   */
  private async runAgentLoop(cfg: AiConfig, req: AiChatRequest, id: string): Promise<AiChatOutcome> {
    // The renderer sends the whole conversation; the runtime wants the task
    // separated from the prior turns so its own message log stays clean.
    const turns = (req.messages ?? []).filter((m) => m.content.trim().length > 0);
    const lastUser = [...turns].reverse().find((m) => m.role === "user");
    const history = turns
      .filter((m) => m !== lastUser)
      .map((m) => ({ role: m.role === "assistant" ? ("assistant" as const) : ("user" as const), content: m.content }));

    const result = await getAgentRuntime().run(
      buildRunSpec({
        runId: id,
        agentId: DEFAULT_AGENT_ID,
        task: lastUser?.content ?? turns[turns.length - 1]?.content ?? "",
        workspace: req.workspace ?? null,
        context: req.context ?? "",
        history,
        config: cfg,
      }),
    );

    if (result.status === "completed") {
      return { ok: true, text: result.text, toolSteps: result.toolCalls };
    }
    return {
      ok: false,
      text: result.text,
      toolSteps: result.toolCalls,
      error: result.error?.message ?? "The agent run did not complete.",
    };
  }

  /**
   * Resolve an outstanding user approval. Phase 21 moved the approval queue
   * into the runtime, so both `ai:respond-approval` (chat) and
   * `agent:respond-approval` (agent panel) resolve the same request.
   */
  resolveApproval(id: string, approved: boolean): void {
    getAgentRuntime().resolveApproval(id, approved);
  }
}
