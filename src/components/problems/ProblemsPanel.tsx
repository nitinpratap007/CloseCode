import { useDiagnosticsStore } from "../../language/diagnostics";
import FileIcon from "../explorer/FileIcon";

export default function ProblemsPanel(): React.JSX.Element {
  const diagnostics = useDiagnosticsStore((s) => s.diagnostics);
  const errorCount = useDiagnosticsStore((s) => s.errorCount);
  const warningCount = useDiagnosticsStore((s) => s.warningCount);

  // Group by file
  const grouped = new Map<string, typeof diagnostics>();
  for (const d of diagnostics) {
    const arr = grouped.get(d.file) ?? [];
    arr.push(d);
    grouped.set(d.file, arr);
  }

  const handleClick = (d: (typeof diagnostics)[number]): void => {
    const w = window as unknown as Record<string, unknown>;
    const editorStore = w.__editorStore as typeof import("../../stores/editorStore").useEditorStore | undefined;
    const monacoEditor = w.__monacoEditor as import("monaco-editor").editor.IStandaloneCodeEditor | undefined;
    if (editorStore) {
      void editorStore.getState().openFileInWorkspace(d.file).then(() => {
        setTimeout(() => {
          if (monacoEditor) {
            monacoEditor.revealLineInCenter(d.line);
            monacoEditor.setPosition({ lineNumber: d.line, column: d.column });
            monacoEditor.focus();
          }
        }, 100);
      });
    }
  };

  if (diagnostics.length === 0) {
    return (
      <div className="h-full flex flex-col bg-cc-bg" data-problems-panel="true">
        <header className="h-8 flex items-center gap-2 px-3 bg-cc-sidebar border-b border-cc-border shrink-0">
          <span className="text-xs font-semibold text-cc-muted uppercase tracking-wide">Problems</span>
          <span className="ml-auto text-xs text-cc-muted">No problems detected</span>
        </header>
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-cc-muted p-4">
          <div className="w-10 h-10 rounded-full bg-cc-surface flex items-center justify-center text-lg">✓</div>
          <div className="text-sm">No errors or warnings</div>
          <div className="text-xs text-center max-w-xs">Diagnostics appear here when you open files with errors. TypeScript, JSON, HTML, CSS, and Markdown are supported.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-cc-bg" data-problems-panel="true">
      <header className="h-8 flex items-center gap-3 px-3 bg-cc-sidebar border-b border-cc-border shrink-0">
        <span className="text-xs font-semibold text-cc-muted uppercase tracking-wide">Problems</span>
        <span className="flex items-center gap-2 text-xs">
          <span className="flex items-center gap-1 text-red-400" title={`${errorCount} errors`}>
            <span className="w-2 h-2 rounded-full bg-red-500" /> {errorCount}
          </span>
          <span className="flex items-center gap-1 text-amber-400" title={`${warningCount} warnings`}>
            <span className="w-2 h-2 rounded-full bg-amber-500" /> {warningCount}
          </span>
          <span className="text-cc-muted">· {diagnostics.length} total</span>
        </span>
        <span className="ml-auto text-[11px] text-cc-muted">{grouped.size} file{grouped.size !== 1 ? "s" : ""}</span>
      </header>

      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        {[...grouped.entries()].map(([file, fileDiags]) => {
          const fileName = file.split(/[\\/]/).pop() ?? file;
          const rel = file; // Could make relative to workspace root, but keep absolute for now
          return (
            <div key={file} className="border-b border-cc-border/30">
              <div className="flex items-center gap-1.5 px-2 py-1.5 bg-cc-surface/50 sticky top-0">
                <FileIcon name={fileName} isDirectory={false} expanded={false} />
                <span className="flex-1 truncate text-xs font-medium text-cc-text" title={file}>
                  {fileName}
                </span>
                <span className="text-xs text-cc-muted truncate max-w-[200px]" title={file}>
                  {rel}
                </span>
                <span className="text-xs text-cc-muted">{fileDiags.length}</span>
              </div>
              {fileDiags.map((d, idx) => (
                <button
                  key={`${d.line}-${d.column}-${idx}-${d.message}`}
                  type="button"
                  onClick={() => handleClick(d)}
                  className="w-full text-left px-2 py-1.5 hover:bg-cc-surface flex items-start gap-2 border-l-2 border-transparent hover:border-cc-accent"
                  title={`${file}:${d.line}:${d.column} — ${d.message}`}
                >
                  <span className="mt-0.5 shrink-0">
                    {d.severity === "error" ? (
                      <span className="w-3 h-3 rounded-full bg-red-500 flex items-center justify-center text-[8px] text-white">✕</span>
                    ) : d.severity === "warning" ? (
                      <span className="w-3 h-3 rounded-full bg-amber-500 flex items-center justify-center text-[8px] text-white">!</span>
                    ) : (
                      <span className="w-3 h-3 rounded-full bg-blue-500 flex items-center justify-center text-[8px] text-white">i</span>
                    )}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="text-xs text-cc-text line-clamp-2">{d.message}</span>
                    <span className="text-[11px] text-cc-muted">
                      line {d.line}, col {d.column} {d.source ? `· ${d.source}` : ""} {d.code ? `· ${d.code}` : ""}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          );
        })}
      </div>

      <footer className="h-5 px-2 flex items-center text-[11px] text-cc-muted bg-cc-sidebar border-t border-cc-border shrink-0">
        <span>
          {errorCount} error{errorCount !== 1 ? "s" : ""}, {warningCount} warning{warningCount !== 1 ? "s" : ""}
        </span>
        <span className="ml-auto">Click to jump to file</span>
      </footer>
    </div>
  );
}
