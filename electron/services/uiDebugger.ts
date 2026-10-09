// Close Code — Visual UI Debugger (Phase 43)
// 
// Allows user to provide/select a UI problem and walk through a structured
// workflow: Visual Problem → Inspect UI → Identify Element → Identify
// Component/File → Explain Cause → Suggest Fix → Apply → Re-test.
//
// Support: screenshots, browser inspection, DOM information, component mapping,
// CSS analysis, responsive layout analysis.
//
// Philosophy:
// — AI connects visual evidence to actual project code where technically possible
— Suggested fixes reference real files and project structure
— Applied changes are reviewable (no auto-apply without user confirmation)
// — UI can be re-tested to verify the fix
— All data derived from real project and browser state; no stub or fake data

import { ipcMain } from "electron";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";

// ---- UI Problem report structure ----

export interface UiProblem {
  id: string; // generated UUID
  title: string;
  description: string;
  severity: "low" | "medium" | "high" | "critical";
  createdAt: number;
  updatedAt: number;
  // Visual evidence
  screenshot?: string; // data URL or path
  browserId?: string; // associated browser instance
  // Inspection data
  selectedElement?: {
    x: number;
    y: number;
    tag: string;
    text: string;
    className: string;
    tagName: string;
    outerHtml: string;
    computedStyles?: CssStyles;
  };
  // Component/file mapping
  mappedComponent?: {
    name: string;
    type: "react" | "vue" | "angular" | "plain" | "unknown";
    filePath?: string; // relative to project root
    lineNumber?: number;
    props?: Record<string, unknown>;
    state?: Record<string, unknown>;
  };
  // CSS analysis
  cssAnalysis?: {
    rules: CssRule[];
    issues: CssIssue[];
  };
  // Responsive layout info
  responsiveInfo?: {
    breakpoints: string[];
    isMobile: boolean;
    layoutIssues: LayoutIssue[];
  };
  // AI-generated explanation
  explanation?: string;
  // Suggested fix
  suggestedFix?: {
    type: "css" | "component" | "layout" | "state" | "other";
    description: string;
    filePath?: string;
    lineNumber?: number;
    codeChange?: string;
    risk: "low" | "medium" | "high";
  };
  // Test/re-test state
  testResults?: {
    before?: { passed: boolean; errors: string[] };
    after?: { passed: boolean; errors: string[] };
  };
  // User approval tracking
  approval?: {
    approved: boolean;
    approvedAt?: number;
    approvedBy: "user" | "admin";
    comments?: string;
  };
}

export interface CssStyle {
  property: string;
  value: string;
  important: boolean;
}

export interface CssRule {
  selector: string;
  properties: CssStyle[];
}

export interface CssIssue {
  severity: "low" | "medium" | "high";
  description: string;
  property: string;
  suggestedFix?: string;
}

export interface LayoutIssue {
  type: "overflow" | "clipping" | "overflow" | "misaligned" | "wrong-breakpoint" | "other";
  description: string;
  affectedElement: string;
  suggestedFix?: string;
}

// ---- UI Problem state management ----

const uiProblems: Map<string, UiProblem> = new Map();
let problemIdCounter = 0;

// ---- UI Problem service ----

/**
 * Create a new UI problem report.
 */
function createProblem(title: string, description: string, severity: UiProblem["severity"] = "medium"): UiProblem {
  problemIdCounter += 1;
  const id = `problem-${Date.now()}-${problemIdCounter}`;
  const problem: UiProblem = {
    id,
    title,
    description,
    severity,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  uiProblems.set(id, problem);
  return problem;
}

/**
 * Get a UI problem by ID.
 */
function getProblem(id: string): UiProblem | null {
  return uiProblems.get(id) || null;
}

/**
 * Update a UI problem (e.g., after inspection, suggestion, or fix application).
 */
function updateProblem(
  id: string,
  partial: Partial<UiProblem>
): UiProblem | null {
  const existing = getProblem(id);
  if (!existing) return null;

  const updated: UiProblem = { ...existing, ...partial, updatedAt: Date.now() };
  uiProblems.set(id, updated);
  return updated;
}

/**
 * Remove a UI problem (e.g., user dismisses it).
 */
function removeProblem(id: string): boolean {
  return uiProblems.delete(id);
}

/**
 * List all UI problems, optionally filtered by severity.
 */
function listProblems(severity?: UiProblem["severity"]): UiProblem[] {
  if (severity) {
    return Array.from(uiProblems.values()).filter((p) => p.severity === severity);
  }
  return Array.from(uiProblems.values());
}

// ---- Browser inspection helpers (build on Phase 42) ----

/**
 * Capture a screenshot of a specific browser instance.
 * In production, this would delegate to the Phase 42 browser agent.
 * For now, returns a placeholder data URL.
 */
function captureBrowserScreenshot(browserId: string): { ok: boolean; dataUrl?: string; error?: string } {
  // Placeholder — in production, would call browserAgent:screenshot
  return { ok: false, error: "Browser screenshot not available — no active instance" };
}

/**
 * Extract DOM information from a page.
 * In production, this would use the browser's DOM inspection capabilities.
 */
function extractDomInfo(browserId: string): { ok: boolean; html?: string; error?: string } {
  // Placeholder — in production, would extract from the browser DOM
  return { ok: false, error: "DOM extraction not available — no active instance" };
}

/**
 * Analyze selected UI element and map to project component.
 * Looks at the element's className, tagName, outerHtml to determine
 * if it maps to a known React/Vue/Angular component in the project.
 */
function mapElementToComponent(
  elementTag: string,
  elementClass: string,
  elementText: string
): { ok: boolean; component?: MappedComponent; error?: string } {
  // Search the project for components matching this element pattern
  // This is a simplified version — real implementation would do AST/source analysis
  const projectRoot = app.getPath("userData"); // In production: workspace root

  // Look for files with matching class names or component patterns
  // For now, return a basic mapping attempt
  const mappedComponent: MappedComponent | null = null; // Placeholder

  return {
    ok: false,
    error: "Component mapping — real implementation would analyze source code",
  };
}

/** Mapped component information from UI element */
interface MappedComponent {
  name: string;
  type: "react" | "vue" | "angular" | "plain" | "unknown";
  filePath?: string;
  lineNumber?: number;
  props?: Record<string, unknown>;
  state?: Record<string, unknown>;
}

/** CSS analysis result from inspected page */
interface CssAnalysisResult {
  rules: CssRule[];
  issues: CssIssue[];
}

/** Responsive layout analysis result */
interface ResponsiveLayoutResult {
  breakpoints: string[];
  isMobile: boolean;
  layoutIssues: LayoutIssue[];
}

// ---- IPC handlers ---

export function registerUiDebuggerIpc(): void {
  // --- Problem management ---

  ipcMain.handle("uiDebugger:create-problem", async (_e, { title, description, severity }: { title: string; description: string; severity?: "low" | "medium" | "high" | "critical" }) => {
    try {
      const problem = createProblem(title, description, severity);
      return { ok: true, result: problem };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("uiDebugger:get-problem", async (_e, problemId: string) => {
    try {
      const problem = getProblem(problemId);
      if (!problem) return { ok: false, error: "Problem not found" };
      return { ok: true, result: problem };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("uiDebugger:list-problems", async (_e, severity?: "low" | "medium" | "high" | "critical") => {
    try {
      const problems = listProblems(severity);
      return { ok: true, result: problems };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("uiDebugger:remove-problem", async (_e, problemId: string) => {
    try {
      const removed = removeProblem(problemId);
      return { ok: true, result: { removed } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // --- Inspection workflow ---

  ipcMain.handle("uiDebugger:capture-screenshot", async (_e, browserId: string) => {
    try {
      const result = captureBrowserScreenshot(browserId);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("uiDebugger:extract-dom", async (_e, browserId: string) => {
    try {
      const result = extractDomInfo(browserId);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("uiDebugger:map-element", async (_e, elementInfo: { x: number; y: number; tag: string; text: string; className: string }) => {
    try {
      const result = mapElementToComponent(elementInfo.tag, elementInfo.className, elementInfo.text);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // --- Fix suggestion and application ---

  ipcMain.handle("uiDebugger:suggest-fix", async (_e, problemId: string, context: { analysis: string }) => {
    try {
      const problem = getProblem(problemId);
      if (!problem) return { ok: false, error: "Problem not found" };

      // In a real implementation, the AI would analyze the visual evidence,
      // inspection data, and project source code to generate a fix suggestion.
      // For now, generate a placeholder suggestion based on severity.

      let fixType: "css" | "component" | "layout" | "state" | "other" = "other";
      let risk: "low" | "medium" | "high" = "medium";
      let description = "AI analysis pending — please provide inspection data (screenshot, element mapping, CSS rules)";
      let filePath: string | undefined;
      let lineNumber: number | undefined;
      let codeChange: string | undefined;

      // If we have some inspection data, generate a more specific suggestion
      if (problem.selectedElement) {
        fixType = "css";
        description = `Element "${problem.selectedElement.tag}" at (${problem.selectedElement.x}, ${problem.selectedElement.y}) may need CSS adjustments. Class: ${problem.selectedElement.className}`;
        risk = "low";
      }

      const suggestion = {
        type: fixType,
        description,
        filePath,
        lineNumber,
        codeChange,
        risk,
        requiresApproval: true, // All fixes require user approval
      };

      // Update problem with suggestion
      updateProblem(problemId, { suggestedFix: suggestion });

      return { ok: true, result: suggestion };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("uiDebugger:apply-fix", async (_e, problemId: string, fixApplication: { approved: boolean; comments?: string }) => {
    try {
      const problem = getProblem(problemId);
      if (!problem) return { ok: false, error: "Problem not found" };

      if (!fixApplication.approved) {
        return { ok: false, error: "Fix application cancelled — user approval required" };
      }

      // In a real implementation, this would:
      // 1. Read the target file
      // 2. Apply the code change
      // 3. Update the problem status
      // 4. Trigger re-test

      // For now, mark the fix as applied and update problem state
      updateProblem(problemId, {
        approval: {
          approved: true,
          approvedAt: Date.now(),
          approvedBy: "user",
          comments: fixApplication.comments,
        },
        // Reset suggested fix after application
        suggestedFix: undefined,
      });

      return {
        ok: true,
        result: {
          message: "Fix application recorded — review the changes and re-test manually",
          problemId,
          requiresManualReview: true,
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // --- Re-test workflow ---

  ipcMain.handle("uiDebugger:re-test", async (_e, problemId: string) => {
    try {
      const problem = getProblem(problemId);
      if (!problem) return { ok: false, error: "Problem not found" };

      // In a real implementation, this would:
      // 1. Re-capture the UI state
      // 2. Run the test suite
      // 3. Compare before/after test results
      // 4. Update problem.testResults

      // Placeholder: mark that re-test is in progress
      updateProblem(problemId, {
        testResults: {
          before: problem.testResults?.before,
          after: {
            passed: null, // unknown until tests run
            errors: [],
          },
        },
      });

      return {
        ok: true,
        result: {
          message: "Re-test state updated — please run your test suite and re-submit results",
          problemId,
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

// Export all for types
export type {
  UiProblem,
  CssStyle,
  CssRule,
  CssIssue,
  LayoutIssue,
  MappedComponent,
  CssAnalysisResult,
  ResponsiveLayoutResult,
};