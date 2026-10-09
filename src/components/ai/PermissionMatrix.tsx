// Close Code — agent permission matrix (Phase 23)
//
// The panel that makes permission state visible and editable, per scope.
//
// Two columns, and the distinction is the reason the panel is not just a list of
// toggles:
//
//   * **In this scope** — the rule stored *here*. "—" means inherited.
//   * **Effective** — what a run in the current agent and project will actually
//     get, after every scope is resolved.
//
// Collapsing them into one would be simpler and wrong. With a global `allow` and
// a project `deny`, a single column would either hide the project's rule (leaving
// the user unable to find why their agent is blocked) or hide the global rule
// (leaving them unable to find where to change it).
//
// Every control maps to a real IPC call. There is nothing decorative here.

import { useEffect, useMemo, useState } from "react";
import { usePermissionStore, type PermissionMode } from "../../stores/permissionStore";
import { canonicalAgentId, DEFAULT_AGENT } from "../../stores/agentIds";
import type { AgentPermissionScope } from "../../types/electron";

const MODE_STYLE: Record<PermissionMode, string> = {
  allow: "text-green-500",
  ask: "text-amber-400",
  deny: "text-red-400",
};

const MODE_TITLE: Record<PermissionMode, string> = {
  allow: "Run without asking",
  ask: "Ask me each time",
  deny: "Never run",
};

const MODES: readonly PermissionMode[] = ["allow", "ask", "deny"];

/** Used by the per-row override picker below, and kept honest by the E2E suite. */
export const PERMISSION_MODES = MODES;

type ScopeChoice = "global" | "project" | "agent";

export default function PermissionMatrix({ workspace }: { workspace: string | null }): React.JSX.Element {
  const state = usePermissionStore();
  const [choice, setChoice] = useState<ScopeChoice>("global");
  // Phase 24. `default` was the only agent id, so it was hardcoded as the scope
  // to open on. It is now an alias for `build`, and the scope is keyed by agent
  // id — editing `agent:default` would write rules the runtime never reads,
  // because `agent:start` canonicalises to `agent:build` before it resolves them.
  // So the default scope is the canonical id, and a stale stored id is
  // reconciled against the real list below rather than used as typed.
  const [agentId, setAgentId] = useState(DEFAULT_AGENT);

  useEffect(() => {
    void state.load();
    // Once, on mount. The store guards against a concurrent second load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const agentOptions = useMemo(() => {
    if (state.agents.length > 0) return state.agents;
    // Only reachable before the list arrives. Naming a real agent rather than
    // `default` means the first render is already pointed at `agent:build`.
    return [{ id: DEFAULT_AGENT, name: "Build Agent" }];
  }, [state.agents]);

  // If a stored id is not in the list, snap to the canonical name of whatever
  // was stored (`default` → `build`) and then to the first real agent. Without
  // this, a user with `default` in state would open a scope named after an
  // agent the matrix does not offer and quietly edit a scope nothing reads.
  useEffect(() => {
    if (agentOptions.some((a) => a.id === agentId)) return;
    const canonical = canonicalAgentId(agentId);
    if (agentOptions.some((a) => a.id === canonical)) {
      setAgentId(canonical);
      return;
    }
    if (agentOptions[0]) setAgentId(agentOptions[0].id);
  }, [agentId, agentOptions]);

  const scope: AgentPermissionScope = useMemo(() => {
    if (choice === "project" && workspace) return { kind: "project", root: workspace };
    if (choice === "agent") return { kind: "agent", agentId };
    return { kind: "global" };
  }, [choice, workspace, agentId]);

  // A project scope is meaningless with no folder open. Falling back to global
  // rather than rendering an empty panel, and saying so, is better than showing
  // a project row the user can edit that will never apply to anything.
  const projectUnavailable = choice === "project" && !workspace;

  useEffect(() => {
    if (projectUnavailable) {
      void state.selectScope({ kind: "global" }, { agentId, workspace });
      setChoice("global");
      return;
    }
    void state.selectScope(scope, { agentId, workspace });
    // `scope` is derived from the three values above, so those are the real deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choice, agentId, workspace]);

  const scopeName =
    choice === "project" && workspace
      ? workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace
      : choice === "agent"
        ? (agentOptions.find((a) => a.id === agentId)?.name ?? agentId)
        : "All projects";

  const overridden = state.rows.filter((r) => r.own !== null && r.own !== r.effective).length;

  return (
    <div className="px-3 py-2 border-t border-cc-border shrink-0" data-permission-matrix>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[11px] font-semibold text-cc-muted uppercase tracking-wide">Agent permissions</span>
        {state.saving && <span className="text-[10px] text-cc-muted">saving…</span>}
        {state.configured && (
          <button
            type="button"
            className="ml-auto text-[11px] text-cc-muted hover:text-cc-text disabled:opacity-40"
            onClick={() => void state.clearScope()}
            disabled={state.saving !== null}
            title="Remove every rule stored in this scope"
            data-permission-clear-scope
          >
            reset this scope
          </button>
        )}
      </div>

      {/* Scope selector. The acceptance criterion is per-project and per-agent
          configuration, so the two have to be addressable, not implied. */}
      <div className="flex items-center gap-1.5 mb-1.5">
        <select
          className="bg-cc-surface border border-cc-border rounded px-1.5 py-0.5 text-[11px] text-cc-text outline-none"
          value={choice}
          onChange={(e) => setChoice(e.target.value as ScopeChoice)}
          data-permission-scope-kind
          aria-label="Permission scope"
        >
          <option value="global">All projects</option>
          <option value="project" disabled={!workspace}>
            {workspace ? `This project (${workspace.split(/[\\/]/).filter(Boolean).pop()})` : "This project (no folder open)"}
          </option>
          <option value="agent">One agent</option>
        </select>
        {choice === "agent" && (
          <select
            className="bg-cc-surface border border-cc-border rounded px-1.5 py-0.5 text-[11px] text-cc-text outline-none"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            data-permission-agent
            aria-label="Agent"
          >
            {agentOptions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="text-[10px] text-cc-muted leading-snug mb-1.5" data-permission-scope-note>
        {state.configured ? (
          <>
            Rules stored for <span className="text-cc-text">{scopeName}</span>.
            {overridden > 0 && ` ${overridden} of them are overridden by a broader scope.`}
          </>
        ) : (
          <>
            Nothing is set for <span className="text-cc-text">{scopeName}</span> — every permission below is
            inherited from a broader scope or from its default.
          </>
        )}
      </div>

      {state.error && (
        <div className="text-[10px] text-red-400 leading-snug mb-1.5" data-permission-error>
          {state.error}
        </div>
      )}

      <div className="max-h-64 overflow-y-auto" data-permission-rows>
        <div className="grid grid-cols-[1fr_auto_auto] gap-x-1.5 items-center text-[10px] text-cc-muted px-1 sticky top-0 bg-cc-bg">
          <span>Permission</span>
          <span className="w-[4.5rem] text-center">Here</span>
          <span className="w-[4.5rem] text-center">Effective</span>
        </div>
        {state.rows.map((row) => {
          const saving = state.saving === row.capability;
          return (
            <div
              key={row.capability}
              className={`grid grid-cols-[1fr_auto_auto] gap-x-1.5 items-center px-1 py-0.5 ${
                saving ? "opacity-50" : ""
              }`}
              data-permission-row={row.capability}
              data-permission-effective={row.effective}
            >
              <div className="min-w-0">
                <div className="text-[11px] text-cc-text truncate" title={row.label}>
                  {row.label}
                  {row.irreversible && (
                    <span
                      className="ml-1 text-[9px] text-red-400"
                      title="This operation cannot be undone from Close Code, so it always asks even when allowed."
                    >
                      always asks
                    </span>
                  )}
                  {!row.available && (
                    <span className="ml-1 text-[9px] text-cc-muted" title="No MCP server is registered in this build.">
                      not in use
                    </span>
                  )}
                </div>
                <div className="text-[9px] text-cc-muted truncate" title={row.description}>
                  {row.description}
                </div>
              </div>
              <div className="w-[4.5rem] flex justify-center">
                <button
                  type="button"
                  className={`text-[10px] px-1 rounded border border-cc-border ${
                    row.own ? MODE_STYLE[row.own] : "text-cc-muted"
                  } ${row.own ? "bg-cc-surface" : "border-dashed"}`}
                  onClick={() => void state.setMode(row.capability, row.own)}
                  disabled={saving}
                  title={
                    row.own
                      ? `Stored here as ${row.own}. Click to remove this rule and inherit instead.`
                      : "Inherited. Click to store an override in this scope."
                  }
                  data-permission-own
                  data-permission-value={row.own ?? "inherit"}
                >
                  {row.own ?? "inherit"}
                </button>
              </div>
              <div className="w-[4.5rem] flex justify-center">
                <div
                  className={`text-[10px] ${MODE_STYLE[row.effective]} ${
                    row.own && row.own !== row.effective ? "underline decoration-dotted" : ""
                  }`}
                  title={
                    row.own && row.own !== row.effective
                      ? `You set ${row.own} here, but ${row.effective} wins — a broader scope overrides this one.`
                      : MODE_TITLE[row.effective]
                  }
                  data-permission-effective-label
                >
                  {row.effective}
                  {row.own && row.own !== row.effective ? ` (${row.own})` : ""}
                </div>
              </div>
            </div>
          );
        })}
        {state.rows.length === 0 && !state.loading && (
          <div className="text-[10px] text-cc-muted px-1 py-2" data-permission-empty>
            No permissions to show.
          </div>
        )}
      </div>

      {/* The coarse Phase 11/22 category switches stay where they were. Stated
          here so the relationship is not a secret: a category set to "deny"
          blocks everything under it whatever this matrix says, and a category set
          to "allow" fills in the capabilities here that you have not set. */}
      <div className="text-[9px] text-cc-muted leading-snug mt-1.5 border-t border-cc-border pt-1.5">
        The category switches in AI settings still apply: a category set to <b>deny</b> blocks everything under
        it, and one set to <b>allow</b> fills in the rows here you have not set. A denied permission here always
        wins over an allow.
      </div>
    </div>
  );
}
