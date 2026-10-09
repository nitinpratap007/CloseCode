// Close Code — Crash Reporting + Telemetry Privacy System IPC (Phase 53)
// 
// Handles renderer access to crash reporting and telemetry controls.
// All data is local-first; no source code is collected; sensitive information
// is filtered. User can opt-in or opt-out of telemetry.

import { ipcMain } from "electron";
import {
  initializeCrashReporting,
  logCrash,
  readCrashReports,
  clearLogs,
  exportLogs,
  getTelemetryState,
  setTelemetryState,
} from "../../services/crashReporter";

function fail(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

// --- Crash reporting ---

ipcMain.handle("crashReporter:initialize", async (_e) => {
  try {
    initializeCrashReporting();
    return {
      ok: true,
      result: { telemetryEnabled: isTelemetryEnabledFromStore() },
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("crashReporter:get-logs", async (_e) => {
  try {
    const reports = readCrashLogsFromStore();
    return { ok: true, result: reports };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("crashReporter:clear-logs", async (_e) => {
  try {
    clearLogs();
    return { ok: true, result: { cleared: true } };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("crashReporter:export-logs", async (_e) => {
  try {
    const result = exportLogsFromStore();
    return { ok: true, result };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

// --- Telemetry opt-in/opt-out ---

ipcMain.handle("telemetry:get-state", async (_e) => {
  try {
    const enabled = isTelemetryEnabledFromStore();
    return { ok: true, result: { enabled } };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("telemetry:set-state", async (_e, enabled: boolean) => {
  try {
    const state = setTelemetryState(enabled);
    return { ok: true, result: { enabled: state } };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

// Helper: read from the simulated "store" (in a real app, this would use
// electron's session storage or a prefs file). For this implementation,
// we just check the global variable set by the service.
function isTelemetryEnabledFromStore(): boolean {
  // The service maintains its own state; we reflect it here.
  // In production, persist to app.getPath("userData")/.closecode/telemetry.json
  return telemetryEnabled; // fallback to global (will be updated by setTelemetryState)
}

// For readLogs/clearLogs/exportLogs we similarly delegate to the service;
// the IPC handlers above just proxy.
function readCrashLogsFromStore(): any[] {
  return readCrashReportsFromService();
}
function clearLogsFromService(): void {
  clearLogs();
}
function exportLogsFromStore(): any {
  return exportLogsFromService();
}

// Export types for use in renderer if needed
export type { } from "../../services/crashReporter";