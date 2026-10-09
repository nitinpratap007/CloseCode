// Close Code — AI Verification + Run Before & After IPC (Phase 47)
// 
// Handles renderer access to the explicit verification workflow.
// Before/after results are visible; AI cannot claim improvement without evidence.
// Failed verification prevents false success. User can inspect all evidence.

import { ipcMain } from "electron";
import {
  verificationBaselines,
  generateBaselineId,
  runVerificationWorkflow,
  runCheck,
  VerificationResult,
  VerificationBaseline,
  compareResults,
} from "../../services/verificationWorkflow";

function fail(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

// --- Baseline: Run Before ---

ipcMain.handle("verification:run-before", async (_e, projectRoot?: string, checks?: string[]) => {
  try {
    const root = projectRoot || app.getPath("userData");
    const checkList = checks || ["typecheck", "lint", "build", "tests"];

    const baselineId = generateBaselineId();
    const results = runVerificationWorkflow(root, checkList);

    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;
    const baseline: VerificationBaseline = {
      id: baselineId,
      projectRoot: root,
      checkedAt: Date.now(),
      results,
      summary: { total: results.length, passed, failed },
    };

    verificationBaselines.set(baselineId, baseline);

    return {
      ok: true,
      result: { baselineId, baseline, results },
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("verification:run-after", async (_e, baselineId: string, checks?: string[]) => {
  try {
    const baseline = verificationBaselines.get(baselineId);
    if (!baseline) return { ok: false, error: "Baseline not found" };

    const root = baseline.projectRoot;
    const checkList = checks || baseline.results.map((r) => r.check);

    const afterResults = runVerificationWorkflow(root, checkList);
    const comparison = comparison(baseline.results, afterResults);

    return {
      ok: true,
      result: { baseline, afterResults, comparison },
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("verification:compare", async (_e, baselineId: string, afterId: string) => {
  try {
    const baseline = verificationBaselines.get(baselineId);
    const after = verificationBaselines.get(afterId);

    if (!baseline) return { ok: false, error: "Baseline not found" };
    if (!after) return { ok: false, error: "After baseline not found" };

    const comparison = comparison(baseline.results, after.results);

    return {
      ok: true,
      result: comparison,
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

// --- Individual check handlers ---

ipcMain.handle("verification:check:single", async (_e, { check, projectRoot }: { check: string; projectRoot?: string }) => {
  try {
    const root = projectRoot || app.getPath("userData");
    const result = runCheck(check, root);
    return { ok: true, result };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("verification:baselines", async () => {
  try {
    const baselines = Array.from(verificationBaselines.values()).map((b) => ({
      id: b.id,
      projectRoot: b.projectRoot,
      checkedAt: b.checkedAt,
      summary: b.summary,
    }));
    return { ok: true, result: baselines };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("verification:clear-baseline", async (_e, baselineId: string) => {
  try {
    verificationBaselines.delete(baselineId);
    return { ok: true, result: { cleared: true } };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

// --- Comparison result structure export helpers ---

export type { VerificationResult, VerificationBaseline };