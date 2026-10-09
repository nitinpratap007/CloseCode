import { create } from "zustand";
import type { Diagnostic } from "./types";
import * as monaco from "monaco-editor";

interface DiagnosticsState {
  diagnostics: Diagnostic[];
  errorCount: number;
  warningCount: number;
  setDiagnostics: (diags: Diagnostic[]) => void;
  clearFile: (file: string) => void;
}

export const useDiagnosticsStore = create<DiagnosticsState>((set) => ({
  diagnostics: [],
  errorCount: 0,
  warningCount: 0,
  setDiagnostics: (diags) =>
    set({
      diagnostics: diags,
      errorCount: diags.filter((d) => d.severity === "error").length,
      warningCount: diags.filter((d) => d.severity === "warning").length,
    }),
  clearFile: (file) =>
    set((s) => {
      const filtered = s.diagnostics.filter((d) => d.file !== file);
      return {
        diagnostics: filtered,
        errorCount: filtered.filter((d) => d.severity === "error").length,
        warningCount: filtered.filter((d) => d.severity === "warning").length,
      };
    }),
}));

function severityFromMonaco(sev: monaco.MarkerSeverity): Diagnostic["severity"] {
  switch (sev) {
    case monaco.MarkerSeverity.Error:
      return "error";
    case monaco.MarkerSeverity.Warning:
      return "warning";
    case monaco.MarkerSeverity.Info:
      return "info";
    case monaco.MarkerSeverity.Hint:
      return "hint";
    default:
      return "info";
  }
}

function markerToDiagnostic(marker: monaco.editor.IMarker): Diagnostic {
  // marker.resource is a URI
  const file = marker.resource.path;
  // For file:// URIs, path is like /E:/closecode/file.js -> we want absolute path
  // On Windows, Uri.file creates /e:/... -> path is /e:/...
  // We'll try to convert back to filesystem path via monaco.Uri
  let absPath: string;
  try {
    absPath = monaco.Uri.parse(marker.resource.toString()).fsPath;
  } catch {
    absPath = file;
  }
  return {
    file: absPath,
    line: marker.startLineNumber,
    column: marker.startColumn,
    endLine: marker.endLineNumber,
    endColumn: marker.endColumn,
    severity: severityFromMonaco(marker.severity),
    message: marker.message,
    source: marker.source,
    code: typeof marker.code === "string" ? marker.code : (marker.code as { value: string } | undefined)?.value,
  };
}

export function setupDiagnosticsListener(): () => void {
  // Listen to all markers
  const disposable = monaco.editor.onDidChangeMarkers(() => {
    // Collect all markers for all models
    const allMarkers = monaco.editor.getModelMarkers({});
    const diags = allMarkers.map(markerToDiagnostic);
    useDiagnosticsStore.getState().setDiagnostics(diags);
    // Also expose for tests
    const w = window as unknown as Record<string, unknown>;
    w.__diagnostics = diags;
  });

  // Initial collect
  const initial = monaco.editor.getModelMarkers({}).map(markerToDiagnostic);
  useDiagnosticsStore.getState().setDiagnostics(initial);
  (window as unknown as Record<string, unknown>).__diagnostics = initial;

  return () => disposable.dispose();
}

// Expose for tests
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__diagnosticsStore = useDiagnosticsStore;
}
