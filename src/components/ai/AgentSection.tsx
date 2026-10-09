// Close Code — Agent runtime panel section (Phase 21)
// Renders the real runtime state: the registered agents, a task box, start and
// stop controls, live run state (steps / tool calls / duration), the run's own
// status trace, and any typed error. Every control here maps to a real runtime
// call — there is nothing decorative in this component.

import { useMemo } from "react";
import { selectFocusedRun, type AgentStoreState } from "../../stores/agentStore";
import { DEFAULT_AGENT } from "../../stores/agentIds";
import ContextPanel from "./ContextPanel";
import SessionBar from "./SessionBar";
import { useSessionStore } from "../../stores/sessionStore";
import type { AgentRun, AgentStatus } from "../../types/electron";

const STATUS_STYLE: Record<AgentStatus, string> = {
  idle: "text-cc-muted",
  starting: "text-cc-accent",
  running: "text-cc-accent",
  awaiting_approval: "text-amber-400",
  cancelling: "text-amber-400",
  cancelled: "text-cc-muted",
  completed: "text-green-500",
  failed: "text-red-400",
};

const STATUS_TEXT: Record<AgentStatus, string> = {
  idle: "idle",
  starting: "starting",
  running: "running",
  awaiting_approval: "waiting for approval",
  cancelling: "stopping",
  cancelled: "cancelled",
  completed: "completed",
  failed: "failed",
};

function isActive(status: AgentStatus): boolean {
  return status === "starting" || status === "running" || status === "awaiting_approval" || status === "cancelling";
}

function duration(run: AgentRun): string {
  const ms = run.result?.durationMs ?? Math.max(0, run.updatedAt - run.createdAt);
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Phase 26. Same formatting the context panel uses, so two numbers never disagree. */
function fmtContextChars(n: number): string {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(1)}k`;
}

export default function AgentSection({ state }: { state: AgentStoreState }): React.JSX.Element {
  const run = useMemo(() => selectFocusedRun(state), [state]);
  const active = run ? isActive(run.status) : false;
  const selected = state.definitions.find((d) => d.id === state.selectedAgentId);
  const canStart = !active && state.task.trim().length > 0 && state.definitions.length > 0;
  // Phase 27. Read directly rather than threaded through the agent store: this is
  // a separate concern with its own state, and merging it into `AgentStoreState`
  // would make every agent call site responsible for the session list.
  const sessions = useSessionStore();

  return (
    <div className="px-3 py-2 border-b border-cc-border shrink-0" data-agent-section>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[11px] font-semibold text-cc-muted uppercase tracking-wide">Agent runtime</span>
        {run && (
          <span className={`text-[11px] ${STATUS_STYLE[run.status]}`} data-agent-status={run.status}>
            {STATUS_TEXT[run.status]}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {run && (
            <button
              type="button"
              className="text-[11px] text-cc-muted hover:text-cc-text"
              onClick={() => void state.clearFinished()}
              title="Remove finished runs from the list"
              data-agent-clear
            >
              clear
            </button>
          )}
          <button
            type="button"
            disabled={!active}
            onClick={() => void state.cancel()}
            className="text-[11px] px-2 py-0.5 rounded border border-cc-border text-cc-muted hover:bg-cc-surface disabled:opacity-40"
            title="Stop the running agent"
            data-agent-stop
          >
            Stop
          </button>
          <button
            type="button"
            disabled={!canStart}
            onClick={() => void state.start()}
            className="text-[11px] px-2 py-0.5 rounded bg-cc-accent text-white hover:bg-cc-accent/90 disabled:opacity-40"
            title="Start the selected agent on this task"
            data-agent-start
          >
            Start
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <select
          className="flex-1 min-w-0 bg-cc-surface border border-cc-border rounded px-2 py-1 text-xs text-cc-text outline-none"
          value={state.selectedAgentId}
          onChange={(e) => state.selectAgent(e.target.value)}
          disabled={active}
          data-agent-select
          aria-label="Agent"
        >
          {/* Phase 24. This placeholder's value used to be `default`, which is now
              an alias. It still has to match `selectedAgentId`, or the browser
              falls back to showing the first option while the select's own value
              says something else. */}
          {state.definitions.length === 0 && <option value={DEFAULT_AGENT}>Loading agents…</option>}
          {state.definitions.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
              {d.readOnly ? " (read-only)" : ""}
            </option>
          ))}
        </select>
      </div>
      {selected && <div className="mt-1 text-[10px] text-cc-muted leading-snug">{selected.description}</div>}

      <div className="flex items-end gap-1.5 mt-1.5">
        <textarea
          className="flex-1 min-w-0 bg-cc-surface border border-cc-border rounded px-2 py-1 text-xs text-cc-text outline-none resize-none min-h-[34px]"
          rows={1}
          placeholder={active ? "Agent is working…" : "Task for the agent…"}
          value={state.task}
          disabled={active}
          onChange={(e) => state.setTask(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (canStart) void state.start();
            }
          }}
          data-agent-task
        />
      </div>

      {run && (
        <div className="mt-1.5 text-[10px] text-cc-muted flex flex-wrap items-center gap-x-2 gap-y-0.5" data-agent-metrics>
          <span data-agent-metric-agent>{run.agentId}</span>
          <span>·</span>
          <span data-agent-metric-steps>{run.steps} step(s)</span>
          <span>·</span>
          <span data-agent-metric-tools>{run.toolCalls} tool call(s)</span>
          <span>·</span>
          <span data-agent-metric-duration>{duration(run)}</span>
          {run.depth > 0 && (
            <>
              <span>·</span>
              <span data-agent-metric-depth>sub-agent depth {run.depth}</span>
            </>
          )}
          {/* Phase 26. What *this* run was given, read from the run record rather
              than from the engine's current state — a later rebuild must not
              change the answer to "what did this run receive". */}
          {run.contextSummary && (
            <>
              <span>·</span>
              <span data-agent-metric-context={`${run.contextSummary.status}:${run.contextSummary.totalChars}`}>
                context {fmtContextChars(run.contextSummary.totalChars)} ch
              </span>
            </>
          )}
          {/* Phase 28. This run's payload was compressed before it was sent.
              Before → after, because the *span* is the fact that fits in a chip;
              the notice text with preserved/omitted counts lives in the trace. */}
          {run.compaction && (
            <>
              <span>·</span>
              <span
                data-agent-compaction={`${run.compaction.beforeChars}:${run.compaction.afterChars}:${run.compaction.passes}`}
              >
                compacted {fmtContextChars(run.compaction.beforeChars)} →{' '}
                {fmtContextChars(run.compaction.afterChars)} ch
                {run.compaction.passes > 1 ? ` ×${run.compaction.passes}` : ""}
              </span>
            </>
          )}
          {/* Phase 27. Which conversation this run is filed under, read from the
              run record so it stays right after the session is switched away. */}
          {run.sessionId && (
            <>
              <span>·</span>
              <span data-agent-metric-session={run.sessionId}>
                session {sessions.sessions.find((s) => s.id === run.sessionId)?.name ?? run.sessionId}
              </span>
            </>
          )}
        </div>
      )}

      <SessionBar state={sessions} />

      <ContextPanel
        enabled={state.contextEnabled}
        building={state.contextBuilding}
        summary={state.contextSummary}
        hasTask={state.task.trim().length > 0}
        onToggle={state.setContextEnabled}
        onBuild={(force) => void state.buildContext(undefined, force)}
        onCancel={() => void state.cancelContext()}
      />

      {state.error && (
        <div className="mt-1.5 text-[10px] text-red-400 leading-snug" data-agent-error>
          {state.error}
        </div>
      )}
      {!state.error && state.notice && (
        <div className="mt-1.5 text-[10px] text-cc-muted leading-snug" data-agent-notice>
          {state.notice}
        </div>
      )}

      {run && run.trace.length > 0 && (
        <div
          className="mt-1.5 max-h-28 overflow-y-auto text-[10px] leading-snug border-t border-cc-border pt-1.5"
          data-agent-trace
        >
          {run.trace.slice(-40).map((entry, i) => (
            <div
              key={`${entry.at}-${i}`}
              className={
                entry.kind === "error"
                  ? "text-red-400"
                  : entry.kind === "tool"
                    ? entry.granted === false
                      ? "text-red-400"
                      : "text-cc-text"
                    : "text-cc-muted"
              }
              data-agent-trace-entry={entry.kind}
            >
              {entry.kind === "tool" ? (
                <>
                  <span className="text-cc-muted">step {entry.step + 1} ▸ </span>
                  {entry.tool}
                  {entry.granted === false ? " (denied)" : ""}
                  {entry.text ? ` — ${entry.text}` : ""}
                </>
              ) : entry.kind === "error" ? (
                entry.text
              ) : (
                entry.text
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
