// Close Code — Agent runtime IPC (Phase 21)
// Thin validation layer over the main-process agent runtime. Every handler
// returns the same `{ ok, result?, error? }` envelope the rest of the app uses,
// and no handler ever throws across the IPC boundary.

import { ipcMain, BrowserWindow } from "electron";
import { getAgentRuntime, getContextEngine, buildRunSpec } from "../services/agent/instance";
import { canonicalAgentId, listSubagentDefinitions, DEFAULT_AGENT_ID } from "../services/agent/definitions";
import { sanitizeSnapshot } from "../services/agent/context";
import { getWorkspaceRoot } from "./workspace";
import { loadAiConfig } from "../services/aiSettings";
import type { AgentEvent, ContextSummary, EditorSnapshot } from "../services/agent/types";

function fail(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

/**
 * Phase 26. Push a finished context summary to the panel.
 *
 * Sent on every build (a preview, a rebuild, or the one `agent:start` performs
 * on the user's behalf) so the panel never has to poll, and never shows a
 * summary belonging to a request the user has since changed.
 */
function broadcastContext(summary: ContextSummary): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send("agent:context", summary);
    } catch {
      // the window went away mid-broadcast
    }
  }
}

/**
 * Phase 27. A replayed conversation, validated before it can reach the prompt.
 *
 * A resumed run hands this straight to a model provider, so an unclamped array from
 * a renderer would be an unbounded prompt with no ceiling at all — the context
 * engine's budget does not apply here because this path does not go through the
 * engine. Bounded by count and by per-turn length, and non-string entries are
 * dropped rather than coerced, because `"[object Object]"` in a conversation is
 * worse than one fewer turn.
 */
const MAX_REPLAY_TURNS = 40;
const MAX_REPLAY_TURN_CHARS = 4_000;

export function sanitizeHistory(raw: unknown): Array<{ role: "user" | "assistant"; content: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.content !== "string" || !o.content) continue;
    out.push({
      role: o.role === "assistant" ? "assistant" : "user",
      content: o.content.length > MAX_REPLAY_TURN_CHARS ? o.content.slice(0, MAX_REPLAY_TURN_CHARS) : o.content,
    });
  }
  return out.slice(-MAX_REPLAY_TURNS);
}

export function registerAgentIpc(): void {
  const runtime = getAgentRuntime();
  const engine = getContextEngine();

  ipcMain.handle("agent:definitions", () => {
    try {
      return { ok: true, result: runtime.definitions() };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  // Phase 25. The roles a parent model may delegate to.
  //
  // Deliberately a *separate* channel from `agent:definitions`, which continues
  // to return only the four primaries. The renderer needs to be able to show
  // that delegation is available and which roles exist, without those roles
  // becoming selectable in the agent picker — they cannot be started by a user,
  // and a selector offering them would be offering a button that does nothing.
  ipcMain.handle("agent:subagents", () => {
    try {
      return { ok: true, result: listSubagentDefinitions() };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  // Phase 26. Async because it assembles context first.
  //
  // The order matters and is the whole point of the phase: context is built
  // *before* `runtime.start`, so the summary on the run record describes exactly
  // what that run received. Assembling afterwards would leave a window where the
  // panel showed one bundle and the run was sent another, and a user who is being
  // shown an exact character count deserves that count to be true.
  ipcMain.handle(
    "agent:start",
    async (_e, payload: { agentId?: unknown; task?: unknown; context?: unknown; contextEnabled?: unknown; snapshot?: unknown; sessionId?: unknown; history?: unknown }) => {
      try {
        // Phase 24. Canonicalised here, at the boundary, so a stored or
        // hand-supplied `default` becomes `build` before it reaches a run spec.
        // Left uncanonicalised it would resolve to a working agent (via
        // `getAgentDefinition`) while the run still reported `default` — and a
        // per-agent permission rule the user wrote under `build` would then
        // silently not apply to it.
        const rawAgentId = typeof payload?.agentId === "string" ? payload.agentId : "";
        const agentId = canonicalAgentId(rawAgentId);
        const task = typeof payload?.task === "string" ? payload.task.trim() : "";
        const explicit = typeof payload?.context === "string" ? payload.context.trim() : "";
        if (!task) return fail("An agent run needs a task.");
        if (!runtime.hasAgent(agentId)) return fail(`Unknown agent "${agentId}".`);

        const cfg = loadAiConfig();
        if (!cfg.baseUrl && !cfg.localBaseUrl) return fail("No AI endpoint configured. Open AI settings first.");
        const endpointModel = cfg.provider === "local" ? cfg.localModel : cfg.model;
        if (!endpointModel) return fail("No model configured. Open AI settings and set a model id.");

        // Phase 26. `contextEnabled === false` is the user's explicit "send
        // nothing", and it is honoured without building: an off switch that still
        // walked the project tree would be lying about what it costs.
        const contextEnabled = payload?.contextEnabled !== false;
        const snapshot: EditorSnapshot | null = contextEnabled
          ? sanitizeSnapshot(payload?.snapshot)
          : null;

        let context = explicit;
        let contextSummary: ContextSummary | undefined;
        if (contextEnabled) {
          const bundle = await engine.build({ agentId, task, workspace: getWorkspaceRoot(), snapshot });
          contextSummary = bundle.summary;
          broadcastContext(bundle.summary);
          context = [explicit, bundle.text].filter(Boolean).join("\n\n");
        }

        // Phase 27. Only the conversation is replayed, never the run's tool
        // calls: a resumed run continues from what was said, and re-issuing a
        // `write_file` because someone reopened a conversation would be a
        // destructive thing to make possible. This is a trust boundary — the
        // array arrives from a renderer and goes straight into the model prompt.
        const history = sanitizeHistory(payload?.history);

        const spec = buildRunSpec({
          agentId,
          task,
          workspace: getWorkspaceRoot(),
          context,
          contextEnabled,
          ...(contextSummary ? { contextSummary } : {}),
          snapshot,
          config: cfg,
          ...(history.length > 0 ? { history } : {}),
          ...(typeof payload?.sessionId === "string" && payload.sessionId
            ? { sessionId: payload.sessionId }
            : {}),
        });
        // `start` returns immediately; the renderer follows progress on `agent:event`.
        const { runId, done } = runtime.start(spec);
        void done.catch(() => undefined);
        return { ok: true, result: { runId, context: contextSummary ?? null } };
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // -------------------------------------------------------------------------
  // Phase 26 — context engine
  // -------------------------------------------------------------------------

  /**
   * Build (or rebuild) context without starting a run.
   *
   * One channel rather than separate "build" and "rebuild" ones: a rebuild is
   * exactly a build of the same request with `force`, and the two would have
   * differed only in a boolean — which is a shape that invites the two answers to
   * drift apart over time.
   */
  ipcMain.handle(
    "agent:context:build",
    async (_e, payload: { task?: unknown; agentId?: unknown; snapshot?: unknown; force?: unknown }) => {
      try {
        const agentId = canonicalAgentId(typeof payload?.agentId === "string" ? payload.agentId : DEFAULT_AGENT_ID);
        // An empty task means "rebuild what you last looked at", which is what a
        // user pressing Rebuild in the panel means. Falling back to the previous
        // request's task keeps the ranking — and therefore the answer — the same.
        let task = typeof payload?.task === "string" ? payload.task.trim() : "";
        if (!task) task = engine.last()?.task ?? "";
        const bundle = await engine.build({
          agentId,
          task,
          workspace: getWorkspaceRoot(),
          snapshot: sanitizeSnapshot(payload?.snapshot),
          force: payload?.force === true,
        });
        broadcastContext(bundle.summary);
        return { ok: true, result: bundle.summary };
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  ipcMain.handle("agent:context:cancel", () => {
    try {
      return { ok: true, result: { cancelled: engine.cancel() } };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("agent:context:inspect", () => {
    try {
      return { ok: true, result: engine.last()?.summary ?? null };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("agent:cancel", (_e, runId: unknown) => {
    try {
      if (typeof runId !== "string" || !runId) return fail("A run id is required.");
      return { ok: true, result: { cancelled: runtime.cancel(runId) } };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("agent:cancel-all", () => {
    try {
      return { ok: true, result: { cancelled: runtime.cancelAll() } };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("agent:runs", () => {
    try {
      return { ok: true, result: runtime.listRuns() };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("agent:run", (_e, runId: unknown) => {
    try {
      if (typeof runId !== "string" || !runId) return fail("A run id is required.");
      return { ok: true, result: runtime.getRun(runId) ?? null };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("agent:approvals", () => {
    try {
      return { ok: true, result: runtime.pendingApprovals() };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("agent:respond-approval", (_e, id: unknown, approved: unknown) => {
    try {
      if (typeof id !== "string" || !id) return fail("An approval id is required.");
      return { ok: true, result: { resolved: runtime.resolveApproval(id, approved === true) } };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("agent:clear", () => {
    try {
      return { ok: true, result: { removed: runtime.clearFinished() } };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });
}

/** Re-exported so the app can reason about the event union without importing internals. */
export type { AgentEvent };
