// Close Code — Context panel (Phase 26)
//
// The inspection surface for the context engine. Everything it shows comes from a
// `ContextSummary` the main process produced: exact character counts, which files
// ranked and why, and a stated reason for every part that did not make it.
//
// Two rules shaped this component:
//
//   1. **The count is the product.** A number is shown *before* anything is sent,
//      and it is the same number that went into the system prompt. A panel that
//      rounded, estimated, or showed the count only after the run would be
//      decoration.
//   2. **Nothing is shown that was not sent.** The renderer never receives a
//      bundle's full text — only 600-character previews — so this component cannot
//      accidentally promise a "see everything" view that does not exist. The
//      preview is what the model saw, bounded; the count is what it cost.
//
// Every control maps to a real engine call. There is no decorative button.

import { useMemo, useState } from "react";
import type { ContextSummary, ContextSummaryPart, EditorSnapshot } from "../../types/electron";

export interface ContextPanelProps {
  enabled: boolean;
  building: boolean;
  summary: ContextSummary | null;
  hasTask: boolean;
  onToggle: (on: boolean) => void;
  onBuild: (force: boolean) => void;
  onCancel: () => void;
}

function fmtChars(n: number): string {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(1)}k`;
}

const STATUS_LABEL: Record<ContextSummary["status"], string> = {
  built: "ready",
  cancelled: "cancelled",
  empty: "nothing to send",
};

function partTone(part: ContextSummaryPart): string {
  if (!part.included) return "text-cc-muted";
  return part.truncated ? "text-amber-400" : "text-cc-text";
}

function fileTone(included: boolean): string {
  return included ? "text-green-500" : "text-cc-muted";
}

export default function ContextPanel({
  enabled,
  building,
  summary,
  hasTask,
  onToggle,
  onBuild,
  onCancel,
}: ContextPanelProps): React.JSX.Element {
  const [open, setOpen] = useState(false);

  const ranked = useMemo(() => {
    const part = summary?.parts.find((p) => p.kind === "relevantCode");
    return part?.files ?? [];
  }, [summary]);

  const includedFiles = ranked.filter((f) => f.included);
  const excludedFiles = ranked.filter((f) => !f.included);

  return (
    <div className="mt-1.5 border-t border-cc-border pt-1.5" data-context-panel>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="text-[11px] text-cc-muted hover:text-cc-text flex items-center gap-1"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          data-context-toggle
          title={open ? "Hide the context breakdown" : "Show exactly what will be sent"}
        >
          <span className="text-[9px]">{open ? "▾" : "▸"}</span>
          <span className="uppercase tracking-wide">Context</span>
        </button>

        <label className="flex items-center gap-1 text-[10px] text-cc-muted" title="Send project context with the task">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onToggle(e.target.checked)}
            data-context-enabled
          />
          <span>on</span>
        </label>

        {enabled && (
          <span className="ml-auto flex items-center gap-1.5" data-context-total>
            {building ? (
              <span className="text-[11px] text-cc-accent" data-context-building>
                assembling…
              </span>
            ) : summary ? (
              <span className="text-[11px] text-cc-muted" data-context-chars={summary.totalChars}>
                {STATUS_LABEL[summary.status]} · exactly {fmtChars(summary.totalChars)} chars of{" "}
                {fmtChars(summary.budgetChars)} budget
              </span>
            ) : (
              <span className="text-[11px] text-cc-muted" data-context-chars="0">
                not assembled yet
              </span>
            )}
            <button
              type="button"
              className="text-[11px] px-1.5 py-0.5 rounded border border-cc-border text-cc-muted hover:bg-cc-surface disabled:opacity-40"
              disabled={building}
              onClick={() => onBuild(true)}
              title="Re-assemble from scratch, ignoring the cache"
              data-context-rebuild
            >
              Rebuild
            </button>
            <button
              type="button"
              className="text-[11px] px-1.5 py-0.5 rounded border border-cc-border text-cc-muted hover:bg-cc-surface disabled:opacity-40"
              disabled={!building}
              onClick={onCancel}
              title="Stop the assembly in progress"
              data-context-cancel
            >
              Cancel
            </button>
          </span>
        )}
      </div>

      {enabled && !hasTask && (
        <div className="mt-1 text-[10px] text-cc-muted leading-snug" data-context-hint>
          Type a task first — what counts as "relevant" is ranked against the words you use.
        </div>
      )}

      {enabled && open && summary && (
        <div className="mt-1 max-h-56 overflow-y-auto text-[10px] leading-snug" data-context-detail>
          <div className="text-cc-muted" data-context-scan>
            Examined {summary.filesScanned} entr{summary.filesScanned === 1 ? "y" : "ies"};{" "}
            {summary.filesRanked} file{summary.filesRanked === 1 ? "" : "s"} matched the task; assembled in{" "}
            {summary.ms}ms.
          </div>

          {summary.parts.map((part) => (
            <div key={part.kind} className="mt-1" data-context-part={part.kind}>
              <div className="flex items-baseline gap-1.5">
                <span className={partTone(part)}>{part.included ? "✓" : "·"}</span>
                <span className={`${partTone(part)} flex-1 min-w-0 break-words`} data-context-part-label={part.kind}>
                  {part.label}
                </span>
                <span className="text-cc-muted tabular-nums shrink-0" data-context-part-chars={part.kind}>
                  {part.included ? `${fmtChars(part.chars)} ch` : "not sent"}
                </span>
              </div>
              {part.reason && (
                <div className="text-cc-muted pl-3.5" data-context-part-reason={part.kind}>
                  {part.reason}
                </div>
              )}
              {part.preview && (
                <pre className="pl-3.5 mt-0.5 whitespace-pre-wrap break-words text-cc-muted max-h-20 overflow-y-auto">
                  {part.preview}
                  {part.truncated ? "\n…" : ""}
                </pre>
              )}
            </div>
          ))}

          {includedFiles.length > 0 && (
            <div className="mt-1.5" data-context-files-included>
              <div className="text-cc-muted">Sent as ranked excerpts:</div>
              {includedFiles.map((f) => (
                <div key={f.path} className="pl-3.5 break-all">
                  <span className={fileTone(f.included)}>{f.path}</span>{" "}
                  <span className="text-cc-muted">· relevance {f.score} · {fmtChars(f.chars)} ch</span>
                </div>
              ))}
            </div>
          )}

          {excludedFiles.length > 0 && (
            <div className="mt-1.5" data-context-files-excluded>
              <div className="text-cc-muted">Matched the task but left out:</div>
              {excludedFiles.slice(0, 8).map((f) => (
                <div key={f.path} className="pl-3.5 break-all">
                  <span className={fileTone(f.included)}>{f.path}</span>{" "}
                  <span className="text-cc-muted">· {f.reason ?? "not sent"}</span>
                </div>
              ))}
              {excludedFiles.length > 8 && (
                <div className="pl-3.5 text-cc-muted">… and {excludedFiles.length - 8} more</div>
              )}
            </div>
          )}

          {summary.dropped.length > 0 && (
            <div className="mt-1.5" data-context-dropped>
              <div className="text-cc-muted">Not sent:</div>
              {summary.dropped.map((line) => (
                <div key={line} className="pl-3.5 text-cc-muted break-words">
                  {line}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Re-exported so a test or a future panel can build a snapshot without the store. */
export type { EditorSnapshot };
