import { create } from "zustand";
import type {
  DebugBreakpoint,
  DebugEventPayload,
  DebugFrame,
  DebugOutputCategory,
  DebugRuntimeState,
  DebugScope,
} from "../types/electron";
import { useEditorStore } from "./editorStore";

let unsubListen: (() => void) | null = null;

function samePath(a: string, b: string): boolean {
  if (!a || !b) return false;
  const na = a.split("\\").join("/").toLowerCase().replace(/^\/+/, "");
  const nb = b.split("\\").join("/").toLowerCase().replace(/^\/+/, "");
  return na === nb;
}

async function loadFrameVariables(frameId: number): Promise<void> {
  try {
    const r = await window.closeCode.debugGetVariables({ frameId });
    if (r.ok && r.result) {
      useDebugStore.setState({ scopes: r.result.scopes, selectedObjectId: null, variableStack: [null] });
    }
  } catch {}
}

async function loadObjectVariables(objectId: string): Promise<void> {
  try {
    const r = await window.closeCode.debugGetVariables({ objectId });
    if (r.ok && r.result) {
      const s = useDebugStore.getState();
      useDebugStore.setState({
        scopes: r.result.scopes,
        selectedObjectId: objectId,
        variableStack: [...s.variableStack, objectId],
      });
    }
  } catch {}
}

interface ConsoleEntry {
  text: string;
  category: DebugOutputCategory;
  time: number;
}

interface DebugState {
  state: DebugRuntimeState;
  runningFile: string | null;
  breakpoints: DebugBreakpoint[];
  callFrames: DebugFrame[];
  selectedFrameId: number | null;
  scopes: DebugScope[];
  selectedObjectId: string | null;
  variableStack: (string | null)[];
  consoleEntries: ConsoleEntry[];
  error: string | null;
  isLoading: boolean;

  startListening: () => void;
  applyDebugEvent: (ev: DebugEventPayload) => void;

  start: (file: string) => Promise<void>;
  stop: () => Promise<void>;
  pause: () => Promise<void>;
  continue: () => Promise<void>;
  stepOver: () => Promise<void>;
  stepInto: () => Promise<void>;
  stepOut: () => Promise<void>;

  setBreakpoint: (file: string, line: number) => Promise<void>;
  removeBreakpoint: (id: string) => Promise<void>;
  toggleBreakpoint: (file: string, line: number) => Promise<void>;

  selectFrame: (frameId: number) => Promise<void>;
  expandObject: (objectId: string) => Promise<void>;
  backVariable: () => void;

  evaluate: (expression: string) => Promise<void>;
  appendConsole: (text: string, category: DebugOutputCategory) => void;
  clearConsole: () => void;
  clearError: () => void;
}

export const useDebugStore = create<DebugState>((set, get) => ({
  state: "inactive",
  runningFile: null,
  breakpoints: [],
  callFrames: [],
  selectedFrameId: null,
  scopes: [],
  selectedObjectId: null,
  variableStack: [],
  consoleEntries: [],
  error: null,
  isLoading: false,

  startListening: () => {
    if (unsubListen) return;
    unsubListen = window.closeCode.onDebugEvent((ev) => {
      void get().applyDebugEvent(ev);
    });
  },

  applyDebugEvent: (ev) => {
    switch (ev.type) {
      case "state":
        set({ state: ev.payload.state });
        break;
      case "paused": {
        const frames = ev.payload.frames ?? [];
        const top = frames[0];
        set({
          state: "paused",
          callFrames: frames,
          selectedFrameId: top?.frameId ?? null,
          error: null,
        });
        if (top && top.url && !top.url.startsWith("node:")) {
          void useEditorStore.getState().openFileInWorkspace(top.url).catch(() => undefined);
        }
        if (top) void loadFrameVariables(top.frameId);
        break;
      }
      case "resumed":
        set({ state: "running" });
        break;
      case "exited":
        set({
          state: "inactive",
          runningFile: null,
          callFrames: [],
          scopes: [],
          selectedFrameId: null,
          selectedObjectId: null,
          variableStack: [],
          error: null,
        });
        break;
      case "output":
        set((s) => ({
          consoleEntries: [
            ...s.consoleEntries,
            { text: ev.payload.text, category: ev.payload.category, time: Date.now() },
          ].slice(-500),
        }));
        break;
      case "error":
        set({ error: ev.payload.message });
        break;
      case "breakpointSet":
        set((s) => {
          const idx = s.breakpoints.findIndex((b) => b.id === ev.payload.id);
          if (idx === -1) return { breakpoints: [...s.breakpoints, ev.payload] };
          const next = s.breakpoints.slice();
          next[idx] = { ...next[idx], ...ev.payload };
          return { breakpoints: next };
        });
        break;
      case "breakpointRemoved":
        set((s) => ({ breakpoints: s.breakpoints.filter((b) => b.id !== ev.payload.id) }));
        break;
      default:
        break;
    }
  },

  start: async (file) => {
    if (!file) return;
    if (get().state !== "inactive") {
      await get().stop();
    }
    set({
      runningFile: file,
      error: null,
      isLoading: true,
      consoleEntries: [],
      callFrames: [],
      scopes: [],
      selectedFrameId: null,
      selectedObjectId: null,
      variableStack: [],
    });
    try {
      const r = await window.closeCode.debugStart({ file });
      if (!r.ok) {
        set({ error: r.error ?? "Failed to start debugger", isLoading: false, state: "inactive" });
      } else {
        set({ isLoading: false });
      }
    } catch (e) {
      set({ error: String(e), isLoading: false, state: "inactive" });
    }
  },

  stop: async () => {
    try {
      await window.closeCode.debugStop();
    } catch {}
  },

  pause: async () => {
    try {
      await window.closeCode.debugPause();
    } catch {}
  },

  continue: async () => {
    try {
      await window.closeCode.debugContinue();
    } catch {}
  },

  stepOver: async () => {
    try {
      await window.closeCode.debugStepOver();
    } catch {}
  },

  stepInto: async () => {
    try {
      await window.closeCode.debugStepInto();
    } catch {}
  },

  stepOut: async () => {
    try {
      await window.closeCode.debugStepOut();
    } catch {}
  },

  setBreakpoint: async (file, line) => {
    try {
      const r = await window.closeCode.debugSetBreakpoint(file, line);
      if (r.ok && r.result) {
        set((s) =>
          s.breakpoints.some((b) => b.id === r.result!.id)
            ? s
            : { breakpoints: [...s.breakpoints, r.result!] },
        );
      }
    } catch {}
  },

  removeBreakpoint: async (id) => {
    try {
      await window.closeCode.debugRemoveBreakpoint(id);
    } catch {}
    set((s) => ({ breakpoints: s.breakpoints.filter((b) => b.id !== id) }));
  },

  toggleBreakpoint: async (file, line) => {
    const existing = get().breakpoints.find(
      (b) => samePath(b.file, file) && b.line === line,
    );
    if (existing) await get().removeBreakpoint(existing.id);
    else await get().setBreakpoint(file, line);
  },

  selectFrame: async (frameId) => {
    set({ selectedFrameId: frameId, selectedObjectId: null, variableStack: [null] });
    await loadFrameVariables(frameId);
  },

  expandObject: async (objectId) => {
    await loadObjectVariables(objectId);
  },

  backVariable: () => {
    const stack = get().variableStack;
    if (stack.length <= 1) return;
    const next = stack.slice(0, -1);
    const target = next[next.length - 1] ?? null;
    set({ variableStack: next, selectedObjectId: target });
    if (target) void loadObjectVariables(target);
    else {
      const frame = get().selectedFrameId;
      if (frame != null) void loadFrameVariables(frame);
    }
  },

  evaluate: async (expression) => {
    if (!expression.trim()) return;
    set((s) => ({
      consoleEntries: [
        ...s.consoleEntries,
        { text: `> ${expression}`, category: "console" as const, time: Date.now() },
      ].slice(-500),
    }));
    try {
      const r = await window.closeCode.debugEvaluate(expression);
      if (r.ok && r.result) {
        set((s) => ({
          consoleEntries: [
            ...s.consoleEntries,
            { text: r.result!.value, category: "console" as const, time: Date.now() },
          ].slice(-500),
        }));
      } else {
        set((s) => ({
          consoleEntries: [
            ...s.consoleEntries,
            { text: r.error ?? "Evaluation failed", category: "stderr" as const, time: Date.now() },
          ].slice(-500),
        }));
      }
    } catch (e) {
      set((s) => ({
        consoleEntries: [...s.consoleEntries, { text: String(e), category: "stderr" as const, time: Date.now() }].slice(-500),
      }));
    }
  },

  appendConsole: (text, category) => {
    set((s) => ({
      consoleEntries: [...s.consoleEntries, { text, category, time: Date.now() }].slice(-500),
    }));
  },

  clearConsole: () => set({ consoleEntries: [] }),
  clearError: () => set({ error: null }),
}));