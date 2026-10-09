// Close Code — Agent store (Phase 21)
// Renderer half of the agent runtime: which agents exist, which run is
// selected, and the live projection of every run the main process reports.
//
// The renderer never executes an agent. It starts one over IPC and then only
// consumes `agent:event`, which is why an agent can stream, fail, or be
// cancelled without the UI thread ever doing real work.

import { create } from "zustand";
import { canonicalAgentId, DEFAULT_AGENT } from "./agentIds";
import { buildEditorSnapshot } from "../ai/context";
import { useSessionStore } from "./sessionStore";
import type {
  AgentDefinitionInfo,
  AgentEvent,
  AgentRun,
  AgentStatus,
  AgentTraceEntry,
  ContextSummary,
} from "../types/electron";
import { formatCompactionNotice } from "../lib/compaction";

const MAX_TRACKED_RUNS = 25;
const MAX_TRACE_PER_RUN = 200;

export interface AgentStoreState {
  definitions: AgentDefinitionInfo[];
  selectedAgentId: string;
  task: string;
  runs: AgentRun[];
  activeRunId: string | null;
  error: string | null;
  notice: string | null;
  listening: boolean;

  // --- Phase 26: context engine ---
  /**
   * Whether a run is given project context. Default `true`, which is a real
   * default and not a placeholder: it is the whole point of the phase, it is
   * hard-capped, and the panel shows the exact character count before anything
   * is sent. Turning it off is one click and is inherited by sub-agents, so a
   * user who turns it off does not get it back through delegation.
   */
  contextEnabled: boolean;
  /** The most recent assembly. `null` until one has happened. */
  contextSummary: ContextSummary | null;
  /** True while the main process is assembling. */
  contextBuilding: boolean;

  startListening: () => void;
  loadDefinitions: () => Promise<void>;
  refreshRuns: () => Promise<void>;
  selectAgent: (id: string) => void;
  setTask: (text: string) => void;
  start: (taskOverride?: string) => Promise<void>;
  cancel: (runId?: string) => Promise<void>;
  clearFinished: () => Promise<void>;
  selectRun: (runId: string | null) => void;
  clearError: () => void;

  setContextEnabled: (on: boolean) => void;
  /** Assemble (or re-assemble) context for a task, without starting a run. */
  buildContext: (taskOverride?: string, force?: boolean) => Promise<void>;
  cancelContext: () => Promise<void>;
}

function isTerminal(status: AgentStatus): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
}

function upsert(runs: AgentRun[], run: AgentRun): AgentRun[] {
  const next = [run, ...runs.filter((r) => r.id !== run.id)].sort((a, b) => b.createdAt - a.createdAt);
  return next.slice(0, MAX_TRACKED_RUNS);
}

export const useAgentStore = create<AgentStoreState>((set, get) => {
  const handleEvent = (ev: AgentEvent): void => {
    const runId = ev.runId;
    if (ev.type === "result") {
      // A run this store never saw (started elsewhere, or the window attached
      // mid-run) has no local record to merge into. Pull the authoritative one
      // instead of inventing a partial run with a fabricated timestamp.
      if (!get().runs.some((r) => r.id === runId)) {
        void window.closeCode.agentRun(runId).then((res) => {
          if (res.ok && res.result) set((s) => ({ runs: upsert(s.runs, res.result as AgentRun) }));
        });
      }
      set((s) => {
        const existing = s.runs.find((r) => r.id === runId);
        const finished: AgentRun = {
          id: runId,
          agentId: ev.result.agentId,
          task: existing?.task ?? "",
          workspace: existing?.workspace ?? null,
          status: ev.result.status,
          parentRunId: existing?.parentRunId ?? null,
          depth: existing?.depth ?? 0,
          steps: ev.result.steps,
          toolCalls: ev.result.toolCalls,
          messages: existing?.messages ?? [],
          trace: existing?.trace ?? [],
          result: ev.result,
          error: ev.result.error,
          // Phase 26. Carried over from the local record. A run that finished
          // without one genuinely had no context summary — the main process is
          // authoritative for that field and inventing one here would be a lie.
          ...(existing?.contextSummary ? { contextSummary: existing.contextSummary } : {}),
          createdAt: existing?.createdAt ?? Date.now(),
          updatedAt: Date.now(),
          // Phase 27. Kept from the local record: the `result` event carries the
          // outcome but not the session this run belonged to, and a run that
          // started before this window attached has no local record at all.
          ...(existing?.sessionId ? { sessionId: existing.sessionId } : {}),
          // Phase 28. Same reasoning as the two above: the `result` event adds
          // the outcome but is not `CompactionRecord`-aware, and re-reading the
          // run would race the wire. A run that genuinely never compacted has no
          // local record either, so this is a truthful "nothing happened" rather
          // than an invented one.
          ...(existing?.compaction ? { compaction: existing.compaction } : {}),
        };
        return {
          runs: upsert(s.runs, finished),
          activeRunId: s.activeRunId === runId ? null : s.activeRunId,
          notice:
            ev.result.status === "completed"
              ? `${ev.result.agentId} finished — ${ev.result.steps} step(s), ${ev.result.toolCalls} tool call(s).`
              : ev.result.status === "cancelled"
                ? `${ev.result.agentId} cancelled.`
                : (ev.result.error?.message ?? "The agent run failed."),
          error: ev.result.status === "failed" ? (ev.result.error?.message ?? "The agent run failed.") : s.error,
        };
      });
      // Phase 27. The main process has already written this run into its session;
      // this is only the renderer's chance to re-read the list so the session's
      // run count is not stale. Fire-and-forget because nothing in this store
      // depends on it having finished. Read outside the `set` below because the
      // local record is only in scope inside it.
      void useSessionStore
        .getState()
        .noteRunFiled(get().runs.find((r) => r.id === runId)?.sessionId ?? null);
      return;
    }

    if (ev.type === "error") {
      set((s) => ({
        error: `${ev.error.kind}: ${ev.error.message}`,
        runs: s.runs.map((r) =>
          r.id === runId
            ? {
                ...r,
                error: ev.error,
                trace: appendTrace(r.trace, { at: ev.error.at, kind: "error", step: 0, text: ev.error.message }),
              }
            : r,
        ),
      }));
      return;
    }

    if (ev.type === "approval") {
      // Approval prompts are rendered by the AI panel, which already owns that
      // interaction; it receives the same request through the legacy event.
      set(() => ({
        notice: `Waiting for your approval to use ${ev.tool}.`,
      }));
      return;
    }

    set((s) => {
      const existing = s.runs.find((r) => r.id === runId);
      if (!existing) {
        // A run started outside this store (e.g. AI chat agent mode). Pull the
        // authoritative record rather than inventing a partial one.
        void window.closeCode.agentRun(runId).then((res) => {
          if (res.ok && res.result) set((st) => ({ runs: upsert(st.runs, res.result as AgentRun) }));
        });
        return {};
      }

      let trace = existing.trace;
      if (ev.type === "status") {
        trace = appendTrace(trace, { at: Date.now(), kind: "status", step: ev.step, level: ev.level, text: ev.text });
      } else if (ev.type === "tool") {
        trace = appendTrace(trace, {
          at: Date.now(),
          kind: "tool",
          step: ev.step,
          tool: ev.tool,
          granted: ev.granted,
          ms: ev.ms,
          text: ev.result.slice(0, 120),
        });
      } else if (ev.type === "compaction") {
        // Phase 28. One trace line per run, not per pass — every later pass
        // still lands in `run.compaction`, but ten lines saying "the context
        // is still big" would read as noise, not information.
        if (!existing.compaction) {
          trace = appendTrace(trace, {
            at: Date.now(),
            kind: "compaction",
            step: ev.step,
            text: formatCompactionNotice(ev.record),
          });
        }
      }

      const messages =
        ev.type === "message" ? [...existing.messages, ev.message].slice(-120) : existing.messages;

      return {
        runs: upsert(s.runs, {
          ...existing,
          status: ev.type === "state" ? ev.status : existing.status,
          messages,
          trace,
          // Phase 28. The record on the store mirrors the record in the main
          // process for the latest pass; earlier passes are only counted in
          // `passes`, and their detail is in the trace line from the first one.
          compaction: ev.type === "compaction" ? ev.record : existing.compaction,
          updatedAt: ev.type === "state" ? ev.at : Date.now(),
        }),
      };
    });
  };

  return {
    definitions: [],
    // Phase 24. The general-purpose implementer is `build` now. `default` still
    // resolves (it is an alias), so an older persisted value keeps working — the
    // reconcile below rewrites it to the canonical id on load.
    selectedAgentId: "build",
    task: "",
    runs: [],
    activeRunId: null,
    error: null,
    notice: null,
    listening: false,
    // Phase 26.
    contextEnabled: true,
    contextSummary: null,
    contextBuilding: false,

    startListening: () => {
      if (get().listening) return;
      set({ listening: true });
      window.closeCode.onAgentEvent(handleEvent);
      // Phase 26. The main process pushes a summary after *every* build,
      // including the one `start` performs on the user's behalf, so the panel
      // never polls and never shows a summary for a task the user has changed
      // since. This also catches a build started in another window.
      window.closeCode.onAgentContext((summary) => {
        set({ contextSummary: summary, contextBuilding: false });
      });
      void get().loadDefinitions();
      void get().refreshRuns();
      // Ask for whatever the engine already has, so a reopened panel shows the
      // real last assembly instead of an empty panel that looks like a bug.
      void window.closeCode
        .agentContextInspect()
        .then((res) => {
          if (res.ok && res.result) set({ contextSummary: res.result });
        })
        .catch(() => undefined);
    },

    loadDefinitions: async () => {
      try {
        const res = await window.closeCode.agentDefinitions();
        if (res.ok && res.result) {
          const list = res.result;
          // Phase 24. A persisted `default` is still in some users' state. It is
          // resolved here rather than left to fail the `some()` test, so the
          // selector shows `Build Agent` rather than silently snapping to
          // whatever happens to be first in the list.
          const byId = new Map(list.map((d) => [d.id, d]));
          const current = get().selectedAgentId;
          const canonical = canonicalAgentId(current);
          set({
            definitions: list,
            // Keep the user's pick if it is still a real agent; otherwise use its
            // canonical name (`default` → `build`); otherwise the first one.
            selectedAgentId: byId.has(current) ? current : (byId.has(canonical) ? canonical : (list[0]?.id ?? DEFAULT_AGENT)),
          });
        } else {
          set({ error: res.error ?? "Could not load the agent list." });
        }
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      }
    },

    refreshRuns: async () => {
      try {
        const res = await window.closeCode.agentRuns();
        if (res.ok && res.result) set({ runs: res.result.slice(0, MAX_TRACKED_RUNS) });
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      }
    },

    selectAgent: (id) => set({ selectedAgentId: id }),

    setTask: (text) => set({ task: text }),

    start: async (taskOverride) => {
      const text = (taskOverride ?? get().task).trim();
      if (!text) {
        set({ error: "Type a task for the agent first." });
        return;
      }
      set({ error: null, notice: null, activeRunId: null });
      const { contextEnabled } = get();
      // Phase 27. Read the session *before* the await, so a session switch that
      // happens while the context engine is walking cannot attach this run to the
      // conversation the user is no longer looking at.
      const sessionId = useSessionStore.getState().activeId;
      const history = useSessionStore.getState().takeResumeHistory();
      // Phase 26. Assembled here rather than by the main process alone so the
      // panel can show "assembling…" for the whole build. The snapshot is read
      // once, at the moment of starting, so the context cannot describe an editor
      // state that was already gone by the time the main process walked the tree.
      set({ contextBuilding: contextEnabled });
      try {
        const res = await window.closeCode.agentStart({
          agentId: get().selectedAgentId,
          task: text,
          contextEnabled,
          ...(contextEnabled ? { snapshot: buildEditorSnapshot() } : {}),
          // Phase 27. The run is filed against the open session, and a resumed
          // session's conversation is replayed so the run continues it rather than
          // restarting beside it. The history is taken (consumed) here because once
          // this run exists the history is inside it.
          ...(sessionId ? { sessionId } : {}),
          ...(history.length > 0 ? { history } : {}),
        });
        set({ contextBuilding: false });
        if (res.ok && res.result) {
          if (res.result.context) set({ contextSummary: res.result.context });
          set({ activeRunId: res.result.runId, task: taskOverride == null ? "" : get().task });
          await get().refreshRuns();
        } else {
          set({ error: res.error ?? "The agent could not be started." });
        }
      } catch (err) {
        set({ contextBuilding: false, error: err instanceof Error ? err.message : String(err) });
      }
    },

    setContextEnabled: (on) => {
      set({ contextEnabled: on });
      // Turning it off clears the panel. Leaving a stale "12,400 characters will
      // be sent" on screen next to a disabled toggle would be the sort of thing
      // that makes a user stop trusting a number.
      if (!on) set({ contextSummary: null, contextBuilding: false });
    },

    buildContext: async (taskOverride, force) => {
      const text = (taskOverride ?? get().task).trim();
      set({ contextBuilding: true, error: null });
      try {
        const res = await window.closeCode.agentContextBuild({
          agentId: get().selectedAgentId,
          // An empty task is sent as empty on purpose: the main process then
          // rebuilds the *last* request, which is what a bare Rebuild means.
          task: text,
          snapshot: buildEditorSnapshot(),
          force: force === true,
        });
        set({ contextBuilding: false });
        if (res.ok) {
          if (res.result) set({ contextSummary: res.result });
        } else {
          set({ error: res.error ?? "Context could not be assembled." });
        }
      } catch (err) {
        set({ contextBuilding: false, error: err instanceof Error ? err.message : String(err) });
      }
    },

    cancelContext: async () => {
      try {
        const res = await window.closeCode.agentContextCancel();
        if (!res.ok) set({ error: res.error ?? "The context build could not be cancelled." });
        else if (res.result?.cancelled) set({ contextBuilding: false, notice: "Context assembly cancelled." });
        // A `false` means the assembly had already finished, which is not a
        // failure and must not be reported as one.
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      }
    },

    cancel: async (runId) => {
      const id = runId ?? get().activeRunId;
      if (!id) {
        set({ error: "There is no active agent run to stop." });
        return;
      }
      try {
        const res = await window.closeCode.agentCancel(id);
        if (!res.ok) set({ error: res.error ?? "The agent could not be stopped." });
        else if (res.result && !res.result.cancelled) {
          set({ notice: "That agent run had already finished." });
        }
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      }
    },

    clearFinished: async () => {
      try {
        await window.closeCode.agentClear();
        await get().refreshRuns();
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      }
    },

    selectRun: (runId) => set({ activeRunId: runId }),

    clearError: () => set({ error: null }),
  };
});

function appendTrace(trace: AgentTraceEntry[], entry: AgentTraceEntry): AgentTraceEntry[] {
  const next = [...trace, entry];
  return next.length > MAX_TRACE_PER_RUN ? next.slice(next.length - MAX_TRACE_PER_RUN) : next;
}

/** The run the UI is currently focused on, or the newest active one. */
export function selectFocusedRun(state: AgentStoreState): AgentRun | null {
  if (state.activeRunId) {
    const found = state.runs.find((r) => r.id === state.activeRunId);
    if (found) return found;
  }
  return state.runs.find((r) => !isTerminal(r.status)) ?? state.runs[0] ?? null;
}
