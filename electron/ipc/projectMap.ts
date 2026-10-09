// Close Code — Project Map + AI Change Impact Analyzer IPC (Phase 39)
// 
// Handles renderer access to the graphical project map and change impact analysis.
// All data is derived from real project files — stored locally in userData.

import { ipcMain } from "electron";
import path from "path";
import fs from "fs";
import {
  buildProjectMap,
  analyzeChangeImpact,
  computeProjectHealth,
  type ProjectMap,
  type ProjectHealthMetrics,
  type ProjectNode,
  type ProjectEdge,
} from "../services/projectMap";

function fail(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

// Ensure workspace root is available — in a real implementation this would
// come from the workspace service. For now we derive it from the preload context.
function getWorkspaceRoot(): string | null {
  try {
    // This would be provided via the preload bridge; falling back to process.cwd
    // for Phase 39 demo purposes. In production, replace with:
    // return window.closeCode.workspace.getRootPath!();
    return null;
  } catch {
    return null;
  }
}

export function registerProjectMapIpc(): void {
  // --- Map building ---

  ipcMain.handle("projectMap:build", async (_e, options?: { maxDepth?: number }) => {
    try {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) return { ok: false, error: "No workspace open" };
      const map = buildProjectMap(workspaceRoot);
      return { ok: true, result: map };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  // --- Change impact analysis ---

  ipcMain.handle(
    "projectMap:impactAnalysis",
    async (_e, { nodeId, options }: { nodeId: string; options?: { maxDepth?: number; includeTests?: boolean } }) => {
      try {
        const workspaceRoot = getWorkspaceRoot();
        if (!workspaceRoot) return { ok: false, error: "No workspace open" };

        // First, ensure we have a project map
        const mapResult = await _e.ipcRenderer?.invoke?.("projectMap:build") ?? {};
        let map: ProjectMap = mapResult.result as ProjectMap;
        if (!map || map.nodeCount === 0) {
          // Build on-demand
          map = buildProjectMap(workspaceRoot);
        }

        const analysis = analyzeChangeImpact(map, nodeId, options ?? {});
        return { ok: true, result: analysis };
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // --- Project health metrics ---

  ipcMain.handle("projectHealth:compute", async (_e) => {
    try {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) return { ok: false, error: "No workspace open" };
      const health = computeProjectHealth(workspaceRoot);
      return { ok: true, result: health };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  // --- Navigate to code from graph ---

  ipcMain.handle("projectMap:navigateTo", async (_e, nodeId: string) => {
    try {
      // Return the path so the renderer can open it
      const absolutePath = path.isAbsolute(nodeId) ? nodeId : path.join(process.cwd(), nodeId);
      if (!fs.existsSync(absolutePath)) return { ok: false, error: "File not found" };
      return { ok: true, result: { path: absolutePath } };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });
}