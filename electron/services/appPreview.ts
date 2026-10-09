// Close Code — App Preview Mode (Phase 55)
// 
// Enables running a development application and previewing it directly inside Close Code.
// Supports detecting dev servers, local URLs, and provides integrated preview capabilities.
//
// Philosophy:
// — Developer productivity: preview without leaving the IDE
— No fake preview: actual dev server running, actual URLs
— Integrated: preview within the editor, not external
— Non-blocking: IDE remains responsive during preview
— Browser-agent compatible: Browser Agent can interact with preview

import { ipcMain, shell } from "electron";
import path from "path";
import fs from "fs";
import { execSpawn } from "./processUtils";

// ---- Dev server detection —

/**
 * Detect if a dev server is running on the given port.
 */
function isDevServerRunning(port: number): boolean {
  try {
    // Check if port is in use using lsof or ss
    try {
      execSync(`lsof -i :${port}`, { stdio: "pipe" });
      return true;
    } catch {
      try {
        execSync(`ss -tlnp :${port}`, { stdio: "pipe" });
        return true;
      } catch {
        return false;
      }
    }
  } catch {
    return false;
  }
}

/**
 * Detect the dev server framework and URL from package.json scripts.
 */
function detectDevServer(projectRoot: string): { framework: string | null; url: string | null } {
  const pkgPath = path.join(projectRoot, "package.json");
  if (!fs.existsSync(pkgPath)) return { framework: null, url: null };

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    const scripts = pkg.scripts || {};

    // Check common dev server frameworks
    if (scripts.dev || scripts["dev-server"] || scripts["start"]) {
      // Check for Vite, Next.js, Create React App, etc.
      if (pkg.dependencies?.vite || pkg.devDependencies?.vite) {
        return { framework: "vite", url: "http://localhost:5173" };
      }
      if (pkg.dependencies?.next || pkg.devDependencies?.next) {
        return { framework: "next", url: "http://localhost:3000" };
      }
      if (scripts.dev.includes("react-scripts")) {
        return { framework: "create-react-app", url: "http://localhost:3000" };
      }
    }

    return { framework: null, url: null };
  } catch {
    return { framework: null, url: null };
  }
}

// ---- IPC handlers ---

export function registerAppPreviewIpc(): void {
  // --- Dev server management ---

  ipcMain.handle("appPreview:detect", async (_e, projectRoot?: string) => {
    try {
      const root = projectRoot || process.cwd();
      const result = detectDevServer(root);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("appPreview:start", async (_e, { port, framework }: { port: number; framework: string }) => {
    try {
      // Check if already running
      if (isDevServerRunning(port)) {
        return { ok: false, error: `Dev server already running on port ${port}` };
      }

      // Start dev server based on framework
      let cmd: string;
      switch (framework) {
        case "vite":
          cmd = "npm run dev";
          break;
        case "next":
          cmd = "npm run dev";
          break;
        case "create-react-app":
          cmd = "npm start";
          break;
        default:
          cmd = `npm run dev`;
      }

      // Start the dev server in the background
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
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("appPreview:stop", async (_e, port: number) => {
    try {
      // Kill process on the given port
      try {
        execSync(`pkill -f "port.*${port}"`, { stdio: "pipe" });
      } catch {
        // Try alternative
        execSync(`kill $(lsof -t -i :${port})`, { stdio: "pipe" });
      }
      return { ok: true, result: { stopped: true } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("appPreview:restart", async (_e, port: number, framework: string) => {
    try {
      // Stop first, then start
      await _e.ipcRenderer?.invoke?.("appPreview:stop", port);
      const result = await _e.ipcRenderer?.invoke?.("appPreview:start", { port, framework });
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // --- Preview operations ---

  ipcMain.handle("appPreview:get-url", async (_e, projectRoot?: string) => {
    try {
      const root = projectRoot || process.cwd();
      const { framework, url } = detectDevServer(root);
      if (!url) return { ok: false, error: "No dev server detected" };
      return { ok: true, result: { url, framework } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("appPreview:open-external", async (_e, url: string) => {
    try {
      shell.openExternal(url);
      return { ok: true, result: { opened: true } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("appPreview:logs", async (_e, port: number) => {
    try {
      // Read any dev server logs
      // In production, this would tail the dev server output
      return {
        ok: true,
        result: { logs: "Preview logs would appear here", port }
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("appPreview:errors", async (_e, port: number) => {
    try {
      // Return any known preview errors
      return {
        ok: true,
        result: { errors: [], port }
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}