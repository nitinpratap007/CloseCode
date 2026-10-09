import { create } from "zustand";
import { useSettingsStore } from "./settingsStore";

export interface TerminalInfo {
  id: string;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  isPty: boolean;
  title: string;
}

interface TerminalState {
  terminals: TerminalInfo[];
  activeId: string | null;
  createTerminal: (cwd?: string, cols?: number, rows?: number) => Promise<string | null>;
  setActive: (id: string) => void;
  killTerminal: (id: string) => Promise<void>;
  killAll: () => Promise<void>;
  restartTerminal: (id: string) => Promise<string | null>;
  clearTerminal: (id: string) => void;
  resizeTerminal: (id: string, cols: number, rows: number) => Promise<void>;
  writeToTerminal: (id: string, data: string) => Promise<void>;
  // For UI to trigger new with current workspace cwd
  createWithWorkspaceCwd: () => Promise<string | null>;
}

function shellBaseName(shell: string): string {
  const base = shell.split(/[\\/]/).pop() ?? shell;
  return base.replace(/\.exe$/i, "");
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  terminals: [],
  activeId: null,

  createTerminal: async (cwd, cols = 80, rows = 24) => {
    try {
      const shellPath = useSettingsStore.getState().effective.shellPath;
      const shell = typeof shellPath === "string" && shellPath.trim().length > 0 ? shellPath.trim() : undefined;
      const res = await window.closeCode.terminalCreate({ cwd, cols, rows, shell });
      if (!res.ok || !res.result) {
        console.error("Failed to create terminal:", res.error);
        return null;
      }
      const info: TerminalInfo = {
        ...res.result,
        title: `${shellBaseName(res.result.shell)} — ${res.result.cwd.split(/[\\/]/).pop() ?? res.result.cwd}`,
      };
      set({ terminals: [...get().terminals, info], activeId: info.id });
      return info.id;
    } catch (err) {
      console.error("createTerminal failed:", err);
      return null;
    }
  },

  createWithWorkspaceCwd: async () => {
    const w = window as unknown as Record<string, unknown>;
    const wsStore = w.__workspaceStore as typeof import("./workspaceStore").useWorkspaceStore | undefined;
    const root = wsStore?.getState().root ?? undefined;
    // Use cols/rows from current terminal or default
    return get().createTerminal(root);
  },

  setActive: (id) => set({ activeId: id }),

  killTerminal: async (id) => {
    try {
      await window.closeCode.terminalKill(id);
    } catch (e) { console.error(e); }
    const next = get().terminals.filter((t) => t.id !== id);
    set({
      terminals: next,
      activeId: get().activeId === id ? (next[0]?.id ?? null) : get().activeId,
    });
  },

  killAll: async () => {
    try { await window.closeCode.terminalKillAll(); } catch {}
    set({ terminals: [], activeId: null });
  },

  restartTerminal: async (id) => {
    try {
      const res = await window.closeCode.terminalRestart(id);
      if (!res.ok || !res.result) {
        console.error("Restart failed:", res.error);
        return null;
      }
      const info: TerminalInfo = {
        ...res.result,
        title: `${shellBaseName(res.result.shell)} — ${res.result.cwd.split(/[\\/]/).pop() ?? res.result.cwd}`,
      };
      // Replace old with new (new id)
      const next = get().terminals.map((t) => (t.id === id ? info : t));
      // If id changed, update activeId if it was active
      const wasActive = get().activeId === id;
      set({ terminals: next, activeId: wasActive ? info.id : get().activeId });
      return info.id;
    } catch (err) {
      console.error("restart failed:", err);
      return null;
    }
  },

  clearTerminal: (id) => {
    // Clear is handled in UI via xterm clear, but we also notify main if needed
    void window.closeCode.terminalClear(id);
    // Emit event for UI to clear
    const w = window as unknown as Record<string, unknown>;
    const handler = w.__terminalClearHandler as ((clearId: string) => void) | undefined;
    if (handler) handler(id);
  },

  resizeTerminal: async (id, cols, rows) => {
    try {
      await window.closeCode.terminalResize(id, cols, rows);
      set({ terminals: get().terminals.map((t) => (t.id === id ? { ...t, cols, rows } : t)) });
    } catch (e) { console.error(e); }
  },

  writeToTerminal: async (id, data) => {
    try {
      const res = await window.closeCode.terminalWrite(id, data);
      if (!res.ok) console.error("Write failed:", res.error);
    } catch (e) { console.error(e); }
  },
}));
