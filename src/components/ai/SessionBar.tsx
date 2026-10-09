// Close Code — Session bar (Phase 27)
//
// The visible half of persistent AI sessions. It answers one question at a glance
// — *which conversation am I in, and is it safe* — and exposes the seven
// operations as real controls: new, open, rename, close/reopen, fork, delete.
//
// Two decisions worth stating, because both are refusals:
//
//   * **Delete is confirmed, not immediate.** It is the only control here that
//     destroys data. A confirmation that says what will be lost (how many turns and
//     runs) is the minimum; a second dialog style would be worse, not better.
//   * **Nothing here shows a session the store could not read.** A corrupt session
//     is reported as corrupt, with the path its bytes were moved to, because
//     "your conversation could not be loaded" and "you have no sessions" are
//     different facts and only one of them is true.
//
// The bar reads its state from `SessionStoreState` and calls the store; it holds no
// conversation of its own. There is deliberately no local copy of the turns here —
// a second copy in a component is how two views of a conversation start disagreeing.

import { useState } from "react";
import type { SessionStoreState } from "../../stores/sessionStore";
import type { AiSessionSummary } from "../../types/electron";

export interface SessionBarProps {
  state: SessionStoreState;
}

function fmtAgo(at: number): string {
  const ms = Date.now() - at;
  if (ms < 60_000) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(at).toLocaleDateString();
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * What a session row says on its own line.
 *
 * Built here rather than inline so the list and the header cannot describe the
 * same session two different ways — a session with three runs shown as "3 runs" in
 * the list and "2 runs" in the header is the kind of small lie that makes a user
 * stop believing the rest of the panel.
 */
function describe(s: AiSessionSummary): string {
  const bits: string[] = [];
  if (s.turnCount > 0) bits.push(`${s.turnCount} turn${s.turnCount === 1 ? "" : "s"}`);
  if (s.runCount > 0) bits.push(`${s.runCount} run${s.runCount === 1 ? "" : "s"}`);
  if (s.toolCallCount > 0) bits.push(`${s.toolCallCount} tool call${s.toolCallCount === 1 ? "" : "s"}`);
  if (bits.length === 0) bits.push("empty");
  return bits.join(", ");
}

export default function SessionBar({ state }: SessionBarProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  const active = state.current;
  // The open session's own copy lags every write — the main process owns the file,
  // and `current` is only re-read on open or on a filed run. The list summary is
  // pushed after every change, so anything about the open session that must not be
  // stale (its counts, its redactions, whether it was trimmed) is read from there.
  const activeSummary = state.sessions.find((s) => s.id === state.activeId) ?? null;

  const commitRename = (id: string): void => {
    const name = renameText.trim();
    setRenaming(null);
    if (!name) return;
    void state.rename(id, name);
  };

  return (
    <div className="mt-1.5 border-t border-cc-border pt-1.5" data-session-bar>
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] font-semibold text-cc-muted uppercase tracking-wide">Session</span>
        <span
          className="text-[11px] text-cc-text truncate min-w-0"
          data-session-name={active ? active.name : "none"}
          title={active ? active.name : "No session is open"}
        >
          {active ? active.name : "No session open"}
        </span>
        {active && (
          <span className="text-[10px] text-cc-muted shrink-0" data-session-meta>
            {activeSummary ? `${activeSummary.turnCount} turn(s) · ${activeSummary.runCount} run(s)` : `${active.turns.length} turn(s) · ${active.runs.length} run(s)`}
          </span>
        )}
        {/* Redaction and trimming are surfaced without expanding the list. A user
            who pasted a key deserves to know it was stripped without having to go
            looking for the row, and a session that quietly dropped its older turns
            is not something to hide behind a disclosure triangle. */}
        {activeSummary && activeSummary.redactions > 0 && (
          <span className="text-[10px] text-amber-400 shrink-0" data-session-redactions={state.activeId} title="Secret-shaped text was replaced before it was stored">
            {activeSummary.redactions} redacted
          </span>
        )}
        {activeSummary?.truncated && (
          <span className="text-[10px] text-amber-400 shrink-0" title="Some history was dropped to stay within the storage bounds">
            trimmed
          </span>
        )}
        {state.busy && (
          <span className="text-[10px] text-cc-accent shrink-0" data-session-busy>
            working…
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            className="text-[11px] px-2 py-0.5 rounded bg-cc-accent text-white hover:bg-cc-accent/90 disabled:opacity-40"
            onClick={() => void state.create()}
            disabled={state.busy}
            title="Start a new session"
            data-session-new
          >
            New
          </button>
          <button
            type="button"
            className="text-[11px] text-cc-muted hover:text-cc-text"
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? "Hide the session list" : "Show every session"}
            data-session-list-toggle
          >
            {expanded ? "hide" : `${state.sessions.length} saved`}
          </button>
        </div>
      </div>

      {/* A session whose file could not be read. Reported as exactly that — never
          as an empty list, which would read as "you have nothing" and be a lie. */}
      {state.corrupted && (
        <div className="mt-1 text-[10px] leading-snug" data-session-corrupt>
          <div className="text-amber-400">
            A session could not be read: {state.corrupted.corruptReason ?? "unknown reason"}.
          </div>
          <div className="text-cc-muted">
            Its file was moved, not deleted, to <span className="break-all">{state.corrupted.corruptFile ?? "an unknown path"}</span> — you can
            try opening it by hand.
          </div>
          <button
            type="button"
            className="mt-0.5 text-[10px] text-cc-muted hover:text-cc-text underline"
            onClick={() => state.dismissCorrupted()}
            data-session-corrupt-dismiss
          >
            Dismiss
          </button>
        </div>
      )}

      {expanded && (
        <div className="mt-1 max-h-44 overflow-y-auto text-[10px]" data-session-list>
          {state.sessions.length === 0 && (
            <div className="text-cc-muted" data-session-list-empty>
              No sessions saved yet.
            </div>
          )}
          {state.sessions.map((s) => {
            const isActive = s.id === state.activeId;
            const isRenaming = renaming === s.id;
            const isDeleting = confirmingDelete === s.id;
            return (
              <div
                key={s.id}
                className={`py-1 border-b border-cc-border/40 last:border-b-0 ${isActive ? "text-cc-text" : "text-cc-muted"}`}
                data-session-row={s.id}
                data-session-row-active={isActive ? "true" : "false"}
                data-session-row-status={s.status}
              >
                <div className="flex items-center gap-1">
                  {isRenaming ? (
                    <>
                      <input
                        className="flex-1 min-w-0 bg-cc-surface border border-cc-border rounded px-1 py-0.5 text-[10px] text-cc-text outline-none"
                        value={renameText}
                        autoFocus
                        data-session-rename-input
                        onChange={(e) => setRenameText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename(s.id);
                          if (e.key === "Escape") setRenaming(null);
                        }}
                      />
                      <button
                        type="button"
                        className="text-[10px] text-cc-accent"
                        onClick={() => commitRename(s.id)}
                        data-session-rename-save
                      >
                        save
                      </button>
                      <button
                        type="button"
                        className="text-[10px] text-cc-muted"
                        onClick={() => setRenaming(null)}
                        data-session-rename-cancel
                      >
                        cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className={`flex-1 min-w-0 text-left truncate ${isActive ? "text-cc-accent" : "hover:text-cc-text"}`}
                        onClick={() => void state.open(s.id)}
                        disabled={isActive}
                        title={`${s.name} — ${describe(s)}, ${fmtBytes(s.bytes)}, ${fmtAgo(s.updatedAt)}`}
                        data-session-open={s.id}
                      >
                        {s.name}
                        {s.status === "closed" ? " (closed)" : ""}
                        {s.forkedFrom ? " ⑂" : ""}
                      </button>
                      <button
                        type="button"
                        className="text-[10px] text-cc-muted hover:text-cc-text"
                        onClick={() => {
                          setRenaming(s.id);
                          setRenameText(s.name);
                        }}
                        title="Rename this session"
                        data-session-rename={s.id}
                      >
                        rename
                      </button>
                      <button
                        type="button"
                        className="text-[10px] text-cc-muted hover:text-cc-text"
                        onClick={() => void state.fork(s.id)}
                        title="Copy this session, including its conversation"
                        data-session-fork={s.id}
                      >
                        fork
                      </button>
                      <button
                        type="button"
                        className="text-[10px] text-cc-muted hover:text-cc-text"
                        onClick={() => void state.setStatus(s.id, s.status === "open" ? "closed" : "open")}
                        title={s.status === "open" ? "Close it — kept, not deleted" : "Reopen it"}
                        data-session-toggle-status={s.id}
                      >
                        {s.status === "open" ? "close" : "reopen"}
                      </button>
                      <button
                        type="button"
                        className="text-[10px] text-red-400 hover:text-red-300"
                        onClick={() => setConfirmingDelete(s.id)}
                        title="Delete this session permanently"
                        data-session-delete={s.id}
                      >
                        delete
                      </button>
                    </>
                  )}
                </div>

                <div className="text-cc-muted/80 flex flex-wrap items-center gap-x-2">
                  <span data-session-row-detail={s.id}>{describe(s)}</span>
                  <span>·</span>
                  <span>{fmtBytes(s.bytes)}</span>
                  <span>·</span>
                  <span>{fmtAgo(s.updatedAt)}</span>
                  {s.redactions > 0 && (
                    <>
                      <span>·</span>
                      <span className="text-amber-400" data-session-redactions={s.id}>
                        {s.redactions} redacted
                      </span>
                    </>
                  )}
                  {s.truncated && (
                    <>
                      <span>·</span>
                      <span className="text-amber-400" data-session-truncated={s.id}>
                        older history dropped
                      </span>
                    </>
                  )}
                  {s.corrupted && (
                    <>
                      <span>·</span>
                      <span className="text-red-400" data-session-row-corrupt={s.id}>
                        unreadable
                      </span>
                    </>
                  )}
                </div>

                {isDeleting && (
                  <div className="mt-0.5 text-[10px] leading-snug" data-session-delete-confirm={s.id}>
                    <div className="text-red-400">
                      Delete “{s.name}”? {s.turnCount} turn(s) and {s.runCount} run(s) are erased from disk. This cannot be undone.
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <button
                        type="button"
                        className="text-[10px] text-red-400 hover:text-red-300 underline"
                        onClick={() => {
                          setConfirmingDelete(null);
                          void state.remove(s.id);
                        }}
                        data-session-delete-confirm-yes={s.id}
                      >
                        delete permanently
                      </button>
                      <button
                        type="button"
                        className="text-[10px] text-cc-muted hover:text-cc-text"
                        onClick={() => setConfirmingDelete(null)}
                        data-session-delete-confirm-no={s.id}
                      >
                        keep it
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {state.error && (
        <div className="mt-1 text-[10px] text-red-400 leading-snug" data-session-error>
          {state.error}
          <button
            type="button"
            className="ml-1 underline"
            onClick={() => state.clearError()}
            data-session-error-dismiss
          >
            dismiss
          </button>
        </div>
      )}
      {!state.error && state.notice && (
        <div className="mt-1 text-[10px] text-cc-muted leading-snug" data-session-notice>
          {state.notice}
        </div>
      )}
    </div>
  );
}