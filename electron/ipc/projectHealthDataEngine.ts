// Close Code — Advanced Project Health Data Engine IPC (Phase 56)
// 
// Handles renderer access to project health data collection.
// All health data is derived from real project signals — no invented scores.

import { ipcMain } from "electron";
import {
  runTypeCheck,
  runLintCheck,
  runBuildCheck,
  runTestsCheck,
  runDependencyCheck,
  runGitStatus,
  runSecurityScan,
  getProjectConfig,
  runAiVerificationCheck,
  ProjectHealthData,
  HealthCheckResult,
} from "../../services/projectHealthDataEngine";

function fail(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

// --- Individual check handlers ---

ipcMain.handle("health:check:typecheck", async (_e, projectRoot?: string) => {
  try {
    const result = await runTypeCheck(projectRoot || process.cwd());
    return { ok: true, result };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("health:check:lint", async (_e, projectRoot?: string) => {
  try {
    const result = await runLintCheck(projectRoot || process.cwd());
    return { ok: true, result };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("health:check:build", async (_e, projectRoot?: string) => {
  try {
    const result = await runBuildCheck(projectRoot || process.cwd());
    return { ok: true, result };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("health:check:tests", async (_e, projectRoot?: string) => {
  try {
    const result = await runTestsCheck(projectRoot || process.cwd());
    return { ok: true, result };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("health:check:dependencies", async (_e, projectRoot?: string) => {
  try {
    const result = await runDependencyCheck(projectRoot || process.cwd());
    return { ok: true, result };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("health:check:git", async (_e, projectRoot?: string) => {
  try {
    const result = await runGitStatus(projectRoot || process.cwd());
    return { ok: true, result };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("health:check:security", async (_e, projectRoot?: string) => {
  try {
    const result = await runSecurityScan(projectRoot || process.cwd());
    return { ok: true, result };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("health:check:configuration", async (_e, projectRoot?: string) => {
  try {
    const result = await getProjectConfig(projectRoot || process.cwd());
    return { ok: true, result };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("health:check:ai-verification", async (_e, projectRoot?: string) => {
  try {
    const result = await runAiVerificationCheck(projectRoot || process.cwd());
    return { ok: true, result };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

// --- Full health scan ---

ipcMain.handle("health:scan:full", async (_e, projectRoot?: string) => {
  try {
    const result = await runFullHealthScan(projectRoot || process.cwd());
    return { ok: true, result };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

// --- Helper: full scan (internal) ---

async function runFullHealthScan(projectRoot: string): Promise<ProjectHealthData> {
  const framework = detectTestFramework(projectRoot);

  const checks: HealthCheckResult[] = [
    runTypeCheck(projectRoot),
    runLintCheck(projectRoot),
    runBuildCheck(projectRoot),
    runTestsCheck(projectRoot, framework),
    runDependencyCheck(projectRoot),
    runGitStatus(projectRoot),
    runSecurityScan(projectRoot),
    getProjectConfig(projectRoot),
    runAiVerificationCheck(projectRoot),
  ];

  const passed = checks.filter((c) => c.status === "passed").length;
  const failed = checks.filter((c) => c.status === "failed").length;
  const unavailable = checks.filter((c) => c.status === "unavailable").length;

  return {
    projectRoot,
    scannedAt: Date.now(),
    version: process.env.npm_package_version || "0.0.0",
    checks,
    summary: {
      total: checks.length,
      passed,
      failed,
      unavailable,
    },
    metadata: {},
  };
}

// Export types for use in renderer
export type { HealthCheckResult, ProjectHealthData };