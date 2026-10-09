import { useEffect, useState } from "react";
import { useDebugStore } from "../../stores/debugStore";
import { useEditorStore } from "../../stores/editorStore";

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

export default function DebugPanel(): React.JSX.Element {
  const state = useDebugStore((s) => s.state);
  const runningFile = useDebugStore((s) => s.runningFile);
  const breakpoints = useDebugStore((s) => s.breakpoints);
  const callFrames = useDebugStore((s) => s.callFrames);
  const selectedFrameId = useDebugStore((s) => s.selectedFrameId);
  const scopes = useDebugStore((s) => s.scopes);
  const variableStack = useDebugStore((s) => s.variableStack);
  const error = useDebugStore((s) => s.error);
  const isLoading = useDebugStore((s) => s.isLoading);

  const start = useDebugStore((s) => s.start);
  const stop = useDebugStore((s) => s.stop);
  const pause = useDebugStore((s) => s.pause);
  const continueRun = useDebugStore((s) => s.continue);
  const stepOver = useDebugStore((s) => s.stepOver);
  const stepInto = useDebugStore((s) => s.stepInto);
  const stepOut = useDebugStore((s) => s.stepOut);
  const removeBreakpoint = useDebugStore((s) => s.removeBreakpoint);
  const selectFrame = useDebugStore((s) => s.selectFrame);
  const expandObject = useDebugStore((s) => s.expandObject);
  const backVariable = useDebugStore((s) => s.backVariable);
  const clearError = useDebugStore((s) => s.clearError);

  const activePath = useEditorStore((s) => s.activePath);
  const [fileInput, setFileInput] = useState("");

  useEffect(() => {
    clearError();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const programFile = fileInput.trim() || activePath || "";
  const isPaused = state === "paused";
  const isRunning = state === "running";
  const isActive = state !== "inactive";

  const onRun = (): void => {
    if (isPaused) void continueRun();
    else if (!isRunning) void start(programFile);
  };

  return (
    <div className="h-full flex flex-col bg-cc-sidebar" data-debug-panel="true">
      <header className="h-9 flex items-center gap-1 px-2 border-b border-cc-border shrink-0">
        <span className="font-semibold text-[12px] uppercase tracking-wide text-cc-muted px-1 flex-1">Run &amp; Debug</span>
        {isActive && (
          <button
            type="button"
            onClick={() => void stop()}
            className="w-6 h-6 flex items-center justify-center rounded text-xs text-red-400 hover:bg-cc-surface"
            title="Stop (Shift+F5)"
            aria-label="Stop debugging"
          >
            ■
          </button>
        )}
      </header>

      {/* Control toolbar */}
      <div className="px-2 py-2 border-b border-cc-border bg-cc-surface/30" data-debug-toolbar="true">
        <div className="flex items-center gap-1">
          {(isPaused || !isActive) && (
            <button
              type="button"
              onClick={onRun}
              disabled={!isPaused && !programFile}
              className="flex-1 px-2 py-1 text-xs rounded bg-cc-accent text-white hover:bg-cc-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
              title="Continue / Start (F5)"
            >
              {isPaused ? "Continue" : "Start"}
            </button>
          )}
          {isRunning && (
            <button
              type="button"
              onClick={() => void pause()}
              className="flex-1 px-2 py-1 text-xs rounded bg-cc-bg border border-cc-border hover:bg-cc-surface text-cc-text"
              title="Pause"
            >
              Pause
            </button>
          )}
          {isPaused && (
            <>
              <button
                type="button"
                onClick={() => void stepOver()}
                className="w-8 px-2 py-1 text-xs rounded bg-cc-bg border border-cc-border hover:bg-cc-surface text-cc-text"
                title="Step Over (F10)"
              >
                ⤵
              </button>
              <button
                type="button"
                onClick={() => void stepInto()}
                className="w-8 px-2 py-1 text-xs rounded bg-cc-bg border border-cc-border hover:bg-cc-surface text-cc-text"
                title="Step Into (F11)"
              >
                ⤷
              </button>
              <button
                type="button"
                onClick={() => void stepOut()}
                className="w-8 px-2 py-1 text-xs rounded bg-cc-bg border border-cc-border hover:bg-cc-surface text-cc-text"
                title="Step Out (Shift+F11)"
              >
                ⤴
              </button>
            </>
          )}
        </div>

        {!isActive && (
          <div className="mt-2 flex gap-1">
            <input
              value={fileInput}
              onChange={(e) => setFileInput(e.target.value)}
              placeholder={activePath ? baseName(activePath) : "Script path (e.g. app.js)"}
              aria-label="Program file"
              className="flex-1 min-w-0 bg-cc-bg border border-cc-border rounded px-2 py-1 text-xs text-cc-text placeholder:text-cc-muted focus:outline-none focus:border-cc-accent"
              onKeyDown={(e) => {
                if (e.key === "Enter" && programFile) void start(programFile);
              }}
            />
            <button
              type="button"
              onClick={() => void start(programFile)}
              disabled={!programFile}
              className="px-2 py-1 text-xs rounded bg-cc-accent text-white hover:bg-cc-accent/90 disabled:opacity-50"
              title="Start debugging (F5)"
            >
              ▶
            </button>
          </div>
        )}

        {isActive && runningFile && (
          <div className="mt-2 text-[11px] text-cc-muted truncate" title={runningFile}>
            <span className="capitalize">{state}</span> · {baseName(runningFile)}
          </div>
        )}
        {error && (
          <div className="mt-2 text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded px-2 py-1 break-words">
            {error}
          </div>
        )}
        {isLoading && <div className="mt-2 text-[11px] text-cc-muted">Starting debugger…</div>}
      </div>

      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        {/* Breakpoints */}
        <Section title={`Breakpoints (${breakpoints.length})`}>
          {breakpoints.length === 0 ? (
            <div className="text-xs text-cc-muted px-1 py-1">
              No breakpoints. Click the gutter in the editor to add one.
            </div>
          ) : (
            <div className="space-y-0.5" data-debug-breakpoints="true">
              {breakpoints.map((bp) => (
                <div key={bp.id} className="flex items-center gap-2 px-1 py-1 rounded hover:bg-cc-surface group">
                  <span className="w-2 h-2 rounded-full bg-red-400 shrink-0" />
                  <span className="flex-1 text-xs text-cc-text truncate" title={bp.file}>
                    {baseName(bp.file)}:{bp.line}
                  </span>
                  {!bp.resolved && (
                    <span className="text-[10px] text-amber-400" title="Unverified breakpoint">
                      !
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => void removeBreakpoint(bp.id)}
                    className="text-xs text-cc-muted hover:text-cc-text opacity-60 group-hover:opacity-100"
                    title="Remove breakpoint"
                    aria-label="Remove breakpoint"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* Call stack */}
        <Section title="Call Stack" dataAttr="data-debug-callstack">
          {!isActive || callFrames.length === 0 ? (
            <div className="text-xs text-cc-muted px-1 py-1">No call stack</div>
          ) : (
            <div className="space-y-0.5">
              {callFrames.map((f) => (
                <button
                  key={f.frameId}
                  type="button"
                  onClick={() => void selectFrame(f.frameId)}
                  className={`w-full text-left px-1.5 py-1 rounded text-xs flex items-center gap-2 ${selectedFrameId === f.frameId ? "bg-cc-accent text-white" : "text-cc-text hover:bg-cc-surface"}`}
                >
                  <span className="flex-1 truncate">{f.functionName}</span>
                  <span className={`font-mono text-[10px] truncate ${selectedFrameId === f.frameId ? "text-white/80" : "text-cc-muted"}`}>
                    {baseName(f.url)}:{f.line}
                  </span>
                </button>
              ))}
            </div>
          )}
        </Section>

        {/* Variables */}
        <Section title="Variables" dataAttr="data-debug-variables">
          {!isPaused || scopes.length === 0 ? (
            <div className="text-xs text-cc-muted px-1 py-1">No variables</div>
          ) : (
            <div className="space-y-2 px-1">
              {variableStack.length > 1 && (
                <button
                  type="button"
                  onClick={backVariable}
                  className="text-[11px] text-cc-accent hover:underline"
                >
                  ← Back
                </button>
              )}
              {scopes.map((scope) => (
                <div key={scope.name}>
                  <div className="text-[11px] font-semibold text-cc-muted uppercase tracking-wide">{scope.name}</div>
                  <div className="space-y-0.5 mt-0.5">
                    {scope.variables.map((v) => (
                      <div key={v.name} className="flex items-center gap-1.5 text-xs py-0.5 group">
                        <span className="text-cc-muted shrink-0">
                          {v.expandable && v.objectId ? (
                            <button
                              type="button"
                              className="text-cc-accent hover:underline"
                              onClick={() => void expandObject(v.objectId!)}
                              title="Expand"
                            >
                              ▸
                            </button>
                          ) : (
                            <span className="inline-block w-3 text-center text-cc-muted/40">·</span>
                          )}
                        </span>
                        <span className="text-cc-accent shrink-0">{v.name}</span>
                        <span className="text-cc-muted/60 shrink-0">=</span>
                        <span className="flex-1 text-cc-text truncate" title={v.value}>
                          {v.value}
                        </span>
                        <span className="text-[10px] text-cc-muted/60 shrink-0">{v.type}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>

      <footer className="h-6 px-2 flex items-center text-[11px] text-cc-muted border-t border-cc-border shrink-0">
        <span className="capitalize">{state}</span>
        <span className="ml-auto">{isLoading ? "Loading…" : error ? "Error" : "Ready"}</span>
      </footer>
    </div>
  );
}

function Section({
  title,
  children,
  dataAttr,
}: {
  title: string;
  children: React.ReactNode;
  dataAttr?: string;
}): React.JSX.Element {
  return (
    <div {...(dataAttr ? { [dataAttr]: "true" } : {})}>
      <div className="px-2 py-1.5 border-b border-cc-border/50 bg-cc-sidebar sticky top-0">
        <span className="text-[11px] font-semibold text-cc-muted uppercase tracking-wide">{title}</span>
      </div>
      <div className="px-1 py-1.5">{children}</div>
    </div>
  );
}