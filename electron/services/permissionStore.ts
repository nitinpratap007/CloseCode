// Close Code — agent permission policy store (Phase 23)
//
// Where the per-scope capability rules live on disk.
//
// Two deliberate constraints:
//
//   * **No `electron` import.** The directory is a parameter. The rest of the app
//     passes `app.getPath("userData")`; the test suite passes a temp dir. That is
//     what makes "the policy survives a restart" an assertion rather than a claim.
//
//   * **A corrupt or unknown file degrades to defaults, it does not throw.** The
//     whole point of this store is to be the thing that stops an agent, so it has
//     to be usable when it is not working. A permissions file that cannot be read
//     is exactly the moment where silently falling back to "ask" everywhere is
//     correct, and where throwing would take the AI panel down with it.
//
// The policy itself is *sparse by design*: a scope only stores the capabilities
// the user actually changed. That is what lets a per-agent override name one
// thing without restating the other sixteen, and it is why an upgrade needs no
// migration — a file written by a future build is simply read for the keys this
// build recognises.

import fs from "fs";
import path from "path";
import {
  ALL_CAPABILITIES,
  emptyPolicy,
  sanitizePolicy,
  setRule,
  clearScope,
  effectivePolicy,
  scopeKey,
  type Capability,
  type PermissionMode,
  type PermissionPolicy,
  type PermissionScope,
} from "./agent/permissions";

/** File format marker, so a future format can be detected rather than misread. */
const POLICY_FILE_VERSION = 1;

interface StoredPolicy {
  version: number;
  policy: PermissionPolicy;
}

function policyPath(dir: string): string {
  return path.join(dir, "ai", "permissions.json");
}

/**
 * Read the stored policy, or an empty one.
 *
 * Never throws. A missing file, a truncated write, or a hand-edited file with the
 * wrong shape all land on "no rules stored", which resolves to the built-in
 * defaults — every irreversible capability denied, everything else asked for.
 * That is the safe direction to fail in, and it is worth saying so rather than
 * leaving it to the reader.
 */
export function loadPermissionPolicy(dir: string): PermissionPolicy {
  try {
    const file = policyPath(dir);
    if (!fs.existsSync(file)) return emptyPolicy();
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<StoredPolicy> | null;
    // `sanitizePolicy` is the trust boundary: this file lives in the user's
    // profile, and the gate must not be defeatable by editing a JSON key.
    return sanitizePolicy(parsed?.policy);
  } catch {
    return emptyPolicy();
  }
}

function writePermissionPolicy(dir: string, policy: PermissionPolicy): boolean {
  try {
    const file = policyPath(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body: StoredPolicy = { version: POLICY_FILE_VERSION, policy };
    fs.writeFileSync(file, JSON.stringify(body, null, 2), "utf-8");
    return true;
  } catch (err) {
    console.error("Failed to save the agent permission policy:", err);
    return false;
  }
}

/**
 * Set one capability in one scope, leaving every other rule untouched.
 */
export function savePermissionRule(
  dir: string,
  scope: PermissionScope,
  capability: Capability,
  mode: PermissionMode | null,
): PermissionPolicy {
  // `setRule` already treats `null` as "remove this rule", so clearing and
  // setting are the same operation and there is no second code path to get out
  // of step. A cleared rule is *deleted*, not stored as an "inherit" value: a
  // scope full of nulls would look configured in the panel, and a user who
  // cannot tell a real rule from an inherited one stops trusting the panel.
  const next = setRule(loadPermissionPolicy(dir), scope, capability, mode);
  writePermissionPolicy(dir, next);
  return next;
}

/** Remove an entire scope, so a project's overrides all go at once. */
export function clearPermissionScope(dir: string, scope: PermissionScope): PermissionPolicy {
  const next = clearScope(loadPermissionPolicy(dir), scope);
  writePermissionPolicy(dir, next);
  return next;
}

/** Replace the whole policy. Used by "reset to defaults" and by the tests. */
export function savePermissionPolicy(dir: string, policy: PermissionPolicy): PermissionPolicy {
  const next = sanitizePolicy(policy);
  writePermissionPolicy(dir, next);
  return next;
}

export interface PermissionMatrix {
  /** Every capability, in display order. */
  capabilities: readonly Capability[];
  /** The mode each one resolves to in this context. */
  modes: Record<Capability, PermissionMode>;
  /**
   * The raw rules stored *in the selected scope only*, or `null` when that scope
   * has none.
   *
   * The panel needs to show the difference between "you set this here" and "this
   * is inherited", and a single effective column cannot express that. Showing
   * only the effective mode would be a panel where every cell looks deliberately
   * chosen and the user has no way to find the one that is actually theirs.
   */
  own: Record<string, PermissionMode>;
  /** The scope key the `own` rules came from. */
  scope: string;
  /** True when the scope has at least one stored rule. */
  configured: boolean;
}

/**
 * Everything the permission panel needs for one scope, computed once.
 *
 * `effectivePolicy` and the gate's `resolveCapability` are the same function, so
 * a cell in the panel and a decision at the gate cannot disagree. A settings
 * screen that shows something other than what will actually happen is worse than
 * no settings screen.
 */
export function permissionMatrix(
  dir: string,
  context: { scope: PermissionScope; agentId?: string; workspace?: string | null },
): PermissionMatrix {
  const policy = loadPermissionPolicy(dir);
  const key = scopeKey(context.scope);
  const own: Record<string, PermissionMode> = {};
  for (const capability of ALL_CAPABILITIES) {
    const stored = policy.scopes[key]?.[capability];
    if (stored) own[capability] = stored;
  }
  return {
    capabilities: ALL_CAPABILITIES,
    modes: effectivePolicy(policy, { agentId: context.agentId, workspace: context.workspace }),
    own,
    scope: key,
    configured: Object.keys(own).length > 0,
  };
}

/** Every scope that has at least one rule, for the "configured for…" list. */
export function configuredScopes(dir: string): string[] {
  const policy = loadPermissionPolicy(dir);
  return Object.keys(policy.scopes).filter((k) => Object.keys(policy.scopes[k] ?? {}).length > 0);
}
