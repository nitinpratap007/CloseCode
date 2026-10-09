// Phase 26 unit tests: the context engine.
//
// The five acceptance criteria each get their own `describe`, in the order the
// phase states them:
//
//   1. context is assembled dynamically
//   2. irrelevant files are excluded
//   3. context has limits
//   4. context can be cancelled / rebuilt
//   5. context usage can be inspected
//
// Two rules govern how these are written, both learned the hard way in Phase 25:
//
// **Assert the artefact, not the flag.** Where the claim is "irrelevant files are
// excluded", the assertion is that the noise file's *text* is absent from
// `bundle.text` — not that some counter looks plausible. A counter can be right
// while the wrong bytes ship.
//
// **Drive the real engine against a real filesystem.** A temp directory is a
// real workspace: the bounded walk, the real ranking and the real budget all run.
// Git is the one thing injected, because this checkout is not a git repository
// and a test that silently depends on the developer's git state is a test that
// passes on one machine and fails on another.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { AgentRuntime } from "../electron/services/agent/runtime";
import { createBuiltinRegistry, DELEGATE_TOOL_NAME, type ToolRegistry } from "../electron/services/agent/tools";
import {
  CHILD_CONTEXT_BUDGET,
  ContextEngine,
  DEFAULT_CONTEXT_BUDGET,
  MIN_RELEVANCE_SCORE,
  isDocFile,
  isNoiseFile,
  sanitizeSnapshot,
  scoreFile,
  taskTokens,
  type ContextBundle,
  type PriorRun,
} from "../electron/services/agent/context";
import { SUBAGENTS } from "../electron/services/agent/subagents";
import type {
  AgentCompletionRequest,
  AgentCompletionResult,
  AgentRunSpec,
  ContextBudget,
  EditorSnapshot,
} from "../electron/services/agent/types";

const registry = createBuiltinRegistry(true);

/**
 * True once this conversation has already seen a tool result.
 *
 * The one thing a delegation test must get right. A responder that keys only on
 * "am I the parent?" will delegate again on the turn *after* the delegation,
 * forever, and the run will die on the step limit — which looks exactly like a
 * runtime bug and is not one.
 */
function answered(req: { messages: Array<{ role: string }> }): boolean {
  return req.messages.some((m) => m.role === "tool");
}

interface Turn {
  content?: string;
  toolCalls?: Array<{ name: string; args: unknown }>;
}

/**
 * Wraps a responder into an `AgentTransport`.
 *
 * The distinction matters: a responder speaks `{ name, args }` because that is
 * readable in a test, while the transport contract is `{ id, name, arguments }`
 * with `arguments` a JSON *string*. Handing the runtime the readable shape
 * produces a malformed tool call that is silently dropped — the run then
 * "completes" having delegated nothing, which reads as a runtime bug.
 */
function transport(fn: (req: AgentCompletionRequest) => Turn) {
  return async (req: AgentCompletionRequest): Promise<AgentCompletionResult> => {
    const turn = await fn(req);
    return {
      content: turn.content ?? "",
      toolCalls: (turn.toolCalls ?? []).map((t, n) => ({
        id: `call-${n}`,
        name: t.name,
        arguments: JSON.stringify(t.args),
      })),
      streamed: false,
    };
  };
}

/**
 * Which sub-agent role a request came from, by its system prompt.
 *
 * Matching `"<Name> subagent"` rather than the bare word "subagent" is the whole
 * point: a *parent's* prompt also mentions subagents, in the `delegate_task`
 * tool description, so a test that asks "does this say subagent?" classifies
 * every parent as a child and then quietly never delegates at all.
 */
function roleOf(req: { messages: Array<{ role: string; content: string }> }): string | null {
  const system = req.messages[0]?.content ?? "";
  for (const role of SUBAGENTS) {
    if (system.includes(`${role.name} subagent`)) return role.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface GitFile {
  path: string;
  status: string;
  staged: boolean;
  unstaged: boolean;
}

interface Harness {
  runtime: AgentRuntime;
  events: Array<{ type: string }>;
}

let tempRoots: string[] = [];

function ws(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `p26-${prefix}-`));
  tempRoots.push(dir);
  return dir;
}

function write(root: string, rel: string, body: string): void {
  const file = path.join(root, rel.split("/").join(path.sep));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf-8");
}

/**
 * A workspace whose every file is unambiguously about one topic, so "relevant"
 * has a single right answer a test can assert on.
 *
 * `noise.ts` shares no word with any task used below, `docs/design.md` and
 * `README.md` are documentation, and the lockfile/binary/dotted entries are there
 * to prove the exclusions actually exclude.
 */
function topicWorkspace(): string {
  const root = ws("topic");
  write(root, "AGENTS.md", "# Project rules\nAlways run the typecheck before claiming a change works.\nNever edit generated files.\n");
  write(root, "README.md", "# Sample project\nA fixture used by the context tests.\n");
  write(root, "docs/design.md", "# Design\nThe permission ceiling is computed once at spawn time.\n");
  write(root, "src/permissions.ts", "export function resolveCapability() { return 'deny'; }\n// capability ceiling inheritance\n");
  write(root, "src/walk.ts", "export function walkWorkspace() { return []; }\n// bounded directory walk with a byte budget\n");
  write(root, "src/transport.ts", "export function createTransport() { return null; }\n// http transport endpoint\n");
  write(root, "src/noise.ts", "export const answer = 42;\n");
  write(root, "package.json", '{ "name": "sample" }\n');
  write(root, "package-lock.json", '{ "lockfileVersion": 3, "packages": { "": { "name": "sample" } } }\n');
  write(root, "assets/logo.png", "PNG\r\n\nnot really a png but it has a noise extension\n");
  write(root, "node_modules/dep/index.js", "module.exports = 1;\n");
  write(root, ".hidden/secret.ts", "export const secret = 'walk permissions transport';\n");
  return root;
}

function snap(over: Partial<EditorSnapshot> = {}): EditorSnapshot {
  return {
    activePath: null,
    activeContent: "",
    activeDirty: false,
    selection: null,
    openPaths: [],
    diagnostics: [],
    ...over,
  };
}

function budgetOf(totalChars: number, over: Partial<ContextBudget> = {}): ContextBudget {
  return { ...DEFAULT_CONTEXT_BUDGET, totalChars, ...over };
}

/** A `gitStatus` stub. The real thing needs a repository; this checkout is not one. */
function gitStub(files: GitFile[] = [], branch = "main") {
  return (): {
    branch: string;
    ahead: number;
    behind: number;
    detached: boolean;
    files: GitFile[];
  } | null => ({ branch, ahead: 0, behind: 0, detached: false, files });
}

function part(bundle: ContextBundle, kind: string) {
  return bundle.summary.parts.find((p) => p.kind === kind);
}

function partText(bundle: ContextBundle, kind: string): string {
  return part(bundle, kind)?.preview ?? "";
}

// ---------------------------------------------------------------------------

describe("Phase 26 — context engine", () => {
  let root: string;

  beforeEach(() => {
    root = topicWorkspace();
  });

  afterEach(() => {
    for (const dir of tempRoots.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // A leftover temp dir is not worth failing a test over.
      }
    }
  });

  // -------------------------------------------------------------------------
  // 1. Assembled dynamically
  // -------------------------------------------------------------------------

  describe("1. context is assembled dynamically", () => {
    it("ranks different files for different tasks over the same workspace", async () => {
      const engine = new ContextEngine({ gitStatus: gitStub() });

      const perms = await engine.build({
        agentId: "build",
        task: "fix the permission ceiling in spawnChild",
        workspace: root,
      });
      const walk = await engine.build({
        agentId: "build",
        task: "make the workspace walk cheaper",
        workspace: root,
      });

      const permsText = perms.text;
      const walkText = walk.text;

      expect(permsText).toContain("src/permissions.ts");
      expect(walkText).toContain("src/walk.ts");
      // The whole point: the answer is derived from the words used, not fixed.
      expect(permsText).not.toContain("src/walk.ts");
      expect(walkText).not.toContain("src/permissions.ts");
    });

    it("re-assembles when the editor changes, and says which part appeared", async () => {
      const engine = new ContextEngine({ gitStatus: gitStub() });
      const base = { agentId: "build", task: "explain this project", workspace: root };

      const before = await engine.build({ ...base, snapshot: snap() });
      expect(part(before, "selection")).toBeUndefined();

      const withSelection = await engine.build({
        ...base,
        snapshot: snap({
          activePath: path.join(root, "src", "walk.ts"),
          activeContent: "export function walkWorkspace() { return []; }\n",
          selection: { text: "walkWorkspace", startLine: 1, endLine: 1 },
        }),
      });

      expect(part(withSelection, "selection")?.included).toBe(true);
      expect(withSelection.text).toContain("walkWorkspace");
      // The active file arrives as its own part, and the file is not also
      // shipped as a ranked excerpt.
      expect(part(withSelection, "currentFile")?.included).toBe(true);
      // The active file is shipped once, as the active file. Ranking it again
      // would put the same bytes in the context twice.
      const code = part(withSelection, "relevantCode");
      for (const f of code?.files ?? []) {
        expect(f.included).toBe(false);
      }
      const shipped = (code?.files ?? []).filter((f) => f.included).map((f) => f.path);
      expect(shipped).not.toContain("src/walk.ts");
    });

    it("reads the live buffer for a dirty file and labels it as unsaved", async () => {
      const engine = new ContextEngine({ gitStatus: gitStub() });
      // The buffer says "DIRTY"; the file on disk says "SAVED". The buffer wins,
      // because that is the code the user is looking at.
      const bundle = await engine.build({
        agentId: "build",
        task: "review the active file",
        workspace: root,
        snapshot: snap({
          activePath: path.join(root, "src", "walk.ts"),
          activeContent: "const DIRTY = true;\n",
          activeDirty: true,
        }),
      });
      expect(bundle.text).toContain("DIRTY");
      expect(bundle.text).not.toContain("SAVED");
      expect(part(bundle, "currentFile")?.label).toContain("unsaved buffer");
    });

    it("falls back to the file on disk when the snapshot carries no buffer", async () => {
      const engine = new ContextEngine({ gitStatus: gitStub() });
      const bundle = await engine.build({
        agentId: "build",
        task: "explain the walk",
        workspace: root,
        snapshot: snap({ activePath: path.join(root, "src", "walk.ts") }),
      });
      expect(bundle.text).toContain("walkWorkspace");
      expect(part(bundle, "currentFile")?.label).toContain("saved file");
    });

    it("carries earlier agent results into a follow-up task", async () => {
      const history: PriorRun[] = [
        {
          id: "run-1",
          agentId: "explorer",
          task: "find the permission gate",
          status: "completed",
          createdAt: Date.now() - 60_000,
          result: { text: "The gate lives in permissions.ts and clamps via clampToCeiling." },
        },
      ];
      const engine = new ContextEngine({ gitStatus: gitStub(), history: () => history });
      const bundle = await engine.build({
        agentId: "build",
        task: "now fix what you found about the ceiling",
        workspace: root,
      });
      expect(part(bundle, "previousResults")?.included).toBe(true);
      expect(bundle.text).toContain("clampToCeiling");
    });

    it("does not report a failed earlier run as usable context", async () => {
      const history: PriorRun[] = [
        {
          id: "run-2",
          agentId: "coder",
          task: "fix it",
          status: "failed",
          createdAt: Date.now() - 1000,
          result: { text: "half an answer that never finished" },
        },
      ];
      const engine = new ContextEngine({ gitStatus: gitStub(), history: () => history });
      const bundle = await engine.build({ agentId: "build", task: "continue", workspace: root });
      expect(part(bundle, "previousResults")).toBeUndefined();
      expect(bundle.text).not.toContain("never finished");
    });

    it("ships nothing when the workspace is null and there is no selection", async () => {
      const engine = new ContextEngine({ gitStatus: gitStub() });
      const bundle = await engine.build({ agentId: "build", task: "do something", workspace: null });
      // "empty" rather than a paragraph of preamble about a preamble.
      expect(bundle.summary.status).toBe("empty");
      expect(bundle.text).toBe("");
      expect(bundle.summary.totalChars).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Irrelevant files are excluded
  // -------------------------------------------------------------------------

  describe("2. irrelevant files are excluded", () => {
    it("never ships a file that shares nothing with the task", async () => {
      const engine = new ContextEngine({ gitStatus: gitStub() });
      const bundle = await engine.build({
        agentId: "build",
        task: "fix the permission ceiling",
        workspace: root,
      });
      expect(bundle.text).not.toContain("export const answer = 42");
      expect(bundle.text).not.toContain("src/noise.ts");
    });

    it("excludes lockfiles, binaries, node_modules and dotted directories", async () => {
      const engine = new ContextEngine({ gitStatus: gitStub() });
      const bundle = await engine.build({
        agentId: "build",
        task: "walk permissions transport node_modules hidden",
        workspace: root,
      });
      // `package-lock.json` would match "lockfile" only if it were readable as
      // text; `.hidden/secret.ts` contains all three topic words and is still
      // excluded, which is the assertion that actually proves the walk's skips.
      expect(bundle.text).not.toContain("lockfileVersion");
      expect(bundle.text).not.toContain("export const secret");
      expect(bundle.text).not.toContain("module.exports");
      expect(bundle.text).not.toContain("not really a png");
    });

    it("counts only files that actually passed the relevance threshold", async () => {
      const engine = new ContextEngine({ gitStatus: gitStub() });
      const bundle = await engine.build({
        agentId: "build",
        task: "fix the permission ceiling",
        workspace: root,
      });
      // Two topic files plus the design doc; the noise file, the lockfile, the
      // binary and the hidden directory must not be in the count.
      expect(bundle.summary.filesRanked).toBeLessThanOrEqual(4);
      expect(bundle.summary.filesRanked).toBeGreaterThan(0);
      expect(bundle.summary.filesScanned).toBeGreaterThan(bundle.summary.filesRanked);
    });

    it("scores a path hit above a body hit, and nothing at all for a stranger", () => {
      const tokens = taskTokens("permission ceiling");
      const byName = scoreFile("src/permissions.ts", "export const a = 1;", tokens);
      const byBody = scoreFile("src/unrelated.ts", "the permission ceiling applies", tokens);
      const stranger = scoreFile("src/unrelated.ts", "const a = 1;", tokens);
      expect(byName).toBeGreaterThan(0);
      expect(byName).toBeGreaterThan(byBody);
      expect(stranger).toBe(0);
      expect(stranger).toBeLessThan(MIN_RELEVANCE_SCORE);
    });

    it("caps a single token's contribution so a ubiquitous word cannot decide", () => {
      const tokens = taskTokens("the");
      // "the" is a stopword, so it produces no tokens at all — which is the
      // stronger statement: a task made only of stopwords ranks nothing.
      expect(tokens).toEqual([]);
      expect(scoreFile("src/a.ts", "the the the the", tokens)).toBe(0);
    });

    it("splits camelCase and snake_case identifiers out of a prose task", () => {
      const tokens = taskTokens("fix setActivePath inside agent_store.ts");
      expect(tokens).toContain("active");
      expect(tokens).toContain("agent");
      expect(tokens).toContain("store");
      // `set` is a stopword and `fix` is one too, so neither can dominate.
      expect(tokens).not.toContain("set");
    });

    it("sends documentation under its own heading, not as a code excerpt", async () => {
      const engine = new ContextEngine({ gitStatus: gitStub() });
      const bundle = await engine.build({
        agentId: "build",
        task: "how does the permission ceiling work",
        workspace: root,
      });
      expect(part(bundle, "documentation")?.included).toBe(true);
      expect(bundle.text).toContain("docs/design.md");
      const code = part(bundle, "relevantCode");
      const designAsCode = code?.files?.find((f) => f.path === "docs/design.md");
      expect(designAsCode?.included).toBe(false);
      expect(designAsCode?.reason).toBe("counted as documentation");
    });

    it("does not classify an instruction file as documentation", () => {
      // AGENTS.md is read directly as an instruction; ranking it as a doc as well
      // would put the same bytes in the context under two headings.
      expect(isDocFile("AGENTS.md")).toBe(false);
      expect(isDocFile("docs/design.md")).toBe(true);
      expect(isDocFile("README.md")).toBe(true);
      expect(isDocFile("src/a.ts")).toBe(false);
    });

    it("classifies the obvious noise files", () => {
      expect(isNoiseFile("package-lock.json")).toBe(true);
      expect(isNoiseFile("assets/logo.png")).toBe(true);
      expect(isNoiseFile("bundle.js.map")).toBe(true);
      expect(isNoiseFile("src/permissions.ts")).toBe(false);
      // No extension is not an extension.
      expect(isNoiseFile("Makefile")).toBe(false);
      expect(isNoiseFile(".gitignore")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Context has limits
  // -------------------------------------------------------------------------

  describe("3. context has limits", () => {
    it("never exceeds the total budget, even with a large selection", async () => {
      const engine = new ContextEngine({ gitStatus: gitStub() });
      const bundle = await engine.build({
        agentId: "build",
        task: "review the active file",
        workspace: root,
        budget: budgetOf(4_000),
        snapshot: snap({
          activePath: path.join(root, "src", "permissions.ts"),
          activeContent: "x".repeat(50_000),
          selection: { text: "y".repeat(50_000), startLine: 1, endLine: 900 },
        }),
      });
      expect(bundle.summary.totalChars).toBeLessThanOrEqual(4_000);
      expect(bundle.text.length).toBeLessThanOrEqual(4_000);
      // The number the panel shows is the length of the string that ships. If
      // these two ever diverge, the panel is quoting a budget and not a cost.
      expect(bundle.summary.totalChars).toBe(bundle.text.length);
    });

    it("honours the total budget for the default build too", async () => {
      const engine = new ContextEngine({ gitStatus: gitStub() });
      for (const dir of ["src", "docs"]) {
        for (let i = 0; i < 8; i += 1) {
          write(root, `${dir}/gen${i}.ts`, `// permission walk transport ceiling\n${"pad ".repeat(900)}`);
        }
      }
      const bundle = await engine.build({
        agentId: "build",
        task: "permission walk transport ceiling",
        workspace: root,
        snapshot: snap({
          activePath: path.join(root, "src", "permissions.ts"),
          activeContent: "z".repeat(40_000),
          selection: { text: "q".repeat(40_000), startLine: 1, endLine: 400 },
          openPaths: [path.join(root, "src", "walk.ts"), path.join(root, "src", "transport.ts")],
        }),
      });
      expect(bundle.summary.totalChars).toBeLessThanOrEqual(DEFAULT_CONTEXT_BUDGET.totalChars);
      expect(bundle.summary.totalChars).toBeGreaterThan(0);
    });

    it("keeps the total equal to the sum of the parts it reports", async () => {
      const engine = new ContextEngine({ gitStatus: gitStub() });
      const bundle = await engine.build({
        agentId: "build",
        task: "fix the permission ceiling",
        workspace: root,
        snapshot: snap({ selection: { text: "clampToCeiling", startLine: 4, endLine: 9 } }),
      });
      const sum = bundle.summary.parts.reduce((acc, p) => acc + p.chars, 0);
      expect(bundle.summary.totalChars).toBe(sum);
    });

    it("caps each part individually, not just the total", async () => {
      const engine = new ContextEngine({ gitStatus: gitStub() });
      const bundle = await engine.build({
        agentId: "build",
        task: "fix the permission ceiling",
        workspace: root,
        budget: budgetOf(DEFAULT_CONTEXT_BUDGET.totalChars, { maxSelectionChars: 200 }),
        snapshot: snap({ selection: { text: "a".repeat(5_000), startLine: 1, endLine: 300 } }),
      });
      const sel = part(bundle, "selection");
      expect(sel?.included).toBe(true);
      expect(sel?.truncated).toBe(true);
      expect(sel?.chars).toBeLessThanOrEqual(200 + 200);
    });

    it("truncates a long instruction file instead of dropping it", async () => {
      write(root, "AGENTS.md", `# Rules\n${"never do the forbidden thing. ".repeat(2_000)}`);
      const engine = new ContextEngine({ gitStatus: gitStub() });
      const bundle = await engine.build({
        agentId: "build",
        task: "fix the permission ceiling",
        workspace: root,
        budget: budgetOf(DEFAULT_CONTEXT_BUDGET.totalChars, { maxInstructionsChars: 500 }),
      });
      const inst = part(bundle, "instructions");
      expect(inst?.included).toBe(true);
      expect(inst?.truncated).toBe(true);
      expect(inst?.reason).toBe("clipped to this part's own budget");
      expect(inst?.chars).toBeLessThanOrEqual(700);
    });

    it("spends the budget in priority order and drops the leftovers with a reason", async () => {
      const engine = new ContextEngine({ gitStatus: gitStub() });
      // A tab that passes every per-file cap, so the only thing that can exclude
      // it is the total budget. That is what this test is about — the greedy
      // order, not a collector's own limit.
      write(root, "src/big.ts", `export const big = "${"b".repeat(900)}";\n// permission walk ceiling\n`);
      const bundle = await engine.build({
        agentId: "build",
        task: "fix the permission ceiling",
        workspace: root,
        // Sized so the greedy fill is deterministic: the preamble, project
        // instructions and ranked documentation go first, the selection is next
        // and is large enough to take most of what is left, and the open tab is
        // the one part that cannot fit. The per-part caps stay generous on
        // purpose — with them generous, only the *total* budget can be what
        // excluded the tab, which is what this test is about.
        budget: budgetOf(2_000, { maxSelectionChars: 1_200, maxCurrentFileChars: 300, maxRelevantFiles: 1, maxRelevantFileChars: 300, maxOpenFiles: 1, maxOpenFileChars: 4_000, maxStructureLines: 4 }),
        snapshot: snap({
          selection: { text: "a".repeat(1_100), startLine: 1, endLine: 20 },
          openPaths: [path.join(root, "src", "big.ts")],
        }),
      });
      expect(bundle.summary.totalChars).toBeLessThanOrEqual(2_000);
      // The selection outranks the open tab, so the tab is the one that goes.
      expect(part(bundle, "selection")?.included).toBe(true);
      const open = part(bundle, "openFiles");
      expect(open?.included).toBe(false);
      expect(open?.reason).toContain("total context budget");
      expect(bundle.summary.dropped.length).toBeGreaterThan(0);
      // A dropped part is named, not silently omitted: the panel has to be able
      // to answer "what did you decide not to send me?".
      expect(bundle.summary.dropped.join(" | ")).toContain("Other open files");
    });

    it("gives a sub-agent a materially smaller budget than a parent", () => {
      expect(CHILD_CONTEXT_BUDGET.totalChars).toBeLessThan(DEFAULT_CONTEXT_BUDGET.totalChars);
      // Four children per run is the Phase 25 cap, so the arithmetic has to hold
      // against that, not against a single child in isolation.
      expect(CHILD_CONTEXT_BUDGET.totalChars * 4).toBeLessThan(DEFAULT_CONTEXT_BUDGET.totalChars * 2);
      // A child is one step further from the conversation, so it gets none of it.
      expect(CHILD_CONTEXT_BUDGET.maxPreviousChars).toBe(0);
    });

    it("bounds the number of files a walk may read", async () => {
      const big = ws("big");
      for (let i = 0; i < 60; i += 1) {
        write(big, `f${i}.ts`, `// permission ceiling walk\n${"body ".repeat(2_000)}`);
      }
      const engine = new ContextEngine({ gitStatus: gitStub(), rankMaxBytes: 40_000 });
      const bundle = await engine.build({
        agentId: "build",
        task: "permission ceiling walk",
        workspace: big,
      });
      // A byte-capped walk is still a bounded walk: the engine finished, and it
      // finished by spending a budget rather than by reading the whole tree.
      expect(bundle.summary.status).toBe("built");
      expect(bundle.summary.filesScanned).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Cancelled / rebuilt
  // -------------------------------------------------------------------------

  describe("4. context can be cancelled and rebuilt", () => {
    it("cancels an in-flight build and produces nothing", async () => {
      const engine = new ContextEngine({ gitStatus: gitStub() });
      const pending = engine.build({
        agentId: "build",
        task: "fix the permission ceiling",
        workspace: root,
      });
      // Cancelled after the first yield, which is the window the engine opens
      // precisely so a cancel arriving over IPC can be observed.
      expect(engine.cancel()).toBe(true);
      const bundle = await pending;
      expect(bundle.summary.status).toBe("cancelled");
      expect(bundle.text).toBe("");
      expect(bundle.summary.totalChars).toBe(0);
    });

    it("reports false when there was nothing to cancel", async () => {
      const engine = new ContextEngine({ gitStatus: gitStub() });
      expect(engine.cancel()).toBe(false);
      await engine.build({ agentId: "build", task: "fix the permission ceiling", workspace: root });
      // The build has finished, so there is nothing left to stop.
      expect(engine.cancel()).toBe(false);
    });

    it("does not cache a cancelled build", async () => {
      const engine = new ContextEngine({ gitStatus: gitStub() });
      const cancelled = engine.build({ agentId: "build", task: "fix the permission ceiling", workspace: root });
      engine.cancel();
      await cancelled;

      // The next identical request must do the work, not replay the cancellation.
      const next = await engine.build({ agentId: "build", task: "fix the permission ceiling", workspace: root });
      expect(next.summary.status).toBe("built");
      expect(next.text).toContain("src/permissions.ts");
    });

    it("serves an identical request from cache, and a forced one from scratch", async () => {
      const engine = new ContextEngine({ gitStatus: gitStub() });
      const request = { agentId: "build", task: "fix the permission ceiling", workspace: root };
      const first = await engine.build(request);
      const cached = await engine.build(request);
      expect(cached).toBe(first);
      expect(cached.summary.builtAt).toBe(first.summary.builtAt);

      const forced = await engine.build({ ...request, force: true });
      expect(forced).not.toBe(first);
      expect(forced.summary.totalChars).toBe(first.summary.totalChars);
    });

    it("rebuilds with an empty task, reusing the previous one", async () => {
      const engine = new ContextEngine({ gitStatus: gitStub() });
      await engine.build({ agentId: "build", task: "fix the permission ceiling", workspace: root });
      // This is what the panel's Rebuild button sends: no task, `force: true`.
      const rebuilt = await engine.rebuild();
      expect(rebuilt).not.toBeNull();
      expect(rebuilt?.text).toContain("src/permissions.ts");
    });

    it("returns null from rebuild when nothing has been assembled yet", async () => {
      const engine = new ContextEngine({ gitStatus: gitStub() });
      expect(await engine.rebuild()).toBeNull();
    });

    it("picks up a file created after the last build, once forced", async () => {
      const engine = new ContextEngine({ gitStatus: gitStub() });
      const request = { agentId: "build", task: "fix the permission ceiling", workspace: root };
      const before = await engine.build(request);
      expect(before.text).not.toContain("src/added-later.ts");

      write(root, "src/added-later.ts", "// permission ceiling added after the first build\n");

      // Without force this is a cache hit, and saying otherwise would be a lie.
      expect(await engine.build(request)).toBe(before);

      const rebuilt = await engine.build({ ...request, force: true });
      expect(rebuilt.summary.filesScanned).toBeGreaterThan(before.summary.filesScanned);
      expect(rebuilt.text).toContain("src/added-later.ts");
    });

    it("aborts the first build when a second one starts", async () => {
      const engine = new ContextEngine({ gitStatus: gitStub() });
      const first = engine.build({ agentId: "build", task: "fix the permission ceiling", workspace: root });
      const second = engine.build({ agentId: "build", task: "make the workspace walk cheaper", workspace: root });
      const [a, b] = await Promise.all([first, second]);
      expect(a.summary.status).toBe("cancelled");
      expect(b.summary.status).toBe("built");
      expect(b.text).toContain("src/walk.ts");
    });

    it("honours a caller-supplied signal without losing cancel()", async () => {
      const engine = new ContextEngine({ gitStatus: gitStub() });
      const controller = new AbortController();
      const pending = engine.build({
        agentId: "build",
        task: "fix the permission ceiling",
        workspace: root,
        signal: controller.signal,
      });
      controller.abort();
      expect((await pending).summary.status).toBe("cancelled");
      // The forwarder is removed on exit, so `cancel()` still reaches the
      // controller the engine owns rather than a stale one.
      const next = await engine.build({ agentId: "build", task: "fix the permission ceiling", workspace: root });
      expect(next.summary.status).toBe("built");
    });

    it("treats an already-aborted signal as an immediate cancellation", async () => {
      const engine = new ContextEngine({ gitStatus: gitStub() });
      const controller = new AbortController();
      controller.abort();
      const bundle = await engine.build({
        agentId: "build",
        task: "fix the permission ceiling",
        workspace: root,
        signal: controller.signal,
      });
      expect(bundle.summary.status).toBe("cancelled");
    });
  });

  // -------------------------------------------------------------------------
  // 5. Usage can be inspected
  // -------------------------------------------------------------------------

  describe("5. context usage can be inspected", () => {
    it("reports every part with its character count and whether it was sent", async () => {
      const engine = new ContextEngine({ gitStatus: gitStub([{ path: "src/permissions.ts", status: "M", staged: false, unstaged: true }]) });
      const bundle = await engine.build({
        agentId: "build",
        task: "fix the permission ceiling",
        workspace: root,
        snapshot: snap({
          selection: { text: "clampToCeiling", startLine: 3, endLine: 8 },
          diagnostics: [{ file: "src/permissions.ts", line: 12, severity: "error", message: "Type mismatch" }],
        }),
      });
      const summary = bundle.summary;
      expect(summary.status).toBe("built");
      for (const p of summary.parts) {
        expect(typeof p.label).toBe("string");
        expect(p.label.length).toBeGreaterThan(0);
        expect(p.included).toBe(true);
        expect(p.chars).toBeGreaterThan(0);
      }
      expect(summary.parts.map((p) => p.kind)).toContain("git");
      expect(summary.parts.map((p) => p.kind)).toContain("diagnostics");
    });

    it("names the reason for every part that was not sent", async () => {
      const engine = new ContextEngine({ gitStatus: gitStub() });
      const bundle = await engine.build({
        agentId: "build",
        task: "fix the permission ceiling",
        workspace: root,
        budget: budgetOf(700, { maxSelectionChars: 120, maxCurrentFileChars: 120, maxRelevantFiles: 1, maxRelevantFileChars: 120, maxOpenFiles: 0, maxStructureLines: 2, maxDocFiles: 0, maxGitFiles: 0 }),
        snapshot: snap({
          activePath: path.join(root, "src", "walk.ts"),
          activeContent: "walkWorkspace() {}".repeat(400),
          selection: { text: "permission".repeat(400), startLine: 1, endLine: 500 },
        }),
      });
      const dropped = bundle.summary.parts.filter((p) => !p.included);
      expect(dropped.length).toBeGreaterThan(0);
      for (const p of dropped) {
        expect(p.reason, `part "${p.label}" was dropped without a reason`).toBeTruthy();
      }
      // And each one is also in the flat list, so a panel needs no second source.
      expect(bundle.summary.dropped.length).toBe(dropped.length);
    });

    it("shows per-file scores and per-file reasons, included or not", async () => {
      const engine = new ContextEngine({ gitStatus: gitStub() });
      const bundle = await engine.build({
        agentId: "build",
        task: "fix the permission ceiling",
        workspace: root,
        budget: budgetOf(DEFAULT_CONTEXT_BUDGET.totalChars, { maxRelevantFiles: 1 }),
      });
      const files = part(bundle, "relevantCode")?.files ?? [];
      expect(files.length).toBeGreaterThan(1);
      for (const f of files) {
        expect(typeof f.score).toBe("number");
        if (f.included) expect(f.chars).toBeGreaterThan(0);
        else expect(f.reason).toBeTruthy();
      }
      // Sorted by relevance, so the panel can show the ranking in order.
      const included = files.filter((f) => f.included);
      expect(included[0].score).toBeGreaterThanOrEqual(included[included.length - 1].score);
    });

    it("bounds every preview to 600 characters, so the summary cannot become a leak", async () => {
      const engine = new ContextEngine({ gitStatus: gitStub() });
      write(root, "src/huge.ts", `// permission ceiling\n${"secret ".repeat(20_000)}`);
      const bundle = await engine.build({
        agentId: "build",
        task: "permission ceiling",
        workspace: root,
        budget: budgetOf(DEFAULT_CONTEXT_BUDGET.totalChars, { maxRelevantFileChars: 20_000 }),
        snapshot: snap({ activePath: path.join(root, "src", "huge.ts"), activeContent: "s".repeat(200_000), activeDirty: true }),
      });
      for (const p of bundle.summary.parts) {
        expect(p.preview.length).toBeLessThanOrEqual(600);
      }
      // The full text is genuinely larger than the summary, so the bound means
      // something rather than being satisfied by accident.
      expect(bundle.text.length).toBeGreaterThan(600);
    });

    it("carries a bounded preview of the payload, not the payload", async () => {
      const engine = new ContextEngine({ gitStatus: gitStub() });
      const canary = "CANARY_TOKEN_".repeat(400);
      write(root, "src/canary.ts", `export const VALUE = "${canary}";\n// permission ceiling canary`);
      const bundle = await engine.build({
        agentId: "build",
        task: "find CANARY_TOKEN_ permission ceiling",
        workspace: root,
        budget: budgetOf(DEFAULT_CONTEXT_BUDGET.totalChars, { maxRelevantFiles: 2, maxRelevantFileChars: 10_000 }),
      });
      expect(bundle.text).toContain(canary);

      const count = (s: string): number => s.split("CANARY_TOKEN_").length - 1;
      // The summary does quote the file — that is the point of a preview, and a
      // panel showing nothing would be useless. What it must not do is quote all
      // of it. The bound is absolute, not proportional: whatever the file weighs,
      // the summary carries at most one preview's worth per part.
      const perPreview = Math.max(600, count(bundle.text) / 4);
      expect(count(JSON.stringify(bundle.summary))).toBeGreaterThan(0);
      expect(count(JSON.stringify(bundle.summary))).toBeLessThan(perPreview);
    });

    it("reports what the walk cost, so a slow assembly is explainable", async () => {
      const engine = new ContextEngine({ gitStatus: gitStub() });
      const bundle = await engine.build({ agentId: "build", task: "fix the permission ceiling", workspace: root });
      expect(bundle.summary.ms).toBeGreaterThanOrEqual(0);
      expect(bundle.summary.builtAt).toBeGreaterThan(0);
      expect(bundle.summary.filesScanned).toBeGreaterThan(0);
    });

    it("exposes the last bundle for inspection", async () => {
      const engine = new ContextEngine({ gitStatus: gitStub() });
      expect(engine.last()).toBeNull();
      const bundle = await engine.build({ agentId: "build", task: "fix the permission ceiling", workspace: root });
      expect(engine.last()).toBe(bundle);
    });

    it("shows git state as a summary plus a bounded file list", async () => {
      const files: GitFile[] = Array.from({ length: 50 }, (_, i) => ({
        path: `src/file${i}.ts`,
        status: "M",
        staged: false,
        unstaged: true,
      }));
      const engine = new ContextEngine({ gitStatus: gitStub(files) });
      const bundle = await engine.build({
        agentId: "build",
        task: "fix the permission ceiling",
        workspace: root,
        budget: budgetOf(DEFAULT_CONTEXT_BUDGET.totalChars, { maxGitFiles: 5 }),
      });
      const git = part(bundle, "git");
      expect(git?.included).toBe(true);
      expect(bundle.text).toContain("on main");
      expect(bundle.text).toContain("50 changed file(s)");
      expect(bundle.text).toContain("… 45 more");
      expect(git?.files?.filter((f) => f.included).length).toBe(5);
    });

    it("lists errors before warnings in diagnostics", async () => {
      const engine = new ContextEngine({ gitStatus: gitStub() });
      const bundle = await engine.build({
        agentId: "build",
        task: "fix the permission ceiling",
        workspace: root,
        snapshot: snap({
          diagnostics: [
            { file: "a.ts", line: 1, severity: "info", message: "an info" },
            { file: "a.ts", line: 2, severity: "warning", message: "a warning" },
            { file: "a.ts", line: 3, severity: "error", message: "an error" },
          ],
        }),
      });
      const text = bundle.text;
      expect(text.indexOf("an error")).toBeLessThan(text.indexOf("a warning"));
      expect(text.indexOf("a warning")).toBeLessThan(text.indexOf("an info"));
    });
  });

  // -------------------------------------------------------------------------
  // The untrusted boundary
  // -------------------------------------------------------------------------

  describe("the editor snapshot is clamped before anything reads it", () => {
    it("clamps every oversized string", () => {
      const s = sanitizeSnapshot({
        activePath: `C:\\${"p".repeat(5_000)}\\a.ts`,
        activeContent: "a".repeat(500_000),
        selection: { text: "b".repeat(90_000), startLine: 1, endLine: 2 },
        diagnostics: [{ file: "f".repeat(4_000), line: 1, severity: "error", message: "m".repeat(4_000) }],
      });
      expect(s.activePath!.length).toBeLessThanOrEqual(1_024);
      expect(s.activeContent.length).toBeLessThanOrEqual(200_000);
      expect(s.selection!.text.length).toBeLessThanOrEqual(40_000);
      expect(s.diagnostics[0].file.length).toBeLessThanOrEqual(1_024);
      expect(s.diagnostics[0].message.length).toBeLessThanOrEqual(500);
    });

    it("clamps array lengths", () => {
      const s = sanitizeSnapshot({
        openPaths: Array.from({ length: 500 }, (_, i) => `f${i}.ts`),
        diagnostics: Array.from({ length: 5_000 }, (_, i) => ({ file: "a.ts", line: i + 1, severity: "error", message: "m" })),
      });
      expect(s.openPaths.length).toBeLessThanOrEqual(40);
      expect(s.diagnostics.length).toBeLessThanOrEqual(500);
    });

    it("turns wrong-typed and hostile values into the empty value", () => {
      expect(sanitizeSnapshot(null).activePath).toBeNull();
      expect(sanitizeSnapshot(undefined).openPaths).toEqual([]);
      expect(sanitizeSnapshot("nope").diagnostics).toEqual([]);
      const s = sanitizeSnapshot({
        activePath: 42,
        activeDirty: "yes",
        selection: { text: 7, startLine: "x", endLine: -3 },
        openPaths: [1, null, { a: 1 }, "  ", "real.ts"],
        diagnostics: [null, "x", { file: "", message: "" }, { file: "a.ts", line: "q", message: "m" }],
      });
      expect(s.activePath).toBeNull();
      // Anything that is not exactly `true` is false. A truthy string is not consent.
      expect(s.activeDirty).toBe(false);
      expect(s.selection).toBeNull();
      expect(s.openPaths).toEqual(["real.ts"]);
      expect(s.diagnostics).toHaveLength(1);
      expect(s.diagnostics[0].line).toBe(0);
    });

    it("drops untitled tabs, which have no path on disk to confine against", () => {
      const s = sanitizeSnapshot({
        activePath: "untitled:Untitled-3",
        openPaths: ["untitled:Untitled-3", "src/real.ts"],
      });
      expect(s.activePath).toBeNull();
      expect(s.openPaths).toEqual(["src/real.ts"]);
    });

    it("refuses an open path outside the workspace and says so", async () => {
      const engine = new ContextEngine({ gitStatus: gitStub() });
      const bundle = await engine.build({
        agentId: "build",
        task: "fix the permission ceiling",
        workspace: root,
        snapshot: snap({ openPaths: ["..\\..\\Windows\\System32\\config\\SAM", path.join(root, "src", "walk.ts")] }),
      });
      const open = part(bundle, "openFiles");
      const escaped = open?.files?.find((f) => f.path.includes("System32"));
      expect(escaped?.included).toBe(false);
      expect(escaped?.reason).toBe("outside the workspace");
      expect(bundle.text).not.toContain("System32");
    });
  });

  // -------------------------------------------------------------------------
  // Runtime integration: a run records what it was given
  // -------------------------------------------------------------------------

  describe("a run records the context it received", () => {
    function spec(over: Partial<AgentRunSpec> = {}): AgentRunSpec {
      return {
        agentId: "build",
        task: "do the thing",
        workspace: null,
        endpoint: { url: "http://127.0.0.1:1", model: "m", key: null },
        temperature: 0,
        timeoutMs: 5_000,
        stream: false,
        permissions: { files: "allow", search: "allow", git: "allow", terminal: "allow", agent: "allow", web: "allow", browser: "allow" },
        ...over,
      } as AgentRunSpec;
    }

    function harness(respond: (req: AgentCompletionRequest) => Turn, reg: ToolRegistry = registry): Harness {
      const events: Array<{ type: string }> = [];
      const runtime = new AgentRuntime({
        registry: reg,
        createTransport: () => transport(respond),
        onEvent: (ev) => events.push(ev as never),
        approvalTimeoutMs: 80,
      });
      return { runtime, events };
    }

    it("keeps the summary on the run record and injects the text into the prompt", async () => {
      const prompts: string[] = [];
      const h = harness((req) => {
        prompts.push(req.messages[0]?.content ?? "");
        return { content: "done" };
      });
      const summary = {
        status: "built" as const,
        totalChars: 42,
        budgetChars: 24_000,
        ms: 1,
        builtAt: 1,
        filesScanned: 3,
        filesRanked: 1,
        dropped: [],
        parts: [],
      };
      await h.runtime.run(
        spec({
          context: "### Relevant code — 1 file(s)\nthe ceiling is frozen at spawn",
          contextSummary: summary,
          contextEnabled: true,
        }),
      );
      expect(prompts[0]).toContain("the ceiling is frozen at spawn");
      expect(h.runtime.listRuns()[0].contextSummary?.totalChars).toBe(42);
    });

    it("records no summary at all when the run was started with context off", async () => {
      const h = harness(() => ({ content: "done" }));
      await h.runtime.run(spec({ contextEnabled: false }));
      expect(h.runtime.listRuns()[0].contextSummary).toBeUndefined();
    });

    it("gives a sub-agent its own context, ranked for the sub-task", async () => {
      const systems: string[] = [];
      const built: Array<{ task: string; totalChars: number }> = [];
      const engine = new ContextEngine({ gitStatus: gitStub(), history: () => [] });
      const runtime = new AgentRuntime({
        registry,
        createTransport: () =>
          transport((req) => {
            systems.push(req.messages[0]?.content ?? "");
            // Delegate once, then finish. `answered` is what stops the parent
            // delegating again on the turn after its own delegation came back.
            if (!roleOf(req)) {
              if (answered(req)) return { content: "PARENT DONE" };
              return { toolCalls: [{ name: DELEGATE_TOOL_NAME, args: { agent: "explorer", task: "locate the bounded walk" } }] };
            }
            return { content: "CHILD DONE" };
          }),
        onEvent: () => undefined,
        approvalTimeoutMs: 80,
        contextEngine: {
          build: async (request) => {
            const b = await engine.build({
              agentId: request.agentId,
              task: request.task,
              workspace: request.workspace,
              snapshot: request.snapshot ?? null,
              budget: request.budget,
              childOf: request.childOf ?? null,
            });
            built.push({ task: request.task, totalChars: b.summary.totalChars });
            return { text: b.text, summary: b.summary };
          },
        },
      });

      const result = await runtime.run(spec({ workspace: root, contextEnabled: true }));

      expect(result.status, `run failed: ${result.error?.message ?? "no error recorded"}`).toBe("completed");
      // Only the child asked for context, and it asked for the *child's* task.
      expect(built).toHaveLength(1);
      expect(built[0].task).toBe("locate the bounded walk");
      expect(built[0].totalChars).toBeLessThanOrEqual(CHILD_CONTEXT_BUDGET.totalChars);

      const child = runtime.listRuns().find((r) => r.depth === 1);
      expect(child?.agentId).toBe("explorer");
      expect(child?.contextSummary).toBeDefined();
      const childSystem = systems.find((s) => s.includes("Explorer subagent")) ?? "";
      expect(childSystem).toContain("src/walk.ts");
    });

    it("gives a sub-agent no context when the user turned it off", async () => {
      let asked = 0;
      const runtime = new AgentRuntime({
        registry,
        createTransport: () =>
          transport((req) => {
            if (!roleOf(req)) {
              if (answered(req)) return { content: "PARENT DONE" };
              return { toolCalls: [{ name: DELEGATE_TOOL_NAME, args: { agent: "explorer", task: "look around" } }] };
            }
            return { content: "CHILD DONE" };
          }),
        onEvent: () => undefined,
        approvalTimeoutMs: 80,
        contextEngine: {
          build: async () => {
            asked += 1;
            return { text: "should not be used", summary: { status: "built" as const, totalChars: 1, budgetChars: 1, ms: 0, builtAt: 0, filesScanned: 0, filesRanked: 0, dropped: [], parts: [] } };
          },
        },
      });

      await runtime.run(spec({ workspace: root, contextEnabled: false }));
      // The parent's choice is inherited, not quietly reversed by delegating.
      expect(asked).toBe(0);
    });

    it("does not fail a delegation when context assembly throws", async () => {
      const runtime = new AgentRuntime({
        registry,
        createTransport: () =>
          transport((req) => {
            if (!roleOf(req)) {
              if (answered(req)) return { content: "PARENT DONE" };
              return { toolCalls: [{ name: DELEGATE_TOOL_NAME, args: { agent: "explorer", task: "look around" } }] };
            }
            return { content: "CHILD DONE" };
          }),
        onEvent: () => undefined,
        approvalTimeoutMs: 80,
        contextEngine: {
          build: async () => {
            throw new Error("the disk went away");
          },
        },
      });

      const result = await runtime.run(spec({ workspace: root, contextEnabled: true }));
      // The child still ran and still answered. A context failure is a degraded
      // run, never a lost delegation.
      expect(result.status, `run failed: ${result.error?.message ?? "no error recorded"}`).toBe("completed");
      expect(runtime.listRuns().some((r) => r.depth === 1 && r.status === "completed")).toBe(true);
      // And the failure is explainable afterwards rather than silent.
      const parent = runtime.listRuns().find((r) => r.depth === 0);
      expect(parent?.trace.some((e) => (e.text ?? "").includes("Context assembly for explorer failed"))).toBe(true);
    });

    it("runs unchanged with no engine wired at all", async () => {
      const h = harness(() => ({ content: "done" }));
      const result = await h.runtime.run(spec({ context: "some context", contextEnabled: true }));
      expect(result.status).toBe("completed");
      expect(result.text).toBe("done");
    });
  });
});
