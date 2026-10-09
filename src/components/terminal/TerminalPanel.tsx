import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import { useTerminalStore } from "../../stores/terminalStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useSettingsStore } from "../../stores/settingsStore";

interface XtermHolder {
  term: Terminal;
  fit: FitAddon;
  container: HTMLDivElement;
  disposables: Array<{ dispose: () => void }>;
}

export default function TerminalPanel({ onClose }: { onClose?: () => void }): React.JSX.Element {
  const terminals = useTerminalStore((s) => s.terminals);
  const activeId = useTerminalStore((s) => s.activeId);
  const createWithWorkspaceCwd = useTerminalStore((s) => s.createWithWorkspaceCwd);
  const setActive = useTerminalStore((s) => s.setActive);
  const killTerminal = useTerminalStore((s) => s.killTerminal);
  const killAll = useTerminalStore((s) => s.killAll);
  const restartTerminal = useTerminalStore((s) => s.restartTerminal);
  const clearTerminal = useTerminalStore((s) => s.clearTerminal);
  const writeToTerminal = useTerminalStore((s) => s.writeToTerminal);
  const resizeTerminal = useTerminalStore((s) => s.resizeTerminal);
  const root = useWorkspaceStore((s) => s.root);

  // Phase 14: terminal look comes from settings
  const termSettings = useSettingsStore((s) => s.effective);
  const termFontSize = Number(termSettings.terminalFontSize) > 0 ? Number(termSettings.terminalFontSize) : 13;
  const termCursorBlink = termSettings.terminalCursorBlink !== false;
  const termScrollback = Number(termSettings.terminalScrollback) > 0 ? Number(termSettings.terminalScrollback) : 5000;

  const holdersRef = useRef<Map<string, XtermHolder>>(new Map());
  const containerRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; id: string } | null>(null);

  // Create initial terminal if none
  useEffect(() => {
    if (terminals.length === 0) {
      void createWithWorkspaceCwd();
    }
  }, [terminals.length, createWithWorkspaceCwd]);

  // Handle data from main
  useEffect(() => {
    const unsubData = window.closeCode.onTerminalData(({ id, data }) => {
      const holder = holdersRef.current.get(id);
      if (holder) holder.term.write(data);
      else {
        // Buffer for not-yet-created xterm? Store pending?
        // For now, ignore if no holder yet (will be created soon)
      }
    });
    const unsubExit = window.closeCode.onTerminalExit(({ id, exitCode }) => {
      const holder = holdersRef.current.get(id);
      if (holder) {
        holder.term.write(`\r\n\x1b[33m[Process exited with code ${exitCode}]\x1b[0m\r\n`);
        holder.term.write(`\r\nPress Enter to restart or close...\r\n`);
        // Allow Enter to restart
        const disposable = holder.term.onKey(({ domEvent }) => {
          if (domEvent.key === "Enter") {
            void restartTerminal(id);
            disposable.dispose();
          }
        });
        holder.disposables.push(disposable);
      }
    });
    return () => { unsubData(); unsubExit(); };
  }, [restartTerminal]);

  // Handle clear from store (via window.__terminalClearHandler)
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__terminalClearHandler = (clearId: string) => {
      const holder = holdersRef.current.get(clearId);
      if (holder) holder.term.clear();
    };
    return () => { delete w.__terminalClearHandler; };
  }, []);

  // Create xterm for each terminal
  useEffect(() => {
    for (const t of terminals) {
      if (holdersRef.current.has(t.id)) continue;
      const container = containerRefs.current.get(t.id);
      if (!container) continue;

      const term = new Terminal({
        fontFamily: "Cascadia Code, Consolas, monospace",
        fontSize: termFontSize,
        cursorBlink: termCursorBlink,
        cursorStyle: "block",
        scrollback: termScrollback,
        theme: {
          background: "#1e1e2e",
          foreground: "#cdd6f4",
          cursor: "#f5e0dc",
          selectionBackground: "#45475a",
        },
        allowTransparency: false,
        convertEol: true,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(container);
      // Fit after open
      try { fit.fit(); } catch {}
      // Handle input
      const dataDisp = term.onData((data) => {
        void writeToTerminal(t.id, data);
      });
      // Handle resize via fit
      const resizeDisp = term.onResize(({ cols, rows }) => {
        void resizeTerminal(t.id, cols, rows);
      });
      // Copy/paste handling: Ctrl+Shift+C/V, and right-click
      term.attachCustomKeyEventHandler((e) => {
        if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "c") {
          const sel = term.getSelection();
          if (sel) window.closeCode.copyToClipboard(sel);
          return false;
        }
        if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "v") {
          const text = window.closeCode.readClipboard();
          if (text) void writeToTerminal(t.id, text);
          return false;
        }
        // Ctrl+C should be sent to pty as SIGINT, not copy, unless selection exists
        return true;
      });

      const holder: XtermHolder = { term, fit, container, disposables: [dataDisp, resizeDisp] };
      holdersRef.current.set(t.id, holder);

      // Initial resize
      try {
        const dims = fit.proposeDimensions();
        if (dims) void resizeTerminal(t.id, dims.cols, dims.rows);
      } catch {}

      // Focus if active
      if (t.id === activeId) {
        setTimeout(() => term.focus(), 0);
      }
    }

    // Cleanup removed terminals
    for (const [id, holder] of holdersRef.current.entries()) {
      if (!terminals.find((t) => t.id === id)) {
        for (const d of holder.disposables) d.dispose();
        holder.term.dispose();
        holdersRef.current.delete(id);
        containerRefs.current.delete(id);
      }
    }
  }, [terminals, activeId, writeToTerminal, resizeTerminal]);

  // When activeId changes, focus and fit
  useEffect(() => {
    if (!activeId) return;
    const holder = holdersRef.current.get(activeId);
    if (holder) {
      setTimeout(() => {
        try { holder.fit.fit(); } catch {}
        holder.term.focus();
        const dims = holder.fit.proposeDimensions();
        if (dims) void resizeTerminal(activeId, dims.cols, dims.rows);
      }, 0);
    }
  }, [activeId, resizeTerminal]);

  // ResizeObserver for container
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      for (const holder of holdersRef.current.values()) {
        try { holder.fit.fit(); } catch {}
      }
      // Notify main of new dims for active
      if (activeId) {
        const h = holdersRef.current.get(activeId);
        if (h) {
          const dims = h.fit.proposeDimensions();
          if (dims) void resizeTerminal(activeId, dims.cols, dims.rows);
        }
      }
    });
    const el = document.querySelector("[data-terminal-panel]") as HTMLElement | null;
    if (el) ro.observe(el);
    return () => ro.disconnect();
  }, [activeId, resizeTerminal]);

  const handleContextMenu = useCallback((e: React.MouseEvent, id: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, id });
  }, []);

  const handleCopy = useCallback(() => {
    if (!contextMenu) return;
    const holder = holdersRef.current.get(contextMenu.id);
    if (holder) {
      const sel = holder.term.getSelection();
      if (sel) window.closeCode.copyToClipboard(sel);
    }
    setContextMenu(null);
  }, [contextMenu]);

  const handlePaste = useCallback(() => {
    if (!contextMenu) return;
    const text = window.closeCode.readClipboard();
    if (text) void writeToTerminal(contextMenu.id, text);
    setContextMenu(null);
  }, [contextMenu, writeToTerminal]);

  const handleClear = useCallback(() => {
    if (!contextMenu) return;
    clearTerminal(contextMenu.id);
    const holder = holdersRef.current.get(contextMenu.id);
    if (holder) holder.term.clear();
    setContextMenu(null);
  }, [contextMenu, clearTerminal]);

  // Close context menu on click elsewhere
  useEffect(() => {
    if (!contextMenu) return;
    const h = (): void => setContextMenu(null);
    window.addEventListener("click", h);
    window.addEventListener("keydown", (e) => { if (e.key === "Escape") setContextMenu(null); });
    return () => window.removeEventListener("click", h);
  }, [contextMenu]);

  // Expose for tests
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__terminalStore = useTerminalStore;
    w.__createTerminal = () => createWithWorkspaceCwd();
  }, [createWithWorkspaceCwd]);

  return (
    <div data-terminal-panel="true" className="h-full flex flex-col bg-cc-bg border-t border-cc-border">
      <div className="h-8 flex items-center gap-1 px-2 bg-cc-sidebar border-b border-cc-border shrink-0">
        <span className="text-xs font-semibold text-cc-muted uppercase tracking-wide mr-2">Terminal</span>
        <div className="flex items-center gap-1 flex-1 overflow-x-auto">
          {terminals.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setActive(t.id)}
              className={`px-2 py-1 text-xs rounded flex items-center gap-1.5 shrink-0 ${activeId === t.id ? "bg-cc-surface text-cc-text border border-cc-border" : "text-cc-muted hover:text-cc-text hover:bg-cc-surface/50"}`}
              title={`${t.shell} — ${t.cwd}`}
            >
              <span className="w-2 h-2 rounded-full bg-green-500" aria-hidden="true" />
              <span className="truncate max-w-[120px]">{t.title}</span>
              <span
                role="button"
                tabIndex={-1}
                onClick={(e) => { e.stopPropagation(); void killTerminal(t.id); }}
                className="ml-1 w-4 h-4 flex items-center justify-center rounded hover:bg-cc-border text-cc-muted hover:text-cc-text"
                title="Kill terminal"
                aria-label={`Kill ${t.title}`}
              >
                ×
              </span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => void createWithWorkspaceCwd()}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-cc-surface text-cc-muted hover:text-cc-text"
            title="New terminal"
            aria-label="New terminal"
          >
            +
          </button>
        </div>
        <div className="flex items-center gap-1 ml-auto">
          <button
            type="button"
            onClick={() => { if (activeId) { const h = holdersRef.current.get(activeId); if (h) h.term.clear(); } }}
            className="px-2 py-1 text-xs rounded hover:bg-cc-surface text-cc-muted hover:text-cc-text"
            title="Clear terminal"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={() => { if (activeId) void restartTerminal(activeId); }}
            className="px-2 py-1 text-xs rounded hover:bg-cc-surface text-cc-muted hover:text-cc-text"
            title="Restart terminal"
          >
            ↻
          </button>
          <button
            type="button"
            onClick={() => void killAll()}
            className="px-2 py-1 text-xs rounded hover:bg-cc-surface text-cc-muted hover:text-cc-text"
            title="Kill all terminals"
          >
            Kill All
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="w-7 h-7 flex items-center justify-center rounded hover:bg-cc-surface text-cc-muted hover:text-cc-text"
              title="Close terminal panel"
              aria-label="Close terminal panel"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 relative bg-[#1e1e2e] overflow-hidden">
        {terminals.length === 0 ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-cc-muted">
            <div className="text-sm">No terminal sessions</div>
            <button
              type="button"
              onClick={() => void createWithWorkspaceCwd()}
              className="px-3 py-1.5 text-sm rounded bg-cc-accent text-white hover:bg-cc-accent/90"
            >
              New Terminal
            </button>
            <div className="text-xs">CWD: {root ?? "home"}</div>
          </div>
        ) : (
          terminals.map((t) => (
            <div
              key={t.id}
              ref={(el) => { if (el) containerRefs.current.set(t.id, el); }}
              className={`absolute inset-0 p-2 ${activeId === t.id ? "block" : "hidden"}`}
              onContextMenu={(e) => handleContextMenu(e, t.id)}
              data-terminal-id={t.id}
            />
          ))
        )}

        {contextMenu && (
          <div
            className="fixed z-50 bg-cc-surface border border-cc-border rounded shadow-lg py-1 min-w-[140px]"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            role="menu"
          >
            <button type="button" onClick={handleCopy} className="w-full text-left px-3 py-1.5 text-sm hover:bg-cc-bg text-cc-text" role="menuitem">Copy</button>
            <button type="button" onClick={handlePaste} className="w-full text-left px-3 py-1.5 text-sm hover:bg-cc-bg text-cc-text" role="menuitem">Paste</button>
            <button type="button" onClick={handleClear} className="w-full text-left px-3 py-1.5 text-sm hover:bg-cc-bg text-cc-text" role="menuitem">Clear</button>
          </div>
        )}
      </div>

      <div className="h-5 px-2 flex items-center text-[11px] text-cc-muted bg-cc-sidebar border-t border-cc-border shrink-0">
        {activeId ? (
          <>
            <span>{terminals.find((t) => t.id === activeId)?.shell.split(/[\\/]/).pop()}</span>
            <span className="mx-1">·</span>
            <span className="truncate">{terminals.find((t) => t.id === activeId)?.cwd}</span>
            <span className="ml-auto">{terminals.find((t) => t.id === activeId)?.isPty ? "PTY" : "PIPE"} · {terminals.length} session{terminals.length !== 1 ? "s" : ""}</span>
          </>
        ) : (
          <span>No active terminal</span>
        )}
      </div>
    </div>
  );
}
