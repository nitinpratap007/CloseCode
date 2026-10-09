// Close Code — agent permission store (Phase 23)
//
// Renderer half of the permission system. It owns no policy: every value it
// shows came from `agent:permission-matrix`, and every change is one call to
// `agent:permission-set` followed by a re-read.
//
// Two decisions worth stating:
//
//   * **No optimistic updates.** The matrix is re-read after every write. An
//     optimistically-painted cell that the store rejected is how a permissions
//     panel starts showing the user a permission they do not have, which is the
//     exact failure this phase exists to prevent.
//
//   * **The context is kept, not recomputed.** The effective column is only
//     meaningful against a specific agent and workspace: the same global scope
//     resolves `files.write` differently in a project that denies it. A re-read
//     that forgot the context would quietly answer a different question than the
//     one the panel is displaying.

import { create } from "zustand";
import type { AgentPermissionRow, AgentPermissionScope } from "../types/electron";

export type PermissionMode = "allow" | "ask" | "deny";

export interface PermissionAgent {
  id: string;
  name: string;
}

export interface PermissionStoreState {
  /** The scope whose rules are being edited right now. */
  scope: AgentPermissionScope;
  /** The rows as the gate would resolve them in this scope and context. */
  rows: AgentPermissionRow[];
  /** True when the selected scope has at least one rule of its own. */
  configured: boolean;
  /** Every scope that currently has rules, for the "configured for" summary. */
  configuredScopes: string[];
  agents: PermissionAgent[];
  loading: boolean;
  saving: string | null;
  error: string | null;
  loaded: boolean;

  load: () => Promise<void>;
  /** Edit a different scope. The context stays as it is unless one is passed. */
  selectScope: (
    scope: AgentPermissionScope,
    context?: { agentId?: string; workspace?: string | null },
  ) => Promise<void>;
  setMode: (capability: string, mode: PermissionMode | null) => Promise<void>;
  clearScope: () => Promise<void>;
  clearError: () => void;
}

interface Context {
  agentId?: string;
  workspace?: string | null;
}

export const usePermissionStore = create<PermissionStoreState>((set, get) => {
  /** The context the current matrix was fetched for. */
  let context: Context = {};

  const refresh = async (): Promise<void> => {
    const { scope } = get();
    const res = await window.closeCode.agentPermissionMatrix({ scope, ...context });
    if (res.ok && res.result) {
      set({ rows: res.result.rows, configured: res.result.configured });
      const scopes = await window.closeCode.agentPermissionScopes();
      if (scopes.ok && scopes.result) set({ configuredScopes: scopes.result.scopes });
    } else {
      set({ error: res.error ?? "Could not read the permission matrix." });
    }
  };

  return {
    scope: { kind: "global" },
    rows: [],
    configured: false,
    configuredScopes: [],
    agents: [],
    loading: false,
    saving: null,
    error: null,
    loaded: false,

    load: async () => {
      if (get().loading) return;
      set({ loading: true, error: null });
      try {
        const res = await window.closeCode.agentPermissionCatalog();
        if (res.ok && res.result) set({ agents: res.result.agents });
        else set({ error: res.error ?? "Could not load the permission list." });
        await refresh();
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      } finally {
        set({ loading: false, loaded: true });
      }
    },

    selectScope: async (scope, next) => {
      if (next) context = next;
      set({ scope, error: null, loading: true });
      try {
        await refresh();
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      } finally {
        set({ loading: false });
      }
    },

    setMode: async (capability, mode) => {
      const { scope } = get();
      set({ saving: capability, error: null });
      try {
        const res = await window.closeCode.agentPermissionSet({ scope, capability, mode });
        if (!res.ok) {
          set({ error: res.error ?? "That permission could not be changed." });
          return;
        }
        await refresh();
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      } finally {
        set({ saving: null });
      }
    },

    clearScope: async () => {
      const { scope } = get();
      set({ saving: "scope", error: null });
      try {
        const res = await window.closeCode.agentPermissionClearScope({ scope });
        if (!res.ok) {
          set({ error: res.error ?? "Those permissions could not be cleared." });
          return;
        }
        await refresh();
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      } finally {
        set({ saving: null });
      }
    },

    clearError: () => set({ error: null }),
  };
});
