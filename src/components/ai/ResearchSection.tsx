// Close Code — web research panel section (Phase 32)
//
// The user's half of the research facility: ask a question, optionally name
// documentation URLs to look at directly, and watch the pipeline run — planned
// queries, searches, fetches, then the cited summary — as a live record. Every
// row is a projection of the main-process research store; every button maps
// onto one IPC call. Rows that were refused, failed or ran offline say exactly
// what happened and keep the sources they did gather, so "the web was
// unreachable" reads as a typed note, never as a blank.
//
// The permission story is shown, not decided, here: the `web` category mode in
// AI settings is the gate, decided in main. `deny` rows come back refused;
// `ask` rows carry Approve/Deny buttons; `allow` rows just run.

import { useEffect, useState } from "react";
import { useWebResearchStore } from "../../stores/webResearchStore";
import { useAiStore } from "../../stores/aiStore";
import type { ResearchRecordView, ResearchSourceView, ResearchStepView } from "../../types/electron";

const STATUS_TEXT: Record<ResearchRecordView["status"], string> = {
  queued: "Queued",
  running: "Running…",
  done: "Done",
  failed: "Failed",
  refused: "Refused",
};

const STATUS_STYLE: Record<ResearchRecordView["status"], string> = {
  queued: "text-cc-muted",
  running: "text-cc-accent",
  done: "text-green-500",
  failed: "text-red-400",
  refused: "text-cc-muted line-through",
};

function StepLine({ recordId, step }: { recordId: string; step: ResearchStepView }): React.JSX.Element {
  return (
    <div
      data-research-step={`${recordId}:${step.kind}`}
      className={step.ok ? "text-green-500" : "text-red-400"}
    >
      {step.ok ? "✓" : "✗"} {step.detail}
      {step.error ? ` (${step.error.code})` : ""}
    </div>
  );
}

function SourceLine({ recordId, index, source }: { recordId: string; index: number; source: ResearchSourceView }): React.JSX.Element {
  return (
    <div data-research-source={`${recordId}:${index}`} className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 min-w-0">
      <a data-research-url={source.url} href={source.url} target="_blank" rel="noreferrer" className="text-cc-accent truncate max-w-[40ch]">
        {source.title}
      </a>
      <span className="text-cc-muted truncate max-w-[60ch]">— {source.url}</span>
      <span
        data-research-source-status={`${recordId}:${index}:${source.status}`}
        className={source.status === "ok" ? "text-green-500" : source.status === "failed" ? "text-red-400" : "text-cc-muted"}
      >
        · {source.status}
      </span>
      {source.error ? <span className="text-red-400"> ({source.error.message})</span> : null}
    </div>
  );
}

function RecordRow({ record }: { record: ResearchRecordView }): React.JSX.Element {
  const respond = useWebResearchStore((s) => s.respond);
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col rounded border border-cc-border/60 bg-cc-surface/40 px-2 py-1.5" data-research-record={record.id}>
      <button type="button" onClick={() => setOpen(!open)} className="w-full text-left" data-research-toggle={record.id}>
        <span className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-cc-text truncate">{record.question}</span>
          <span data-research-status={`${record.id}:${record.status}`} className={`ml-auto shrink-0 text-[11px] ${STATUS_STYLE[record.status]}`}>
            {STATUS_TEXT[record.status]}
          </span>
        </span>
      </button>

      {record.awaitingApproval && !record.error ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]" data-research-approval={record.id}>
          <span className="text-cc-muted">Web access is set to “ask”. Approve to research, or deny.</span>
          <button
            type="button"
            onClick={() => void respond(record.id, true)}
            className="rounded border border-green-600/50 px-2 py-0.5 text-green-500 hover:bg-green-600/10"
            data-research-approve={record.id}
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() => void respond(record.id, false)}
            className="rounded border border-red-600/50 px-2 py-0.5 text-red-400 hover:bg-red-600/10"
            data-research-deny={record.id}
          >
            Deny
          </button>
        </div>
      ) : null}

      {open ? (
        <div className="mt-1.5 flex flex-col gap-1.5 text-[11px] text-cc-muted">
          {record.error && record.status === "failed" ? (
            <p data-research-note={record.id} className="text-red-400">
              {record.error.message}
            </p>
          ) : null}
          {record.error && record.status === "refused" ? <p className="text-red-400">{record.error.message}</p> : null}
          <p className="text-cc-muted">
            Permission mode at run time: <span data-research-permission-record={record.id}>{record.permission}</span>
          </p>
          {record.steps.length > 0 ? (
            <div className="flex flex-col gap-0.5">
              <span className="text-cc-muted font-medium">Steps</span>
              {record.steps.map((s, i) => (
                <StepLine key={i} recordId={record.id} step={s} />
              ))}
            </div>
          ) : null}
          {record.sources.length > 0 ? (
            <div className="flex flex-col gap-0.5">
              <span className="text-cc-muted font-medium">Sources</span>
              {record.sources.map((src, i) => (
                <SourceLine key={i} recordId={record.id} index={i} source={src} />
              ))}
            </div>
          ) : null}
          {record.answer ? (
            <div className="flex flex-col gap-0.5">
              <span className="text-cc-muted font-medium">Answer</span>
              <pre data-research-answer={record.id} className="whitespace-pre-wrap text-cc-text border border-cc-border/60 rounded bg-cc-surface/60 px-2 py-1.5">
                {record.answer}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default function ResearchSection(): React.JSX.Element {
  const store = useWebResearchStore();
  const permission = useAiStore((s) => s.config?.permissions?.web);

  useEffect(() => {
    void store.refresh();
    const off = window.closeCode.onResearchEvent(() => {
      void store.refresh();
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="flex flex-col gap-2" data-research>
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-cc-muted">Web Research</h3>
        <span data-research-permission={permission ?? "ask"} className="text-[10px] text-cc-muted">
          web permission: {permission ?? "ask"}
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <input
          type="text"
          value={store.question}
          onChange={(e) => store.setQuestion(e.target.value)}
          placeholder="Research question, e.g. “What are the current extension APIs?”"
          className="w-full rounded border border-cc-border/60 bg-cc-surface px-2 py-1.5 text-sm text-cc-text"
          data-research-input
        />
        <input
          type="text"
          value={store.focusUrls}
          onChange={(e) => store.setFocusUrls(e.target.value)}
          placeholder="Optional documentation URLs to look at directly (comma separated)"
          className="w-full rounded border border-cc-border/60 bg-cc-surface px-2 py-1.5 text-sm text-cc-text"
          data-research-urls
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void store.start()}
            disabled={store.busy}
            className="rounded border border-cc-border/60 px-3 py-1 text-sm text-cc-text hover:bg-cc-surface disabled:opacity-50"
            data-research-start
          >
            {store.busy ? "Researching…" : "Research"}
          </button>
          {store.error ? <span className="text-[11px] text-red-400" data-research-error>{store.error}</span> : null}
        </div>
      </div>

      {permission === "deny" ? (
        <p className="text-[11px] text-cc-muted">
          Web access is <span className="text-red-400">denied</span> in AI settings — research runs will be refused.
        </p>
      ) : null}

      <div className="flex flex-col gap-1.5" data-research-records>
        {store.records.length === 0 ? (
          <p className="text-[11px] text-cc-muted" data-research-empty>
            No research yet. Ask a question above and the pipeline plans queries, searches, fetches sources and summarizes a
            cited answer.
          </p>
        ) : (
          store.records.map((r) => <RecordRow key={r.id} record={r} />)
        )}
      </div>
    </section>
  );
}