import { useEffect, useRef } from "react";
import { useEditorStore } from "../../stores/editorStore";

interface TabBarProps {
  onSaveActive: () => void;
}

export default function TabBar({ onSaveActive }: TabBarProps): React.JSX.Element {
  const tabs = useEditorStore((s) => s.tabs);
  const activePath = useEditorStore((s) => s.activePath);
  const setActive = useEditorStore((s) => s.setActive);
  const closeTab = useEditorStore((s) => s.closeTab);
  const tabRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Arrow key navigation between tabs
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest('[role="tablist"]')) {
        const focused = document.activeElement;
        if (!focused) return;
        const idx = tabs.findIndex((t) => t.path === activePath);
        if (e.key === "ArrowRight") {
          e.preventDefault(); e.stopPropagation();
          const next = (idx + 1) % tabs.length;
          setActive(tabs[next].path);
          requestAnimationFrame(() => { tabRefs.current[next]?.focus(); });
        } else if (e.key === "ArrowLeft") {
          e.preventDefault(); e.stopPropagation();
          const prev = (idx - 1 + tabs.length) % tabs.length;
          setActive(tabs[prev].path);
          requestAnimationFrame(() => { tabRefs.current[prev]?.focus(); });
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [tabs, activePath, setActive]);

  return (
    <div className="h-9 flex items-end bg-cc-sidebar border-b border-cc-border overflow-x-auto shrink-0" role="tablist" aria-label="Editor tabs">
      {tabs.length === 0 ? (
        <div className="px-3 h-9 flex items-center text-cc-muted text-[12px]">
          No files open
        </div>
      ) : (
        tabs.map((tab) => {
          const active = tab.path === activePath;
          return (
            <div
              key={tab.path}
              role="tab"
              aria-selected={active}
              className={`group flex items-center gap-1.5 h-9 px-3 text-[12px] border-r border-cc-border cursor-pointer shrink-0 ${
                active
                  ? "bg-cc-bg text-cc-text border-t-2 border-t-cc-accent"
                  : "text-cc-muted hover:bg-cc-surface"
              }`}
              onClick={() => setActive(tab.path)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setActive(tab.path);
                }
              }}
              onAuxClick={(e) => {
                if (e.button === 1) handleClose(tab.path, tab.dirty);
              }}
              tabIndex={active ? 0 : -1}
              ref={(el) => { tabRefs.current = [...tabRefs.current.slice(0, tabs.length), el]; }}
              aria-controls={`editor-panel-${tab.path.replace(/[^a-zA-Z0-9]/g, "_")}`}
              title={tab.path}
            >
              <span className="max-w-[160px] truncate">{tab.name}</span>
              {tab.dirty && (
                <span className="w-2 h-2 rounded-full bg-cc-warning" title="Unsaved changes" />
              )}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleClose(tab.path, tab.dirty);
                }}
                className="w-4 h-4 flex items-center justify-center rounded text-cc-muted hover:text-cc-text hover:bg-cc-border/50 opacity-0 group-hover:opacity-100"
                aria-label={`Close ${tab.name}`}
                title="Close"
              >
                ✕
              </button>
            </div>
          );
        })
      )}
      {tabs.length > 0 && (
        <button
          type="button"
          onClick={onSaveActive}
          className="h-9 px-2 text-cc-muted hover:text-cc-accent text-[13px] shrink-0"
          title="Save (Ctrl+S)"
        >
          Save
        </button>
      )}
    </div>
  );

  function handleClose(path: string, dirty: boolean): void {
    if (dirty) {
      const ok = window.confirm(
        "This file has unsaved changes. Close anyway and discard them?"
      );
      if (!ok) return;
    }
    closeTab(path);
  }
}