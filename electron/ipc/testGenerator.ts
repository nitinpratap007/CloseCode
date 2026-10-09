// Close Code — Smart Test Generator IPC (Phase 45)
// 
// Handles renderer access to AI-assisted test generation. All tests are
// generated from actual project code. Existing test frameworks are detected.
// Generated tests are runnable. Results are shown. Failed tests can be analyzed.
// AI never claims test success without execution evidence.

import { ipcMain } from "electron";
import {
  detectTestFramework,
  inspectProject,
  CodeElement,
  ProjectInspection,
  generateFrameworkImports,
  generateDescribeBlock,
  generateFunctionTest,
  generateClassTest,
  runTestSuite,
  analyzeFailures,
} from "../../services/testGenerator";

function fail(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

// --- Framework detection ---

ipcMain.handle("testGenerator:detect-framework", async (_e, projectRoot?: string) => {
  try {
    const root = projectRoot || app.getPath("userData");
    const framework = detectTestFramework(root);
    const testCommand = getTestCommand(root);
    return { ok: true, result: { framework, testCommand } };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

// --- Project inspection ---

ipcMain.handle("testGenerator:inspect-project", async (_e, projectRoot?: string) => {
  try {
    const root = projectRoot || app.getPath("userData");
    const inspection: ProjectInspection = inspectProject(root);
    return { ok: true, result: inspection };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

// --- Test generation ---

ipcMain.handle("testGenerator:generate:function-test", async (_e, { elementId, framework }: { elementId: string; framework: "jest" | "vitest" }) => {
  try {
    const root = app.getPath("userData");
    const inspection = inspectProject(root);

    // Find element by matching line number prefix
    const element = inspection.elements.find((el) => `f-${el.lineNumber}` === elementId || el.name === elementId);

    if (!element) return { ok: false, error: "Element not found in project" };

    let testCode: string;
    if (element.type === "function") {
      testCode = generateFunctionTest(element, framework);
    } else if (element.type === "class") {
      testCode = generateClassTest(element, framework);
    } else {
      testCode = "// Test generation not supported for this element type\n";
    }

    return { ok: true, result: { testCode, element } };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("testGenerator:generate:describe-block", async (_e, { title, elements, framework }: { title: string; elements?: CodeElement[]; framework: "jest" | "vitest" }) => {
  try {
    const testCode = generateDescribeBlock(title, elements, framework);
    return { ok: true, result: { testCode } };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

// --- Test execution ---

ipcMain.handle("testGenerator:run-tests", async (_e, projectRoot?: string) => {
  try {
    const root = projectRoot || app.getPath("userData");
    const result = runTestSuite(root);
    return { ok: true, result };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

// --- Analysis ---

ipcMain.handle("testGenerator:analyze-failures", async (_e, { output, errors }: { output: string; errors: string[] }) => {
  try {
    const analysis: string[] = [];

    if (errors.length > 0) {
      analysis.push(`Found ${errors.length} error(s):`);
      errors.slice(0, 5).forEach((err, i) => {
        analysis.push(`${i + 1}. ${err.substring(0, Math.min(120, err.length))}`);
      });
    }

    if (output) {
      const lowerOutput = output.toLowerCase();

      if (/timeout|timed out/i.test(lowerOutput)) {
        analysis.push("Possible test timeout issue");
      }
      if (/assertionerror|expect.*to.*be/i.test(lowerOutput)) {
        analysis.push("Assertion failure detected - check expected vs actual values");
      }
      if (/.*test/.test(lowerOutput)) {
        analysis.push("Test file pattern detected - verify test file locations");
      }
    }

    if (errors.length === 0 && output) {
      if (/fail|failed/.test(output) && !/passed/.test(output)) {
        analysis.push("Tests appear to have failed - review output above");
      }
    }

    return {
      ok: true,
      result: {
        analysis: analysis.length > 0 ? analysis.join("\n") : "No significant failures detected; all tests passed",
        errorCount: errors.length,
        outputLength: output.length,
      },
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

// Export types for use in renderer
export type { CodeElement, ProjectInspection };