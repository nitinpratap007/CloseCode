import { useEffect, useRef } from "react";

export interface ContextMenuItem {
  label: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export default function ContextMenu({
  x,
  y,
  items,
  onClose,
}: ContextMenuProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onClickOutside = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onClickOutside, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClickOutside, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const style: React.CSSProperties = {
    position: "fixed",
    left: Math.min(x, window.innerWidth - 220),
    top: Math.min(y, window.innerHeight - items.length * 30 - 20),
    zIndex: 1000,
  };

  return (
    <div
      ref={ref}
      style={style}
      className="w-52 bg-cc-surface border border-cc-border rounded-md shadow-xl shadow-black/40 py-1 select-none"
      role="menu"
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={() => {
            onClose();
            item.onClick();
          }}
          className={`w-full text-left px-3 py-1.5 text-[13px] flex items-center justify-between hover:bg-cc-bg ${
            item.danger ? "text-cc-error" : "text-cc-text"
          } disabled:opacity-40 disabled:cursor-not-allowed`}
        >
          <span>{item.label}</span>
          {item.shortcut && (
            <span className="text-cc-muted text-[11px]">{item.shortcut}</span>
          )}
        </button>
      ))}
    </div>
  );
}