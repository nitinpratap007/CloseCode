// Close Code — Dependency Doctor IPC (Phase 41)
// 
// Handles renderer access to dependency analysis. All data derived from
// real project files; no auto-modifications without user approval.

import { ipcMain } from "electron";
import path from "path";
import fs from "fs";
import {
  analyzeDependencies,
  DependencyFindings,
  type PackageJsonDeps,
  type normalizeVersion,
} from "../../services/dependencyDoctor";

function fail(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

function getWorkspaceRoot(): string | null {
  try {
    // In production, this would come from the workspace service
    // For now, return user data dir as placeholder
    return app.getPath("userData");
  } catch {
    return null;
  }
}

// --- Analysis ---

ipcMain.handle("dependencyDoctor:analyze", async (_e) => {
  try {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return { ok: false, error: "No workspace open" };

    const findings = analyzeDependencies(workspaceRoot);
    return { ok: true, result: findings };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

// --- Individual check handlers ---

ipcMain.handle("dependencyDoctor:check:missing", async () => {
  try {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return { ok: false, error: "No workspace open" };

    const findings = analyzeDependencies(workspaceRoot);
    const missing = findings.missingDeps.map((m) => ({
      name: m.name,
      kind: m.kind,
      referencedFrom: m.referencedFrom,
    }));
    return { ok: true, result: { missing } };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("dependencyDoctor:check:version-conflicts", async () => {
  try {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return { ok: false, error: "No workspace open" };

    const findings = analyzeDependencies(workspaceRoot);
    const conflicts = findings.versionConflicts.map((c) => ({
      package: c.package,
      kind: c.kind,
      rangeA: c.rangeA,
      rangeB: c.rangeB,
      reason: c.reason,
    }));
    return { ok: true, result: { conflicts } };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("dependencyDoctor:check:peer-deps", async () => {
  try {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return { ok: false, error: "No workspace open" };

    const findings = analyzeDependencies(workspaceRoot);
    const peers = findings.missingPeerDeps.map((m) => ({
      package: m.package,
      peerOf: m.peerOf,
      requiredVersion: m.requiredVersion,
    }));
    return { ok: true, result: { missingPeerDeps: peers } };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("dependencyDoctor:check:incompatible", async () => {
  try {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return { ok: false, error: "No workspace open" };

    const findings = analyzeDependencies(workspaceRoot);
    const inc = findings.incompatibleVersions.map((v) => ({
      package: v.package,
      declaredVersion: v.declaredVersion,
      lockfileVersion: v.lockfileVersion,
      issue: v.issue,
    }));
    return { ok: true, result: { incompatibleVersions: inc } };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("dependencyDoctor:check:duplicates", async () => {
  try {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return { ok: false, error: "No workspace open" };

    const findings = analyzeDependencies(workspaceRoot);
    const dups = findings.duplicateDeps.map((d) => ({
      package: d.package,
      versions: d.versions,
      location: d.location,
    }));
    return { ok: true, result: { duplicateDeps: dups } };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

// --- Recommendations ---

ipcMain.handle("dependencyDoctor:recommendations", async () => {
  try {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return { ok: false, error: "No workspace open" };

    const findings = analyzeDependencies(workspaceRoot);
    return { ok: true, result: findings.recommendations };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

// --- Convenience: full scan + recommendations ---

ipcMain.handle("dependencyDoctor:full-scan", async () => {
  try {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return { ok: false, error: "No workspace open" };

    const findings = analyzeDependencies(workspaceRoot);
    return {
      ok: true,
      result: {
        findings,
        recommendations: findings.recommendations,
        summary: {
          totalIssues:
            findings.missingDeps.length +
            findings.versionConflicts.length +
            findings.missingPeerDeps.length +
            findings.duplicateDeps.length +
            findings.incompatibleVersions.length,
        },
      },
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});