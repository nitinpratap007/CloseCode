// Close Code — Autonomous Builder renderer store (Phase 33)
//
// Mirrors the webResearchStore pattern exactly: the disk is the truth, the main
// process is the authority, every row arrives over `build:list`, every write
// goes through `build:start` / `build:respond` / `build:cancel`, and the push
// channel (`build:event`) keeps the panel live during a running pipeline.

import { create } from "zustand";
import type { BuildRecordView, BuildPhaseView, BuildVerificationEntryView, BuildStatus } from "../types/electron";

export interface BuildStoreState {
  records: BuildRecordView[];
  busy: boolean;
  request: string;
  note: string;
  error: string | null;

  setRequest: (r: string) => void;
  setNote: (n: string) => void;
  refresh: () => Promise<void>;
  start: () => Promise<void>;
  respond: (id: string, approved: boolean) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  clearError: () => void;
}

export function msg(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : typeof err === "string" ? err : fallback;
}

export const STATUS_TEXT: Record<BuildStatus, string> = {
  queued: "Queued",
  planning: "Planning…",
  awaiting_input: "Waiting for your approval",
  building: "Building…",
  verifying: "Verifying…",
  completed: "Completed",
  failed: "Failed",
  refused: "Declined",
  cancelled: "Cancelled",
};

export { type BuildRecordView, type BuildPhaseView, type BuildVerificationEntryView } from "../types/electron";

export const useBuildStore = create<BuildStoreState>((set, get) => ({
  records: [],
  busy: false,
  request: "",
  note: "",
  error: null,

  setRequest: (r) => set({ request: r }),
  setNote: (n) => set({ note: n }),
  clearError: () => set({ error: null }),

  refresh: async () => {
    try {
      const res = await window.closeCode.buildList();
      if (res.ok && res.records) set({ records: res.records });
      else set({ error: res.error ?? "Failed to load build records." });
    } catch (err) {
      set({ error: msg(err, "Failed to load build records.") });
    }
  },

  start: async () => {
    const { request, note, busy } = get();
    if (busy) return;
    const trimmed = request.trim();
    if (!trimmed) return set({ error: "Describe what you want built first." });
    if (trimmed.length > 2000) return set({ error: "Request too long (max 2000 characters)." });
    set({ busy: true, error: null });
    try {
      const w = window as unknown as Record<string, unknown>;
      const wsStore = w.__workspaceStore as typeof import("./workspaceStore").useWorkspaceStore | undefined;
      const ssStore = w.__sessionStore as typeof import("./sessionStore").useSessionStore | undefined;
      const workspace = wsStore?.getState().root ?? null;
      const sessionId = ssStore?.getState().activeId ?? null;
      const res = await window.closeCode.buildStart({ request: trimmed, note, workspace, sessionId });
      if (res.ok) set({ request: "", note: "" });
      else set({ error: res.error ?? "Failed to start build." });
    } catch (err) {
      set({ error: msg(err, "Failed to start build.") });
    } finally {
      set({ busy: false });
    }
  },

  respond: async (id: string, approved: boolean) => {
    set({ busy: true, error: null });
    try {
      const res = await window.closeCode.buildRespond(id, approved, get().note);
      if (!res.ok) set({ error: res.error ?? "Failed to respond." });
    } catch (err) {
      set({ error: msg(err, "Failed to respond.") });
    } finally {
      set({ busy: false });
    }
  },

  cancel: async (id: string) => {
    set({ busy: true, error: null });
    try {
      const res = await window.closeCode.buildCancel(id);
      if (!res.ok) set({ error: res.error ?? "Failed to cancel." });
    } catch (err) {
      set({ error: msg(err, "Failed to cancel.") });
    } finally {
      set({ busy: false });
    }
  },
}));

// ---- render helpers (like ResearchSection) ----

export function phaseKindStyle(kind: BuildPhaseView["kind"]): string {
  switch (kind) {
    case "plan":
      return "text-cc-accent";
    case "question":
      return "text-amber-400";
    case "implement":
      return "text-green-500";
    case "verify":
      return "text-blue-400";
  }
}

export function phaseStatusStyle(status: BuildPhaseView["status"]): string {
  switch (status) {
    case "pending":
      return "text-cc-muted";
    case "running":
      return "text-cc-accent";
    case "done":
      return "text-green-500";
    case "failed":
      return "text-red-400";
    case "skipped":
      return "text-cc-muted line-through";
    case "cancelled":
      return "text-cc-muted line-through";
  }
}

export function verificationStatusStyle(entry: BuildVerificationEntryView): string {
  if (entry.skipped) return "text-cc-muted line-through";
  return entry.ok ? "text-green-500" : "text-red-400";
}