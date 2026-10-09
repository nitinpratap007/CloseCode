import { ipcMain, BrowserWindow } from "electron";
import {
  createTerminal,
  getSession,
  listSessions,
  writeToTerminal,
  resizeTerminal,
  killTerminal,
  killAllTerminals,
  restartTerminal,
  attachDataListeners,
} from "../services/terminal";

function getMainWindow(): BrowserWindow | null {
  const wins = BrowserWindow.getAllWindows();
  return wins[0] ?? null;
}

function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, ...args);
  }
}

export function registerTerminalIpc(): void {
  ipcMain.handle("terminal:create", (_e, opts: { cwd?: string; cols?: number; rows?: number; shell?: string }) => {
    try {
      const session = createTerminal({ cwd: opts.cwd, cols: opts.cols, rows: opts.rows, shell: opts.shell });
      // Attach listeners to broadcast data
      attachDataListeners(
        session,
        (id, data) => broadcast("terminal:data", { id, data }),
        (id, code) => broadcast("terminal:exit", { id, exitCode: code })
      );
      return { ok: true, result: { id: session.id, shell: session.shell, cwd: session.cwd, cols: session.cols, rows: session.rows, isPty: session.isPty } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("terminal:write", (_e, id: string, data: string) => {
    try {
      writeToTerminal(id, data);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("terminal:resize", (_e, id: string, cols: number, rows: number) => {
    try {
      resizeTerminal(id, cols, rows);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("terminal:kill", (_e, id: string) => {
    try {
      killTerminal(id);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("terminal:kill-all", () => {
    try {
      killAllTerminals();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("terminal:restart", (_e, id: string) => {
    try {
      const old = getSession(id);
      const cwd = old?.cwd;
      const shell = old?.shell;
      // Kill old
      killTerminal(id);
      // Create new
      const session = createTerminal({ cwd, shell, cols: old?.cols, rows: old?.rows });
      attachDataListeners(
        session,
        (sid, data) => broadcast("terminal:data", { id: sid, data }),
        (sid, code) => broadcast("terminal:exit", { id: sid, exitCode: code })
      );
      return { ok: true, result: { id: session.id, shell: session.shell, cwd: session.cwd, cols: session.cols, rows: session.rows, isPty: session.isPty } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("terminal:list", () => {
    try {
      return { ok: true, result: listSessions() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("terminal:clear", (_e, id: string) => {
    // Clear is handled in renderer, but we also send a clear event if needed
    // For now just return ok
    return { ok: true };
  });
}
