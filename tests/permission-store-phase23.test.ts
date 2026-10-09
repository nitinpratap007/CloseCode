// Phase 23 unit tests: the permission policy store.
//
// The model is covered in `agent-permissions-phase23.test.ts` and the gate in
// `agent-gate-phase23.test.ts`. This file is about the two properties that only
// exist because the rules are written to disk:
//
//   * a rule survives a restart (i.e. a fresh read of the same directory)
//   * a corrupt, hostile or absent file degrades to the safe defaults
//
// The store takes a directory rather than reading `app.getPath("userData")`
// itself, which is what makes "survives a restart" testable at all: the same
// functions run again against the same path, exactly as they would after a
// relaunch.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  clearPermissionScope,
  configuredScopes,
  loadPermissionPolicy,
  permissionMatrix,
  savePermissionPolicy,
  savePermissionRule,
} from "../electron/services/permissionStore";
import {
  ALL_CAPABILITIES,
  DEFAULT_CAPABILITY_MODES,
  IRREVERSIBLE_CAPABILITIES,
  emptyPolicy,
  isPermissionScope,
  projectScopeKey,
  setRule,
  type Capability,
  type PermissionScope,
} from "../electron/services/agent/permissions";

const GLOBAL: PermissionScope = { kind: "global" };
const project = (root: string): PermissionScope => ({ kind: "project", root });
const agentScope = (id: string): PermissionScope => ({ kind: "agent", agentId: id });

let dir: string;

function policyFile(): string {
  return path.join(dir, "ai", "permissions.json");
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "p23-store-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe("Phase 23 · stored rules survive a restart", () => {
  it("reads back a rule it wrote, with no in-memory state involved", () => {
    savePermissionRule(dir, GLOBAL, "files.write", "deny");
    // A fresh call, not a returned value: nothing is cached between these two.
    const reloaded = loadPermissionPolicy(dir);
    expect(reloaded.scopes.global?.["files.write"]).toBe("deny");
  });

  it("creates the directory it needs rather than assuming one exists", () => {
    expect(fs.existsSync(dir)).toBe(true);
    savePermissionRule(dir, GLOBAL, "files.read", "ask");
    expect(fs.existsSync(policyFile())).toBe(true);
  });

  it("keeps every other rule when one changes", () => {
    savePermissionRule(dir, GLOBAL, "files.read", "allow");
    savePermissionRule(dir, GLOBAL, "files.write", "deny");
    savePermissionRule(dir, GLOBAL, "shell.exec", "ask");
    savePermissionRule(dir, GLOBAL, "files.read", "deny");
    const rules = loadPermissionPolicy(dir).scopes.global ?? {};
    expect(rules["files.read"]).toBe("deny");
    expect(rules["files.write"]).toBe("deny");
    expect(rules["shell.exec"]).toBe("ask");
  });

  it("stores project and agent rules under different scopes", () => {
    const root = path.join(dir, "proj");
    savePermissionRule(dir, GLOBAL, "shell.exec", "allow");
    savePermissionRule(dir, project(root), "shell.exec", "deny");
    savePermissionRule(dir, agentScope("plan"), "shell.exec", "ask");
    const scopes = loadPermissionPolicy(dir).scopes;
    expect(Object.keys(scopes).length).toBe(3);
    expect(scopes[projectScopeKeyFor(root)]?.["shell.exec"]).toBe("deny");
    expect(scopes["agent:plan"]?.["shell.exec"]).toBe("ask");
  });

  it("removes the whole scope when it is cleared", () => {
    const root = path.join(dir, "proj");
    savePermissionRule(dir, project(root), "files.read", "deny");
    savePermissionRule(dir, project(root), "files.write", "deny");
    clearPermissionScope(dir, project(root));
    expect(loadPermissionPolicy(dir).scopes[projectScopeKeyFor(root)]).toBeUndefined();
  });

  it("drops the scope key entirely once its last rule is removed", () => {
    savePermissionRule(dir, GLOBAL, "files.read", "deny");
    savePermissionRule(dir, GLOBAL, "files.read", null);
    // A scope left behind as an empty object would show as "configured" in the
    // panel with nothing in it.
    expect(loadPermissionPolicy(dir).scopes.global).toBeUndefined();
  });
});

/** The exact key the store will use, so the test does not reimplement it. */
function projectScopeKeyFor(root: string): string {
  return projectScopeKey(root);
}

// ---------------------------------------------------------------------------
// Failure modes
// ---------------------------------------------------------------------------

describe("Phase 23 · a broken policy file fails closed, not open", () => {
  it("falls back to defaults when the file is not valid JSON", () => {
    fs.mkdirSync(path.dirname(policyFile()), { recursive: true });
    fs.writeFileSync(policyFile(), "{ this is not json", "utf-8");
    // An empty policy is the safe direction: every irreversible capability is
    // denied by default, so a corrupt file cannot open anything up.
    expect(loadPermissionPolicy(dir)).toEqual(emptyPolicy());
    expect(effectiveMode(dir, "shell.dangerous")).toBe("deny");
    expect(effectiveMode(dir, "files.delete")).toBe("deny");
  });

  it("falls back to defaults when the file is an empty object", () => {
    fs.mkdirSync(path.dirname(policyFile()), { recursive: true });
    fs.writeFileSync(policyFile(), "{}", "utf-8");
    expect(loadPermissionPolicy(dir)).toEqual(emptyPolicy());
  });

  it("ignores a hand-edited rule for a capability that does not exist", () => {
    savePermissionPolicy(dir, { scopes: { global: { "files.teleport": "allow" } } } as never);
    const rules = loadPermissionPolicy(dir).scopes.global ?? {};
    expect(rules["files.teleport"]).toBeUndefined();
  });

  it("ignores a hand-edited mode that is not allow, ask or deny", () => {
    savePermissionPolicy(dir, { scopes: { global: { "files.read": "probably" } } } as never);
    const rules = loadPermissionPolicy(dir).scopes.global ?? {};
    expect(rules["files.read"]).toBeUndefined();
  });

  it("cannot be turned into an allow through a prototype key", () => {
    // The file lives in the user's profile, so it is untrusted input as far as
    // the gate is concerned. A JSON key of `__proto__` must not reach Object
    // .prototype and be inherited by every capability.
    fs.mkdirSync(path.dirname(policyFile()), { recursive: true });
    fs.writeFileSync(policyFile(), JSON.stringify({ version: 1, policy: { scopes: { global: { __proto__: { "files.read": "allow" } } } } }), "utf-8");
    const rules = loadPermissionPolicy(dir).scopes.global ?? {};
    expect(Object.prototype.hasOwnProperty.call(rules, "files.read")).toBe(false);
    expect(effectiveMode(dir, "files.read")).not.toBe("allow");
  });

  it("returns an empty policy when the directory does not exist", () => {
    const missing = path.join(dir, "nope", "deeper");
    expect(loadPermissionPolicy(missing)).toEqual(emptyPolicy());
  });

  it("rejects a relative project scope instead of storing a rule that can never match", () => {
    // Handled by `isPermissionScope` at the IPC boundary; asserted here through
    // the same validator so the store and the boundary cannot disagree.
    expect(isPermissionScope({ kind: "project", root: "relative/path" })).toBe(false);
    expect(isPermissionScope({ kind: "project", root: path.join(dir, "ok") })).toBe(true);
  });
});

function effectiveMode(dir: string, capability: Capability) {
  return permissionMatrix(dir, { scope: GLOBAL }).modes[capability];
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

describe("Phase 23 · the panel's matrix is the gate's answer", () => {
  it("reports the built-in default for every capability it has never been told about", () => {
    const matrix = permissionMatrix(dir, { scope: GLOBAL });
    expect(matrix.capabilities.length).toBe(ALL_CAPABILITIES.length);
    for (const capability of ALL_CAPABILITIES) {
      expect(matrix.modes[capability], capability).toBe(DEFAULT_CAPABILITY_MODES[capability]);
      expect(matrix.own[capability], capability).toBeUndefined();
    }
    expect(matrix.configured).toBe(false);
  });

  it("separates the rule stored in this scope from the effective one", () => {
    // The user narrows one project to deny while allowing it globally. Showing
    // only the effective mode would hide that the *global* allow is still there,
    // and the panel would look like a single source of truth when it is not.
    const root = path.join(dir, "proj");
    savePermissionRule(dir, GLOBAL, "files.read", "allow");
    savePermissionRule(dir, project(root), "files.read", "deny");
    const matrix = permissionMatrix(dir, { scope: project(root), workspace: root });
    expect(matrix.own["files.read"]).toBe("deny");
    expect(matrix.modes["files.read"]).toBe("deny");

    const globalView = permissionMatrix(dir, { scope: GLOBAL, workspace: root });
    expect(globalView.own["files.read"]).toBe("allow");
    // …and the global view still shows the narrower project's deny winning,
    // because that is what a run in this project will actually get.
    expect(globalView.modes["files.read"]).toBe("deny");
  });

  it("marks a scope as configured only when it holds a rule", () => {
    expect(permissionMatrix(dir, { scope: agentScope("plan") }).configured).toBe(false);
    savePermissionRule(dir, agentScope("plan"), "agent.spawn", "deny");
    expect(permissionMatrix(dir, { scope: agentScope("plan") }).configured).toBe(true);
  });

  it("lists every scope that has rules, for the 'configured for' summary", () => {
    const root = path.join(dir, "proj");
    savePermissionRule(dir, GLOBAL, "files.read", "allow");
    savePermissionRule(dir, project(root), "shell.exec", "deny");
    const scopes = configuredScopes(dir);
    expect(scopes).toContain("global");
    expect(scopes.some((s) => s.startsWith("project:"))).toBe(true);
    // A scope whose rules were all removed must not linger in the list.
    clearPermissionScope(dir, project(root));
    expect(configuredScopes(dir)).toEqual(["global"]);
  });

  it("agrees with the pure model, because it calls it", () => {
    const policy = setRule(setRule(emptyPolicy(), GLOBAL, "files.write", "deny"), agentScope("review"), "network.fetch", "allow");
    savePermissionPolicy(dir, policy);
    const viaStore = permissionMatrix(dir, { scope: GLOBAL, agentId: "review" }).modes;
    expect(viaStore["files.write"]).toBe("deny");
    expect(viaStore["network.fetch"]).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// The store is not the gate
// ---------------------------------------------------------------------------

describe("Phase 23 · the store cannot widen anything on its own", () => {
  it("keeps the irreversible defaults denied until they are named explicitly", () => {
    // Writing a policy that mentions only safe capabilities must not accidentally
    // re-open the dangerous ones, which is the failure mode a "replace whole
    // policy" save would have.
    savePermissionPolicy(
      dir,
      setRule(setRule(emptyPolicy(), GLOBAL, "files.read", "allow"), GLOBAL, "files.write", "allow"),
    );
    for (const capability of IRREVERSIBLE_CAPABILITIES) {
      expect(effectiveMode(dir, capability), capability).toBe("deny");
    }
  });
});
