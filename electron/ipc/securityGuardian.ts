// Close Code — AI Security Guardian IPC (Phase 44)
// 
// Handles renderer access to security code analysis. All findings are based on
// actual code evidence. No secrets are logged or exposed. Security fixes
// require explicit user approval — scanning never auto-modifies critical code.

import { ipcMain } from "electron";
import {
  scanProject,
  SecurityFinding,
  SecurityReport,
  runSecurityScan,
} from "../../services/securityGuardian";

function fail(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

// --- Project scanning ---

ipcMain.handle("securityGuardian:scan", async (_e, projectRoot?: string) => {
  try {
    const root = projectRoot || app.getPath("userData");
    if (!fs.existsSync(path.join(root, "package.json")) && !fs.existsSync(path.join(root, "tsconfig.json"))) {
      return { ok: false, error: "No recognized project root found" };
    }
    const report = runSecurityScan(root);
    return { ok: true, result: report };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("securityGuardian:scan-path", async (_e, projectRoot: string) => {
  try {
    if (!fs.existsSync(projectRoot)) {
      return { ok: false, error: "Project root directory does not exist" };
    }
    const report = runSecurityScan(projectRoot);
    return { ok: true, result: report };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

// --- Individual check handlers ---

ipcMain.handle("securityGuardian:check:secrets", async (_e, projectRoot?: string) => {
  try {
    const root = projectRoot || app.getPath("userData");
    const report = runSecurityScan(root);
    const secrets = report.findings.filter((f) => f.category === "hardcoded-secrets");
    return { ok: true, result: { findings: secrets, totalScanned: report.summary.total } };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("securityGuardian:check:shell-injection", async (_e, projectRoot?: string) => {
  try {
    const root = projectRoot || app.getPath("userData");
    const report = runSecurityScan(root);
    const shellfindings = report.findings.filter((f) => f.category === "shell-injection");
    return { ok: true, result: { findings: shellfindings, totalScanned: report.summary.total } };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("securityGuardian:check:injection", async (_e, projectRoot?: string) => {
  try {
    const root = projectRoot || app.getPath("userData");
    const report = runSecurityScan(root);
    const injectionfindings = report.findings.filter((f) => f.category === "code-injection");
    return { ok: true, result: { findings: injectionfindings, totalScanned: report.summary.total } };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("securityGuardian:check:input", async (_e, projectRoot?: string) => {
  try {
    const root = projectRoot || app.getPath("userData");
    const report = runSecurityScan(root);
    const inputfindings = report.findings.filter((f) => f.category === "input-handling");
    return { ok: true, result: { findings: inputfindings, totalScanned: report.summary.total } };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("securityGuardian:check:exposed", async (_e, projectRoot?: string) => {
  try {
    const root = projectRoot || app.getPath("userData");
    const report = runSecurityScan(root);
    const exposedfindings = report.findings.filter((f) => f.category === "exposed-credentials");
    return { ok: true, result: { findings: exposedfindings, totalScanned: report.summary.total } };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("securityGuardian:check:all", async (_e, projectRoot?: string) => {
  try {
    const root = projectRoot || app.getPath("userData");
    const report = runSecurityScan(root);
    return {
      ok: true,
      result: {
        report,
        summary: report.summary,
        findingsBySeverity: {
          info: report.summary.bySeverity.info,
          low: report.summary.bySeverity.low,
          medium: report.summary.bySeverity.medium,
          high: report.summary.bySeverity.high,
          critical: report.summary.bySeverity.critical,
        },
        findingsByCategory: {
          "hardcoded-secrets": report.summary.byCategory["hardcoded-secrets"],
          "insecure-config": report.summary.byCategory["insecure-config"],
          "shell-injection": report.summary.byCategory["shell-injection"],
          "code-injection": report.summary.byCategory["code-injection"],
          "input-handling": report.summary.byCategory["input-handling"],
          authentication: report.summary.byCategory.authentication,
          authorization: report.summary.byCategory.authorization,
          "file-access": report.summary.byCategory["file-access"],
          dependencies: report.summary.byCategory.dependencies,
          "exposed-credentials": report.summary.byCategory["exposed-credentials"],
        },
      },
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

// --- Finding approval and remediation ---

ipcMain.handle("securityGuardian:approve-finding", async (_e, findingId: string, approved: boolean, comments?: string) => {
  try {
    const finding = securityFindings.get(findingId);
    if (!finding) return { ok: false, error: "Finding not found" };

    // Update the finding approval status
    const updated: SecurityFinding = {
      ...finding,
      approved,
      approvedAt: approved ? Date.now() : undefined,
      approvedBy: approved ? "user" : "system",
    };

    securityFindings.set(findingId, updated);

    // In a real implementation, this would also update the underlying
    // security data store or database

    return {
      ok: true,
      result: {
        findingId,
        approved,
        message: approved ? "Finding approved" : "Finding unapproved",
        remediation: updated.remediation,
      },
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("securityGuardian:get-finding", async (_e, findingId: string) => {
  try {
    const finding = securityFindings.get(findingId);
    if (!finding) return { ok: false, error: "Finding not found" };
    return { ok: true, result: finding };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

// --- Report operations ---

ipcMain.handle("securityGuardian:export-report", async (_e, format: "json" | "txt" = "json") => {
  try {
    // Find the most recent report by scanning again or from stored data
    // For now, return structure info
    return {
      ok: true,
      result: {
        format,
        message: "Report export structure — in production, would write file to userData/.closecode/security/",
      },
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

// Export types for use in renderer
export type { SecurityFinding, SecurityReport };