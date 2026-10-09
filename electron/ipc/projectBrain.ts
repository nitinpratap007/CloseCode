// Close Code — Project Brain IPC (Phase 38)
// 
// Handles renderer access to the persistent project brain.
// All data is stored locally in .closecode/project-brain/ — never auto-uploads source.

import { ipcMain } from "electron";
import {
  readBrain,
  writeBrain,
  clearBrain,
  isBrainStale,
  BRAIN_VERSION,
  type ProjectBrain,
  type ProjectSummary,
  type Architecture,
  type Modules,
  type Dependencies,
  type Conventions,
  type ImportantFiles,
  type KnownIssues,
  type Decisions,
  type TestingStrategy,
} from "../services/projectBrain";

function fail(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

export function registerProjectBrainIpc(): void {
  // --- Brain status ---

  ipcMain.handle("projectBrain:version", () => {
    try {
      return { ok: true, result: BRAIN_VERSION };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("projectBrain:exists", () => {
    try {
      const exists = fs.existsSync(path.join(app.getPath("userData"), ".closecode", "project-brain"));
      return { ok: true, result: exists };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  // --- Read ---

  ipcMain.handle("projectBrain:read", () => {
    try {
      const brain = readBrain();
      if (!brain) return { ok: true, result: null };
      return { ok: true, result: brain };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  // --- Write / Update ---

  ipcMain.handle("projectBrain:update", (_e, partial: Partial<ProjectBrain>) => {
    try {
      const existing = readBrain();
      const next: ProjectBrain = { ...(existing ?? {}), ...partial };
      writeBrain(next);
      return { ok: true, result: next };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  // --- Refresh / Rebuild ---

  ipcMain.handle("projectBrain:refresh", async (_e) => {
    try {
      // Read current project metrics from the workspace
      const workspaceRoot = await window.closeCode.workspace.getRootPath?.();
      if (!workspaceRoot) return { ok: false, error: "No workspace open" };

      // Compute project metrics
      const metrics = computeProjectMetrics(workspaceRoot);

      // Check if brain is stale
      const stale = isBrainStale(metrics);

      if (stale) {
        // Rebuild the brain from scratch
        const brain = rebuildBrain(workspaceRoot);
        writeBrain(brain);
        return { ok: true, result: { brain, stale: true, rebuilt: true } };
      }

      // Brain is up to date
      const brain = readBrain();
      return { ok: true, result: { brain, stale: false } };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  // --- Invalidate ---

  ipcMain.handle("projectBrain:invalidate", () => {
    try {
      clearBrain();
      return { ok: true, result: { cleared: true } };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  // --- Specific category getters ---

  ipcMain.handle("projectBrain:summary", () => {
    try {
      const brain = readBrain();
      if (!brain) return { ok: false, error: "No brain data found" };
      return { ok: true, result: brain.summary };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("projectBrain:architecture", () => {
    try {
      const brain = readBrain();
      if (!brain) return { ok: false, error: "No brain data found" };
      return { ok: true, result: brain.architecture };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("projectBrain:modules", () => {
    try {
      const brain = readBrain();
      if (!brain) return { ok: false, error: "No brain data found" };
      return { ok: true, result: brain.modules };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("projectBrain:dependencies", () => {
    try {
      const brain = readBrain();
      if (!brain) return { ok: false, error: "No brain data found" };
      return { ok: true, result: brain.dependencies };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("projectBrain:conventions", () => {
    try {
      const brain = readBrain();
      if (!brain) return { ok: false, error: "No brain data found" };
      return { ok: true, result: brain.conventions };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("projectBrain:importantFiles", () => {
    try {
      const brain = readBrain();
      if (!brain) return { ok: false, error: "No brain data found" };
      return { ok: true, result: brain.importantFiles };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("projectBrain:knownIssues", () => {
    try {
      const brain = readBrain();
      if (!brain) return { ok: false, error: "No brain data found" };
      return { ok: true, result: brain.knownIssues };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("projectBrain:decisions", () => {
    try {
      const brain = readBrain();
      if (!brain) return { ok: false, error: "No brain data found" };
      return { ok: true, result: brain.decisions };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("projectBrain:testingStrategy", () => {
    try {
      const brain = readBrain();
      if (!brain) return { ok: false, error: "No brain data found" };
      return { ok: true, result: brain.testingStrategy };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });
}

function computeProjectMetrics(workspaceRoot: string): {
  fileCount: number;
  lineCount: number;
  changedSince: number;
} {
  let fileCount = 0;
  let lineCount = 0;

  try {
    const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(workspaceRoot, entry.name);

      if (entry.isDirectory()) {
        // Recurse into directories, but skip node_modules and .closecode
        if (entry.name === "node_modules" || entry.name === ".closecode") continue;
        try {
          const subMetrics = countFilesAndLines(fullPath);
          fileCount += subMetrics.fileCount;
          lineCount += subMetrics.lineCount;
        } catch {}
      } else if (entry.isFile()) {
        // Count source files (common extensions)
        const ext = path.extname(entry.name).toLowerCase();
        if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".json" || ext === ".md") {
          fileCount += 1;
          try {
            const content = fs.readFileSync(fullPath, "utf-8");
            lineCount += content.split("\n").length;
          } catch {}
        }
      }
    }
  } catch (err) {
    console.error("Failed to compute project metrics:", err);
  }

  const changedSince = Date.now() - 24 * 60 * 60 * 1000; // 24h ago as a simple heuristic

  return { fileCount, lineCount, changedSince };
}

function countFilesAndLines(dir: string): { fileCount: number; lineCount: number } {
  let fileCount = 0;
  let lineCount = 0;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".closecode") continue;
        try {
          const sub = countFilesAndLines(fullPath);
          fileCount += sub.fileCount;
          lineCount += sub.lineCount;
        } catch {}
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".json" || ext === ".md") {
          fileCount += 1;
          try {
            const content = fs.readFileSync(fullPath, "utf-8");
            lineCount += content.split("\n").length;
          } catch {}
        }
      }
    }
  } catch {}

  return { fileCount, lineCount };
}

function rebuildBrain(workspaceRoot: string): ProjectBrain {
  // This is a simplified rebuild — in a full implementation,
  // the AI would analyze the project and populate all categories.
  // Here we compute what we can and set defaults for the rest.

  const fileCount = countFilesAndLines(workspaceRoot).fileCount;
  const lineCount = countFilesAndLines(workspaceRoot).lineCount;

  const brain: ProjectBrain = {
    version: BRAIN_VERSION,
    lastRefreshed: Date.now(),
    summary: {
      description: "",
      primaryLanguage: "TypeScript",
      techStack: ["TypeScript", "React", "Electron"],
      totalFiles: fileCount,
      totalLines: lineCount,
      createdAt: 0,
      lastUpdated: Date.now(),
    },
    architecture: {
      patterns: [],
      frameworks: [],
      keyDesignDecisions: [],
      moduleStructure: [],
    },
    modules: {},
    dependencies: {
      production: {},
      dev: {},
      native: {},
    },
    conventions: {
      naming: {
        file: "kebab-case",
        component: "PascalCase",
        function: "camelCase",
        variable: "camelCase",
      },
      imports: {
        style: "barrel",
        sort: "alphabetical",
      },
      components: {
        fileSuffix: ".tsx",
        folderName: "Components",
        maxProps: 10,
      },
      hooks: {
        naming: "usePrefix",
        paramsStyle: "camelCase",
      },
    },
    importantFiles: {},
    knownIssues: {},
    decisions: {},
    testingStrategy: {
      framework: "Jest",
      testPattern: "per-file",
      coverageGoal: 80,
      ciCommand: "npm test",
      specialInstructions: [],
    },
  };

  return brain;
}

export type {
  ProjectBrain,
  ProjectSummary,
  Architecture,
  Modules,
  Dependencies,
  Conventions,
  ImportantFiles,
  KnownIssues,
  Decisions,
  TestingStrategy,
  BRAIN_VERSION,
};