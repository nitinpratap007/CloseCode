// Close Code — MCP store (Phase 30)
//
// Renderer projection of the MCP manager's server list. Like the task store,
// this store invents nothing: the main process owns config, secrets, connection
// state and discovery; every mutation goes over IPC, and the list arrives back
// either as the mutation's reply or as a `mcp:changed` push — including the
// transitions the user did not cause (a server dropping mid-run, a background
// warmup finishing).
//
// Secret values (env, headers) travel exactly once — out, at add/update time —
// and never come back. A server row knows *names* of env keys, never values.

import { create } from "zustand";
import type { McpAddInput, McpPromptInfo, McpResourceInfo, McpServerView, McpToolInfo, McpUpdateInput } from "../types/electron";

export interface McpStoreState {
  servers: McpServerView[];
  /** Discovery details, loaded on demand per server id. */
  tools: Record<string, McpToolInfo[]>;
  resources: Record<string, McpResourceInfo[]>;
  prompts: Record<string, McpPromptInfo[]>;
  error: string | null;
  notice: string | null;
  busy: boolean;
  listening: boolean;

  startListening: () => void;
  refresh: () => Promise<void>;
  add: (input: McpAddInput) => Promise<McpServerView | null>;
  update: (input: McpUpdateInput) => Promise<void>;
  remove: (id: string) => Promise<void>;
  reconnect: (id: string) => Promise<void>;
  loadDetails: (id: string) => Promise<void>;
  clearError: () => void;
  clearNotice: () => void;
}

function msg(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : typeof err === "string" ? err : fallback;
}

export const useMcpStore = create<McpStoreState>((set, get) => ({
  servers: [],
  tools: {},
  resources: {},
  prompts: {},
  error: null,
  notice: null,
  busy: false,
  listening: false,

  startListening: () => {
    if (get().listening) return;
    set({ listening: true });
    window.closeCode.onMcpChanged((payload) => {
      if (Array.isArray(payload?.servers)) set({ servers: payload.servers });
    });
    void get().refresh();
  },

  refresh: async () => {
    try {
      const res = await window.closeCode.mcpList();
      if (!res.ok) {
        set({ error: res.error ?? "The MCP server list could not be read." });
        return;
      }
      set({ servers: res.servers ?? [], error: null });
    } catch (err) {
      set({ error: msg(err, "The MCP server list could not be read.") });
    }
  },

  add: async (input) => {
    set({ busy: true, error: null });
    try {
      const res = await window.closeCode.mcpAdd(input);
      set({ busy: false });
      if (!res.ok || !res.server) {
        set({ error: res.error ?? "The server could not be added." });
        return null;
      }
      if (res.server.state === "connected") {
        set({ notice: `"${res.server.name}" connected — ${res.server.counts.tools} tools, ${res.server.counts.resources} resources, ${res.server.counts.prompts} prompts.` });
      } else if (res.server.state === "failed") {
        set({ error: `"${res.server.name}" was saved but did not connect: ${res.server.lastError ?? "unknown error"}` });
      } else {
        set({ notice: `"${res.server.name}" saved.` });
      }
      return res.server;
    } catch (err) {
      set({ busy: false, error: msg(err, "The server could not be added.") });
      return null;
    }
  },

  update: async (input) => {
    set({ busy: true, error: null });
    try {
      const res = await window.closeCode.mcpUpdate(input);
      set({ busy: false });
      if (!res.ok) set({ error: res.error ?? "The server could not be updated." });
    } catch (err) {
      set({ busy: false, error: msg(err, "The server could not be updated.") });
    }
  },

  remove: async (id) => {
    set({ busy: true, error: null });
    try {
      const res = await window.closeCode.mcpRemove(id);
      set({ busy: false });
      if (!res.ok) {
        set({ error: res.error ?? "The server could not be removed." });
        return;
      }
      set((s) => ({
        notice: "Server removed.",
        tools: Object.fromEntries(Object.entries(s.tools).filter(([k]) => k !== id)),
        resources: Object.fromEntries(Object.entries(s.resources).filter(([k]) => k !== id)),
        prompts: Object.fromEntries(Object.entries(s.prompts).filter(([k]) => k !== id)),
      }));
    } catch (err) {
      set({ busy: false, error: msg(err, "The server could not be removed.") });
    }
  },

  reconnect: async (id) => {
    set({ busy: true, error: null });
    try {
      const res = await window.closeCode.mcpReconnect(id);
      set({ busy: false });
      if (!res.ok) {
        set({ error: res.error ?? "The server could not reconnect." });
        return;
      }
      if (res.server) set({ notice: `"${res.server.name}" reconnected — ${res.server.counts.tools} tools.` });
      void get().loadDetails(id);
    } catch (err) {
      set({ busy: false, error: msg(err, "The server could not reconnect.") });
    }
  },

  loadDetails: async (id) => {
    try {
      const [tools, resources, prompts] = await Promise.all([
        window.closeCode.mcpTools(id),
        window.closeCode.mcpResources(id),
        window.closeCode.mcpPrompts(id),
      ]);
      set((s) => ({
        tools: { ...s.tools, [id]: tools.ok && tools.tools ? tools.tools : [] },
        resources: { ...s.resources, [id]: resources.ok && resources.resources ? resources.resources : [] },
        prompts: { ...s.prompts, [id]: prompts.ok && prompts.prompts ? prompts.prompts : [] },
      }));
    } catch {
      // Details are a convenience view; a failure here is already visible in
      // the server row's own state, so this stays quiet on purpose.
    }
  },

  clearError: () => set({ error: null }),
  clearNotice: () => set({ notice: null }),
}));
