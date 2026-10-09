// Close Code — Fix Everything + Core Project Health IPC (Phase 40)
// 
// Handles renderer access to the fix-everything workflow and project health metrics.
// All operations are local; no source code is auto-uploaded.

import { ipcMain } from "electron";
import {
  computeProjectHealth,
  runFixEverything,
  checkTypeScript,
  checkBuild,
  checkLint,
  checkTests,
  type ProjectHealthMetrics,
  type FixEverythingOptions,
  type FixResult,
  type FixResult,
} from "../../services/projectHealth";

function fail(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

// --- Project Health ---

ipcMain.handle("projectHealth:compute", async () => {
  try {
    const health = computeProjectHealth();
    return { ok: true, result: health };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

/// --- Fix Everything ---

ipcMain.handle(
  "fixEverything:run",
  async (_e, options?: FixEverythingOptions) => {
    try {
      const result = runFixEverything(options ?? {});
      return { ok: true, result };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }
);

// --- Individual check handlers ---

ipcMain.handle("fixEverything:check:ts", async () => {
  try {
    const result = checkTypeScript();
    return { ok: true, result };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("fixEverything:check:build", async () => {
  try {
    const result = checkBuild();
    return { ok: true, result };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("fixEverything:check:lint", async () => {
  try {
    const result = checkLint();
    return { ok: true, result };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("fixEverything:check:test", async () => {
  try {
    const result = checkTests();
    return { ok: true, result };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

// --- Convenience: run all checks in sequence ---

ipcMain.handle("fixEverything:check:all", async () => {
  try {
    const ts = checkTypeScript();
    const lint = checkLint();
    const build = checkBuild();
    const test = checkTests();

    return {
      ok: true,
      result: {
        tsOk: ts.ok,
        lintOk: lint.ok,
        buildOk: build.ok,
        testOk: test.ok,
        tsError: ts.error,
        lintError: lint.error,
        buildError: build.error,
        testError: test.error,
      },
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});