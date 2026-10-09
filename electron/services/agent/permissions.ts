// Close Code — AI Agent Runtime — granular permissions (Phase 23)
//
// Phase 22 gave every tool a category and every category a mode, so "allow
// files" meant the same thing whether a call read one file or overwrote twenty.
// That is too coarse to be a real answer to "may this agent delete a file?"
//
// This module is the permission *model*: the operations a tool can perform, the
// scopes those permissions are granted in, and the rules for combining them.
// It contains no I/O, imports no `electron`, and is the single source of truth
// that both the runtime's gate and the settings UI read.
//
// Three ideas do the work:
//
//   1. **Capabilities** — what a call actually *does* (`files.read`,
//      `files.write`, `files.delete`, …). A tool declares the ones it needs, and
//      a permission is set per capability rather than per category. Categories
//      survive as the coarse grouping the UI already shows, so nothing that
//      worked in Phase 22 stops working.
//
//   2. **Scopes** — where a permission applies: globally, to one project, to one
//      agent, or to one specific path. The most specific matching scope wins.
//      This is what makes "allow reading in this repo, but ask in that one"
//      expressible, and it is the reason a permission the user set for a
//      throwaway experiment does not follow them everywhere.
//
//   3. **Escalation** — a capability whose mode is `allow` can still be pulled
//      back to `ask` by a rule that sees something the mode cannot: a command
//      matching the dangerous-command list, a path outside the workspace, a
//      destructive tool. This is deliberately one-directional. `allow` may be
//      narrowed by policy; it can never be widened by a model, a tool, or a
//      stale cached rule.

import path from "path";
import type { AgentToolCategory } from "./types";

/** allow / ask / deny, unchanged from Phase 11 so existing configs keep working. */
export type PermissionMode = "allow" | "ask" | "deny";

/**
 * The operations a tool call can perform.
 *
 * These are deliberately *operations*, not tools: a tool that can do two things
 * (write a file, or create a directory) asks for both, and the gate requires
 * both. Grouping them the way the UI groups them would put `files.delete` and
 * `files.read` under one switch again, which is the coarseness this phase exists
 * to remove.
 */
export type Capability =
  | "files.read"
  | "files.write"
  | "files.delete"
  | "search.read"
  | "shell.exec"
  | "shell.dangerous"
  | "network.fetch"
  | "network.search"
  | "git.read"
  | "git.write"
  | "git.history"
  | "browser.navigate"
  | "browser.interact"
  | "agent.spawn"
  | "external.read"
  | "external.write"
  | "mcp.invoke"
  | "skills.invoke"
  | "tasks.manage";

export const ALL_CAPABILITIES: readonly Capability[] = Object.freeze([
  "files.read",
  "files.write",
  "files.delete",
  "search.read",
  "shell.exec",
  "shell.dangerous",
  "network.fetch",
  "network.search",
  "git.read",
  "git.write",
  "git.history",
  "browser.navigate",
  "browser.interact",
  "agent.spawn",
  "external.read",
  "external.write",
  "mcp.invoke",
  "skills.invoke",
  "tasks.manage",
]);

/** Every mode starts at `ask` except the two that can destroy a machine. */
export const DEFAULT_CAPABILITY_MODES: Readonly<Record<Capability, PermissionMode>> = Object.freeze({
  "files.read": "ask",
  "files.write": "ask",
  "files.delete": "deny",
  "search.read": "ask",
  "shell.exec": "ask",
  // `deny` by default is the point. A user must opt in to the agent running
  // `rm -rf` before it can even be attempted, let alone approved per-call.
  "shell.dangerous": "deny",
  "network.fetch": "ask",
  "network.search": "ask",
  "git.read": "ask",
  "git.write": "ask",
  "git.history": "deny",
  "browser.navigate": "ask",
  "browser.interact": "ask",
  "agent.spawn": "ask",
  "external.read": "deny",
  "external.write": "deny",
  // Phase 30 speaks MCP now, and the default stays `deny`: an MCP server can
  // do literally anything its author wrote, so a fresh install must not be one
  // config file away from an agent calling it unprompted. The user opts in —
  // per category or per capability — before the first call can even be
  // attempted, which is the same failure direction `shell.dangerous` takes.
  "mcp.invoke": "deny",
  // Phase 29. Task-list maintenance changes only the app's own stored task
  // state, never the workspace or the machine — but it is still a side effect,
  // so it defaults to asking just like `files.write`.
  "tasks.manage": "ask",
  // Phase 31. Invoking a skill injects workspace- or user-authored instructions
  // into the run. The instructions themselves are text — anything they inspire
  // still passes the normal gate — but a cloned repo can carry a poisoned
  // SKILL.md, so the model asking for one is a decision the user should see,
  // exactly like `agent.spawn`.
  "skills.invoke": "ask",
});

/**
 * Which capability each Phase 22 category maps onto.
 *
 * This is the bridge that keeps Phase 22 settings meaningful: a user who set
 * `files: "allow"` gets every *non-destructive* files capability allowed, and
 * `files.delete` still respects its own (stricter) rule. A category setting is
 * a bulk edit on the capabilities underneath it, not an override that defeats
 * them.
 */
export const CATEGORY_CAPABILITIES: Readonly<Record<AgentToolCategory, readonly Capability[]>> = Object.freeze({
  files: Object.freeze(["files.read", "files.write"] as Capability[]),
  terminal: Object.freeze(["shell.exec", "shell.dangerous"] as Capability[]),
  search: Object.freeze(["search.read"] as Capability[]),
  git: Object.freeze(["git.read", "git.write", "git.history"] as Capability[]),
  agent: Object.freeze(["agent.spawn"] as Capability[]),
  web: Object.freeze(["network.fetch", "network.search"] as Capability[]),
  browser: Object.freeze(["browser.navigate", "browser.interact"] as Capability[]),
  // Phase 29. The whole task surface maps onto one capability: reading the list
  // and changing it are both "maintain the task list", which is coarse on
  // purpose — a task list that even the read had to ask permission for would be
  // a list nobody lets the agent look at. Separating `tasks.read` from
  // `tasks.manage` is real work later if a user wants it; it is not worth a
  // second switch today.
  tasks: Object.freeze(["tasks.manage"] as Capability[]),
  // Phase 30. Every MCP server tool maps onto the one pre-declared capability.
  // It stays coarse for the same reason `tasks.manage` is: the per-server
  // decision is made when the server is added and enabled, so per-capability
  // granularity here would only let a user believe they had allowed one server
  // while the gate had no way to know which one a call came from at mode level.
  mcp: Object.freeze(["mcp.invoke"] as Capability[]),
  // Phase 31. One capability for one tool (`use_skill`). The skill's own
  // `allowed-tools` restriction narrows what a run may do *after* invoking,
  // but that restriction is run state, not permission state — the gate and the
  // restriction both apply, and neither can widen the other.
  skills: Object.freeze(["skills.invoke"] as Capability[]),
});

/**
 * Capabilities that remove data irreversibly.
 *
 * Used for the UI's permanent warning and for forcing an approval prompt even
 * when the capability is set to `allow` — see `escalateMode`.
 */
export const IRREVERSIBLE_CAPABILITIES: readonly Capability[] = Object.freeze([
  "files.delete",
  "shell.dangerous",
  "git.history",
]);

/** Human labels. Kept next to the codes so a new capability cannot ship blank. */
export const CAPABILITY_LABELS: Readonly<Record<Capability, string>> = Object.freeze({
  "files.read": "Read files",
  "files.write": "Create or change files",
  "files.delete": "Delete files",
  "search.read": "Search the workspace",
  "shell.exec": "Run shell commands",
  "shell.dangerous": "Run destructive shell commands",
  "network.fetch": "Fetch URLs",
  "network.search": "Search the web",
  "git.read": "Read git state",
  "git.write": "Stage, commit, switch branches",
  "git.history": "Rewrite or discard git history",
  "browser.navigate": "Open pages in a browser",
  "browser.interact": "Click and type in a browser",
  "agent.spawn": "Start sub-agents",
  "external.read": "Read outside the workspace",
  "external.write": "Write outside the workspace",
  "mcp.invoke": "Call MCP servers",
  "skills.invoke": "Invoke skills",
  "tasks.manage": "Maintain the task list",
});

/** One-line explanation of what granting this actually permits. Shown in the UI. */
export const CAPABILITY_DESCRIPTIONS: Readonly<Record<Capability, string>> = Object.freeze({
  "files.read": "Open files and folders inside the workspace and see their contents.",
  "files.write": "Create new files and change the contents of existing ones.",
  "files.delete": "Remove files and folders. The workspace's Recycle Bin restore does not apply.",
  "search.read": "Search file names and contents inside the workspace.",
  "shell.exec": "Run any command in the workspace's terminal.",
  "shell.dangerous": "Run commands that delete, reformat, overwrite or take over the machine.",
  "network.fetch": "Make HTTP requests to any URL, which can send workspace content off this machine.",
  "network.search": "Send a search query to a web search provider.",
  "git.read": "Read status, diff, log and branches.",
  "git.write": "Stage files, commit, create branches and switch between them.",
  "git.history": "Discard commits, reset branches or clean untracked files. Work can be lost permanently.",
  "browser.navigate": "Open a URL in a browser window that can reach the network.",
  "browser.interact": "Click buttons, type into fields and submit forms on a page you opened.",
  "agent.spawn": "Start another agent, which gets its own permissions but runs under your approval.",
  "external.read": "Read files in folders you have not opened as the workspace.",
  "external.write": "Create or change files outside the workspace.",
  "mcp.invoke": "Call tools and read resources provided by any configured MCP server. A server can do whatever its author wrote — this is the gate for all of them.",
  "skills.invoke": "Load a skill's workflow instructions into the run. The instructions are text; anything the model then does still passes the normal permission gate.",
  "tasks.manage": "Create, update, complete, cancel, retry and assign tasks in the app's persistent task list. Changes only the task list, never files.",
});

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

/**
 * Where a permission applies.
 *
 * `project` and `agent` scopes compose: the most specific scope that declares a
 * capability decides it, and the order below is that specificity. `path` is
 * checked last and is the most specific of all.
 */
export type PermissionScope =
  | { kind: "global" }
  | { kind: "project"; root: string }
  | { kind: "agent"; agentId: string }
  | { kind: "path"; path: string };

export function scopeKey(scope: PermissionScope): string {
  switch (scope.kind) {
    case "global":
      return "global";
    case "project":
      return `project:${normalizeKeyPath(scope.root)}`;
    case "agent":
      return `agent:${scope.agentId}`;
    case "path":
      return `path:${normalizeKeyPath(scope.path)}`;
  }
}

/**
 * Windows paths are case-insensitive, so `C:\Repo` and `c:\repo` must not
 * become two different permissions. Anything else is compared as-is, because
 * on macOS and Linux `Repo` and `repo` really are different folders.
 */
function normalizeKeyPath(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

export function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "allow" || value === "ask" || value === "deny";
}

/**
 * Whether an untrusted value is a usable scope.
 *
 * Every field is checked, including that the path is absolute for the scopes that
 * name one. A relative project root would silently create a scope that never
 * matches — the rule would be stored, the panel would show it, and no run would
 * ever consult it. That is a permission the user believes in and does not have.
 */
export function isPermissionScope(value: unknown): value is PermissionScope {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  switch (s.kind) {
    case "global":
      return true;
    case "project":
      return typeof s.root === "string" && s.root.length > 0 && path.isAbsolute(s.root);
    case "agent":
      return typeof s.agentId === "string" && s.agentId.length > 0;
    case "path":
      return typeof s.path === "string" && s.path.length > 0 && path.isAbsolute(s.path);
    default:
      return false;
  }
}

/**
 * Specificity order: later entries override earlier ones.
 */
const SCOPE_RANK: Record<PermissionScope["kind"], number> = {
  global: 0,
  project: 1,
  agent: 2,
  path: 3,
};

/**
 * The full stored policy: every rule, keyed by scope.
 *
 * Rules within one scope are sparse. An absent capability means "inherit", which
 * is what makes a per-agent override able to change one thing without
 * restating the other sixteen.
 */
export interface PermissionPolicy {
  /** scope key -> capability -> mode. */
  scopes: Record<string, Record<string, PermissionMode>>;
}

export function emptyPolicy(): PermissionPolicy {
  return { scopes: {} };
}

/**
 * Read the effective mode for a capability in a given context.
 *
 * Resolution order, most specific first:
 *   path scope → agent scope → project scope → global → built-in default
 *
 * Two rules matter more than the order:
 *
 *   * **`deny` is not overridable by a broader scope.** If any matching scope
 *     says `deny`, the answer is `deny`. This is what stops a per-agent
 *     "allow" from quietly re-enabling something the user denied for the whole
 *     machine, which is the one way a layered permission system can become less
 *     safe than a flat one.
 *   * **`allow` is overridable downward.** Anything narrower may narrow it.
 *     A user who allows `shell.exec` globally and asks per-project genuinely
 *     means the narrower one.
 *
 * @see resolveCapabilityDetailed
 */
/** Where a resolved mode came from. */
export interface CapabilityResolution {
  mode: PermissionMode;
  /**
   * The scope key that decided it, or `null` when no stored rule applied and the
   * built-in default was used.
   */
  scope: string | null;
  /**
   * True when the mode came from a stored rule rather than the built-in default.
   *
   * This is the distinction the gate needs and a bare `PermissionMode` cannot
   * carry: a category-level `allow` is a *bulk edit on the capabilities it
   * covers*, so it should apply where the user has expressed no opinion and
   * stand aside where they have. Without `explicit`, there is no way to tell
   * "allow this, because the user asked" from "allow this, because the user
   * never had an opinion and the category is open", and the first must not be
   * silently narrowed by a coarse setting.
   */
  explicit: boolean;
}

export function resolveCapability(
  policy: PermissionPolicy,
  capability: Capability,
  context: { agentId?: string; workspace?: string | null; path?: string | null },
): PermissionMode {
  return resolveCapabilityDetailed(policy, capability, context).mode;
}

/**
 * Resolve a capability and say how it was decided.
 *
 * Resolution order, most specific first:
 *   path scope → agent scope → project scope → global → built-in default
 *
 * Two rules matter more than the order:
 *
 *   * **`deny` is not overridable by a broader scope.** If any matching scope
 *     says `deny`, the answer is `deny`. This is what stops a per-agent
 *     "allow" from quietly re-enabling something the user denied for the whole
 *     machine, which is the one way a layered permission system can become less
 *     safe than a flat one.
 *   * **`allow` is overridable downward.** Anything narrower may narrow it.
 *     A user who allows `shell.exec` globally and asks per-project genuinely
 *     means the narrower one.
 */
export function resolveCapabilityDetailed(
  policy: PermissionPolicy,
  capability: Capability,
  context: { agentId?: string; workspace?: string | null; path?: string | null },
): CapabilityResolution {
  // An unrecognised capability has no meaningful default, so it is treated as
  // denied rather than falling through to `ask` for a typo'd id.
  if (!ALL_CAPABILITIES.includes(capability)) return { mode: "deny", scope: null, explicit: true };

  // `deny` anywhere in the chain wins outright. Collected separately from the
  // specificity race so a broader deny is never lost to a narrower allow.
  let deniedScope: string | null = null;
  const specific: Array<{ rank: number; mode: PermissionMode; scope: string }> = [];
  // Read through `ownRule` rather than `scopes[key]?.[capability]` directly: a
  // bare index falls through to the prototype, where `constructor` and friends
  // live. Sanitisation already filters those keys on the way in, but the gate is
  // the last line of defence and should not depend on that having happened.
  const collect = (key: string, rank: number): void => {
    const mode = ownRule(policy, key, capability);
    if (mode === null) return;
    if (mode === "deny") {
      if (deniedScope === null) deniedScope = key;
    } else {
      specific.push({ rank, mode, scope: key });
    }
  };

  collect("global", 0);
  if (context.workspace) collect(scopeKey({ kind: "project", root: context.workspace }), SCOPE_RANK.project);
  if (context.agentId) collect(scopeKey({ kind: "agent", agentId: context.agentId }), SCOPE_RANK.agent);
  if (context.path) collect(scopeKey({ kind: "path", path: context.path }), SCOPE_RANK.path);

  if (deniedScope !== null) return { mode: "deny", scope: deniedScope, explicit: true };
  if (!specific.length) return { mode: DEFAULT_CAPABILITY_MODES[capability], scope: null, explicit: false };
  // Highest rank wins among the non-denied candidates.
  specific.sort((a, b) => b.rank - a.rank);
  return { mode: specific[0].mode, scope: specific[0].scope, explicit: true };
}

/**
 * Phase 25. The stricter of two modes.
 *
 * `deny` beats `ask` beats `allow`. Written as a total order rather than a
 * numeric comparison so that adding a fourth mode later cannot silently become
 * "the new one wins", which is the wrong default for a permission system.
 */
export function strictestMode(a: PermissionMode, b: PermissionMode): PermissionMode {
  if (a === "deny" || b === "deny") return "deny";
  if (a === "ask" || b === "ask") return "ask";
  return "allow";
}

/**
 * Phase 25. Cap one resolved mode at a ceiling inherited from a parent run.
 *
 * An absent ceiling entry means the parent imposed no bound on that capability,
 * which for a top-level run is every capability. A ceiling entry is only ever
 * consulted for a *nested* run; see `effectiveModeFor`.
 */
export function clampToCeiling(mode: PermissionMode, ceiling: PermissionMode | undefined): PermissionMode {
  if (ceiling === undefined) return mode;
  return strictestMode(mode, ceiling);
}

/**
 * Whether a category-level setting may widen this capability.
 *
 * A category is a bulk edit over the capabilities it covers, so `files: allow`
 * means "the file operations in this category are fine" — but it is not a licence
 * to enable the operations whose whole purpose is to be hard to reverse. Those
 * keep their stricter built-in default until the user names them individually,
 * which is why `terminal: allow` still does not permit a silent `rm -rf`.
 *
 * Capabilities outside the category's own set are never widened by it: a
 * category setting says nothing about reaching outside the workspace or calling
 * an MCP server.
 */
export function categoryCanWiden(category: AgentToolCategory, capability: Capability): boolean {
  const covered = CATEGORY_CAPABILITIES[category];
  if (!covered || !covered.includes(capability)) return false;
  return !IRREVERSIBLE_CAPABILITIES.includes(capability);
}

/**
 * Read one stored rule, ignoring anything inherited.
 *
 * Returns `null` for "no rule here", which is distinct from all three modes and
 * is what lets a scope inherit rather than assert.
 */
function ownRule(policy: PermissionPolicy, scopeKey: string, capability: Capability): PermissionMode | null {
  const rules = policy.scopes[scopeKey];
  if (!rules || !Object.prototype.hasOwnProperty.call(rules, capability)) return null;
  const mode = rules[capability];
  return mode === "allow" || mode === "ask" || mode === "deny" ? mode : null;
}

/**
 * Write one rule, replacing whatever that scope had for that capability.
 *
 * An empty mode map is pruned rather than kept, so a scope the user has since
 * cleared stops shadowing anything.
 */
export function setRule(
  policy: PermissionPolicy,
  scope: PermissionScope,
  capability: Capability,
  mode: PermissionMode | null,
): PermissionPolicy {
  const key = scopeKey(scope);
  // Null-prototype for the same reason `sanitizePolicy` uses one: a spread of a
  // plain object gives back a plain object, and assigning `__proto__` to one
  // reaches the prototype instead of failing loudly. Capability ids are
  // allow-listed by the caller, so this is belt-and-braces, but the copy below
  // would otherwise silently undo the protection on the way in.
  const current: Record<string, PermissionMode> = Object.assign(
    Object.create(null) as Record<string, PermissionMode>,
    policy.scopes[key] ?? {},
  );
  if (mode === null) delete current[capability];
  else current[capability] = mode;
  const scopes = { ...policy.scopes };
  if (Object.keys(current).length === 0) delete scopes[key];
  else scopes[key] = current;
  return { scopes };
}

/** Remove a whole scope, e.g. "reset this project's permissions". */
export function clearScope(policy: PermissionPolicy, scope: PermissionScope): PermissionPolicy {
  const scopes = { ...policy.scopes };
  delete scopes[scopeKey(scope)];
  return { scopes };
}

/**
 * The effective mode for every capability, given a context.
 *
 * This is the single function the settings UI calls to render its matrix, so
 * the answer the user is shown is produced by the same code that answers the
 * gate. A separate "what does the UI think is allowed" path is how a settings
 * screen and a security gate drift apart.
 */
export function effectivePolicy(
  policy: PermissionPolicy,
  context: { agentId?: string; workspace?: string | null } = {},
): Record<Capability, PermissionMode> {
  const out = {} as Record<Capability, PermissionMode>;
  for (const c of ALL_CAPABILITIES) {
    out[c] = resolveCapability(policy, c, context);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

/**
 * Why a capability was pulled back to `ask` despite being set to `allow`.
 *
 * Returned rather than applied in place so the approval prompt can explain
 * itself. "Allowed, but asking anyway because the command matched the
 * destructive list" is a sentence a user can act on; a bare prompt is not.
 */
export interface Escalation {
  capability: Capability;
  /**
   * Always `ask` or `deny`.
   *
   * Narrowed on purpose. Escalation exists to turn a capability that would have
   * run silently into one a human decides on, and there is no third outcome;
   * typing the field as the full `PermissionMode` would let a future caller
   * record `allow` as an escalation, which is the one thing that would let a
   * dangerous operation through with a note saying it had been checked.
   */
  mode: "ask" | "deny";
  reason: string;
}

/**
 * Narrow a resolved mode. Never widens.
 *
 * The only source of escalation is the caller passing a reason; there is no
 * code path from `deny` to `ask` or from `ask` to `allow` here. That direction
 * is enforced by the types (`mode` can only come out equal or stricter) and by
 * every test that asserts it.
 */
export function escalateMode(mode: PermissionMode, escalation?: Escalation | null): PermissionMode {
  if (!escalation) return mode;
  if (mode === "deny") return "deny";
  // `allow` narrows to `ask`; `ask` stays `ask`. Nothing here reaches `allow`.
  return escalation.mode === "deny" ? "deny" : "ask";
}

// ---------------------------------------------------------------------------
// Dangerous command detection
// ---------------------------------------------------------------------------

/**
 * Commands that are destructive regardless of how they were spelled.
 *
 * This is a *floor*, not a filter: matching does not execute anything, it only
 * forces an approval the user would otherwise not get. The list is intentionally
 * conservative in what it *detects* — a false positive costs one prompt, a false
 * negative costs a user's files — and deliberately incomplete as a *blocker*,
 * because a blocklist a model can route around by spelling is not a security
 * control. `shell.exec` being `ask` is the actual control; this is what stops
 * `shell.exec: allow` from being read as "any command".
 */
const DANGEROUS_PATTERNS: ReadonlyArray<{ re: RegExp; why: string }> = Object.freeze([
  // Recursive force-delete, in every spelling that matters.
  { re: /\brm\s+(-[a-z]*[rf][a-z]*\s+)*(-[a-z]*[rf][a-z]*\s+)*\S/i, why: "force-deletes files" },
  { re: /\brmdir\s+\/s\b/i, why: "deletes a directory tree" },
  { re: /\bdel\s+\/[sf]\b/i, why: "force-deletes files" },
  { re: /\bRemove-Item\b[^\n]*-Recurse/i, why: "deletes a directory tree" },
  { re: /\bshutil\.rmtree\b/i, why: "deletes a directory tree" },
  // Whole-disk or system-level operations.
  { re: /\bformat\s+[a-z]:/i, why: "formats a drive" },
  { re: /\bmkfs\b/i, why: "erases a filesystem" },
  { re: /\bdiskpart\b/i, why: "repartitions disks" },
  { re: /\bdd\s+[^\n]*\bof=\/dev\//i, why: "overwrites a raw device" },
  // Fork bomb.
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, why: "is a fork bomb" },
  // Disk and permission destruction.
  { re: /\bchmod\s+(-[a-zA-Z]*\s+)*(777|-R\s+777)\b/i, why: "makes everything world-writable" },
  { re: /\bchown\s+-R\s+root/i, why: "hands ownership to root" },
  { re: /\bTakeOwn\b|\bIcacls\b[^\n]*\/reset/i, why: "changes ownership or permissions of files" },
  // History and credential destruction.
  { re: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|push\s+[^\n]*--force(?!-with-lease))/i, why: "discards git work" },
  { re: /\bhistory\s+-c\b|\bClear-Content\b[^\n]*History/i, why: "erases shell history" },
  // Registry and system configuration.
  { re: /\breg\s+delete\b|\bRemove-Item\b[^\n]*HKLM:/i, why: "changes the registry" },
  { re: /\bSet-ExecutionPolicy\b/i, why: "changes the execution policy" },
  // Piping a download straight into a shell is the classic remote-code-execution
  // shape. Flagged because the *user* should see it, not because the pattern is
  // hard to spell differently.
  { re: /\b(curl|wget|Invoke-WebRequest|iwr)\b[^\n]*\|\s*(ba|z|k|da)?sh\b/i, why: "pipes a download into a shell" },
  {
    re: /\b(curl|wget|Invoke-WebRequest|iwr)\b[^\n]*\|\s*(python|node|ruby|perl|iex|Invoke-Expression|powershell|pwsh)\b/i,
    why: "pipes a download into an interpreter",
  },
  // Process and service control that can stop the user's work.
  { re: /\b(taskkill|Stop-Process|Terminate-Process)\b/i, why: "kills processes" },
  { re: /\b(shutdown|reboot|halt|Stop-Computer)\b/i, why: "shuts the machine down" },
]);

export interface DangerousCommandMatch {
  /** The pattern that matched, for the approval prompt. */
  why: string;
  /** The fragment that matched, clipped. Never shown to a model as a suggestion. */
  sample: string;
}

/**
 * Inspect a shell command and say whether it is destructive.
 *
 * Returns `null` for a command that is not on the list. It does **not** decide
 * whether the command is safe — it only reports that it needs a human. An empty
 * result means "not on the list", which is a weaker statement and is documented
 * as such at every call site.
 *
 * Commands are split on the separators a shell actually treats as such before
 * matching, so `ls && rm -rf /` is caught even though the `rm` is not the first
 * token, and a `;` inside a quoted string is not treated as a separator.
 */
export function detectDangerousCommand(command: string): DangerousCommandMatch | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  // Two passes, in this order, because they catch genuinely different things:
  //
  //   1. **Whole command, quotes stripped.** A fork bomb, a `curl … | sh` pipe
  //      and a `&&`-chained delete are all single syntactic units: splitting
  //      them on separators destroys the very text the pattern is looking for.
  //      Quoted spans are blanked first, so `echo "rm -rf /"` does not match.
  //
  //   2. **Per segment.** A pattern like `\brm\s+…` still matches on the whole
  //      string, so this pass mainly guards the case where a pattern was written
  //      to match a command's own leading token.
  //
  // Blank-out rather than delete: the surrounding text must stay contiguous so
  // that `curl … | sh` still reads as one pipe across the removed argument.
  const stripped = blankQuoted(trimmed);
  const first = matchDangerous(stripped);
  if (first) return first;

  for (const segment of splitShellCommands(stripped)) {
    const hit = matchDangerous(segment);
    if (hit) return hit;
  }

  // Pass 3. An interpreter handed a script as a quoted argument.
  //
  // Passes 1 and 2 blank quoted spans, which is what stops `echo "rm -rf /"`
  // from matching — but it also means `powershell -Command "Remove-Item
  // -Recurse -Force C:\..."` is scanned with the dangerous part replaced by
  // spaces, and a recursive delete sails through unflagged. The quoting is not
  // there to make the text inert; it is there to pass it to something that
  // *will* run it.
  //
  // So the quoted text is scanned too, but only when an interpreter that
  // executes its argument appears first. `echo` is not one, and that asymmetry
  // is the entire reason the two cases can be told apart at all.
  if (INLINE_INTERPRETER.test(stripped)) {
    const whole = matchDangerous(trimmed);
    if (whole) return whole;
    for (const segment of splitShellCommands(trimmed)) {
      const hit = matchDangerous(segment);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Interpreters that execute the argument they are given.
 *
 * A closed list on purpose. This is the one place where quoted text is treated
 * as code, so adding a name here is a decision that quoted text after it will
 * be matched against the destructive list — which means a user typing
 * `python -c "print('rm -rf /')"` gets an unnecessary prompt. A false positive
 * costs one click; a false negative costs someone's files, so the bias is
 * deliberate and the list stays short.
 */
const INLINE_INTERPRETER =
  /(^|[\s;&|(])(?:powershell|pwsh|cmd(?:\.exe)?|bash|sh|zsh|dash|ksh|node|deno|bun|python[0-9.]*|perl|ruby|php|iex|Invoke-Expression)\b[^\n]*?(?:\s-(?:c|Command|EncodedCommand|e|eval)\b|\s\/c\b)/i;

function matchDangerous(text: string): DangerousCommandMatch | null {
  for (const { re, why } of DANGEROUS_PATTERNS) {
    const m = re.exec(text);
    if (m) return { why, sample: clip(m[0], 120) };
  }
  return null;
}

/**
 * Replace the contents of quoted spans with spaces.
 *
 * Length-preserving on purpose, so character offsets still line up with the
 * original command and a reported `sample` can be pointed back at it.
 */
function blankQuoted(command: string): string {
  let out = "";
  let quote: '"' | "'" | null = null;
  for (const ch of command) {
    if (quote) {
      out += ch === quote ? (quote = null, ch) : " ";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Split on shell separators that are *not* inside quotes.
 *
 * A small hand-rolled scanner rather than a regex, because the regex version of
 * "not inside quotes" is famously wrong: `echo 'a; b'` would split, and a
 * command containing `&&` inside a string is not two commands.
 */
function splitShellCommands(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    // `&&`, `||`, `|` and `;` are separators. A single `&` is a separator too,
    // but the two-character forms are checked first so `&&` is not read as `&`.
    if (ch === ";" || ch === "\n") {
      out.push(current);
      current = "";
      continue;
    }
    if (ch === "&" || ch === "|") {
      if (command[i + 1] === ch) i += 1;
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

// ---------------------------------------------------------------------------
// Path capability
// ---------------------------------------------------------------------------

/**
 * Which capability a path implies, beyond reading or writing it.
 *
 * A path *outside* the workspace is a different decision from one inside it,
 * whichever way it is being used. Confinement still refuses it in this phase —
 * this function exists so that when that is relaxed, the permission the user
 * must grant first is already named correctly rather than being invented at the
 * point of relaxation.
 */
export function pathCapabilities(
  target: string,
  workspace: string | null,
  intent: "read" | "write" | "delete",
): { capabilities: Capability[]; outsideWorkspace: boolean } {
  const outside = isOutsideWorkspace(target, workspace);
  if (!outside) {
    return {
      capabilities: [`files.${intent}` as Capability],
      outsideWorkspace: false,
    };
  }
  // Outside the workspace: both the operation and the escape are required.
  //
  // A delete maps onto `external.write`, not a hypothetical `external.delete`.
  // There is no `external.delete` capability, and inventing one here would
  // produce a capability no rule can ever be written for — a permission the UI
  // could display but never enforce. Deleting outside the workspace is a write
  // outside the workspace; the `files.delete` capability already carries the
  // extra severity of it being irreversible.
  const external: Capability = intent === "delete" ? "external.write" : `external.${intent}`;
  return {
    capabilities: [`files.${intent}` as Capability, external],
    outsideWorkspace: true,
  };
}

/** Lexical containment check. Symlinks are handled by `paths.ts`, not here. */
export function isOutsideWorkspace(target: string, workspace: string | null): boolean {
  if (!workspace) return true;
  // Case-folded: the two comparisons below are a pure containment test, and a
  // case difference must not read as "outside" on a case-insensitive volume.
  const norm = (p: string): string => p.replace(/[\\/]+$/, "").toLowerCase();
  const root = norm(workspace);
  if (!root) return true;
  const t = norm(target);
  return !(t === root || t.startsWith(root + "/") || t.startsWith(root + "\\"));
}

// ---------------------------------------------------------------------------
// Persistence shape
// ---------------------------------------------------------------------------

/**
 * Validate a policy read from disk.
 *
 * Unknown capabilities and unknown modes are dropped rather than rejected, so a
 * file written by a newer build (or a hand-edited one) degrades to "no rule"
 * instead of making the agent unstartable. Losing a rule is recoverable;
 * refusing to open the app is not.
 */
export function sanitizePolicy(input: unknown): PermissionPolicy {
  const out = emptyPolicy();
  if (!input || typeof input !== "object") return out;
  const scopes = (input as { scopes?: unknown }).scopes;
  if (!scopes || typeof scopes !== "object") return out;
  for (const [scope, rules] of Object.entries(scopes as Record<string, unknown>)) {
    if (!rules || typeof rules !== "object") continue;
    // Null-prototype so a stored `__proto__` key is an ordinary own property
    // that the allowlist below drops, rather than an assignment that reaches the
    // prototype. The cost is that callers cannot rely on `hasOwnProperty`
    // without `Object.prototype.hasOwnProperty.call`, which is why `ownRule`
    // above does exactly that.
    const clean: Record<string, PermissionMode> = Object.create(null);
    // `Object.entries` only yields own enumerable keys, and the `includes` check
  // is an allowlist rather than a deny-list, so a hostile or newer-build key
  // cannot survive into the object the gate later reads.
  for (const [cap, mode] of Object.entries(rules as Record<string, unknown>)) {
      if (!ALL_CAPABILITIES.includes(cap as Capability)) continue;
      if (mode === "allow" || mode === "ask" || mode === "deny") clean[cap] = mode;
    }
    if (Object.keys(clean).length > 0) out.scopes[scope] = clean;
  }
  return out;
}

/** A stable key for persisting a per-project policy. Case-normalised on Windows. */
export function projectScopeKey(root: string): string {
  return scopeKey({ kind: "project", root });
}
