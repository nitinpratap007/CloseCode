import { useRef } from "react";
export type ActivityView = "explorer" | "search" | "git" | "debug" | "extensions";
export type RightView = "ai";

interface ActivityBarProps {
  activeView: ActivityView | null;
  aiOpen: boolean;
  onChange: (view: ActivityView) => void;
  onToggleAi: () => void;
}

export default function ActivityBar({ activeView, aiOpen, onChange, onToggleAi }: ActivityBarProps): React.JSX.Element {
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const item = (view: ActivityView, glyph: string, label: string, title: string, index: number): React.JSX.Element => (
    <button
      type="button"
      ref={(el) => { itemRefs.current[index] = el; }}
      onClick={() => onChange(view)}
      className={`w-9 h-9 flex items-center justify-center rounded text-lg transition-colors ${activeView === view ? "bg-cc-surface text-cc-accent" : "text-cc-muted hover:text-cc-text hover:bg-cc-surface"}`}
      title={title}
      aria-label={label}
      aria-pressed={activeView === view}
      role="menuitem"
      tabIndex={activeView === view ? 0 : -1}
      onKeyDown={(e) => {
        const views: ActivityView[] = ["explorer", "search", "git", "debug", "extensions"];
        if (e.key === "ArrowDown" || e.key === "ArrowRight") {
          e.preventDefault();
          e.stopPropagation();
          const idx = views.indexOf(view);
          const next = views[(idx + 1) % views.length];
          onChange(next);
          requestAnimationFrame(() => { itemRefs.current[views.indexOf(next)]?.focus(); });
        } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
          e.preventDefault();
          e.stopPropagation();
          const idx = views.indexOf(view);
          const prev = views[(idx - 1 + views.length) % views.length];
          onChange(prev);
          requestAnimationFrame(() => { itemRefs.current[views.indexOf(prev)]?.focus(); });
        }
      }}
    >
      {glyph}
    </button>
  );

  return (
    <nav className="w-12 bg-cc-sidebar border-r border-cc-border flex flex-col items-center py-2 gap-1 shrink-0" aria-label="Activity Bar" role="menubar">
      {item("explorer", "▦", "Explorer", "Explorer (Ctrl+Shift+E)", 0)}
      {item("search", "⚲", "Search", "Search (Ctrl+Shift+F)", 1)}
      {item("git", "⎇", "Source Control", "Source Control (Ctrl+Shift+G)", 2)}
      {item("debug", "▶", "Run and Debug", "Run and Debug (Ctrl+Shift+D)", 3)}
      {item("extensions", "◆", "Extensions", "Extensions", 4)}
      <div className="flex-1" />
      <button
        type="button"
        onClick={onToggleAi}
        className={`w-9 h-9 flex items-center justify-center rounded text-lg transition-colors ${aiOpen ? "bg-cc-surface text-cc-accent" : "text-cc-muted hover:text-cc-text hover:bg-cc-surface"}`}
        title="AI Assistant (Ctrl+Shift+A)"
        aria-label="AI Assistant"
        aria-pressed={aiOpen}
        role="menuitem"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowRight") {
            e.preventDefault(); e.stopPropagation();
            onChange("explorer");
            requestAnimationFrame(() => { itemRefs.current[0]?.focus(); });
          } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
            e.preventDefault(); e.stopPropagation();
            onChange("extensions");
            requestAnimationFrame(() => { itemRefs.current[4]?.focus(); });
          }
        }}
      >
        ✦
      </button>
    </nav>
  );
}