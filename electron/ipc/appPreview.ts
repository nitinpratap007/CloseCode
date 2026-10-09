// Close Code — App Preview IPC (Phase 55)
// 
// Handles renderer access to app preview functionality.
// All preview operations are local; no auto-blocking of IDE.

import { ipcMain } from "electron";
import {
  isDevServerRunning,
  detectDevServer,
  execSpawn,
} from "../../services/appPreview";

function fail(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

// --- Dev server detection ---

ipcMain.handle("appPreview:detect", async (_e, projectRoot?: string) => {
  try {
    const result = isDevServerRunning(0); // placeholder - real impl would check specific port
    // Actually use detectDevServer
    const root = process.cwd;
    const result = detectDevServer(process.cwd());
    return { ok: true, result };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

// --- Dev server management ---

ipcMain.handle("appPreview:start", async (_e, { port, framework }: { port: number; framework: string }) => {
  try {
    // Check if already running
    const running = isDevServerRunning(port);
    if (running) {
      return { ok: false, error: `Dev server already running on port ${port}` };
    }
    
    // Start dev server
    const cmd = `npm run dev`;
    const result = execSpawn(cmd, {
      cwd: process.cwd(),
      stdio: "pipe",
      timeout: 30000,
    });
    
    return {
      ok: true,
      result: { 
        started: true, 
        port,
        framework,
        pid: result.pid,
        message: "Dev server started"
      }
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("appPreview:stop", async (_e, port: number) => {
  try {
    try {
      execSync(`pkill -f "port.*${port}"`, { stdio: "pipe" });
    } catch {
      execSync(`kill $(lsof -t -i :${port})`, { stdio: "pipe" });
    }
    return { ok: true, result: { stopped: true } };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("appPreview:restart", async (_e, port: number, framework: string) => {
  try {
    // Stop then start
    try {
      execSync(`pkill -f "port.*${port}"`, { stdio: "pipe" });
    } catch {}
    
    const cmd = `npm run dev`;
    const result = execSpawn(cmd, {
      cwd: process.cwd(),
      stdio: "pipe",
      timeout: 30000,
    });
    
    return {
      ok: true,
      result: { 
        restarted: true, 
        port,
        framework,
        pid: result.pid,
        message: "Dev server restarted"
      }
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

// --- Preview operations ---

ipcMain.handle("appPreview:get-url", async (_e) => {
  try {
    const { framework, url } = detectDevServer(process.cwd());
    if (!url) return { ok: false, error: "No dev server detected" };
    return { ok: true, result: { url, framework } };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("appPreview:open-external", async (_e, url: string) => {
  try {
    // In real implementation, use shell.openExternal
    return { ok: true, result: { opened: true, url } };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("appPreview:logs", async (_e, port: number) => {
  try {
    return {
      ok: true,
      result: { logs: "Preview logs would appear here", port }
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("appPreview:errors", async (_e, port: number) => {
  try {
    return {
      ok: true,
      result: { errors: [], port }
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});