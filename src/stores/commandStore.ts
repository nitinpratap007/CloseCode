// Close Code — Command Center renderer store (Phase 33)
//
// Mirrors the webResearchStore pattern: the main process owns the records, the
// renderer only projects them and dispatches writes over IPC.

import { create } from "zustand";
import type { CommandCatalogEntry, CommandRunResult } from "../types/electron";

export interface CommandStoreState {
  catalog: CommandCatalogEntry[];
  input: string;
  busy: boolean;
  error: string | null;
  lastRun: CommandRunResult | null;

  setInput: (v: string) => void;
  refreshCatalog: () => Promise<void>;
  run: () => Promise<void>;
  clearError: () => void;
}

function msg(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : typeof err === "string" ? err : fallback;
}

export const useCommandStore = create<CommandStoreState>((set, get) => ({
  catalog: [],
  input: "",
  busy: false,
  error: null,
  lastRun: null,

  setInput: (v) => set({ input: v, error: null }),
  clearError: () => set({ error: null }),

  refreshCatalog: async () => {
    try {
      const res = await window.closeCode.commandCatalog();
      if (res.ok && res.result) set({ catalog: res.result });
      else set({ error: res.error ?? "Failed to load command catalog." });
    } catch (err) {
      set({ error: msg(err, "Failed to load command catalog.") });
    }
  },

  run: async () => {
    const { input, busy } = get();
    if (busy) return;
    const trimmed = input.trim();
    if (!trimmed) return set({ error: "Enter a command first." });
    if (trimmed.length > 2000) return set({ error: "Command too long." });
    set({ busy: true, error: null });
    try {
      const w = window as unknown as Record<string, unknown>;
      const wsStore = w.__workspaceStore as typeof import("./workspaceStore").useWorkspaceStore | undefined;
      const ssStore = w.__sessionStore as typeof import("./sessionStore").useSessionStore | undefined;
      const workspace = wsStore?.getState().root ?? null;
      const sessionId = ssStore?.getState().activeId ?? null;
      const res = await window.closeCode.commandRun({ request: trimmed, workspace, sessionId });
      if (res.ok && res.result) {
        set({ lastRun: res.result, input: "" });
      } else {
        set({ error: res.error ?? "Command failed." });
      }
    } catch (err) {
      set({ error: msg(err, "Command failed.") });
    } finally {
      set({ busy: false });
    }
  },
}));