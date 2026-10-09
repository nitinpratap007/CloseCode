// Close Code — Phase 22: tool registry, validation and structured results
//
// The Phase 21 suite covers the runtime and the six original tools. This file
// covers what Phase 22 added on top:
//
//   * the schema validator, which Phase 21 declared but never enforced;
//   * the structured outcome, so callers can branch on a code instead of
//     re-parsing English;
//   * every new tool, against real filesystem / real git-service behaviour
//     rather than mocks of themselves.
//
// No tool in the agent layer imports `electron`, which is what lets this whole
// file run in plain Node. The browser tool is exercised against a fake
// `BrowserController` for the same reason.

import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

import { ToolRegistry, createBuiltinRegistry, confineToWorkspace } from "../electron/services/agent/tools";
import { formatIssues, schemaIsMeaningful, validateArgs } from "../electron/services/agent/schema";
import { deniedResult, errorResult, isRecoverableCode, normalizeOutcome, okResult } from "../electron/services/agent/result";
import { editFileTool, grepFilesTool } from "../electron/services/agent/tools-files";
import { GIT_TOOLS } from "../electron/services/agent/tools-git";
import { PROJECT_TOOLS } from "../electron/services/agent/tools-project";
import { WEB_TOOLS, htmlToText } from "../electron/services/agent/tools-web";
import { createBrowserTool, unavailableBrowserController } from "../electron/services/agent/tools-browser";
import type { BrowserController, BrowserPage } from "../electron/services/agent/tools-browser";
import type { AgentTool, AgentToolCategory, AgentToolContext, AgentToolOutcome } from "../electron/services/agent/types";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const temps: string[] = [];

function tempWorkspace(prefix = "cc-p22-"): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length) {
    const dir = temps.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface CtxOptions {
  workspace?: string | null;
  granted?: boolean;
  signal?: AbortSignal;
  webSearch?: { apiKey: string | null; endpoint?: string };
  confineTo?: string | null;
}

function makeCtx(over: CtxOptions = {}): AgentToolContext & { authorize: ReturnType<typeof vi.fn> } {
  const workspace = over.workspace ?? null;
  return {
    runId: "run-1",
    agentId: "default",
    workspace,
    signal: over.signal ?? new AbortController().signal,
    deadline: Date.now() + 10_000,
    maxOutputChars: 20_000,
    authorize: vi.fn(async () => over.granted ?? true),
    log: vi.fn(),
    spawnChild: vi.fn(),
    confine: (p: string) => confineToWorkspace(p, over.confineTo === undefined ? workspace : over.confineTo),
    ...(over.webSearch ? { webSearch: over.webSearch } : {}),
  } as AgentToolContext & { authorize: ReturnType<typeof vi.fn> };
}

/**
 * Invoke one tool the way production does — through the registry, not by
 * calling `execute` directly. That is the point: a tool that only works when
 * its `execute` is called by hand is not actually wired up, and this helper
 * makes that impossible to miss.
 */
function call(target: AgentTool, args: Record<string, unknown>, over: CtxOptions = {}): Promise<AgentToolOutcome> {
  // `extra` is required: the browser tool is injected rather than part of
  // BUILTIN_TOOLS, so a registry built without it answers `unknown_tool` and
  // every browser assertion would silently pass against the wrong thing.
  return createBuiltinRegistry(false, [target]).invoke(target.name, args, makeCtx(over));
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe("Tool argument validation (Phase 22)", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string", minLength: 2, maxLength: 10 },
      count: { type: "integer", minimum: 1, maximum: 5 },
      mode: { type: "string", enum: ["read", "write"] },
      tags: { type: "array", items: { type: "string" } },
      slug: { type: "string", pattern: "^[a-z]+$" },
      deep: { type: "object", properties: { level: { type: "number" } } },
    },
    required: ["name"],
    additionalProperties: false,
  };

  it("accepts a well-formed argument object", () => {
    const r = validateArgs(schema, { name: "ok", count: 3, mode: "read", tags: ["a"], slug: "abc", deep: { level: 1 } });
    expect(r.ok).toBe(true);
  });

  it("rejects a missing required argument and names it", () => {
    const r = validateArgs(schema, { count: 2 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues[0].path).toBe("name");
    expect(r.issues[0].message).toMatch(/required/);
  });

  it("treats null as missing for a required argument", () => {
    // A model that sends `{"path": null}` means "no path", and saying "null is
    // not a string" would be technically true and useless.
    const r = validateArgs(schema, { name: null });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues[0].message).toMatch(/required/);
  });

  it("rejects a wrong type and reports what arrived instead", () => {
    const r = validateArgs(schema, { name: 123 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues[0].message).toContain("expected string, received number");
  });

  it("enforces integer bounds, not just number bounds", () => {
    expect(validateArgs(schema, { name: "ab", count: 0 }).ok).toBe(false);
    expect(validateArgs(schema, { name: "ab", count: 6 }).ok).toBe(false);
    // 2.5 is a valid number but not a valid integer, and a tool that indexes by
    // this would silently do the wrong thing.
    const fractional = validateArgs(schema, { name: "ab", count: 2.5 });
    expect(fractional.ok).toBe(false);
    expect(validateArgs(schema, { name: "ab", count: 2 }).ok).toBe(true);
  });

  it("enforces string length on both sides", () => {
    expect(validateArgs(schema, { name: "a" }).ok).toBe(false);
    expect(validateArgs(schema, { name: "abcdefghijk" }).ok).toBe(false);
  });

  it("enforces an enum and lists the allowed values", () => {
    const r = validateArgs(schema, { name: "ab", mode: "sideways" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues[0].message).toContain('"read"');
    expect(r.issues[0].message).toContain('"write"');
  });

  it("validates every element of an array, not just the array", () => {
    const r = validateArgs(schema, { name: "ab", tags: ["fine", 5] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues[0].path).toBe("tags[1]");
  });

  it("validates a nested object property", () => {
    const r = validateArgs(schema, { name: "ab", deep: { level: "high" } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues[0].path).toBe("level");
  });

  it("enforces a pattern", () => {
    expect(validateArgs(schema, { name: "ab", slug: "abc" }).ok).toBe(true);
    expect(validateArgs(schema, { name: "ab", slug: "ABC" }).ok).toBe(false);
  });

  it("rejects an undeclared argument when the schema closes the object", () => {
    const r = validateArgs(schema, { name: "ab", surprise: 1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues[0].message).toMatch(/not an accepted argument/);
  });

  it("allows an undeclared argument when the schema does not close the object", () => {
    // This is the default, and it matters: a too-strict default would reject
    // calls a provider legitimately adds fields to.
    const r = validateArgs({ type: "object", properties: { a: { type: "string" } } }, { a: "x", b: 1 });
    expect(r.ok).toBe(true);
  });

  it("fills declared defaults and does not mutate the caller's object", () => {
    const original = { name: "ab" };
    const r = validateArgs(
      { type: "object", properties: { name: { type: "string" }, limit: { type: "integer", default: 20 } } },
      original,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.limit).toBe(20);
    expect(original).toEqual({ name: "ab" });
  });

  it("does not overwrite a value the caller actually sent", () => {
    const r = validateArgs(
      { type: "object", properties: { limit: { type: "integer", default: 20 } } },
      { limit: 3 },
    );
    expect(r.ok && r.value.limit).toBe(3);
  });

  it("rejects non-object arguments as a whole rather than field by field", () => {
    for (const bad of ["a string", 42, true, ["a"]]) {
      const r = validateArgs(schema, bad);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.issues[0].message).toMatch(/must be an object/);
    }
  });

  it("treats a schema-less tool as accepting anything, because it declared nothing", () => {
    const r = validateArgs({ type: "object" }, { anything: true });
    expect(r.ok).toBe(true);
  });

  it("does not reject every call when a pattern is not a valid regex", () => {
    // A typo in a tool's own schema must not make the tool unusable. The tool is
    // the authority on its own argument; the validator refuses to guess.
    const r = validateArgs({ type: "object", properties: { v: { type: "string", pattern: "([unclosed" } } }, { v: "x" });
    expect(r.ok).toBe(true);
  });

  it("formats every issue on one line for the model", () => {
    const r = validateArgs(schema, { count: 99, mode: "nope" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const line = formatIssues(r.issues);
    expect(line).toContain("`name`");
    expect(line).toContain(";");
  });

  it("knows when a schema can actually reject something", () => {
    expect(schemaIsMeaningful({ type: "object", properties: { a: { type: "string" } } })).toBe(true);
    expect(schemaIsMeaningful({ type: "object", properties: {} })).toBe(false);
    expect(schemaIsMeaningful(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Structured results
// ---------------------------------------------------------------------------

describe("Structured tool results (Phase 22)", () => {
  it("gives a Phase 11-style outcome a correct status without rewriting its text", () => {
    const out = normalizeOutcome({ granted: true, text: "42 lines in x" }, "count_lines", 7);
    expect(out.text).toBe("42 lines in x");
    expect(out.status).toBe("ok");
    expect(out.meta).toMatchObject({ tool: "count_lines", durationMs: 7 });
  });

  it("derives `denied` from granted:false alone", () => {
    const out = normalizeOutcome({ granted: false, text: "Permission denied by policy or user." }, "x", 1);
    expect(out.status).toBe("denied");
    expect(out.error?.code).toBe("permission_denied");
  });

  it("derives `error` from a typed error, even when the status was omitted", () => {
    const out = normalizeOutcome(
      { granted: true, text: "Error: nope", error: { code: "not_found", message: "nope", recoverable: true } },
      "x",
      1,
    );
    expect(out.status).toBe("error");
  });

  it("invents a typed error rather than leaving status:error untyped", () => {
    // The whole point of the phase: no outcome may say "error" without saying why
    // in a form code can branch on.
    const out = normalizeOutcome({ granted: true, text: "something went wrong", status: "error" }, "x", 1);
    expect(out.error?.code).toBe("tool_failed");
    expect(out.error?.reportable).toBe(true);
  });

  it("treats a tool that returned nothing as a reportable failure, not a success", () => {
    const out = normalizeOutcome(undefined, "x", 1);
    expect(out.status).toBe("error");
    expect(out.error?.reportable).toBe(true);
  });

  it("marks a model-correctable failure recoverable and an internal one reportable", () => {
    expect(isRecoverableCode("invalid_input")).toBe(true);
    expect(isRecoverableCode("timeout")).toBe(true);
    expect(isRecoverableCode("permission_denied")).toBe(false);
    expect(isRecoverableCode("outside_workspace")).toBe(false);
    expect(errorResult("invalid_input", "bad args").error?.recoverable).toBe(true);
    expect(errorResult("tool_failed", "boom", { reportable: true }).error?.reportable).toBe(true);
  });

  it("keeps granted:true on a failure — the permission gate did allow the call", () => {
    // Conflating "refused" with "failed" is what would make a legitimate
    // recoverable error look to the user like their own policy blocked them.
    const out = errorResult("not_found", "no such file");
    expect(out.granted).toBe(true);
    expect(out.status).toBe("error");
    expect(deniedResult().granted).toBe(false);
    expect(deniedResult().status).toBe("denied");
  });

  it("preserves a tool's structured payload untouched", () => {
    const payload = { files: ["a", "b"] };
    const out = normalizeOutcome(okResult("a\nb", { data: payload }), "x", 1);
    expect(out.data).toBe(payload);
  });

  it("prefers the registry's timing over a self-reported one", () => {
    // A tool measuring only part of its own work would under-report; the
    // registry's clock covers validation too.
    const out = normalizeOutcome({ granted: true, text: "x", meta: { tool: "x", durationMs: 1 } }, "x", 99);
    expect(out.meta?.durationMs).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// The registry as the single door
// ---------------------------------------------------------------------------

describe("ToolRegistry is the one door (Phase 22)", () => {
  it("refuses to register an incomplete tool", () => {
    const registry = new ToolRegistry();
    const base: AgentTool = {
      name: "t",
      description: "does a thing",
      parameters: { type: "object", properties: {} },
      category: "files",
      readOnly: true,
      execute: async () => ({ granted: true, text: "" }),
    };
    // A tool with no description is invisible to the model, which is the one
    // thing a tool must never be.
    expect(() => registry.register({ ...base, description: "  " })).toThrow(/description/);
    // A category outside the permission model means no permission ever applies.
    expect(() => registry.register({ ...base, category: "net" as AgentToolCategory })).toThrow(/permission category/);
    // A non-object schema means validation silently accepts everything.
    expect(() => registry.register({ ...base, parameters: { type: "string" } })).toThrow(/JSON Schema object/);
    expect(() => registry.register({ ...base, parameters: undefined as never })).toThrow(/JSON Schema object/);
    expect(() => registry.register({ ...base, readOnly: "yes" as never })).toThrow(/readOnly/);
  });

  it("rejects invalid arguments before the tool body can run", async () => {
    const ran: string[] = [];
    const registry = new ToolRegistry([
      {
        name: "needs_path",
        description: "Takes a path.",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
        category: "files",
        readOnly: true,
        execute: async (_ctx, args) => {
          ran.push(String(args.path));
          return { granted: true, text: "ok" };
        },
      },
    ]);
    const out = await registry.invoke("needs_path", { path: 42 }, makeCtx());
    expect(ran).toEqual([]);
    expect(out.status).toBe("error");
    expect(out.error?.code).toBe("invalid_input");
    expect(out.text).toContain("invalid arguments");
  });

  it("shows the schema back to the model so it can correct itself", async () => {
    const out = await createBuiltinRegistry().invoke("git_commit", { message: "" }, makeCtx());
    expect(out.error?.code).toBe("invalid_input");
    expect(out.text).toContain("minLength");
    expect(out.error?.recoverable).toBe(true);
  });

  it("keeps the exact Phase 11 wording for an unknown tool", async () => {
    const out = await createBuiltinRegistry().invoke("teleport", {}, makeCtx());
    expect(out.text).toBe("Unknown tool: teleport");
    expect(out.error?.code).toBe("unknown_tool");
  });

  it("contains a throwing tool instead of letting it escape into the run", async () => {
    const registry = new ToolRegistry([
      {
        name: "boom",
        description: "Always fails.",
        parameters: { type: "object", properties: {} },
        category: "files",
        readOnly: true,
        execute: async () => {
          throw new Error("kaboom");
        },
      },
    ]);
    const out = await registry.invoke("boom", {}, makeCtx());
    expect(out.text).toBe("Error in boom: kaboom");
    expect(out.error?.code).toBe("tool_failed");
    // Only this kind of failure is shown to the user as a run error; a model
    // sending bad arguments must never raise a banner.
    expect(out.error?.reportable).toBe(true);
  });

  it("does not raise a run error for a model mistake", async () => {
    const out = await createBuiltinRegistry().invoke("read_file", { path: 5 }, makeCtx());
    expect(out.error?.reportable).toBeUndefined();
  });

  it("passes the validated arguments through, with defaults applied", async () => {
    let seen: Record<string, unknown> = {};
    const registry = new ToolRegistry([
      {
        name: "echo_defaults",
        description: "Echoes its arguments.",
        parameters: {
          type: "object",
          properties: { a: { type: "string" }, b: { type: "integer", default: 7 } },
          required: ["a"],
        },
        category: "files",
        readOnly: true,
        execute: async (_ctx, args) => {
          seen = args;
          return { granted: true, text: "ok" };
        },
      },
    ]);
    await registry.invoke("echo_defaults", { a: "x" }, makeCtx());
    expect(seen).toEqual({ a: "x", b: 7 });
  });

  it("asks the permission gate with the resolved arguments, defaults included", async () => {
    // Phase 21 passed the model's raw arguments to the gate. Phase 22 fills in
    // the schema's declared defaults first, so the approval prompt shows the
    // operation as it will actually run rather than a shorter version of it —
    // the user sees `limit: 200`, not an empty object that turns out to mean
    // "two hundred".
    //
    // The six Phase 21 tools declare no defaults, so their prompt text is
    // byte-identical to before; that regression is asserted in
    // agent-runtime.test.ts, not here.
    const ctx = makeCtx({ granted: true });
    await createBuiltinRegistry().invoke("grep_files", { pattern: "x" }, ctx);
    expect(ctx.authorize).toHaveBeenCalledWith("search", {
      pattern: "x",
      include: "",
      ignore_case: false,
      max_results: 50,
    });
  });

  it("leaves the caller's argument object untouched when filling defaults", async () => {
    const ctx = makeCtx({ granted: true });
    const args = { pattern: "x" };
    await createBuiltinRegistry().invoke("grep_files", args, ctx);
    expect(args).toEqual({ pattern: "x" });
  });

  it("validates before it prompts, so a doomed call never asks the user", async () => {
    const ctx = makeCtx({ granted: true });
    const out = await createBuiltinRegistry().invoke("write_file", {}, ctx);
    expect(out.error?.code).toBe("invalid_input");
    expect(ctx.authorize).not.toHaveBeenCalled();
  });

  it("describes the whole tool set for a UI, with no executable code in it", () => {
    const described = createBuiltinRegistry().describe();
    expect(described.length).toBe(createBuiltinRegistry().size);
    const readFile = described.find((d) => d.name === "read_file");
    expect(readFile).toMatchObject({ category: "files", readOnly: true, destructive: false });
    expect(readFile?.required).toEqual(["path"]);
    expect(readFile?.parameters).toEqual(["path:string"]);
    expect(JSON.stringify(described)).not.toContain("function");
  });
});

// ---------------------------------------------------------------------------
// The tool surface itself
// ---------------------------------------------------------------------------

describe("Tool inventory (Phase 22)", () => {
  /**
   * The inventory is only meaningful against the registry the app actually
   * builds: `createDefaultRegistry()` adds `delegate_task` and the browser tool
   * on top of `BUILTIN_TOOLS`. Checking a bare `createBuiltinRegistry()` would
   * silently omit two tools *and* an entire permission category, and the test
   * would still pass.
   */
  function fullRegistry(): ToolRegistry {
    return createBuiltinRegistry(true, [
      createBrowserTool({ available: () => true, unavailableReason: () => "", page: async () => ({}) as BrowserPage }),
    ]);
  }

  it("covers every permission category the settings UI offers", () => {
    const categories = new Set(fullRegistry().describe().map((d) => d.category));
    // A category with no tool is a permission the user can configure that does
    // nothing; a tool with no category is a permission that cannot be granted.
    for (const c of ["files", "terminal", "search", "git", "agent", "web", "browser"]) {
      expect(categories.has(c as AgentToolCategory)).toBe(true);
    }
  });

  it("registers every tool the user's list asked for", () => {
    const names = fullRegistry().names();
    for (const expected of [
      // files / read / write / edit
      "read_file", "write_file", "edit_file", "list_dir",
      // search / grep
      "search_files", "grep_files",
      // git
      "git_status", "git_diff", "git_log", "git_branches", "git_stage", "git_commit", "git_create_branch", "git_checkout",
      // terminal / task / LSP
      "run_terminal", "delegate_task", "run_tests", "run_build",
      // project / diagnostics
      "project_inspection", "type_diagnostics",
      // web
      "web_fetch", "web_search",
      // browser
      "browser",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("keeps destructive tools out of the read-only set", () => {
    const registry = fullRegistry();
    // A read-only agent getting `write_file` would break the promise the
    // `plan` and `review` definitions make to the user.
    const writeFile = registry.get("write_file");
    expect(writeFile?.readOnly).toBe(false);
    expect(writeFile?.destructive).toBe(true);
    for (const name of ["read_file", "list_dir", "search_files", "grep_files", "git_status", "git_diff"]) {
      expect(registry.get(name)?.readOnly).toBe(true);
    }
  });

  it("gives every tool a description, because that is all the model sees", () => {
    for (const d of fullRegistry().describe()) {
      expect(d.description.trim().length).toBeGreaterThan(10);
    }
  });

  it("asks for permission under the category the tool declares", async () => {
    const registry = fullRegistry();
    const cases: Array<[string, AgentToolCategory, Record<string, unknown>]> = [
      ["read_file", "files", { path: "a" }],
      ["grep_files", "search", { pattern: "x" }],
      ["git_branches", "git", {}],
      ["web_fetch", "web", { url: "https://example.com" }],
      ["run_terminal", "terminal", { command: "echo hi" }],
    ];
    for (const [name, category, args] of cases) {
      const ctx = makeCtx({ granted: true });
      await registry.invoke(name, args, ctx);
      // Phase 23. `read_file` and `browser` now pass a third argument carrying
      // the resolved path (or the per-call capabilities), which is what lets the
      // gate apply a `path`-scoped rule and a per-action browser permission.
      // The first two arguments are unchanged, so the assertion checks them
      // positionally rather than demanding the whole call match exactly.
      const call = ctx.authorize.mock.calls[0];
      expect(call, `${name} must ask for ${category}`).toBeDefined();
      expect(call?.[0], `${name} category`).toBe(category);
      expect(call?.[1], `${name} args`).toEqual(expect.objectContaining(args));
    }
  });
});

// ---------------------------------------------------------------------------
// edit_file
// ---------------------------------------------------------------------------

describe("edit_file (Phase 22)", () => {
  const setUp = (body: string) => {
    const root = tempWorkspace();
    const file = path.join(root, "notes.txt");
    fs.writeFileSync(file, body, "utf-8");
    return { root, file };
  };

  it("replaces a unique span and reports where", async () => {
    const { root, file } = setUp("alpha\nbeta\ngamma\n");
    const out = await call(editFileTool, { path: file, find: "beta", replace: "BETA" }, { workspace: root });
    expect(out.status).toBe("ok");
    expect(fs.readFileSync(file, "utf-8")).toBe("alpha\nBETA\ngamma\n");
    expect(out.text).toContain("1 occurrence");
    expect(out.text).toContain("line 2");
    expect((out.data as { replacements: number }).replacements).toBe(1);
  });

  it("refuses an ambiguous edit and writes nothing", async () => {
    // This is the property that makes the tool safe: a model that has not been
    // specific enough gets a refusal, not a corrupted file.
    const { root, file } = setUp("x\nx\n");
    const out = await call(editFileTool, { path: file, find: "x", replace: "y" }, { workspace: root });
    expect(out.status).toBe("error");
    expect(out.error?.code).toBe("conflict");
    expect(out.error?.recoverable).toBe(true);
    expect(out.text).toContain("line(s) 1, 2");
    expect(fs.readFileSync(file, "utf-8")).toBe("x\nx\n");
  });

  it("replaces every occurrence when asked to, and says how many", async () => {
    const { root, file } = setUp("x\nx\nx\n");
    const out = await call(editFileTool, { path: file, find: "x", replace: "y", replace_all: true }, { workspace: root });
    expect(fs.readFileSync(file, "utf-8")).toBe("y\ny\ny\n");
    expect(out.text).toContain("3 occurrences");
  });

  it("reports a missing span as not-found, not as a write failure", async () => {
    const { root, file } = setUp("alpha\n");
    const out = await call(editFileTool, { path: file, find: "omega", replace: "z" }, { workspace: root });
    expect(out.error?.code).toBe("not_found");
    expect(out.text).toContain("Nothing was written");
  });

  it("does not treat the replacement text as a pattern", async () => {
    // `$&` and `$1` are special to String.replace; a literal edit must be literal.
    const { root, file } = setUp("value = old\n");
    await call(editFileTool, { path: file, find: "old", replace: "$&new" }, { workspace: root });
    expect(fs.readFileSync(file, "utf-8")).toBe("value = $&new\n");
  });

  it("refuses a path outside the workspace", async () => {
    const root = tempWorkspace();
    const out = await call(editFileTool, { path: path.join(root, "..", "escape.txt"), find: "a", replace: "b" }, { workspace: root });
    expect(out.error?.code).toBe("outside_workspace");
  });

  it("refuses to edit a directory", async () => {
    const root = tempWorkspace();
    const out = await call(editFileTool, { path: root, find: "a", replace: "b" }, { workspace: root });
    expect(out.error?.code).toBe("invalid_input");
  });

  it("is a no-op when the permission gate refuses", async () => {
    const { root, file } = setUp("alpha\n");
    const out = await call(editFileTool, { path: file, find: "alpha", replace: "BETA" }, { workspace: root, granted: false });
    expect(out.status).toBe("denied");
    expect(out.granted).toBe(false);
    expect(fs.readFileSync(file, "utf-8")).toBe("alpha\n");
  });
});

// ---------------------------------------------------------------------------
// grep_files
// ---------------------------------------------------------------------------

describe("grep_files (Phase 22)", () => {
  it("returns file:line hits for a real pattern", async () => {
    const root = tempWorkspace();
    fs.writeFileSync(path.join(root, "a.ts"), "const one = 1;\nconst two = 2;\n", "utf-8");
    fs.writeFileSync(path.join(root, "b.ts"), "const one = 1;\n", "utf-8");
    const out = await call(grepFilesTool, { pattern: "const (one|two)" }, { workspace: root });
    expect(out.status).toBe("ok");
    expect(out.text).toContain("a.ts:1:");
    expect(out.text).toContain("a.ts:2:");
    expect(out.text).toContain("b.ts:1:");
    expect((out.meta?.count ?? 0) >= 3).toBe(true);
  });

  it("reports an invalid regex as a typed input error, not a crash", async () => {
    const root = tempWorkspace();
    const out = await call(grepFilesTool, { pattern: "([unclosed" }, { workspace: root });
    expect(out.error?.code).toBe("invalid_input");
    expect(out.error?.recoverable).toBe(true);
    expect(out.text).toContain("not a valid regular expression");
  });

  it("honours an include filter", async () => {
    const root = tempWorkspace();
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "a.ts"), "needle\n", "utf-8");
    fs.writeFileSync(path.join(root, "b.txt"), "needle\n", "utf-8");
    const out = await call(grepFilesTool, { pattern: "needle", include: "src/" }, { workspace: root });
    expect(out.text).toContain("src/a.ts");
    expect(out.text).not.toContain("b.txt");
  });

  it("respects the case-sensitivity flag", async () => {
    const root = tempWorkspace();
    fs.writeFileSync(path.join(root, "a.txt"), "Needle\n", "utf-8");
    expect((await call(grepFilesTool, { pattern: "needle" }, { workspace: root })).status).toBe("ok");
    expect((await call(grepFilesTool, { pattern: "needle" }, { workspace: root })).text).toContain("No match");
    expect((await call(grepFilesTool, { pattern: "needle", ignore_case: true }, { workspace: root })).text).toContain("a.txt:1");
  });

  it("caps results and says so rather than pretending the search was complete", async () => {
    const root = tempWorkspace();
    fs.writeFileSync(path.join(root, "big.txt"), `${"needle\n".repeat(500)}`, "utf-8");
    const out = await call(grepFilesTool, { pattern: "needle", max_results: 5 }, { workspace: root });
    expect(out.text).toContain("showing the first");
    expect((out.data as { truncated: boolean }).truncated).toBe(true);
  });

  it("caps per file, so one huge file cannot hide every other match", async () => {
    const root = tempWorkspace();
    fs.writeFileSync(path.join(root, "aaa.txt"), `${"needle\n".repeat(400)}`, "utf-8");
    fs.writeFileSync(path.join(root, "zzz.txt"), "needle\n", "utf-8");
    const out = await call(grepFilesTool, { pattern: "needle" }, { workspace: root });
    expect(out.text).toContain("zzz.txt:1");
  });

  it("does not search node_modules or .git", async () => {
    const root = tempWorkspace();
    fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "needle\n", "utf-8");
    const out = await call(grepFilesTool, { pattern: "needle" }, { workspace: root });
    expect(out.text).toContain("No match");
  });

  it("reports having no workspace instead of searching nothing", async () => {
    const out = await call(grepFilesTool, { pattern: "x" }, { workspace: null });
    expect(out.error?.code).toBe("no_workspace");
  });
});

// ---------------------------------------------------------------------------
// project_inspection
// ---------------------------------------------------------------------------

describe("project_inspection (Phase 22)", () => {
  const toolOf = PROJECT_TOOLS.find((t) => t.name === "project_inspection")!;

  it("reports a real manifest honestly", async () => {
    const root = tempWorkspace();
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "demo", version: "1.2.3", dependencies: { react: "18" }, scripts: { build: "tsc" } }),
      "utf-8",
    );
    const out = await call(toolOf, {}, { workspace: root });
    expect(out.text).toContain("name: demo");
    expect(out.text).toContain("version: 1.2.3");
    expect(out.text).toContain("runtime dependencies (1): react");
    expect(out.text).toContain('npm scripts (1): build');
  });

  it("says plainly when the folder is not an npm project", async () => {
    const root = tempWorkspace();
    const out = await call(toolOf, {}, { workspace: root });
    expect(out.text).toContain("No package.json found");
    expect(out.text).toContain("not an npm project");
  });

  it("reports an unparseable manifest rather than a project with no dependencies", async () => {
    const root = tempWorkspace();
    fs.writeFileSync(path.join(root, "package.json"), "{ this is not json", "utf-8");
    const out = await call(toolOf, {}, { workspace: root });
    expect(out.text).toContain("could not be parsed");
  });

  it("lists config files and structure without walking the whole tree", async () => {
    const root = tempWorkspace();
    fs.writeFileSync(path.join(root, "tsconfig.json"), "{}", "utf-8");
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "main.ts"), "", "utf-8");
    const out = await call(toolOf, {}, { workspace: root });
    expect(out.text).toContain("tsconfig.json");
    expect(out.text).toContain("src/");
  });
});

// ---------------------------------------------------------------------------
// run_tests / run_build
// ---------------------------------------------------------------------------

describe("npm script tools (Phase 22)", () => {
  const tests = PROJECT_TOOLS.find((t) => t.name === "run_tests")!;
  const build = PROJECT_TOOLS.find((t) => t.name === "run_build")!;

  it("runs a declared script and reports a non-zero exit as a result, not a failure", async () => {
    // `npm test` exiting 1 because a test failed is the single most important
    // thing this tool can tell the model. Reporting it as a tool error would
    // hide that behind a "the tool broke" framing.
    const root = tempWorkspace();
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "d", version: "1.0.0", scripts: { test: "node -e \"console.log('1 failed');process.exit(1)\"" } }),
      "utf-8",
    );
    const out = await call(tests, {}, { workspace: root });
    expect(out.status).toBe("ok");
    expect(out.text).toContain("exited with code 1");
    expect(out.text).toContain("1 failed");
    expect((out.data as { exitCode: number }).exitCode).toBe(1);
  });

  it("lists the real scripts when the requested one does not exist", async () => {
    const root = tempWorkspace();
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "d", version: "1.0.0", scripts: { lint: "x" } }), "utf-8");
    const out = await call(build, {}, { workspace: root });
    expect(out.error?.code).toBe("not_found");
    expect(out.text).toContain("Available scripts: lint");
  });

  it("cannot be used as a disguised run_terminal", async () => {
    // It takes no arguments at all, so there is no way to smuggle a command in.
    expect(tests.parameters).toMatchObject({ type: "object", additionalProperties: false });
    expect(build.parameters).toMatchObject({ type: "object", additionalProperties: false });
    const out = await createBuiltinRegistry().invoke("run_tests", { command: "rm -rf /" }, makeCtx({ workspace: null }));
    expect(out.error?.code).toBe("invalid_input");
  });

  it("asks the terminal permission, not a category of its own", async () => {
    const ctx = makeCtx({ granted: true });
    await createBuiltinRegistry().invoke("run_tests", {}, ctx);
    expect(ctx.authorize).toHaveBeenCalledWith("terminal", {});
  });
});

// ---------------------------------------------------------------------------
// type_diagnostics
// ---------------------------------------------------------------------------

describe("type_diagnostics (Phase 22)", () => {
  const diag = PROJECT_TOOLS.find((t) => t.name === "type_diagnostics")!;

  it("refuses to report success when there is no tsconfig to check against", async () => {
    // The most dangerous possible lie here: `tsc` with no tsconfig compiles
    // nothing and exits 0, which would read as "no errors".
    const root = tempWorkspace();
    const out = await call(diag, {}, { workspace: root });
    expect(out.error?.code).toBe("not_found");
    expect(out.text).toContain("check nothing");
  });

  it("reports a real compile error with its file, line and code", async () => {
    const root = tempWorkspace();
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "d", version: "1.0.0", devDependencies: { typescript: "*" } }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true }, include: ["a.ts"] }),
      "utf-8",
    );
    fs.writeFileSync(path.join(root, "a.ts"), "const n: number = \"not a number\";\n", "utf-8");
    // Link this repo's own TypeScript rather than installing one, so the test is
    // offline and still runs the real compiler.
    //
    // `fileURLToPath`, not `new URL(...).pathname`: on Windows the latter is
    // `/E:/closecode/tests`, which is not a path anything can open.
    //
    // A directory junction is used rather than a hand-picked file copy. Copying
    // "the tsc files" means guessing which of the ~18 MB under
    // `node_modules/typescript/lib` the compiler requires — miss one and the
    // test fails with `Cannot find module './_tsc.js'`, which is a fact about
    // the fixture, not about the tool.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const realTscDir = path.join(here, "..", "node_modules", "typescript");
    const realTsc = path.join(realTscDir, "bin", "tsc");
    if (!fs.existsSync(realTsc)) {
      // TypeScript is not installed in this checkout; the refusal path above is
      // still covered, and saying so beats asserting a result we cannot produce.
      ctx.skip();
      return;
    }
    const link = path.join(root, "node_modules", "typescript");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    try {
      fs.symlinkSync(realTscDir, link, "junction");
    } catch {
      // Junctions need a filesystem that supports them. Copying the whole
      // compiler is slow but unconditional.
      fs.cpSync(realTscDir, link, { recursive: true });
    }
    const out = await call(diag, {}, { workspace: root });
    expect(out.status).toBe("ok");
    expect(out.text).toContain("TS2322");
    expect(out.text).toContain("a.ts(1,");
    expect((out.data as { diagnostics: unknown[] }).diagnostics.length).toBeGreaterThan(0);
  }, 120_000);

  it("reports a compiler that died silently as a failure, not as 'no errors'", async () => {
    // The second-worst possible lie in this tool: a broken compiler install
    // exits non-zero with nothing on stdout, and "nothing to report" would be
    // indistinguishable from a clean type-check.
    const root = tempWorkspace();
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "d", version: "1.0.0" }), "utf-8");
    fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ include: ["a.ts"] }), "utf-8");
    fs.writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n", "utf-8");
    // A `tsc` that exists, is not a script, and says nothing when run.
    const bin = path.join(root, "node_modules", "typescript", "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "tsc"), "process.exit(2);\n", "utf-8");
    const out = await call(diag, {}, { workspace: root });
    expect(out.status).toBe("error");
    expect(out.error?.code).toBe("tool_failed");
    expect(out.text).not.toContain("No TypeScript errors.");
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Web tools
// ---------------------------------------------------------------------------

describe("Web tools (Phase 22)", () => {
  const fetchTool = WEB_TOOLS.find((t) => t.name === "web_fetch")!;
  const searchTool = WEB_TOOLS.find((t) => t.name === "web_search")!;

  it("refuses a non-http scheme before any request is made", async () => {
    // `file://` through a fetch tool would be a workspace-confinement bypass:
    // a path the file tools refuse would be readable through a URL.
    const out = await call(fetchTool, { url: "file:///C:/Windows/win.ini" }, { workspace: null });
    expect(out.error?.code).toBe("invalid_input");
    expect(out.text).toContain("Only http and https");
  });

  it("refuses a malformed URL without throwing", async () => {
    const out = await call(fetchTool, { url: "not a url" }, { workspace: null });
    expect(out.error?.code).toBe("invalid_input");
  });

  it("refuses web_search with no key rather than inventing results", async () => {
    const out = await call(searchTool, { query: "typescript" }, { workspace: null, webSearch: { apiKey: null } });
    expect(out.status).toBe("error");
    expect(out.error?.code).toBe("unavailable");
    expect(out.text).toContain("none is configured");
    expect(out.text).toContain("does not guess");
    expect(out.text).not.toMatch(/https?:\/\//);
  });

  it("refuses web_search when the runtime supplied no search config at all", async () => {
    const out = await call(searchTool, { query: "typescript" }, { workspace: null });
    expect(out.error?.code).toBe("unavailable");
  });

  it("asks for the web permission, not the search permission", async () => {
    // Sharing `search` with the in-workspace tools would let an `allow` on
    // search silently permit sending data off the machine.
    const ctx = makeCtx({ granted: true });
    await createBuiltinRegistry().invoke("web_fetch", { url: "https://example.com" }, ctx);
    expect(ctx.authorize).toHaveBeenCalledWith("web", expect.objectContaining({ url: "https://example.com" }));
  });

  it("turns a page into readable text without pretending to be a parser", async () => {
    const text = htmlToText(
      "<!doctype html><html><head><style>b{}</style><script>evil()</script></head>" +
        "<body><h1>Title</h1><p>First&nbsp;line &amp; more</p><script>bad()</script></body></html>",
    );
    expect(text).toContain("Title");
    expect(text).toContain("First line & more");
    expect(text).not.toContain("evil()");
    expect(text).not.toContain("bad()");
  });
});

// ---------------------------------------------------------------------------
// Browser tool
// ---------------------------------------------------------------------------

describe("browser tool (Phase 22)", () => {
  interface FakePageState {
    url: string;
    title: string;
    body: string;
  }

  function fakeController(): { controller: BrowserController; state: FakePageState; calls: string[] } {
    const state: FakePageState = { url: "", title: "", body: "" };
    const calls: string[] = [];
    const page: BrowserPage = {
      goto: async (url) => {
        calls.push(`goto:${url}`);
        state.url = url;
        state.title = "Example Domain";
        state.body = "Hello from the page";
        return { finalUrl: url, status: 200, title: state.title };
      },
      text: async () => {
        calls.push("text");
        return state.body;
      },
      click: async (selector) => {
        calls.push(`click:${selector}`);
        if (selector === "#missing") throw new Error("no such element: #missing");
        state.body = "clicked";
      },
      type: async (selector, value) => {
        calls.push(`type:${selector}:${value}`);
      },
      attr: async (_selector, name) => {
        calls.push(`attr:${name}`);
        return name === "value" ? "42" : null;
      },
      currentUrl: async () => state.url,
      screenshot: async () => {
        calls.push("screenshot");
        return { pngBase64: "AAAA", bytes: 3 };
      },
      close: async () => {
        calls.push("close");
        state.url = "";
      },
    };
    return { controller: { available: () => true, unavailableReason: () => "", page: async () => page }, state, calls };
  }

  it("opens a page and reads it", async () => {
    const { controller, calls } = fakeController();
    const browser = createBrowserTool(controller);
    const opened = await call(browser, { action: "open", url: "https://example.com" }, { workspace: null });
    expect(opened.status).toBe("ok");
    expect(opened.text).toContain("Example Domain");
    const read = await call(browser, { action: "read" }, { workspace: null });
    expect(read.text).toContain("Hello from the page");
    // One window across calls is what makes the second call mean anything.
    // The URL is compared in its normalised form: the tool parses the input
    // through `new URL()`, and `https://example.com` becomes
    // `https://example.com/` before it is ever handed to Chromium — which is
    // what a real `load` event reports back too.
    expect(calls).toEqual(["goto:https://example.com/", "text"]);
  });

  it("refuses a non-http URL", async () => {
    const { controller } = fakeController();
    const out = await call(createBrowserTool(controller), { action: "open", url: "file:///C:/x" }, { workspace: null });
    expect(out.error?.code).toBe("invalid_input");
  });

  it("rejects an unknown action at validation time, naming the valid ones", async () => {
    const { controller } = fakeController();
    const out = await call(createBrowserTool(controller), { action: "teleport" }, { workspace: null });
    expect(out.error?.code).toBe("invalid_input");
    expect(out.text).toContain("must be one of");
  });

  it("explains a missing selector in terms of the page, not the selector", async () => {
    const { controller } = fakeController();
    const out = await call(createBrowserTool(controller), { action: "click", selector: "#missing" }, { workspace: null });
    expect(out.error?.code).toBe("tool_failed");
    expect(out.error?.hint).toMatch(/selector did not match/);
  });

  it("requires a selector for the actions that need one", async () => {
    const { controller } = fakeController();
    const out = await call(createBrowserTool(controller), { action: "click" }, { workspace: null });
    expect(out.error?.code).toBe("invalid_input");
    expect(out.text).toContain("requires a CSS");
  });

  it("asks for the browser permission, separately from web", async () => {
    const { controller } = fakeController();
    const ctx = makeCtx({ granted: true });
    await createBuiltinRegistry(true, [createBrowserTool(controller)]).invoke("browser", { action: "open", url: "https://x.dev" }, ctx);
    // Phase 23. `open` only navigates, so it adds no capability beyond the
    // tool's declared `browser.navigate`.
    const call = ctx.authorize.mock.calls[0];
    expect(call?.[0]).toBe("browser");
    expect(call?.[1]).toEqual(expect.objectContaining({ action: "open" }));
    expect(call?.[2]?.capabilities).toEqual([]);
  });

  it("adds the interaction capability only for the actions that drive the page", async () => {
    // A user who allows navigation but not interaction can let an agent read a
    // page and refuse to let it submit the form. `click` and `type` are the
    // actions that change something on the far side; `open`, `text` and
    // `screenshot` only pull content in.
    for (const action of ["click", "type"]) {
      const { controller } = fakeController();
      const ctx = makeCtx({ granted: true });
      await createBuiltinRegistry(true, [createBrowserTool(controller)]).invoke(
        "browser",
        { action, selector: "button", text: "hello" },
        ctx,
      );
      expect(ctx.authorize.mock.calls[0]?.[2]?.capabilities, action).toEqual(["browser.interact"]);
    }
    // The real action names, so this is checking the capability split rather than
    // a schema rejection: `text` and `current` are not actions, and an
    // unrecognised action is refused before the gate is ever reached.
    for (const action of ["open", "read", "screenshot", "close"]) {
      const { controller } = fakeController();
      const ctx = makeCtx({ granted: true });
      await createBuiltinRegistry(true, [createBrowserTool(controller)]).invoke(
        "browser",
        { action, url: "https://x.dev", selector: "h1", name: "id" },
        ctx,
      );
      expect(ctx.authorize.mock.calls[0]?.[2]?.capabilities, action).toEqual([]);
    }
  });

  it("tells the model exactly why browsing is unavailable instead of vanishing", async () => {
    const browser = createBrowserTool(unavailableBrowserController("no window is open"));
    const out = await call(browser, { action: "open", url: "https://example.com" }, { workspace: null });
    expect(out.error?.code).toBe("not_supported");
    expect(out.text).toContain("no window is open");
    expect(out.error?.hint).toContain("web_fetch");
  });

  it("cannot read the workspace — it takes no path argument at all", async () => {
    const { controller } = fakeController();
    const out = await call(createBrowserTool(controller), { action: "read", path: "C:/secret.txt" }, { workspace: null });
    expect(out.error?.code).toBe("invalid_input");
  });
});

// ---------------------------------------------------------------------------
// Git tools
// ---------------------------------------------------------------------------

describe("Git tools (Phase 22)", () => {
  const names = GIT_TOOLS.map((t) => t.name);
  const pick = (n: string) => GIT_TOOLS.find((t) => t.name === n)!;

  it("registers the real read-only and mutating git operations", () => {
    expect(names).toEqual(
      ["git_diff", "git_log", "git_branches", "git_stage", "git_commit", "git_create_branch", "git_checkout", "git_remotes", "git_merge_conflicts", "git_conflict_resolution_suggest", "git_branch_tracking", "git_commit_message_suggest", "git_history_analyze", "git_repo_understand"],
    );
    for (const name of ["git_diff", "git_log", "git_branches", "git_remotes", "git_merge_conflicts", "git_conflict_resolution_suggest", "git_branch_tracking", "git_commit_message_suggest", "git_history_analyze", "git_repo_understand"]) {
      expect(pick(name).readOnly).toBe(true);
    }
    for (const name of ["git_stage", "git_commit", "git_create_branch", "git_checkout"]) {
      expect(pick(name).readOnly).toBe(false);
    }
  });

  it("does not expose a tool that destroys work", () => {
    // `git_reset` and `git_clean` discard uncommitted work, and the Git panel
    // confirms neither. A model must not be able to do what the UI will not.
    expect(names).not.toContain("git_reset");
    expect(names).not.toContain("git_clean");
  });

  it("says when the folder is not a repository, rather than failing obscurely", async () => {
    const root = tempWorkspace();
    const out = await call(pick("git_branches"), {}, { workspace: root });
    // Either git is absent from this machine, or the folder is not a repo. Both
    // are a typed, explained refusal — never a silent empty result.
    expect(["not_supported", "not_found"]).toContain(out.error?.code);
    expect(out.text).toMatch(/not installed|not a git repository/);
  });

  it("will not unstage the whole repository implicitly", async () => {
    const root = tempWorkspace();
    const out = await call(pick("git_stage"), { unstage: true }, { workspace: root });
    // Checked before touching the repository, so the refusal is the same
    // whether or not this folder happens to be a repo.
    expect(out.error?.code).toBe("invalid_input");
  });

  it("asks for the git permission for each of them", async () => {
    const ctx = makeCtx({ granted: true });
    await createBuiltinRegistry().invoke("git_diff", {}, ctx);
    expect(ctx.authorize).toHaveBeenCalledWith("git", {
      path: "",
      staged: false,
    });
  });
});
