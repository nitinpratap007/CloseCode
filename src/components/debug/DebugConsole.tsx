import { useEffect, useRef, useState } from "react";
import { useDebugStore } from "../../stores/debugStore";

const CATEGORY_COLOR: Record<string, string> = {
  stdout: "text-cc-text",
  stderr: "text-red-400",
  console: "text-cc-accent",
};

export default function DebugConsole(): React.JSX.Element {
  const consoleEntries = useDebugStore((s) => s.consoleEntries);
  const evaluate = useDebugStore((s) => s.evaluate);
  const [input, setInput] = useState("");
  const outRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    onAutoScroll();
  });

  function onAutoScroll(): void {
    const el = outRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }

  const submit = (): void => {
    const v = input.trim();
    if (!v) return;
    setInput("");
    void evaluate(v);
  };

  return (
    <div className="h-full flex flex-col bg-cc-bg" data-debug-console="true">
      <div ref={outRef} className="flex-1 overflow-y-auto overflow-x-hidden px-2 py-1 font-mono text-xs leading-relaxed">
        {consoleEntries.length === 0 ? (
          <div className="text-cc-muted py-1">
            Debug console — evaluate expressions in the paused context (or print program output).
          </div>
        ) : (
          consoleEntries.map((entry, i) => {
            const cls = entry.text.startsWith("> ") ? "text-cc-muted italic" : CATEGORY_COLOR[entry.category] ?? "text-cc-text";
            return (
              <div key={i} className={`whitespace-pre-wrap break-words ${cls}`}>
                {entry.text || "\u00a0"}
              </div>
            );
          })
        )}
      </div>
      <div className="h-9 flex items-center gap-2 px-2 border-t border-cc-border shrink-0">
        <span className="text-cc-accent text-sm select-none">&gt;</span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="expression…"
          aria-label="Debug console input"
          className="flex-1 min-w-0 bg-transparent text-xs font-mono text-cc-text placeholder:text-cc-muted focus:outline-none"
        />
      </div>
    </div>
  );
}