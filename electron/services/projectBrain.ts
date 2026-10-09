// Close Code — Project Brain (Phase 38)
// 
// Persistent project understanding stored in .closecode/project-brain/.
// This is AI-managed metadata — never auto-uploads source code.
//
// The brain is stored as JSON files in userData/.closecode/project-brain/.
// Each file represents a category of derived information.
//
// Philosophy:
// — AI-owned: the AI can read/write its own metadata
// — User-owned: the user controls the folder; we never auto-upload source
// — Derived: all values are computed from the project, not hand-edited (except
//   for free-form fields like "decisions" or "conventions")
// — Versioned: each entry has a version stamp so stale data can be detected
// — Invalidate-on-change: the build system signals when the project changes,
//   prompting a brain refresh

import { app } from "electron";
import path from "path";
import fs from "fs";

const BRAIN_DIR = path.join(app.getPath("userData"), ".closecode", "project-brain");
const BRAIN_VERSION = "1.0";

// Ensure brain directory exists
function ensureBrainDir(): void {
  if (!fs.existsSync(BRAIN_DIR)) {
    fs.mkdirSync(BRAIN_DIR, { recursive: true });
  }
}

// --- File paths ---

function brainPath(filename: string): string {
  return path.join(BRAIN_DIR, filename);
}

// --- Stored categories ---

export interface ProjectSummary {
  description: string;
  primaryLanguage: string;
  techStack: string[];
  totalFiles: number;
  totalLines: number;
  createdAt: number;
  lastUpdated: number;
}

export interface Architecture {
  patterns: string[];
  frameworks: string[];
  keyDesignDecisions: string[];
  moduleStructure: string[];
}

export interface Modules {
  [key: string]: {
    name: string;
    type: "source" | "test" | "config" | "other";
    entryPoints: string[];
    dependencies: string[];
    lineCount: number;
  };
}

export interface Dependencies {
  production: Record<string, string>;
  dev: Record<string, string>;
  native: Record<string, string>;
}

export interface Conventions {
  naming: {
    file: string;
    component: string;
    function: string;
    variable: string;
  };
  imports: {
    style: "barrel" | "direct" | "path-alias";
    sort: "alphabetical" | "grouped";
  };
  components: {
    fileSuffix: string;
    folderName: string;
    maxProps: number;
  };
  hooks: {
    naming: string;
    paramsStyle: "camelCase" | "kebab-case";
  };
}

export interface ImportantFiles {
  [key: string]: {
    purpose: string;
    kind: "source" | "config" | "test" | "doc" | "other";
    lastAccessed: number;
  };
}

export interface KnownIssues {
  [key: string]: {
    description: string;
    severity: "low" | "medium" | "high" | "critical";
    component: string;
    status: "open" | "in-progress" | "fixed" | "workaround";
    introducedAt: number;
  };
}

export interface Decisions {
  [key: string]: {
    decision: string;
    rationale: string;
    alternativesConsidered: string[];
    decidedAt: number;
    author: string;
  };
}

export interface TestingStrategy {
  framework: string;
  testPattern: "per-file" | "per-component" | "integration";
  coverageGoal: number;
  ciCommand: string;
  specialInstructions: string[];
}

export interface ProjectBrain {
  version: string;
  last refreshed: number;
  summary: ProjectSummary;
  architecture: Architecture;
  modules: Modules;
  dependencies: Dependencies;
  conventions: Conventions;
  importantFiles: ImportantFiles;
  knownIssues: KnownIssues;
  decisions: Decisions;
  testingStrategy: TestingStrategy;
}

// --- Persistence ---

function readBrain(): ProjectBrain | null {
  try {
    ensureBrainDir();
    const indexPath = brainPath("index.json");
    if (fs.existsSync(indexPath)) {
      const raw = fs.readFileSync(indexPath, "utf-8");
      const data = JSON.parse(raw) as ProjectBrain;
      // Validate version
      if (data.version !== BRAIN_VERSION) {
        // Stale version — return null to trigger rebuild
        return null;
      }
      // Update last refreshed
      data.lastRefreshed = Date.now();
      // Write back the updated timestamp
      writeBrain(data);
      return data;
    }
    return null;
  } catch (err) {
    console.error("Failed to read project brain:", err);
    return null;
  }
}

function writeBrain(data: ProjectBrain): void {
  try {
    ensureBrainDir();
    const indexPath = brainPath("index.json");
    // Timestamp the write
    data.lastRefreshed = Date.now();
    data.version = BRAIN_VERSION;
    fs.writeFileSync(indexPath, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.error("Failed to write project brain:", err);
  }
}

// --- Invalidation ---

/** Clear the brain (e.g., on major project restructure) */
function clearBrain(): void {
  try {
    if (fs.existsSync(BRAIN_DIR)) {
      fs.rmSync(BRAIN_DIR, { recursive: true, force: true });
    }
  } catch (err) {
    console.error("Failed to clear project brain:", err);
  }
}

/** Check if brain data is stale (e.g., project files changed) */
function isBrainStale(metrics: {
  fileCount: number;
  lineCount: number;
  changedSince: number;
}): boolean {
  const brain = readBrain();
  if (!brain) return true; // No brain = stale
  
  // If the brain was last refreshed before the project metrics changed
  if (brain.lastRefreshed < metrics.changedSince) return true;
  
  // If file counts don't match
  if (brain.summary.totalFiles !== metrics.fileCount) return true;
  if (brain.summary.totalLines !== metrics.lineCount) return true;
  
  return false;
}

// --- Exported API ---

export { readBrain, writeBrain, clearBrain, isBrainStale, BRAIN_VERSION, ProjectBrain, ProjectSummary, Architecture, Modules, Dependencies, Conventions, ImportantFiles, KnownIssues, Decisions, TestingStrategy };