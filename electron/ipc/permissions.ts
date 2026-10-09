// Close Code — agent permission IPC (Phase 23)
//
// Four channels, all returning the app's usual `{ ok, result?, error? }` envelope.
// Three are for the settings panel; the fourth exists so the panel and the gate
// cannot disagree about what is allowed.
//
// Validation is strict on purpose. This is the surface a user's permissions are
// edited through, and a handler that quietly accepted an unknown capability id
// would store a rule the gate can never read — the user would believe they had
// restricted something they had in fact changed nothing about. A wrong id is
// rejected loudly instead.

import { ipcMain, app } from "electron";
import {
  clearPermissionScope,
  permissionMatrix,
  savePermissionPolicy,
  savePermissionRule,
  configuredScopes,
} from "../services/permissionStore";
import { setPermissionPolicyDir } from "../services/agent/instance";
import {
  ALL_CAPABILITIES,
  CAPABILITY_DESCRIPTIONS,
  CAPABILITY_LABELS,
  IRREVERSIBLE_CAPABILITIES,
  isPermissionMode,
  isPermissionScope,
} from "../services/agent/permissions";
import type { Capability, PermissionMode, PermissionScope } from "../services/agent/permissions";
import { listAgentDefinitions } from "../services/agent/definitions";
import { listMcpServers } from "../services/mcp";

function fail(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

/**
 * The `userData` directory the policy lives in.
 *
 * `app.getPath` is read on first use rather than at module load, because this
 * module is imported from `main.ts` before `app.whenReady()` in some builds and a
 * throw at import time would take the whole window down.
 */
function userDataDir(): string {
  const dir = app.getPath("userData");
  setPermissionPolicyDir(dir);
  return dir;
}

/** One row of the panel, ready to render without the renderer importing the model. */
interface PermissionRow {
  capability: Capability;
  label: string;
  description: string;
  /** The mode that will actually be used in this context. */
  effective: PermissionMode;
  /** The rule stored in the selected scope, or null when inherited. */
  own: PermissionMode | null;
  /**
   * True for operations that destroy data or leave the workspace.
   *
   * Sent so the panel can say "this one always asks" rather than letting the
   * user discover it by being prompted for something they had allowed.
   */
  irreversible: boolean;
  /** True when an MCP server could exist to be gated by this. */
  available: boolean;
}

export function registerPermissionIpc(): void {
  // The static half of the matrix: what exists, what it is called, and why.
  // Sent once on open rather than re-derived in the renderer, so the labels the
  // user reads and the ids the gate checks cannot drift apart.
  ipcMain.handle("agent:permission-catalog", () => {
    try {
      return {
        ok: true,
        result: {
          capabilities: ALL_CAPABILITIES.map((capability) => ({
            capability,
            label: CAPABILITY_LABELS[capability] ?? capability,
            description: CAPABILITY_DESCRIPTIONS[capability] ?? "",
            irreversible: IRREVERSIBLE_CAPABILITIES.includes(capability),
          })),
          agents: listAgentDefinitions().map((a) => ({ id: a.id, name: a.name })),
        },
      };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle(
    "agent:permission-matrix",
    (_e, payload: { scope?: unknown; agentId?: unknown; workspace?: unknown }) => {
      try {
        const scope: PermissionScope = isPermissionScope(payload?.scope) ? payload.scope : { kind: "global" };
        const agentId = typeof payload?.agentId === "string" ? payload.agentId : undefined;
        const workspace = typeof payload?.workspace === "string" ? payload.workspace : null;
        const matrix = permissionMatrix(userDataDir(), { scope, agentId, workspace });
        const rows: PermissionRow[] = matrix.capabilities.map((capability) => ({
          capability,
          label: CAPABILITY_LABELS[capability] ?? capability,
          description: CAPABILITY_DESCRIPTIONS[capability] ?? "",
          effective: matrix.modes[capability],
          own: matrix.own[capability] ?? null,
          irreversible: IRREVERSIBLE_CAPABILITIES.includes(capability),
          // Phase 23 declared `mcp.invoke` ahead of the tools that use it, and
          // Phase 30 shipped them. The switch guards nothing when no server is
          // configured, so the panel still says so in that case — a permission
          // for a thing that cannot happen reads as a broken UI, not a choice.
          available: capability !== "mcp.invoke" || listMcpServers().servers.length > 0,
        }));
        return { ok: true, result: { scope: matrix.scope, configured: matrix.configured, rows } };
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  ipcMain.handle(
    "agent:permission-set",
    (_e, payload: { scope?: unknown; capability?: unknown; mode?: unknown }) => {
      try {
        if (!isPermissionScope(payload?.scope)) return fail("A permission scope is required.");
        const capability = payload?.capability;
        if (typeof capability !== "string" || !ALL_CAPABILITIES.includes(capability as Capability)) {
          return fail(`Unknown capability "${String(capability)}".`);
        }
        // `null` clears the rule. Anything that is not a mode and not null is a
        // bug worth surfacing rather than coercing to a default.
        const mode: PermissionMode | null = payload?.mode === null ? null : isPermissionMode(payload?.mode) ? payload.mode : null;
        if (mode === null && payload?.mode !== null) return fail("A mode of allow, ask, deny, or null is required.");
        savePermissionRule(userDataDir(), payload.scope, capability as Capability, mode);
        return { ok: true, result: { scope: payload.scope, capability, mode } };
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  ipcMain.handle("agent:permission-clear-scope", (_e, payload: { scope?: unknown }) => {
    try {
      if (!isPermissionScope(payload?.scope)) return fail("A permission scope is required.");
      savePermissionPolicy(userDataDir(), clearPermissionScope(userDataDir(), payload.scope));
      return { ok: true, result: { scope: payload.scope } };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("agent:permission-scopes", () => {
    try {
      return { ok: true, result: { scopes: configuredScopes(userDataDir()) } };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });
}
