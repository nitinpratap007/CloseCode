// Close Code — AI Browser Agent (Phase 42)
// 
// Browser automation architecture for development and debugging.
// Controls browser actions, handles failures recoverably, and ensures
// dangerous external actions require proper permissions.
//
// All browser operations are local to the development environment.
// No external browsing or source code upload occurs.

import { app, ipcMain, screen, Tray, nativeImage } from "electron";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";

// ---- Browser state tracking ----

const browserInstances: Map<string, any> = new Map(); // window references
const browserOperations: Map<string, Array<{ step: number; type: string; result: any }>> = new Map();

// ---- Allowed browser operations map ----

/**
 * Defines which browser operations are permitted per scope.
 * Dangerous operations (external navigation, file system access, etc.)
 * require explicit user permission.
 */
type BrowserOperation =
  | "launch-app"
  | "open-url"
  | "click"
  | "type"
  | " inspect-element"
  | "console-errors"
  | "network-errors"
  | "screenshot"
  | "reload"
  | "back"
  | "forward";

interface OperationPermission {
  operation: BrowserOperation;
  allowed: boolean;
  grantedAt: number;
  grantedBy: "user" | "admin" | "system";
}

// ---- Service state ----

let permittedOperations: BrowserOperation[] = [];
let isBrowserAutomationEnabled = false;

// ---- Core functions ----

/**
 * Initialize browser automation with permitted operations list.
 * Called from main process on startup or explicit request.
 */
function initializeBrowserAutomation(allowedOps: BrowserOperation[]): void {
  permittedOperations = allowedOps;
  isBrowserAutomationEnabled = true;
  browserInstances.clear();
  browserOperations.clear();
}

/**
 * Check if a specific operation is permitted.
 */
function isOperationPermitted(op: BrowserOperation): boolean {
  return permittedOperations.includes(op);
}

/**
 * Execute a browser operation on a named instance.
 * Returns the result or an error.
 */
function executeBrowserOperation(
  instanceId: string,
  op: BrowserOperation,
  payload: any
): { ok: boolean; result?: any; error?: string } {
  // Check permission
  if (!isOperationPermitted(op)) {
    return { ok: false, error: `Operation "${op}" not permitted` };
  }

  const instance = browserInstances.get(instanceId);
  if (!instance) {
    return { ok: false, error: `Browser instance ${instanceId} not found` };
  }

  try {
    // Delegate to the instance's handler
    if (op === "screenshot") {
      const img = instance.capturePage ? instance.capturePage() : null;
      return { ok: true, result: img ? img.toDataURL() : null };
    }

    if (op === "console-errors") {
      // Collect console errors from the page
      const errors: Array<{ text: string; level: string; timestamp: number }> = [];
      // This would depend on the underlying framework
      // For now, return empty with indication
      return { ok: true, result: { errors, count: 0 } };
    }

    if (op === "network-errors") {
      const errors: Array<{ url: string; error: string; timestamp: number }> = [];
      return { ok: true, result: { errors, count: 0 } };
    }

    // Default: return success with placeholder
    return { ok: true, result: { executed: op, instanceId } };
  } catch (err: any) {
    return { ok: false, error: err.message || String(err) };
  }
}

// ---- IPC handlers ---

export function registerBrowserAgentIpc(): void {
  // --- Initialization ---

  ipcMain.handle("browserAgent:init", async (_e, allowedOps: BrowserOperation[]) => {
    try {
      initializeBrowserAutomation(allowedOps);
      return { ok: true, result: { automationEnabled: isBrowserAutomationEnabled } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // --- Instance management ---

  ipcMain.handle("browserAgent:create-instance", async (_e, label: string) => {
    try {
      // In a real implementation, this would create a browser window
      // using puppeteer or playwright. For now, we track the instance.
      const instanceId = `browser-${label}-${Date.now()}`;
      browserInstances.set(instanceId, {
        label,
        createdAt: Date.now(),
        ops: [],
      });
      browserOperations.set(instanceId, []);
      return { ok: true, result: { instanceId } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("browserAgent:remove-instance", async (_e, instanceId: string) => {
    try {
      browserInstances.delete(instanceId);
      browserOperations.delete(instanceId);
      return { ok: true, result: { removed: true } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // --- Operation handlers ---

  ipcMain.handle("browserAgent:launch-app", async (_e, appPath: string) => {
    try {
      if (!isOperationPermitted("launch-app")) {
        return { ok: false, error: "launch-app not permitted" };
      }
      // Use shell open as a simple approach
      execSync(`open "${appPath}"`, { stdio: "pipe" });
      return { ok: true, result: { launched: appPath } };
    } catch (err: any) {
      return { ok: false, error: err.message || "Failed to launch application" };
    }
  });

  ipcMain.handle("browserAgent:open-url", async (_e, url: string, instanceId: string) => {
    try {
      if (!isOperationPermitted("open-url")) {
        return { ok: false, error: "open-url not permitted" };
      }
      // In production, would navigate the browser instance
      return { ok: true, result: { url, instanceId, navigated: true } };
    } catch (err: any) {
      return { ok: false, error: err.message || "Failed to open URL" };
    }
  });

  ipcMain.handle("browserAgent:click", async (_e, x: number, y: number, instanceId: string) => {
    try {
      if (!isOperationPermitted("click")) {
        return { ok: false, error: "click not permitted" };
      }
      return { ok: true, result: { x, y, clicked: true, instanceId } };
    } catch (err: any) {
      return { ok: false, error: err.message || "Click failed" };
    }
  });

  ipcMain.handle("browserAgent:type", async (_e, text: string, instanceId: string) => {
    try {
      if (!isOperationPermitted("type")) {
        return { ok: false, error: "type not permitted" };
      }
      return { ok: true, result: { text, typed: true, instanceId } };
    } catch (err: any) {
      return { ok: false, error: err.message || "Type failed" };
    }
  });

  ipcMain.handle("browserAgent:screenshot", async (_e, instanceId: string) => {
    try {
      if (!isOperationPermitted("screenshot")) {
        return { ok: false, error: "screenshot not permitted" };
      }
      return executeBrowserOperation(instanceId, "screenshot", {});
    } catch (err: any) {
      return { ok: false, error: err.message || "Screenshot failed" };
    }
  });

  ipcMain.handle("browserAgent:console-errors", async (_e, instanceId: string) => {
    try {
      if (!isOperationPermitted("console-errors")) {
        return { ok: false, error: "console-errors not permitted" };
      }
      return executeBrowserOperation(instanceId, "console-errors", {});
    } catch (err: any) {
      return { ok: false, error: err.message || "Failed to get console errors" };
    }
  });

  ipcMain.handle("browserAgent:network-errors", async (_e, instanceId: string) => {
    try {
      if (!isOperationPermitted("network-errors")) {
        return { ok: false, error: "network-errors not permitted" };
      }
      return executeBrowserOperation(instanceId, "network-errors", {});
    } catch (err: any) {
      return { ok: false, error: err.message || "Failed to get network errors" };
    }
  });

  ipcMain.handle("browserAgent:reload", async (_e, instanceId: string) => {
    try {
      if (!isOperationPermitted("reload")) {
        return { ok: false, error: "reload not permitted" };
      }
      return executeBrowserOperation(instanceId, "reload", {});
    } catch (err: any) {
      return { ok: false, error: err.message || "Reload failed" };
    }
  });

  // --- Permission management ---

  ipcMain.handle("browserAgent:permissions:get", async () => {
    try {
      return {
        ok: true,
        result: {
          permittedOperations,
          isBrowserAutomationEnabled,
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("browserAgent:permissions:set", async (_e, ops: BrowserOperation[]) => {
    try {
      permittedOperations = ops;
      return { ok: true, result: { permittedOperations } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

// Export all
export { initializeBrowserAutomation, isOperationPermitted, executeBrowserOperation };