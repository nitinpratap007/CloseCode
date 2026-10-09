import { useEffect, useMemo, useRef, useState } from "react";
import { getAllCommands, searchCommands, executeCommand, type CommandMeta } from "../commands/registry";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export default function CommandPalette({ open, onClose }: CommandPaletteProps): React.JSX.Element | null {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const commands = useMemo<CommandMeta[]>(() => {
    if (!query.trim()) return getAllCommands();
    return searchCommands(query);
  }, [query, open]);

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
      // focus next frame
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Clamp selected
  useEffect(() => {
    if (selected >= commands.length) setSelected(Math.max(0, commands.length - 1));
  }, [commands.length, selected]);

  // Scroll selected into view
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-index="${selected}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // Global Escape when open (also handled by shortcut manager, but keep here)
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
      // Focus trap: keep Tab within the dialog
      if (e.key === "Tab" && e.target === inputRef.current) {
        const items = listRef.current?.querySelectorAll<HTMLElement>('[role="option"]');
        if (!items || items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose, commands]);

  const run = (cmd: CommandMeta): void => {
    onClose();
    // Defer so palette unmounts before command's UI (e.g., dialog) shows
    setTimeout(() => {
      void executeCommand(cmd.id).catch((err) => console.error(err));
    }, 0);
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center pt-[20vh] bg-black/40 backdrop-blur-[1px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        data-command-palette="true"
        className="w-[560px] max-w-[92vw] bg-cc-surface border border-cc-border rounded-lg shadow-2xl overflow-hidden flex flex-col max-h-[60vh]"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-cc-border">
          <span className="text-cc-muted text-sm" aria-hidden="true">›</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelected(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setSelected((s) => Math.min(s + 1, commands.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); }
              else if (e.key === "Enter") {
                e.preventDefault();
                const cmd = commands[selected];
                if (cmd) run(cmd);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
            placeholder="Type a command or search…"
            className="flex-1 bg-transparent outline-none text-sm text-cc-text placeholder:text-cc-muted"
            aria-label="Command search"
            aria-activedescendant={commands[selected] ? `cmd-${commands[selected].id}` : undefined}
            aria-controls="command-list"
            aria-describedby="command-palette-instructions"
          />
          <span id="command-palette-instructions" className="sr-only">Use arrow keys to navigate commands, Enter to select, Escape to close</span>
          <span className="text-[11px] text-cc-muted border border-cc-border rounded px-1 py-0.5">ESC</span>
        </div>

        <div ref={listRef} id="command-list" className="overflow-y-auto flex-1 py-1" role="listbox" aria-label="Commands" aria-activedescendant={commands[selected] ? `cmd-${commands[selected].id}` : undefined}>
          {commands.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-cc-muted">No commands matching “{query}”</div>
          ) : (
            commands.map((cmd, idx) => (
              <button
                key={cmd.id}
                type="button"
                id={`cmd-${cmd.id}`}
                data-index={idx}
                role="option"
                aria-selected={idx === selected}
                onMouseEnter={() => setSelected(idx)}
                onClick={() => run(cmd)}
                className={`w-full text-left px-3 py-2 flex items-center justify-between gap-3 text-sm transition-colors ${
                  idx === selected ? "bg-cc-accent text-white" : "text-cc-text hover:bg-cc-bg"
                }`}
              >
                <span className="flex flex-col items-start min-w-0">
                  <span className="font-medium truncate">{cmd.title}</span>
                  {cmd.description && <span className={`text-xs truncate ${idx === selected ? "text-white/80" : "text-cc-muted"}`}>{cmd.description}</span>}
                </span>
                {cmd.shortcut && (
                  <span className={`shrink-0 text-xs font-mono border rounded px-1.5 py-0.5 ${idx === selected ? "bg-white/20 border-white/30 text-white" : "bg-cc-bg border-cc-border text-cc-muted"}`}>
                    {cmd.shortcut}
                  </span>
                )}
              </button>
            ))
          )}
        </div>

        <div className="px-3 py-1.5 border-t border-cc-border flex items-center justify-between text-[11px] text-cc-muted">
          <span>{commands.length} commands</span>
          <span>↑↓ Navigate · Enter Run · Esc Close</span>
        </div>
      </div>
    </div>
  );
}
