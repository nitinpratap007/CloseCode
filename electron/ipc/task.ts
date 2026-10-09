// Close Code — AI task IPC (Phase 29)
//
// Seven channels over the persistent task store, all returning the app's usual
// `{ ok, … }` envelope. The panel and the task tools speak to the same store
// (`electron/services/aiTasks.ts`), so a task a run creates appears in the user's
// panel in the same instant, and every mutating handler broadcasts a change so
// both windows stay in step.
//
// `delete` exists here and nowhere in the agent tool surface: deleting tracked
// work is a user decision, deliberately not one a model can make.

import { BrowserWindow, ipcMain } from "electron";
import {
  cancelTask,
  createTask,
  deleteTask,
  listTasks,
  retryTask,
  setTasksChangedListener,
  updateTask,
  taskService,
} from "../services/aiTasks";
import type { TaskToolService, TaskCreateInput, TaskUpdateInput } from "../services/agent/tools-tasks";

function sendToAllWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch {
      // the window went away mid-broadcast
    }
  }
}

function fail(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

function workspaceOf(payload: unknown): string | null {
  if (payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).workspace === "string") {
    return (payload as Record<string, unknown>).workspace as string;
  }
  return null;
}

/** Tell every window the task list for this workspace changed. */
export function broadcastTasksChanged(workspace: string | null): void {
  const read = listTasks(workspace);
  sendToAllWindows("task:ai:changed", {
    workspace,
    tasks: read.ok ? read.tasks : [],
    truncated: read.ok ? read.truncated : false,
    redactions: read.ok ? read.redactions : 0,
  });
}

export function registerTaskIpc(): void {
  // The store says "changed"; IPC turns that into the renderer push. This is
  // registered here, not in the store, so the store never knows windows exist —
  // and so the agent tool path, which never touches this file, broadcasts too.
  setTasksChangedListener(broadcastTasksChanged);

  // Type alias so both the factory and the IPC agree on what "the task service"
  // means without importing the store's full surface.
  type Svc = TaskToolService;

  ipcMain.handle("task:ai:list", (_e, payload: unknown) => {
    try {
      const read = listTasks(workspaceOf(payload));
      if (!read.ok) return { ok: false, error: read.error, corrupted: read.corrupted, corruptFile: read.corruptFile };
      return { ok: true, tasks: read.tasks, truncated: read.truncated, redactions: read.redactions };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("task:ai:create", (_e, payload: { workspace?: unknown; input?: unknown }) => {
    try {
      const input = (payload?.input ?? {}) as TaskCreateInput;
      const res = createTask(workspaceOf(payload), input, "user");
      if (!res.ok) return fail(res.error);
      return { ok: true, task: res.task };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("task:ai:update", (_e, payload: { workspace?: unknown; id?: unknown; patch?: unknown }) => {
    try {
      const id = payload?.id;
      if (typeof id !== "string" || !id) return fail("Which task?");
      const patch = (payload?.patch ?? {}) as TaskUpdateInput;
      const res = updateTask(workspaceOf(payload), id, patch, "user");
      if (!res.ok) return fail(res.error);
      return { ok: true, task: res.task };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("task:ai:delete", (_e, payload: { workspace?: unknown; id?: unknown }) => {
    try {
      const id = payload?.id;
      if (typeof id !== "string" || !id) return fail("Which task?");
      const res = deleteTask(workspaceOf(payload), id);
      if (!res.ok) return fail(res.error);
      return { ok: true };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("task:ai:cancel", (_e, payload: { workspace?: unknown; id?: unknown; reason?: unknown }) => {
    try {
      const id = payload?.id;
      if (typeof id !== "string" || !id) return fail("Which task?");
      const reason = typeof payload?.reason === "string" && payload.reason ? payload.reason : null;
      const res = cancelTask(workspaceOf(payload), id, reason, "user");
      if (!res.ok) return fail(res.error);
      return { ok: true, task: res.task };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("task:ai:retry", (_e, payload: { workspace?: unknown; id?: unknown }) => {
    try {
      const id = payload?.id;
      if (typeof id !== "string" || !id) return fail("Which task?");
      const res = retryTask(workspaceOf(payload), id, "user");
      if (!res.ok) return fail(res.error);
      return { ok: true, task: res.task };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("task:ai:assign", (_e, payload: { workspace?: unknown; id?: unknown; assignee?: unknown }) => {
    try {
      const id = payload?.id;
      if (typeof id !== "string" || !id) return fail("Which task?");
      const svc: Svc = taskService;
      const res = svc.update(workspaceOf(payload), id, { assignee: (payload?.assignee as string) ?? null }, "user");
      if (!res.ok) return fail(res.error);
      return { ok: true, task: res.task };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });
}