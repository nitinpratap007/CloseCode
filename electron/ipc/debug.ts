import { ipcMain, BrowserWindow } from "electron";
import * as path from "path";
import { DebugSessionManager, registerDebugAdapterFactory } from "../services/debug/adapter";
import { NodeJsDebugAdapter } from "../services/debug/nodeAdapter";
import type { DebugConfig } from "../services/debug/types";

registerDebugAdapterFactory("node", (config, emit) => new NodeJsDebugAdapter(config, emit));

const manager = new DebugSessionManager((event) => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("debug:event", event);
  }
});

export function stopDebugger(): Promise<void> {
  return manager.stop();
}

export function registerDebugIpc(): void {
  ipcMain.handle("debug:start", async (_e, config: DebugConfig) => {
    try {
      if (!config?.file) throw new Error("No file to run");
      const resolved = config.cwd ? path.resolve(config.cwd, config.file) : config.file;
      await manager.start({
        file: resolved,
        cwd: config.cwd ?? path.dirname(resolved),
        args: config.args,
        env: config.env,
      });
      return { ok: true, result: { state: manager.getState() } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("debug:stop", async () => {
    try {
      await manager.stop();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("debug:pause", async () => {
    try {
      await manager.pause();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("debug:continue", async () => {
    try {
      await manager.resume();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("debug:stepOver", async () => {
    try {
      await manager.stepOver();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("debug:stepInto", async () => {
    try {
      await manager.stepInto();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("debug:stepOut", async () => {
    try {
      await manager.stepOut();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("debug:setBreakpoint", async (_e, file: string, line: number) => {
    try {
      if (!file || typeof line !== "number") throw new Error("Usage: debugSetBreakpoint(file, line)");
      const bp = await manager.setBreakpoint(file, line);
      return { ok: true, result: bp };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("debug:removeBreakpoint", async (_e, id: string) => {
    try {
      await manager.removeBreakpoint(id);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("debug:getBreakpoints", () => {
    try {
      return { ok: true, result: manager.getBreakpoints() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("debug:getVariables", async (_e, opts: { frameId?: number; objectId?: string }) => {
    try {
      if (typeof opts?.objectId === "string") {
        const scope = await manager.expandObject(opts.objectId);
        return { ok: true, result: { scopes: [scope] } };
      }
      if (typeof opts?.frameId === "number") {
        const scopes = await manager.getVariables(opts.frameId);
        return { ok: true, result: { scopes } };
      }
      throw new Error("Usage: debugGetVariables({frameId} | {objectId})");
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("debug:evaluate", async (_e, expression: string) => {
    try {
      if (!expression.trim()) throw new Error("Empty expression");
      const result = await manager.evaluate(expression);
      return { ok: result.ok, result: { value: result.value }, error: result.error };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("debug:getState", () => {
    try {
      return { ok: true, result: { state: manager.getState() } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}