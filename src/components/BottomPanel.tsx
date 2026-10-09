import { useRef } from "react";
import TerminalPanel from "./terminal/TerminalPanel";
import ProblemsPanel from "./problems/ProblemsPanel";
import DebugConsole from "./debug/DebugConsole";
import { useDiagnosticsStore } from "../language/diagnostics";

type BottomView = "terminal" | "problems" | "debug";

interface BottomPanelProps {
  activeView: BottomView;
  onViewChange: (view: BottomView) => void;
  onClose: () => void;
}

export default function BottomPanel({ activeView, onViewChange, onClose }: BottomPanelProps): React.JSX.Element {
  const errorCount = useDiagnosticsStore((s) => s.errorCount);
  const warningCount = useDiagnosticsStore((s) => s.warningCount);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const views: BottomView[] = ["terminal", "problems", "debug"];

  const switchView = (view: BottomView) => {
    onViewChange(view);
    requestAnimationFrame(() => { tabRefs.current[views.indexOf(view)]?.focus(); });
  };

  const handleKeyDown = (e: React.KeyboardEvent, idx: number) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault(); e.stopPropagation();
      const next = views[(idx + 1) % views.length];
      switchView(next);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault(); e.stopPropagation();
      const prev = views[(idx - 1 + views.length) % views.length];
      switchView(prev);
    }
  };

  return (
    <div className="h-full flex flex-col bg-cc-bg" data-bottom-panel="true" role="region" aria-label="Bottom panel">
      <div className="h-8 flex items-center gap-1 px-2 bg-cc-sidebar border-b border-cc-border shrink-0" role="tablist" aria-label="Panel tabs">
        <button
          type="button"
          onClick={() => switchView("terminal")}
          onKeyDown={(e) => handleKeyDown(e, 0)}
          ref={(el) => { tabRefs.current[0] = el; }}
          className={`px-2.5 py-1 text-xs rounded flex items-center gap-1.5 ${activeView === "terminal" ? "bg-cc-surface text-cc-text border border-cc-border" : "text-cc-muted hover:text-cc-text hover:bg-cc-surface/50"}`}
          role="tab"
          aria-selected={activeView === "terminal"}
          aria-controls="bottom-terminal"
          aria-label="Terminal panel"
          tabIndex={activeView === "terminal" ? 0 : -1}
        >
          <span>Terminal</span>
        </button>
        <button
          type="button"
          onClick={() => switchView("problems")}
          onKeyDown={(e) => handleKeyDown(e, 1)}
          ref={(el) => { tabRefs.current[1] = el; }}
          className={`px-2.5 py-1 text-xs rounded flex items-center gap-1.5 ${activeView === "problems" ? "bg-cc-surface text-cc-text border border-cc-border" : "text-cc-muted hover:text-cc-text hover:bg-cc-surface/50"}`}
          role="tab"
          aria-selected={activeView === "problems"}
          aria-controls="bottom-problems"
          aria-label="Problems panel"
          tabIndex={activeView === "problems" ? 0 : -1}
        >
          <span>Problems</span>
          {(errorCount > 0 || warningCount > 0) && (
            <span className="flex items-center gap-1 text-[11px]">
              {errorCount > 0 && <span className="bg-red-500 text-white rounded-full px-1 min-w-[14px] text-center leading-none py-0.5">{errorCount}</span>}
              {warningCount > 0 && <span className="bg-amber-500 text-white rounded-full px-1 min-w-[14px] text-center leading-none py-0.5">{warningCount}</span>}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => switchView("debug")}
          onKeyDown={(e) => handleKeyDown(e, 2)}
          ref={(el) => { tabRefs.current[2] = el; }}
          className={`px-2.5 py-1 text-xs rounded flex items-center gap-1.5 ${activeView === "debug" ? "bg-cc-surface text-cc-text border border-cc-border" : "text-cc-muted hover:text-cc-text hover:bg-cc-surface/50"}`}
          role="tab"
          aria-selected={activeView === "debug"}
          aria-controls="bottom-debug"
          aria-label="Debug console panel"
          tabIndex={activeView === "debug" ? 0 : -1}
          data-debug-tab="true"
        >
          <span className="text-cc-accent">▶</span>
          <span>Debug Console</span>
        </button>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          className="w-7 h-7 flex items-center justify-center rounded hover:bg-cc-surface text-cc-muted hover:text-cc-text"
          title="Close panel"
          aria-label="Close panel"
        >
          ✕
        </button>
      </div>
      <div className="flex-1 min-h-0" role="tabpanel" aria-label={`${activeView} panel content`}>
        {activeView === "terminal" ? (
          <TerminalPanel onClose={onClose} />
        ) : activeView === "debug" ? (
          <DebugConsole />
        ) : (
          <ProblemsPanel />
        )}
      </div>
    </div>
  );
}
