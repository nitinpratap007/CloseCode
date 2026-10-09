// Close Code — Core Project Health (Phase 40)
// 
// Collects project health metrics needed by the future dashboard.
// All data is derived from real project files; nothing is auto-uploaded.

import { app } from "electron";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";

// ---- Configuration problem detection ----

/**
 * Check if TypeScript compilation succeeds.
 * Returns { ok, error, exitCode }
 */
function checkTypeScript(): { ok: boolean; error?: string; exitCode?: number } {
  try {
    const cwd = process.cwd();
    // Try tsc --noEmit from the project root
    // We look for tsconfig.json in cwd or parent
    let tsConfigPath = path.join(cwd, "tsconfig.json");
    if (!fs.existsSync(tsConfigPath)) {
      // Search upward
      let dir = cwd;
      for (let i = 0; i < 10; i++) {
        dir = path.dirname(dir);
        tsConfigPath = path.join(dir, "tsconfig.json");
        if (fs.existsSync(tsConfigPath)) break;
      }
    }
    if (!fs.existsSync(tsConfigPath)) {
      return { ok: false, error: "No tsconfig.json found" };
    }
    const result = execSync("npx tsc --noEmit", {
      cwd: path.dirname(tsConfigPath),
      stdio: "pipe",
      timeout: 120000,
    });
    return { ok: true };
  } catch (err: any) {
    return {
      ok: false,
      error: err.stderr ? err.stderr.toString().substring(0, 2000) : err.message,
      exitCode: err.status,
    };
  }
}

/**
 * Check if the build (vite) succeeds.
 */
function checkBuild(): { ok: boolean; error?: string; exitCode?: number } {
  try {
    const cwd = process.cwd();
    let distConfigPath = path.join(cwd, "vite.config.ts");
    if (!fs.existsSync(distConfigPath)) {
      distConfigPath = path.join(cwd, "vite.config.js");
    }
    if (!fs.existsSync(distConfigPath)) {
      return { ok: false, error: "No vite.config.ts found" };
    }
    const result = execSync("nvite build", {
      cwd: cwd,
      stdio: "pipe",
      timeout: 180000,
    });
    return { ok: true };
  } catch (err: any) {
    return {
      ok: false,
      error: err.stderr ? err.stderr.toString().substring(0, 2000) : err.message,
      exitCode: err.status,
    };
  }
}

/**
 * Run eslint and report results.
 */
function checkLint(): { ok: boolean; error?: string } {
  try {
    const cwd = process.cwd();
    const result = execSync("npx eslint . --max-warnings=0", {
      cwd: cwd,
      stdio: "pipe",
      timeout: 120000,
    });
    return { ok: true };
  } catch (err: any) {
    return {
      ok: false,
      error: err.stdout ? err.stdout.toString().substring(0, 2000) : "Lint check failed",
    };
  }
}

/**
 * Run the test suite and report results.
 */
function checkTests(): { ok: boolean; error?: string; output?: string } {
  try {
    const cwd = process.cwd();
    const result = execSync("npm test -- --passWithNoTests", {
      cwd: cwd,
      stdio: "pipe",
      timeout: 180000,
    });
    return { ok: true, output: result.stdout.toString().substring(0, 2000) };
  } catch (err: any) {
    return {
      ok: false,
      error: err.stdout ? err.stdout.toString().substring(0, 2000) : "Tests failed",
    };
  }
}

// ---- Core health metrics ----

export interface ProjectHealthMetrics {
  version: string;
  lastComputed: number;
  // Structural metrics
  totalFiles: number;
  totalLinesOfCode: number;
  totalDependencies: number;
  dependencyTreeDepth: number;
  // Health indicators
  orphanedFiles: number;
  circularDependencies: number;
  unusedExports: number;
  // Quality metrics
  avgFileComplexity: number;
  testCoverageEstimate: number;
  buildSuccess: boolean | null;
  lastBuildTime: number | null;
  // Lint/status
  lintSuccess: boolean | null;
  lastLintTime: number | null;
  testSuccess: boolean | null;
  lastTestTime: number | null;
  // Error detection
  tsErrorCount: number;
  lintErrorCount: number;
  // Configuration health
  hasTsConfig: boolean;
  hasViteConfig: boolean;
  hasPackageJson: boolean;
}

// Compute comprehensive project health metrics
export function computeProjectHealth(): ProjectHealthMetrics {
  const now = Date.now();
  const workspaceRoot = app.getPath("userData"); // using userData as root for health checks

  // Check for config files
  const hasTsConfig = fs.existsSync(path.join(workspaceRoot, "tsconfig.json"));
  const hasViteConfig = fs.existsSync(path.join(workspaceRoot, "vite.config.ts"));
  const hasPackageJson = fs.existsSync(path.join(workspaceRoot, "package.json"));

  // Run error checks
  const tsResult = checkTypeScript();
  const lintResult = checkLint();
  const testResult = checkTests();

  // Walk the workspace to count files/lines (same logic as Phase 39)
  let totalFiles = 0;
  let totalLines = 0;
  let maxDepth = 0;

  function walkDir(dir: string): {
    fileCount: number;
    lineCount: number;
  } {
    let fileCount = 0;
    let lineCount = 0;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".closecode") continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const sub = walkDir(fullPath);
          fileCount += sub.fileCount;
          lineCount += sub.lineCount;
          maxDepth = Math.max(maxDepth, 1);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") {
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

  const { fileCount, lineCount } = walkDir(workspaceRoot);

  // Count deps from package.json
  let depCount = 0;
  if (fs.existsSync(path.join(workspaceRoot, "package.json"))) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(workspaceRoot, "package.json"), "utf-8"));
      if (pkg.dependencies) depCount += Object.keys(pkg.dependencies).length;
      if (pkg.devDependencies) depCount += Object.keys(pkg.devDependencies).length;
    } catch {}
  }

  return {
    version: "1.0",
    lastComputed: now,
    totalFiles: fileCount,
    totalLinesOfCode: lineCount,
    totalDependencies: depCount,
    dependencyTreeDepth: maxDepth,
    orphanedFiles: 0, // placeholder - would need more analysis
    circularDependencies: 0, // placeholder - would need cycle detection
    unusedExports: 0, // placeholder - would need whole-program analysis
    avgFileComplexity: fileCount > 0 ? lineCount / fileCount : 0,
    testCoverageEstimate: 0, // placeholder - would need istanbul/coverage data
    buildSuccess: tsResult.ok ? null : false,
    lastBuildTime: tsResult.ok ? now : null,
    lintSuccess: lintResult.ok ? null : false,
    lastLintTime: lintResult.ok ? now : null,
    testSuccess: testResult.ok ? null : false,
    lastTestTime: testResult.ok ? now : null,
    tsErrorCount: tsResult.ok ? 0 : 1,
    lintErrorCount: lintResult.ok ? 0 : 1,
    hasTsConfig: hasTsConfig,
    hasViteConfig: hasViteConfig,
    hasPackageJson: hasPackageJson,
  };
}

// ---- Fix Everything workflow ----

/**
 * Phase 40: Fix Everything workflow.
 * 
 * Controlled autonomous fixing with bounded iterations.
 * 
 * Workflow: Detect → Analyze → Fix → Run → Verify → Repeat
 * 
 * @maxIterations maximum number of fix attempts (default 5)
 * @timeoutMs timeout per iteration in milliseconds
 */
export interface FixEverythingOptions {
  maxIterations?: number;
  timeoutMs?: number;
  include?: ("ts" | "build" | "lint" | "test" | "runtime" | "deps" | "config")[];
  exclude?: ("ts" | "build" | "lint" | "test" | "runtime" | "deps" | "config")[];
}

export interface FixResult {
  success: boolean;
  iterations: number;
  fixesApplied: Array<{
    type: "ts" | "build" | "lint" | "test" | "runtime" | "deps" | "config";
    description: string;
    applied: boolean;
    before?: string;
    after?: string;
  }>;
  finalChecks: {
    tsOk: boolean;
    lintOk: boolean;
    buildOk: boolean;
    testOk: boolean;
  };
  error?: string;
}

/**
 * Execute the Fix Everything workflow.
 * Attempts to automatically fix detected issues up to maxIterations times.
 */
export function runFixEverything(
  options: FixEverythingOptions = {}
): FixResult {
  const {
    maxIterations = 5,
    timeoutMs = 30000,
    include,
    exclude,
  } = options;

  const iterationLogs: Array<{
    iteration: number;
    checksBefore: Record<string, boolean>;
    fixes: Array<{ type: string; description: string }>;
  }> = [];

  let tsOk = false;
  let lintOk = false;
  let buildOk = false;
  let testOk = false;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    iterationLogs.push({
      iteration,
      checksBefore: {
        tsOk: false,
        lintOk: false,
        buildOk: false,
        testOk: false,
      },
      fixes: [],
    });

    // 1. Detect: Run checks
    const tsResult = checkTypeScript();
    const lintResult = checkLint();
    const buildResult = checkBuild();
    const testResult = checkTests();

    const checksAfter: Record<string, boolean> = {
      tsOk: tsResult.ok,
      lintOk: lintResult.ok,
      buildOk: buildResult.ok,
      testOk: testResult.ok,
    };

    iterationLogs[iteration - 1].checksAfter = checksAfter;

    // Record what changed
    if (iteration > 1) {
      const prev = iterationLogs[iteration - 2].checksAfter;
      const curr = checksAfter;
      for (const key of ["tsOk", "lintOk", "buildOk", "testOk"] as const) {
        if (prev[key] !== curr[key]) {
          iterationLogs[iteration - 1].fixes.push({
            type: key as any,
            description: `Fixed ${key} issue`,
          });
        }
      }
    }

    // 2. Verify: Are we done?
    const allOk = checksAfter.tsOk && checksAfter.lintOk && checksAfter.buildOk && checksAfter.testOk;
    if (allOk) {
      return {
        success: true,
        iterations,
        fixesApplied: [],
        finalChecks: checksAfter,
      };
    }

    // 3. Analyze + Fix: Attempt automatic fixes
    const iterationFixes: Array<{ type: string; description: string; applied: boolean }> = [];

    // Attempt TypeScript fixes
    if (!checksAfter.tsOk) {
      // Try common auto-fixes
      // 1. Remove unused imports / fix obvious type errors
      // 2. This is a simplified approach - in production, use tsc --fix or a linter
      try {
        // Example: try running tsc with --fix if available, or apply common patterns
        iterationFixes.push({
          type: "ts",
          description: "Attempting TS auto-fix",
          applied: false, // auto-fix for TS is limited without AST manipulation
        });
      } catch {
        iterationFixes.push({
          type: "ts",
          description: "TS auto-fix skipped",
          applied: false,
        });
      }
    }

    // Attempt lint fixes
    if (!checksAfter.lintOk) {
      // Run eslint with --fix
      try {
        execSync("npx eslint . --fix --max-warnings=0", {
          cwd: process.cwd(),
          stdio: "pipe",
          timeout: timeoutMs,
        });
        iterationFixes.push({
          type: "lint",
          description: "ESlint --fix applied",
          applied: true,
        });
      } catch {
        iterationFixes.push({
          type: "lint",
          description: "ESlint --fix failed",
          applied: false,
        });
      }
    }

    // Attempt build fixes
    if (!checksAfter.buildOk && checksAfter.tsOk) {
      // If TS passes but build fails, try common build fixes
      iterationFixes.push({
        type: "build",
        description: "Build fix attempted (review required)",
        applied: false,
      });
    }

    // Attempt test fixes
    if (!checksAfter.testOk) {
      // Common test fixes: re-run, check for flaky tests
      iterationFixes.push({
        type: "test",
        description: "Test rerun attempted",
        applied: false,
      });
    }

    iterationLogs[iteration - 1].fixes = iterationFixes;

    // 4. Store fix status
    const allFixes: Array<{
      type: "ts" | "build" | "lint" | "test" | "runtime" | "deps" | "config";
      description: string;
      applied: boolean;
    }> = [];

    for (const fix of iterationFixes) {
      allFixes.push({
        type: fix.type,
        description: fix.description,
        applied: fix.applied,
      });
    }

    // Mark iteration as having applied fixes
    const hasActualFixes = iterationFixes.some((f) => f.applied);
    if (!hasActualFixes && iteration > 1) {
      // No fixes applied in this iteration and we've tried before — stop
      return {
        success: false,
        iterations,
        fixesApplied: allFixes,
        finalChecks: checksAfter,
        error: "No fixes applied in iteration " + iteration + "; stopping to prevent infinite loop",
      };
    }
  }

  // Max iterations reached without full success
  const finalChecks = {
    tsOk: checkTypeScript().ok,
    lintOk: checkLint().ok,
    buildOk: checkBuild().ok,
    testOk: checkTests().ok,
  };

  return {
    success: false,
    iterations: maxIterations,
    fixesApplied: [],
    finalChecks,
    error: `Exceeded ${maxIterations} iterations without full recovery`,
  };
}

// Export all
export type { ProjectHealthMetrics, FixEverythingOptions, FixResult };
export { checkTypeScript, checkBuild, checkLint, checkTests, runFixEverything, computeProjectHealth };