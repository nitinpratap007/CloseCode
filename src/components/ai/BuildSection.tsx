// Close Code — Autonomous Builder panel section (Phase 33)
//
// Mirrors ResearchSection exactly: every row is a projection of the main-process
// build store, every button maps onto one IPC call. Rows that were refused,
// failed or cancelled say exactly what happened. The verification list surfaces
// the *real* commands the system re-ran, with real exit codes and output.

import { useEffect } from "react";
import { useBuildStore, type BuildRecordView, type BuildPhaseView, type BuildVerificationEntryView, phaseStatusStyle, verificationStatusStyle, STATUS_TEXT } from "../../stores/buildStore";

function PhaseLine({ phase }: { phase: BuildPhaseView }) {
  const statusLabel = phase.status === "running" ? "…" : phase.status === "done" ? "✓" : phase.status === "failed" ? "✗" : phase.status === "skipped" ? "⊘" : "■";
  return (
    <div
      data-build-phase={`${phase.kind}:${phase.status}`}
      className={`flex items-center gap-1 text-sm ${phaseStatusStyle(phase.status as BuildPhaseView["status"])}`}
      style={{ borderLeft: `2px solid ${phase.status === "running" ? "#22d3ee" : phase.status === "done" ? "#22c55e" : phase.status === "failed" ? "#ef4444" : "#6b7280" }`, paddingLeft: 8 }}
    >
      <span className="font-mono text-[10px] opacity-60">{phase.kind}</span>
      <span>{statusLabel}</span>
      <span className="text-cc-muted">{phase.label}</span>
      {phase.runId && <span className="text-[10px] text-cc-muted font-mono">({phase.runId.slice(0, 8)})</span>}
      {phase.detail && <span className="truncate max-w-[300px] ml-2">{phase.detail}</span>}
    </div>
  );
}

function VerificationLine({ entry }: { entry: BuildVerificationEntryView }) {
  const icon = entry.skipped ? "⊘" : entry.ok ? "✓" : "✗";
  return (
    <div
      data-build-verify={`${entry.command}:${entry.ok ? "ok" : entry.skipped ? "skipped" : "fail"}`}
      className={`flex items-center gap-2 text-sm ${verificationStatusStyle(entry)}`}
    >
      <span>{icon}</span>
      <span className="font-mono text-[10px] opacity-60">{entry.command}</span>
      <span className="text-[10px] px-1 py-0.5 rounded bg-cc-muted/20">
        {entry.skipped ? "skipped" : entry.exitCode === null ? "no exit" : `exit ${entry.exitCode}`}
      </span>
      {entry.output && <span className="truncate max-w-[350px] ml-2 font-mono text-[10px] opacity-70">{entry.output}</span>}
      {entry.skipped && <span className="text-[10px] italic opacity-60 ml-2">({entry.output})</span>}
    </div>
  );
}

function ChangedFilesLine({ files }: { files: string[] }) {
  if (!files.length) return null;
  return (
    <div className="mt-2 p-2 rounded bg-cc-muted/10 border border-cc-border text-sm">
      <div className="flex items-center gap-1 text-cc-muted mb-1">
        <span className="font-mono text-[10px]">git diff</span>
        <span>{files.length} file{files.length === 1 ? "" : "s"} changed</span>
      </div>
      <div className="flex flex-wrap gap-1">
        {files.slice(0, 12).map((f) => (
          <span key={f} className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-cc-bg-alt border border-cc-border">
            {f}
          </span>
        ))}
        {files.length > 12 && <span className="text-[10px] text-cc-muted">+{files.length - 12} more</span>}
      </div>
    </div>
  );
}

function RecordCard({ record }: { record: BuildRecordView }) {
  const isActive = ["planning", "awaiting_input", "building", "verifying"].includes(record.status);
  const statusStyle = record.status === "completed" ? "text-green-500" :
    record.status === "failed" ? "text-red-400" :
    record.status === "refused" ? "text-amber-400" :
    record.status === "cancelled" ? "text-cc-muted" : "text-cc-accent";

  return (
    <div
      data-build-record={record.id}
      data-build-status={record.status}
      className={`p-3 rounded border ${isActive ? "border-cc-accent/30 bg-cc-accent/5" : "border-cc-border"}`}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium text-cc-text truncate">{record.request}</span>
            <span className={`font-mono text-[10px] px-1.5 py-0.5 rounded ${statusStyle}`}>{STATUS_TEXT[record.status]}</span>
            {record.plannerRunId && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-cc-muted/20 text-cc-muted font-mono">
                plan: {record.plannerRunId.slice(0, 8)}
              </span>
            )}
            {record.builderRunId && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-400 font-mono">
                build: {record.builderRunId.slice(0, 8)}
              </span>
            )}
          </div>
          {record.note && (
            <div className="mt-1 text-[11px] text-amber-400 italic truncate">
              User note: {record.note}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1">
          {record.status === "awaiting_input" && (
            <>
              <button
                onClick={() => window.closeCode.buildRespond(record.id, true, record.note)}
                className="px-2 py-1 text-[11px] bg-green-500/20 text-green-400 rounded hover:bg-green-500/30"
              >
                Approve
              </button>
              <button
                onClick={() => window.closeCode.buildRespond(record.id, false, record.note)}
                className="px-2 py-1 text-[11px] bg-red-500/20 text-red-400 rounded hover:bg-red-500/30"
              >
                Deny
              </button>
            </>
          )}
          {(isActive || record.status === "awaiting_input") && (
            <button
              onClick={() => window.closeCode.buildCancel(record.id)}
              className="px-2 py-1 text-[11px] bg-cc-muted/20 text-cc-muted rounded hover:bg-cc-muted/30"
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {/* Plan text - collapsible */}
      {record.plan && (
        <details className="mb-2 group">
          <summary className="text-sm text-cc-accent cursor-pointer select-none flex items-center gap-1">
            <span className="text-[10px] transition-transform group-open:rotate-90">▶</span>
            Plan
          </summary>
          <pre className="mt-1 p-2 rounded bg-cc-bg-alt border border-cc-border text-[11px] text-cc-muted overflow-auto max-h-48 whitespace-pre-wrap">
            {record.plan}
          </pre>
        </details>
      )}

      {/* Phases */}
      <div className="space-y-1 mb-2" data-build-phases={record.id}>
        {record.phases.map((phase: BuildPhaseView, i: number) => (
          <PhaseLine key={`${record.id}-${i}`} phase={phase} />
        ))}
      </div>

      {/* Verification - the honest measurement */}
      {record.verification.length > 0 && (
        <div className="space-y-1 mb-2">
          <div className="text-sm text-cc-accent mb-1 font-medium">Verification (system measured)</div>
          {record.verification.map((v: BuildVerificationEntryView, i: number) => (
            <VerificationLine key={`${record.id}-v-${i}`} entry={v} />
          ))}
        </div>
      )}

      {/* Changed files from git */}
      <ChangedFilesLine files={record.changedFiles} />

      {/* Summary / run text */}
      {record.summary && (
        <div className="mt-2 p-2 rounded bg-cc-muted/10 border border-cc-border text-sm text-cc-text">
          {record.summary}
        </div>
      )}

      {record.runText && record.runText !== record.summary && (
        <details className="mt-2">
          <summary className="text-sm text-cc-muted cursor-pointer select-none flex items-center gap-1">
            <span className="text-[10px] transition-transform group-open:rotate-90">▶</span>
            Builder run output
          </summary>
          <pre className="mt-1 p-2 rounded bg-cc-bg-alt border border-cc-border text-[11px] text-cc-muted overflow-auto max-h-48 whitespace-pre-wrap">
            {record.runText}
          </pre>
        </details>
      )}

      {record.error && (
        <div className="mt-2 p-2 rounded bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          <div className="font-medium">{record.error.code}</div>
          <div className="text-[11px] opacity-80">{record.error.message}</div>
        </div>
      )}
    </div>
  );
}

export default function BuildSection() {
  const { records, busy, request, note, error, setRequest, setNote, refresh, start, clearError } = useBuildStore();

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="flex flex-col h-full gap-3" data-testid="build-section">
      <div className="flex items-center gap-2">
        <h3 className="font-medium text-cc-text">Autonomous Builder</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-cc-muted/20 text-cc-muted">
          Inspect → Plan → Approve → Build → Measure
        </span>
      </div>

      <div className="flex flex-col gap-2">
        <textarea
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          placeholder="Build me a full MERN application, add an API endpoint, refactor the store…"
          rows={3}
          className="bg-cc-bg-alt border border-cc-border rounded px-3 py-2 text-cc-text placeholder-cc-muted focus:border-cc-accent focus:outline-none transition resize-none"
          data-testid="build-request"
        />
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional note for the plan (requirements, constraints, preferences…) — added when you approve"
          className="bg-cc-bg-alt border border-cc-border rounded px-3 py-2 text-cc-text placeholder-cc-muted focus:border-cc-accent focus:outline-none transition"
          data-testid="build-note"
        />
        <button
          type="button"
          onClick={start}
          disabled={busy || !request.trim()}
          className="px-4 py-2 bg-cc-accent text-cc-bg font-medium rounded hover:bg-cc-accent/80 disabled:opacity-50 disabled:cursor-not-allowed transition"
          data-testid="build-start"
        >
          {busy ? "Starting…" : "Start Build"}
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

      <div className="flex-1 overflow-y-auto space-y-2" data-testid="build-records">
        {records.length === 0 ? (
          <div className="text-cc-muted text-sm text-center py-8">No builds yet. Describe what you want built and press Start.</div>
        ) : (
          records.map((record) => <RecordCard key={record.id} record={record} />)
        )}
      </div>
    </div>
  );
}