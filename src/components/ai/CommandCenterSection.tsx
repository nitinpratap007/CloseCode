// Close Code — Command Center panel section (Phase 33)
//
// The user-facing half of the NL command center: a text box + catalog chips
// that start real agent runs. Every chip and the free-form input map to the
// same `command:run` IPC; the result is a real run id the panel can follow.

import { useEffect } from "react";
import { useCommandStore } from "../../stores/commandStore";
import { useAgentStore } from "../../stores/agentStore";
import type { CommandCatalogEntry } from "../../types/electron";

const CATEGORY_STYLE: Record<string, string> = {
  files: "bg-blue-500/10 text-blue-400",
  terminal: "bg-amber-500/10 text-amber-400",
  search: "bg-violet-500/10 text-violet-400",
  git: "bg-orange-500/10 text-orange-400",
  web: "bg-cyan-500/10 text-cyan-400",
  browser: "bg-teal-500/10 text-teal-400",
  tasks: "bg-pink-500/10 text-pink-400",
  mcp: "bg-indigo-500/10 text-indigo-400",
  skills: "bg-slate-500/10 text-slate-400",
  agent: "bg-fuchsia-500/10 text-fuchsia-400",
};

function CategoryTag({ cat }: { cat: string }) {
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded ${CATEGORY_STYLE[cat] ?? "bg-cc-muted/20 text-cc-muted"}`}>
      {cat}
    </span>
  );
}

function CatalogChip({ entry, onRun, disabled }: { entry: CommandCatalogEntry; onRun: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={onRun}
      disabled={disabled}
      className={`group flex items-start gap-2 p-2 rounded border border-cc-border hover:border-cc-accent/30 transition disabled:opacity-50 disabled:cursor-not-allowed ${
        entry.readOnly ? "bg-cc-muted/10" : "bg-red-500/5"
      }`}
      title={entry.description}
    >
      <span className="font-mono text-sm text-cc-accent">{entry.title}</span>
      <span className="flex-1 text-sm text-cc-muted leading-snug">{entry.description}</span>
      <span className="flex items-center gap-1 ml-2">
        {entry.categories.slice(0, 3).map((c) => (
          <CategoryTag key={c} cat={c} />
        ))}
        {entry.categories.length > 3 && (
          <span className="text-[10px] text-cc-muted">+{entry.categories.length - 3}</span>
        )}
      </span>
    </button>
  );
}

function ResultBanner({ result }: { result: { commandId: string; title: string; agentId: string; runId: string } }) {
  return (
    <div className="mb-3 p-2 rounded bg-green-500/10 border border-green-500/20 text-green-400 text-sm">
      <div className="flex items-center gap-2 mb-1">
        <span className="font-mono">{result.title}</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-cc-muted/20 text-cc-muted">agent: {result.agentId}</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-cc-muted/20 text-cc-muted">run: {result.runId.slice(0, 8)}</span>
      </div>
      <div className="text-[11px] text-cc-muted">Command started — follow it in the Agent panel.</div>
    </div>
  );
}

export default function CommandCenterSection() {
  const { catalog, input, busy, error, lastRun, setInput, refreshCatalog, run, clearError } = useCommandStore();
  const { listening } = useAgentStore();

  useEffect(() => {
    refreshCatalog();
  }, [refreshCatalog]);

  useEffect(() => {
    if (!listening) return;
    // The command center is not the primary event consumer; AgentSection
    // handles agent:event. But we subscribe for completeness.
  }, [listening]);

  return (
    <div className="flex flex-col h-full gap-3" data-testid="command-center-section">
      <div className="flex items-center gap-2">
        <h3 className="font-medium text-cc-text">Command Center</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-cc-muted/20 text-cc-muted">
          Natural language → real agent actions
        </span>
      </div>

      {/* Free-form NL input */}
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !busy && run()}
          disabled={busy}
          placeholder="Type a command: run tests, find the login code, build a todo app…"
          className="flex-1 bg-cc-bg-alt border border-cc-border rounded px-3 py-2 text-cc-text placeholder-cc-muted focus:border-cc-accent focus:outline-none transition"
          data-testid="command-input"
        />
        <button
          type="button"
          onClick={run}
          disabled={busy || !input.trim()}
          className="px-4 py-2 bg-cc-accent text-cc-bg font-medium rounded hover:bg-cc-accent/80 disabled:opacity-50 disabled:cursor-not-allowed transition"
          data-testid="command-run"
        >
          {busy ? "Running…" : "Run"}
        </button>
      </div>

      {error && (
        <div className="p-2 rounded bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-center gap-2">
          {error}
          <button onClick={clearError} className="ml-auto text-[10px] underline hover:text-red-300">
            Dismiss
          </button>
        </div>
      )}

      {lastRun && <ResultBanner result={lastRun} />}

      {/* Catalog as chips */}
      <div className="flex flex-wrap gap-2" data-testid="command-catalog">
        {catalog.map((entry) => (
          <CatalogChip
            key={entry.id}
            entry={entry}
            onRun={() => {
              const cc = window.closeCode;
              const w = window as unknown as Record<string, unknown>;
              const wsStore = w.__workspaceStore as typeof import("../../stores/workspaceStore").useWorkspaceStore | undefined;
              const workspace = wsStore?.getState().root ?? null;
              cc?.commandRun({ request: entry.examples[0] ?? entry.title, workspace });
            }}
            disabled={busy}
          />
        ))}
      </div>
    </div>
  );
}