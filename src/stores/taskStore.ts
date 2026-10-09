// Close Code — task store (Phase 29)
//
// Renderer half of the persistent AI task list. This store is a *projection* of
// what the main process holds: every mutation goes over IPC, the main process
// is the only writer of the store files on disk, and the list always arrives
// back either as the mutation's reply or as a `task:ai:changed` push. The
// renderer never constructs a task of its own — a task it has not been served
// by the main process does not exist.
//
// Tasks are workspace-scoped, so the store keys the list on the workspace root
// and re-reads whenever that root changes (the AiPanel drives `setWorkspace`
// from the workspace store). A task from the previous folder is not carried
// over; the push listener ignores changes for any other workspace.

import { create } from "zustand";
import { useWorkspaceStore } from "./workspaceStore";
import type { AiTask, AiTaskCreateInput, AiTaskUpdateInput } from "../types/electron";

export interface TaskStoreState {
  tasks: AiTask[];
  /** The workspace whose list `tasks` is. `null` = no folder open (rootless list). */
  workspace: string | null;
  error: string | null;
  notice: string | null;
  busy: boolean;
  listening: boolean;

  startListening: () => void;
  /** Point the store at a workspace and re-read its list. `undefined` keeps the current one. */
  setWorkspace: (workspace: string | null) => Promise<void>;
  refresh: () => Promise<void>;
  create: (input: AiTaskCreateInput) => Promise<void>;
  update: (id: string, patch: AiTaskUpdateInput) => Promise<void>;
  remove: (id: string) => Promise<void>;
  cancel: (id: string, reason?: string) => Promise<void>;
  retry: (id: string) => Promise<void>;
  assign: (id: string, assignee: string | null) => Promise<void>;
  clearError: () => void;
  clearNotice: () => void;
}

function msg(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : typeof err === "string" ? err : fallback;
}

export const useTaskStore = create<TaskStoreState>((set, get) => ({
  tasks: [],
  workspace: null,
  error: null,
  notice: null,
  busy: false,
  listening: false,

  startListening: () => {
    if (get().listening) return;
    set({ listening: true });
    window.closeCode.onAiTaskChanged((payload) => {
      // Only the workspace on the screen owns `tasks`. A change pushed for
      // another folder is not this list and must not clobber it.
      if (payload.workspace !== (get().workspace ?? null)) return;
      set({ tasks: payload.tasks });
    });
    void get().refresh();
  },

  setWorkspace: async (workspace) => {
    if (workspace === get().workspace) return;
    set({ workspace, tasks: [], error: null, notice: null });
    await get().refresh();
  },

  refresh: async () => {
    const workspace = get().workspace;
    try {
      const res = await window.closeCode.aiTasksList(workspace);
      if (!res.ok) {
        set({
          error: res.error ?? "The task list could not be read.",
          ...(res.corrupted && res.corruptFile
            ? { notice: `The task file was unreadable and was moved aside (${res.corruptFile}).` }
            : {}),
        });
        return;
      }
      set({ tasks: res.tasks ?? [], error: null });
    } catch (err) {
      set({ error: msg(err, "The task list could not be read.") });
    }
  },

  create: async (input) => {
    set({ busy: true, error: null });
    try {
      const res = await window.closeCode.aiTaskCreate({ workspace: get().workspace, input });
      set({ busy: false });
      if (!res.ok) {
        set({ error: res.error ?? "The task could not be created." });
        return;
      }
      // The list arrives by push; the reply's single task is enough for the
      // notice without a second round trip.
      set({ notice: `Created “${res.task?.title ?? input.title}”.` });
    } catch (err) {
      set({ busy: false, error: msg(err, "The task could not be created.") });
    }
  },

  update: async (id, patch) => {
    set({ busy: true, error: null });
    try {
      const res = await window.closeCode.aiTaskUpdate({ workspace: get().workspace, id, patch });
      set({ busy: false });
      if (!res.ok) {
        set({ error: res.error ?? "The task could not be updated." });
        return;
      }
      if (patch.status === "completed") set({ notice: `Completed "${res.task?.title ?? id}".` });
    } catch (err) {
      set({ busy: false, error: msg(err, "The task could not be updated.") });
    }
  },

  remove: async (id) => {
    set({ busy: true, error: null });
    try {
      const res = await window.closeCode.aiTaskDelete({ workspace: get().workspace, id });
      set({ busy: false });
      if (!res.ok) {
        set({ error: res.error ?? "The task could not be deleted." });
        return;
      }
      set({ notice: "Task deleted." });
    } catch (err) {
      set({ busy: false, error: msg(err, "The task could not be deleted.") });
    }
  },

  cancel: async (id, reason) => {
    set({ busy: true, error: null });
    try {
      const res = await window.closeCode.aiTaskCancel({
        workspace: get().workspace,
        id,
        ...(reason ? { reason } : {}),
      });
      set({ busy: false });
      if (!res.ok) {
        set({ error: res.error ?? "The task could not be cancelled." });
        return;
      }
      set({ notice: `Cancelled "${res.task?.title ?? id}". The record is kept.` });
    } catch (err) {
      set({ busy: false, error: msg(err, "The task could not be cancelled.") });
    }
  },

  retry: async (id) => {
    set({ busy: true, error: null });
    try {
      const res = await window.closeCode.aiTaskRetry({ workspace: get().workspace, id });
      set({ busy: false });
      if (!res.ok) {
        set({ error: res.error ?? "The task could not be retried." });
        return;
      }
      set({ notice: `Retrying "${res.task?.title ?? id}" (attempt ${res.task?.attempts ?? 1}).` });
    } catch (err) {
      set({ busy: false, error: msg(err, "The task could not be retried.") });
    }
  },

  assign: async (id, assignee) => {
    set({ busy: true, error: null });
    try {
      const res = await window.closeCode.aiTaskAssign({ workspace: get().workspace, id, assignee });
      set({ busy: false });
      if (!res.ok) {
        set({ error: res.error ?? "The task could not be assigned." });
        return;
      }
      set({ notice: `Assigned "${res.task?.title ?? id}" to ${assignee ?? "nobody"}.` });
    } catch (err) {
      set({ busy: false, error: msg(err, "The task could not be assigned.") });
    }
  },

  clearError: () => set({ error: null }),
  clearNotice: () => set({ notice: null }),
}));

/** The workspace root, read like the session store does — no cycle involved. */
export function readWorkspaceRoot(): string | null {
  try {
    return useWorkspaceStore.getState().root ?? null;
  } catch {
    return null;
  }
}