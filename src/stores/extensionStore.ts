// Close Code — Extension store (Phase 13)
// Lists discovered extensions, toggles enable/disable, and syncs
// extension-contributed commands into the command registry so they show up
// in the command palette and can be executed from anywhere.

import { create } from "zustand";
import type { ExtensionInfo } from "../types/electron";
import { registerCommand, unregisterCommand, type CommandId } from "../commands/registry";

interface ExtensionState {
  extensions: ExtensionInfo[];
  registeredCommandIds: string[];
  error: string | null;
  started: boolean;
  startListening: () => void;
  load: () => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<boolean>;
  reload: () => Promise<void>;
  syncCommands: (extensions: ExtensionInfo[]) => void;
}

function syncCommandsFx(prev: string[], extensions: ExtensionInfo[]): string[] {
  for (const id of prev) {
    try {
      unregisterCommand(id as CommandId);
    } catch {
      // ignore
    }
  }
  const next: string[] = [];
  for (const ext of extensions) {
    if (!ext.enabled) continue;
    for (const cmd of ext.commands) {
      try {
        registerCommand({
          id: cmd.id as CommandId,
          title: cmd.title,
          shortcut: "",
          description: `Extension: ${ext.displayName}`,
          execute: () => {
            void window.closeCode.extensionExecCommand(cmd.id).then((res) => {
              if (!res.ok) {
                window.alert(`Extension command "${cmd.id}" failed: ${res.error ?? "unknown error"}`);
              }
            });
          },
        });
        next.push(cmd.id);
      } catch {
        // duplicate or invalid — skip
      }
    }
  }
  return next;
}

export const useExtensionStore = create<ExtensionState>((set, get) => ({
  extensions: [],
  registeredCommandIds: [],
  error: null,
  started: false,

  startListening: () => {
    if (get().started) return;
    set({ started: true });
    window.closeCode.onExtensionsChanged(({ extensions }) => {
      set((s) => ({
        extensions,
        registeredCommandIds: syncCommandsFx(s.registeredCommandIds, extensions),
      }));
    });
    void get().load();
  },

  load: async () => {
    try {
      const extensions = await window.closeCode.extensionList();
      set((s) => ({
        extensions,
        registeredCommandIds: syncCommandsFx(s.registeredCommandIds, extensions),
        error: null,
      }));
    } catch (err) {
      set({ error: String(err) });
    }
  },

  setEnabled: async (id, enabled) => {
    try {
      const res = await window.closeCode.extensionSetEnabled(id, enabled);
      if (res.ok && res.result) {
        set((s) => ({
          extensions: res.result!,
          registeredCommandIds: syncCommandsFx(s.registeredCommandIds, res.result!),
          error: null,
        }));
        return true;
      }
      set({ error: res.error ?? "Failed to toggle extension" });
      return false;
    } catch (err) {
      set({ error: String(err) });
      return false;
    }
  },

  reload: async () => {
    try {
      const res = await window.closeCode.extensionReload();
      if (res.ok && res.result) {
        set((s) => ({
          extensions: res.result!,
          registeredCommandIds: syncCommandsFx(s.registeredCommandIds, res.result!),
          error: null,
        }));
      } else {
        set({ error: res.error ?? "Failed to reload extensions" });
      }
    } catch (err) {
      set({ error: String(err) });
    }
  },

  syncCommands: (extensions) => {
    set((s) => ({ registeredCommandIds: syncCommandsFx(s.registeredCommandIds, extensions) }));
  },
}));

// Expose for CDP / unit tests
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__extensionStore = useExtensionStore;
}