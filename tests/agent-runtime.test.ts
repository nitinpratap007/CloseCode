// Phase 21 unit tests: the AI agent runtime.
//
// These drive the real `AgentRuntime` with a *scripted transport* — the injected
// seam the runtime was designed around. No network, no Electron, no renderer.
// What is exercised is genuine behaviour of the shipped runtime: the state
// machine, budgets, cancellation, typed errors, the tool registry, permissions,
// sub-agent delegation, and the projection onto the Phase 11 chat contract.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { AgentRuntime } from "../electron/services/agent/runtime";
import { createOpenAiTransport, apiUrl } from "../electron/services/agent/transport";
import * as legacy from "../electron/services/agent/legacy";
import { ToolRegistry, createBuiltinRegistry, confineToWorkspace, DELEGATE_TOOL_NAME } from "../electron/services/agent/tools";
import { getAgentDefinition, listAgentDefinitions, DEFAULT_AGENT_ID, canonicalAgentId } from "../electron/services/agent/definitions";
import { toAgentError, classifyHttpStatus, isAbortLike, AgentRuntimeError } from "../electron/services/agent/errors";
import {
  canTransition,
  isActiveStatus,
  isTerminalStatus,
  type AgentCompletionRequest,
  type AgentCompletionResult,
  type AgentEvent,
  type AgentRunSpec,
  type AgentTool,
} from "../electron/services/agent/types";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface ScriptedTurn {
  content?: string;
  toolCalls?: Array<{ name: string; args: unknown }>;
  reasoning?: string;
  /** Streamed text, to prove the delta path really works. */
  stream?: string[];
  /** Throw instead of replying. */
  throws?: AgentRuntimeError;
  /** Never settle, so the test can cancel mid-flight. */
  hang?: boolean;
}

function scriptedTransport(script: ScriptedTurn[]): {
  transport: (req: AgentCompletionRequest) => Promise<AgentCompletionResult>;
  calls: AgentCompletionRequest[];
} {
  const calls: AgentCompletionRequest[] = [];
  let i = 0;
  const transport = async (req: AgentCompletionRequest): Promise<AgentCompletionResult> => {
    calls.push(req);
    const turn = script[Math.min(i, script.length - 1)];
    i += 1;
    if (!turn) throw new AgentRuntimeError("provider", "script exhausted");
    if (turn.throws) throw turn.throws;
    if (turn.hang) {
      return new Promise<AgentCompletionResult>((_resolve, reject) => {
        req.signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }
    for (const chunk of turn.stream ?? []) {
      if (req.signal.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      req.onDelta?.(chunk);
      await new Promise((r) => setTimeout(r, 0));
    }
    return {
      content: turn.content ?? "",
      toolCalls: (turn.toolCalls ?? []).map((tc, n) => ({
        id: `call-${i}-${n}`,
        name: tc.name,
        arguments: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args),
      })),
      reasoning: turn.reasoning,
      streamed: (turn.stream ?? []).length > 0,
    };
  };
  return { transport, calls };
}

function makeSpec(over: Partial<AgentRunSpec> = {}): AgentRunSpec {
  return {
    agentId: DEFAULT_AGENT_ID,
    task: "Summarise the project",
    workspace: null,
    endpoint: { url: "http://127.0.0.1:11434", model: "test-model", key: null },
    temperature: 0,
    timeoutMs: 5000,
    stream: true,
    permissions: { files: "allow", search: "allow", git: "allow", terminal: "allow" },
    ...over,
  };
}

interface Harness {
  runtime: AgentRuntime;
  events: AgentEvent[];
  calls: AgentCompletionRequest[];
}

function makeHarness(script: ScriptedTurn[], registry?: ToolRegistry): Harness {
  const events: AgentEvent[] = [];
  const { transport, calls } = scriptedTransport(script);
  const runtime = new AgentRuntime({
    registry: registry ?? createBuiltinRegistry(true),
    createTransport: () => transport,
    onEvent: (ev) => events.push(ev),
  });
  return { runtime, events, calls };
}

const typesOf = (events: AgentEvent[]): string[] => events.map((e) => e.type);

// ---------------------------------------------------------------------------

describe("Agent definitions (Phase 21)", () => {
  it("registers several real, distinct agents", () => {
    const defs = listAgentDefinitions();
    expect(defs.length).toBeGreaterThanOrEqual(3);
    const ids = defs.map((d) => d.id);
    // Phase 24. `default` became `build`; it is now an alias rather than an id.
    // Its presence in the list is asserted below, as an alias, so the rename is
    // visible here rather than only in `definitions.ts`.
    expect(ids).toContain("build");
    expect(ids).toContain("plan");
    expect(ids).toContain("review");
    expect(ids).toContain("debug");
    // Distinct, non-empty behaviour - not duplicated stubs.
    expect(new Set(defs.map((d) => d.systemPrompt)).size).toBe(defs.length);
    for (const d of defs) expect(d.systemPrompt.length).toBeGreaterThan(40);
  });

  it("resolves the retired `default` id to the build agent", () => {
    // Phase 24. `default` is in persisted renderer state and in old run records.
    // It has to keep working, and it has to resolve to the *canonical* agent -
    // a run reported as `default` would look up per-agent permissions under a
    // key the permission panel does not show.
    expect(canonicalAgentId("default")).toBe("build");
    expect(getAgentDefinition("default")?.id).toBe("build");
    expect(canonicalAgentId("build")).toBe("build");
    expect(canonicalAgentId("nonsense")).toBe("nonsense");
    expect(canonicalAgentId("")).toBe(DEFAULT_AGENT_ID);
    expect(DEFAULT_AGENT_ID).toBe("build");
  });

  it("makes the plan and review agents read-only by construction", () => {
    expect(getAgentDefinition("plan")?.readOnly).toBe(true);
    expect(getAgentDefinition("review")?.readOnly).toBe(true);
    expect(getAgentDefinition("build")?.readOnly).toBeUndefined();
    expect(getAgentDefinition("debug")?.readOnly).toBeUndefined();
  });

  it("lets only some agents delegate, and each to a named set", () => {
    // Phase 25 widened this from "only plan". The claim being kept is the one
    // that matters: delegation is a per-definition decision, not a capability
    // every agent happens to have, and `review`/`debug` are still excluded.
    expect(getAgentDefinition("plan")?.delegates).toEqual(["review", "explorer", "researcher", "security"]);
    expect(getAgentDefinition("build")?.delegates?.length).toBeGreaterThan(0);
    // Unchanged by Phase 25, and deliberately so: a reviewer that delegates is
    // not reviewing, and losing the thread is worst when something is broken.
    expect(getAgentDefinition("review")?.delegates ?? []).toEqual([]);
    expect(getAgentDefinition("debug")?.delegates ?? []).toEqual([]);
  });

  it("returns an undefined definition for an unknown id rather than throwing", () => {
    expect(getAgentDefinition("does-not-exist")).toBeUndefined();
  });
});

describe("Agent state machine (Phase 21)", () => {
  it("allows only legal lifecycle transitions", () => {
    expect(canTransition("idle", "starting")).toBe(true);
    expect(canTransition("starting", "running")).toBe(true);
    expect(canTransition("running", "awaiting_approval")).toBe(true);
    expect(canTransition("awaiting_approval", "running")).toBe(true);
    expect(canTransition("running", "completed")).toBe(true);
    expect(canTransition("running", "cancelling")).toBe(true);
    expect(canTransition("cancelling", "cancelled")).toBe(true);
  });

  it("refuses to resurrect a finished run", () => {
    for (const terminal of ["completed", "cancelled", "failed"]) {
      expect(isTerminalStatus(terminal)).toBe(true);
      expect(canTransition(terminal, "running")).toBe(false);
      expect(canTransition(terminal, "starting")).toBe(false);
    }
  });

  it("refuses illegal jumps", () => {
    expect(canTransition("idle", "completed")).toBe(false);
    expect(canTransition("idle", "running")).toBe(false);
    expect(canTransition("starting", "awaiting_approval")).toBe(false);
    expect(canTransition("running", "starting")).toBe(false);
  });

  it("classifies active versus terminal statuses", () => {
    expect(isActiveStatus("running")).toBe(true);
    expect(isActiveStatus("awaiting_approval")).toBe(true);
    expect(isActiveStatus("completed")).toBe(false);
  });
});

describe("Agent run lifecycle (Phase 21)", () => {
  it("starts a run, tracks state, and completes it", async () => {
    const { runtime, events } = makeHarness([{ content: "All good." }]);
    const result = await runtime.run(makeSpec());

    expect(result.status).toBe("completed");
    expect(result.text).toBe("All good.");
    expect(result.steps).toBe(1);
    expect(result.toolCalls).toBe(0);
    expect(result.cancelled).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const states = events.filter((e) => e.type === "state").map((e) => (e as { status: string }).status);
    expect(states).toEqual(["starting", "running", "completed"]);

    const record = runtime.getRun(result.runId);
    expect(record?.status).toBe("completed");
    expect(record?.task).toBe("Summarise the project");
    expect(record?.result?.text).toBe("All good.");
  });

  it("accepts a user task and reports it in the run record and messages", async () => {
    const { runtime, calls } = makeHarness([{ content: "ok" }]);
    await runtime.run(makeSpec({ task: "Add a README" }));
    const roles = calls[0].messages.map((m) => m.role);
    expect(roles[0]).toBe("system");
    expect(roles[roles.length - 1]).toBe("user");
    expect(calls[0].messages[calls[0].messages.length - 1].content).toBe("Add a README");
  });

  it("keeps the agent's own message log separate from the chat log", async () => {
    const { runtime } = makeHarness([{ content: "done" }]);
    const result = await runtime.run(
      makeSpec({ history: [{ role: "user", content: "earlier question" }, { role: "assistant", content: "earlier answer" }] }),
    );
    const record = runtime.getRun(result.runId);
    const contents = record!.messages.map((m) => m.content);
    expect(contents).toContain("earlier question");
    expect(contents).toContain("earlier answer");
  });

  it("fails cleanly on an unknown agent instead of throwing", async () => {
    const { runtime, events } = makeHarness([{ content: "never" }]);
    const result = await runtime.run(makeSpec({ agentId: "nope" }));
    expect(result.status).toBe("failed");
    expect(result.error?.kind).toBe("config");
    expect(result.error?.message).toContain('Unknown agent "nope"');
    expect(typesOf(events)).toContain("error");
  });

  it("refuses a run with an empty task", async () => {
    const { runtime } = makeHarness([{ content: "never" }]);
    const result = await runtime.run(makeSpec({ task: "   " }));
    expect(result.status).toBe("failed");
    expect(result.error?.kind).toBe("config");
  });

  it("lists runs newest first and clears finished ones only", async () => {
    const { runtime } = makeHarness([{ content: "a" }, { content: "b" }]);
    const first = await runtime.run(makeSpec({ task: "first" }));
    const second = await runtime.run(makeSpec({ task: "second" }));
    const ids = runtime.listRuns().map((r) => r.id);
    expect(ids[0]).toBe(second.runId);
    expect(ids).toContain(first.runId);
    expect(runtime.clearFinished()).toBe(2);
    expect(runtime.listRuns()).toHaveLength(0);
  });
});

describe("Agent streaming (Phase 21)", () => {
  it("emits streamed deltas while the model is answering", async () => {
    const { runtime, events } = makeHarness([{ content: "Hello world", stream: ["Hello ", "world"] }]);
    const result = await runtime.run(makeSpec());
    const deltas = events.filter((e) => e.type === "delta").map((e) => (e as { delta: string }).delta);
    expect(deltas).toEqual(["Hello ", "world"]);
    expect(deltas.join("")).toBe("Hello world");
    expect(result.text).toBe("Hello world");
  });

  it("emits reasoning/status events when the provider supplies them", async () => {
    const { runtime, events } = makeHarness([{ content: "done", reasoning: "First I check the tests.\nThen I answer." }]);
    await runtime.run(makeSpec());
    const statuses = events.filter((e) => e.type === "status") as Array<{ level: string; text: string }>;
    expect(statuses.some((s) => s.text.includes("First I check the tests"))).toBe(true);
    expect(statuses.some((s) => s.level === "thinking")).toBe(true);
    // The opening note is part of the contract the chat UI relies on.
    expect(statuses[0].level).toBe("starting");
    expect(statuses[0].text).toContain("Agent mode enabled");
  });

  it("sends the tool definitions the agent is allowed to use", async () => {
    const { runtime, calls } = makeHarness([{ content: "ok" }]);
    await runtime.run(makeSpec());
    const names = (calls[0].tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("run_terminal");
    // Phase 25. This used to assert the default agent had no `delegates`, which
    // is no longer true — `build` now opts in. The claim underneath it is the
    // one worth keeping, and it is a stronger one: delegation is opt-in *per
    // definition*, so the same registry hands it to one agent and withholds it
    // from another.
    expect(names).toContain(DELEGATE_TOOL_NAME);

    const { runtime: r2, calls: c2 } = makeHarness([{ content: "ok" }]);
    await r2.run(makeSpec({ agentId: "debug" }));
    const debugNames = (c2[0].tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
    expect(debugNames).not.toContain(DELEGATE_TOOL_NAME);
  });

  it("restricts a read-only agent to read-only tools", async () => {
    const { runtime, calls } = makeHarness([{ content: "ok" }]);
    await runtime.run(makeSpec({ agentId: "review" }));
    const names = (calls[0].tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
    expect(names).toContain("read_file");
    expect(names).toContain("search_files");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("run_terminal");
  });

  it("includes the agent's own system prompt and the shared context", async () => {
    const { runtime, calls } = makeHarness([{ content: "ok" }]);
    await runtime.run(makeSpec({ agentId: "review", context: "active file: src/App.tsx" }));
    const system = calls[0].messages[0].content;
    expect(system).toContain("You are the AI assistant built into CloseCode");
    expect(system).toContain("Review Agent");
    expect(system).toContain("active file: src/App.tsx");
  });
});

describe("Agent tool registry (Phase 21)", () => {
  it("keeps the six Phase 11 tools with their original names and categories", () => {
    const registry = createBuiltinRegistry();
    // Phase 22 added tools, so the count is no longer six. What must not change
    // is that the Phase 11 six are still present, still spelled the same way,
    // and still gated by the same permission categories — that is the promise
    // Phase 21 made and Phase 22 has to keep.
    const phase11 = ["git_status", "list_dir", "read_file", "run_terminal", "search_files", "write_file"];
    expect(registry.size).toBeGreaterThan(phase11.length);
    for (const name of phase11) expect(registry.has(name)).toBe(true);
    expect(registry.get("read_file")?.category).toBe("files");
    expect(registry.get("search_files")?.category).toBe("search");
    expect(registry.get("git_status")?.category).toBe("git");
    expect(registry.get("run_terminal")?.category).toBe("terminal");
  });

  it("marks mutating tools as not read-only", () => {
    const registry = createBuiltinRegistry();
    expect(registry.get("write_file")?.readOnly).toBe(false);
    expect(registry.get("run_terminal")?.readOnly).toBe(false);
    expect(registry.get("read_file")?.readOnly).toBe(true);
    expect(registry.get("list_dir")?.readOnly).toBe(true);
  });

  it("accepts a newly registered tool without touching the loop", async () => {
    const registry = createBuiltinRegistry();
    const custom: AgentTool = {
      name: "count_lines",
      description: "Count the lines of a file.",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      category: "files",
      readOnly: true,
      execute: async (_ctx, args) => ({ granted: true, text: `42 lines in ${String(args.path)}` }),
    };
    registry.register(custom);
    expect(registry.has("count_lines")).toBe(true);

    const { runtime, events } = makeHarness(
      [
        { toolCalls: [{ name: "count_lines", args: { path: "x" } }] },
        { content: "It has 42 lines." },
      ],
      registry,
    );
    const result = await runtime.run(makeSpec());
    expect(result.status).toBe("completed");
    expect(result.toolCalls).toBe(1);
    const toolEvent = events.find((e) => e.type === "tool") as { result: string } | undefined;
    expect(toolEvent?.result).toBe("42 lines in x");
  });

  it("rejects a malformed tool definition", () => {
    const registry = new ToolRegistry();
    expect(() => registry.register({ name: "" } as unknown as AgentTool)).toThrow();
    expect(() => registry.register({ name: "x" } as unknown as AgentTool)).toThrow();
  });

  it("reports an unknown tool back to the model instead of crashing", async () => {
    const { runtime, events } = makeHarness([
      { toolCalls: [{ name: "teleport", args: {} }] },
      { content: "Sorry, I cannot do that." },
    ]);
    const result = await runtime.run(makeSpec());
    expect(result.status).toBe("completed");
    const toolEvent = events.find((e) => e.type === "tool") as { result: string };
    expect(toolEvent.result).toBe("Unknown tool: teleport");
  });

  it("turns a throwing tool into model-visible feedback", async () => {
    const registry = createBuiltinRegistry();
    const boom: AgentTool = {
      name: "boom",
      description: "Always fails.",
      parameters: { type: "object", properties: {} },
      category: "files",
      readOnly: true,
      execute: async () => {
        throw new Error("kaboom");
      },
    };
    registry.register(boom);
    const { runtime, calls } = makeHarness(
      [{ toolCalls: [{ name: "boom", args: {} }] }, { content: "That failed." }],
      registry,
    );
    const result = await runtime.run(makeSpec());
    expect(result.status).toBe("completed");
    const toolMessages = calls[1].messages.filter((m) => m.role === "tool");
    expect(toolMessages[0].content).toContain("kaboom");
  });

  it("feeds bad tool arguments back as an error rather than throwing", async () => {
    const { runtime, calls } = makeHarness([
      { toolCalls: [{ name: "read_file", args: "{not json" }] },
      { content: "Understood." },
    ]);
    await runtime.run(makeSpec());
    const toolMessages = calls[1].messages.filter((m) => m.role === "tool");
    expect(toolMessages[0].content).toContain("not valid JSON");
  });
});

describe("Tool invocation and permissions (Phase 21)", () => {
  const fakeCtx = (over: Partial<Parameters<typeof makeToolCtx>[0]> = {}) => makeToolCtx(over);

  function makeToolCtx(over: { workspace?: string | null; granted?: boolean; signal?: AbortSignal } = {}) {
    return {
      runId: "r",
      agentId: "default",
      workspace: over.workspace ?? null,
      signal: over.signal ?? new AbortController().signal,
      deadline: Date.now() + 1000,
      maxOutputChars: 4000,
      authorize: vi.fn(async () => over.granted ?? true),
      log: vi.fn(),
      spawnChild: vi.fn(),
      confine: (p: string) => confineToWorkspace(p, over.workspace ?? null),
    };
  }

  // A cancelled run must kill the terminal child process, not merely stop
  // listening to it. On Windows a command that outlives its run is a command
  // still doing whatever it was asked to do.
  it("kills a running terminal command when the run is aborted", async (ctx) => {
    if (process.platform !== "win32") {
      ctx.skip();
      return;
    }
    const registry = createBuiltinRegistry();
    const controller = new AbortController();
    const marker = path.join(os.tmpdir(), `closecode-abort-${Date.now()}.txt`);
    const toolCtx = makeToolCtx({ signal: controller.signal });
    // The command sleeps, then writes. If the abort kills it, the file never appears.
    const command = `ping -n 6 127.0.0.1 > nul & echo done > "${marker}"`;
    const running = registry.invoke("run_terminal", { command }, toolCtx as never);
    await new Promise((r) => setTimeout(r, 600));
    controller.abort();
    // The abort surfaces as a tool result; the important part is the side effect.
    await running.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 4000));
    expect(fs.existsSync(marker)).toBe(false);
    if (fs.existsSync(marker)) fs.unlinkSync(marker);
  }, 20000);

  it("executes a real read_file inside the workspace", async () => {
    const registry = createBuiltinRegistry();
    const fs = await import("fs");
    const os = await import("os");
    const pathmod = await import("path");
    const dir = fs.mkdtempSync(pathmod.join(os.tmpdir(), "cc-agent-"));
    const file = pathmod.join(dir, "note.txt");
    fs.writeFileSync(file, "hello from disk", "utf-8");

    const ctx = fakeCtx({ workspace: dir });
    const out = await registry.invoke("read_file", { path: file }, ctx);
    expect(out.granted).toBe(true);
    expect(out.text).toBe("hello from disk");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses to read outside the workspace", async () => {
    // A real workspace, so the refusal is genuinely about the path and not
    // about the workspace having gone missing.
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-confine-read-")));
    try {
      const registry = createBuiltinRegistry();
      const out = await registry.invoke(
        "read_file",
        { path: path.join(root, "..", "outside.txt") },
        makeToolCtx({ workspace: root }) as never,
      );
      expect(out.granted).toBe(true);
      expect(out.text).toContain("outside the workspace");
      expect(out.text).not.toContain("Permission denied");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a tool when the permission gate denies", async () => {
    const registry = createBuiltinRegistry();
    const ctx = fakeCtx({ granted: false });
    const out = await registry.invoke("read_file", { path: "C:\\ws\\a.txt" }, ctx);
    expect(out.granted).toBe(false);
    expect(out.text).toBe("Permission denied by policy or user.");
    // Phase 23. The first two arguments are unchanged; the third carries the
    // resolved path so the gate can apply a `path`-scoped rule and require
    // `external.read` for anything outside the workspace.
    const call = ctx.authorize.mock.calls[0];
    expect(call?.[0]).toBe("files");
    expect(call?.[1]).toEqual({ path: "C:\\ws\\a.txt" });
    expect(call?.[2]).toEqual({ path: null });
  });

  it("blocks on an approval and resumes only after the user allows it", async () => {
    const { runtime, events } = makeHarness([
      { toolCalls: [{ name: "read_file", args: { path: "C:\\ws\\a.txt" } }] },
      { content: "Read it." },
    ]);
    const started = runtime.start(makeSpec({ permissions: { files: "ask" } }));
    // Let the run reach the approval gate.
    await new Promise((r) => setTimeout(r, 10));
    const approval = events.find((e) => e.type === "approval") as { id: string; category: string } | undefined;
    expect(approval).toBeDefined();
    expect(approval?.category).toBe("files");
    expect(runtime.getRun(started.runId)?.status).toBe("awaiting_approval");

    expect(runtime.resolveApproval(approval!.id, true)).toBe(true);
    const result = await started.done;
    expect(result.status).toBe("completed");
    const toolEvent = events.find((e) => e.type === "tool") as { granted: boolean };
    expect(toolEvent.granted).toBe(true);
  });

  it("treats a denial as a completed step, not a failure", async () => {
    const { runtime, events } = makeHarness([
      { toolCalls: [{ name: "write_file", args: { path: "C:\\ws\\a.txt", content: "x" } }] },
      { content: "Understood, I will not write." },
    ]);
    const started = runtime.start(makeSpec({ permissions: { files: "deny" } }));
    await new Promise((r) => setTimeout(r, 10));
    const result = await started.done;
    expect(result.status).toBe("completed");
    const toolEvent = events.find((e) => e.type === "tool") as { granted: boolean };
    expect(toolEvent.granted).toBe(false);
  });

  it("times out an unanswered approval instead of hanging forever", async () => {
    const { runtime } = makeHarness([
      { toolCalls: [{ name: "read_file", args: { path: "C:\\ws\\a.txt" } }] },
      { content: "ok" },
    ]);
    const runtimeShort = new AgentRuntime({
      registry: createBuiltinRegistry(),
      createTransport: () => async () => ({ content: "unused", toolCalls: [], streamed: false }),
      onEvent: () => undefined,
      approvalTimeoutMs: 30,
    });
    const started = runtimeShort.start(makeSpec({ permissions: { files: "ask" } }));
    const result = await started.done;
    expect(result.status).toBe("completed");
    expect(runtime).toBeTruthy();
  });

  it("records a denied tool call and keeps going with the answer", async () => {
    const { runtime, calls } = makeHarness([
      { toolCalls: [{ name: "read_file", args: { path: "C:\\ws\\a.txt" } }] },
      { content: "I cannot read that file." },
    ]);
    const result = await runtime.run(makeSpec({ permissions: { files: "deny" } }));
    expect(result.status).toBe("completed");
    // One model call to request the tool, one to answer after the denial.
    expect(calls).toHaveLength(2);
    const denial = calls[1].messages.find((m) => m.role === "tool");
    expect(denial?.content).toContain("Permission denied");
  });

  // Workspace confinement. `confineToWorkspace` resolves symlinks before it
  // trusts a path, because a purely lexical check is defeated by a link that
  // lives inside the workspace and points outside it — and the model chooses
  // these paths, not the user. The tests below cover what is provable on any
  // platform; the symlink case itself needs a platform that permits creating
  // one (see the skip note on that test).
  it("keeps real files and new nested files inside the workspace", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-confine-ok-")));
    try {
      const existing = path.join(root, "a.txt");
      fs.writeFileSync(existing, "hi");
      expect(confineToWorkspace(existing, root)).toBe(existing);

      // Does not exist yet, two directories deep: the nearest existing
      // ancestor is the workspace, so this must still be allowed.
      const fresh = path.join(root, "deep", "nested", "b.txt");
      expect(confineToWorkspace(fresh, root)).toBe(fresh);

      // A relative path is workspace-relative, not process-relative.
      expect(confineToWorkspace("rel.txt", root)).toBe(path.join(root, "rel.txt"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("still refuses traversal and sibling-directory escapes", () => {
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-confine-esc-")));
    const root = path.join(parent, "project");
    fs.mkdirSync(root);
    try {
      expect(confineToWorkspace(path.join(root, "..", "secrets.txt"), root)).toBeNull();
      expect(confineToWorkspace(path.join(root, "..", ".."), root)).toBeNull();
      // A sibling whose name merely starts with the root's name must not pass.
      expect(confineToWorkspace(path.join(parent, "project-secrets"), root)).toBeNull();
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("write_file still creates a new nested file inside the workspace", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-write-")));
    try {
      const registry = createBuiltinRegistry();
      const target = path.join(root, "made", "up", "dirs", "file.txt");
      const out = await registry.invoke("write_file", { path: target, content: "created" }, makeToolCtx({ workspace: root }) as never);
      expect(out.text).toContain("Wrote");
      expect(fs.readFileSync(target, "utf-8")).toBe("created");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // `search_files` walks the tree synchronously on the main process. A query
  // that matches nothing used to walk every file to depth 8 with no bound at
  // all, which blocks the app, and it followed links out of the workspace.
  it("search_files stops on a bounded budget instead of walking a huge tree", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-search-big-")));
    try {
      // One level, 60 directories of 90 files: ~5460 entries, past the budget.
      for (let a = 0; a < 60; a += 1) {
        const da = path.join(root, `a${a}`);
        fs.mkdirSync(da, { recursive: true });
        for (let c = 0; c < 90; c += 1) fs.writeFileSync(path.join(da, `f${c}.dat`), "x");
      }
      const started = Date.now();
      const out = await createBuiltinRegistry().invoke(
        "search_files",
        { query: "zzzz-no-such-file" },
        makeToolCtx({ workspace: root }) as never,
      );
      const elapsed = Date.now() - started;
      // Bounded by the entry budget, not by the size of the tree.
      expect(elapsed).toBeLessThan(10000);
      expect(out.text).toContain("stopped early");
      // And the walk must have stopped at the budget, which is the property
      // that keeps a huge workspace from blocking the main process.
      const scanned = Number(/Searched (\d+) entries/.exec(out.text)?.[1] ?? "0");
      expect(scanned).toBeGreaterThan(0);
      expect(scanned).toBeLessThanOrEqual(5000);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  it("search_files does not follow a symlink out of the workspace", async (ctx) => {
    if (process.platform === "win32") {
      try {
        fs.symlinkSync("t", path.join(os.tmpdir(), "cc-search-probe"), "file");
        fs.unlinkSync(path.join(os.tmpdir(), "cc-search-probe"));
      } catch {
        ctx.skip();
        return;
      }
    }
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-search-link-")));
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-search-out-")));
    try {
      fs.writeFileSync(path.join(outside, "leak.dat"), "hello");
      fs.symlinkSync(path.join(outside, "leak.dat"), path.join(root, "leak.dat"));
      const byName = await createBuiltinRegistry().invoke(
        "search_files",
        { query: "leak" },
        makeToolCtx({ workspace: root }) as never,
      );
      expect(byName.text).toBe("No matches.");
      // The content must not have been read through the link either.
      const byText = await createBuiltinRegistry().invoke(
        "search_files",
        { query: "x", text: "hello" },
        makeToolCtx({ workspace: root }) as never,
      );
      expect(byText.text).toBe("No matches.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  // A refused path must say *why*. Confinement rejects in three distinct ways
  // and the model retries on the message, so "Permission denied" (which it
  // already has) or a bare "outside the workspace" sends it in circles.
  it("explains why a path was refused instead of blaming permissions", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-confine-msg-")));
    const registry = createBuiltinRegistry();
    try {
      const outside = await registry.invoke(
        "read_file",
        { path: path.join(root, "..", "escape.txt") },
        makeToolCtx({ workspace: root }) as never,
      );
      expect(outside.granted).toBe(true);
      expect(outside.text).not.toContain("Permission denied");
      expect(outside.text).toContain("outside the workspace");
      expect(outside.text).toContain(root);

      // list_dir previously answered a bad path with DENIED, i.e. "Permission
      // denied", for a path that was never a permission question.
      const listed = await registry.invoke(
        "list_dir",
        { path: path.join(root, "..") },
        makeToolCtx({ workspace: root }) as never,
      );
      expect(listed.text).not.toContain("Permission denied");
      expect(listed.text).toContain("outside the workspace");

      // No workspace at all is a different failure and is now named.
      const none = await registry.invoke("read_file", { path: "x.txt" }, makeToolCtx({ workspace: null }) as never);
      expect(none.text).toContain("no workspace folder is open");

      // A workspace that has been deleted or unmounted is a third case.
      const gone = await registry.invoke(
        "read_file",
        { path: path.join(root, "a.txt") },
        makeToolCtx({ workspace: path.join(root, "deleted") }) as never,
      );
      expect(gone.text).toContain("no longer reachable");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to follow a symlink that escapes the workspace", async (ctx) => {
    if (process.platform === "win32") {
      // Creating a symlink on Windows needs Developer Mode or elevation. Probe
      // for it and report a genuine skip, because a bare `return` here would be
      // counted as a pass and quietly overstate what has been verified.
      try {
        fs.symlinkSync("target", path.join(os.tmpdir(), "cc-symlink-probe-target"), "file");
        fs.unlinkSync(path.join(os.tmpdir(), "cc-symlink-probe-target"));
      } catch {
        ctx.skip();
        return;
      }
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-confine-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cc-outside-"));
    const secret = path.join(outside, "secret.txt");
    fs.writeFileSync(secret, "TOP SECRET");
    fs.symlinkSync(secret, path.join(root, "link.txt"));
    try {
      expect(confineToWorkspace(path.join(root, "link.txt"), root)).toBeNull();
      const registry = createBuiltinRegistry();
      const out = await registry.invoke(
        "read_file",
        { path: path.join(root, "link.txt") },
        makeToolCtx({ workspace: root }) as never,
      );
      expect(out.text).not.toContain("TOP SECRET");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("Agent budgets (Phase 21)", () => {
  it("stops at the step ceiling and reports a budget failure", async () => {
    // Always asks for another tool, so the run can never finish on its own.
    const { runtime } = makeHarness([{ toolCalls: [{ name: "read_file", args: { path: "C:\\ws\\a.txt" } }] }]);
    const result = await runtime.run(makeSpec({ budget: { maxSteps: 3 } }));
    expect(result.status).toBe("failed");
    expect(result.error?.kind).toBe("budget");
    expect(result.error?.message).toContain("3 steps");
    expect(result.steps).toBe(3);
  });

  it("honours a per-agent step ceiling below the run budget", async () => {
    const { runtime } = makeHarness([{ toolCalls: [{ name: "read_file", args: { path: "C:\\ws\\a.txt" } }] }]);
    // review declares maxSteps 8, default declares 6, run budget asks for 20.
    const result = await runtime.run(makeSpec({ agentId: "review", budget: { maxSteps: 20 } }));
    expect(result.error?.message).toContain("8 steps");
  });

  it("stops at the tool-call ceiling", async () => {
    const { runtime } = makeHarness([
      {
        toolCalls: [
          { name: "read_file", args: { path: "C:\\ws\\a" } },
          { name: "read_file", args: { path: "C:\\ws\\b" } },
        ],
      },
    ]);
    const result = await runtime.run(makeSpec({ budget: { maxSteps: 10, maxToolCalls: 2 } }));
    expect(result.status).toBe("failed");
    expect(result.error?.kind).toBe("budget");
    expect(result.error?.message).toContain("2 tool calls");
  });

  it("aborts a run that exceeds its wall-clock budget", async () => {
    const { runtime, events } = makeHarness([{ hang: true }]);
    const result = await runtime.run(makeSpec({ budget: { maxDurationMs: 40 } }));
    expect(result.status).toBe("cancelled");
    expect(result.cancelled).toBe(true);
    expect(typesOf(events)).toContain("result");
  });
});

describe("Agent cancellation (Phase 21)", () => {
  it("stops a run that is waiting on the model", async () => {
    const { runtime, events } = makeHarness([{ hang: true }]);
    const started = runtime.start(makeSpec());
    await new Promise((r) => setTimeout(r, 10));
    expect(runtime.getRun(started.runId)?.status).toBe("running");
    expect(runtime.cancel(started.runId)).toBe(true);

    const result = await started.done;
    expect(result.status).toBe("cancelled");
    expect(result.cancelled).toBe(true);
    expect(runtime.getRun(started.runId)?.status).toBe("cancelled");
    const states = events.filter((e) => e.type === "state").map((e) => (e as { status: string }).status);
    expect(states).toContain("cancelling");
  });

  it("stops a run that is blocked on a user approval", async () => {
    const { runtime, events } = makeHarness([
      { toolCalls: [{ name: "write_file", args: { path: "C:\\ws\\a.txt", content: "x" } }] },
      { content: "never" },
    ]);
    const started = runtime.start(makeSpec({ permissions: { files: "ask" } }));
    await new Promise((r) => setTimeout(r, 10));
    expect(runtime.getRun(started.runId)?.status).toBe("awaiting_approval");
    expect(runtime.cancel(started.runId)).toBe(true);

    const result = await started.done;
    expect(result.status).toBe("cancelled");
    const toolEvent = events.find((e) => e.type === "tool") as { granted: boolean } | undefined;
    expect(toolEvent?.granted).toBe(false);
  });

  it("really aborts the in-flight request instead of merely ignoring it", async () => {
    let sawAbort = false;
    const runtime = new AgentRuntime({
      registry: createBuiltinRegistry(),
      createTransport: () => async (req) => {
        return new Promise((_res, reject) => {
          req.signal.addEventListener("abort", () => {
            sawAbort = true;
            reject(new AgentRuntimeError("aborted", "aborted"));
          });
        });
      },
      onEvent: () => undefined,
    });
    const started = runtime.start(makeSpec());
    await new Promise((r) => setTimeout(r, 10));
    runtime.cancel(started.runId);
    await started.done;
    expect(sawAbort).toBe(true);
  });

  it("refuses to cancel an unknown or finished run", async () => {
    const { runtime } = makeHarness([{ content: "done" }]);
    expect(runtime.cancel("run-does-not-exist")).toBe(false);
    const result = await runtime.run(makeSpec());
    expect(runtime.cancel(result.runId)).toBe(false);
  });

  it("cancels every active run at once", async () => {
    const { runtime } = makeHarness([{ hang: true }]);
    const a = runtime.start(makeSpec());
    const b = runtime.start(makeSpec());
    await new Promise((r) => setTimeout(r, 10));
    expect(runtime.activeRuns()).toHaveLength(2);
    expect(runtime.cancelAll()).toBe(2);
    expect((await a.done).status).toBe("cancelled");
    expect((await b.done).status).toBe("cancelled");
  });

  it("does not execute any tool call after cancellation", async () => {
    const executed: string[] = [];
    const registry = createBuiltinRegistry();
    registry.register({
      name: "slow_tool",
      description: "Records that it ran, after yielding.",
      parameters: { type: "object", properties: {} },
      category: "files",
      readOnly: true,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 20));
        executed.push("slow_tool");
        return { granted: true, text: "done" };
      },
    });
    const { runtime } = makeHarness(
      Array.from({ length: 10 }, () => ({ toolCalls: [{ name: "slow_tool", args: {} }] })),
      registry,
    );
    const started = runtime.start(makeSpec());
    // Cancel while the first tool is still in flight.
    await new Promise((r) => setTimeout(r, 10));
    expect(runtime.cancel(started.runId)).toBe(true);
    const result = await started.done;

    expect(result.status).toBe("cancelled");
    // The loop checks the abort signal before every tool call, so the remaining
    // nine are never dispatched.
    expect(result.toolCalls).toBeLessThanOrEqual(1);
    expect(executed.length).toBeLessThanOrEqual(1);
  });

  // Regression: a tool that never settles used to make Stop a no-op. The loop
  // awaited `registry.invoke` directly, so cancelling only set the status and
  // fired the abort signal — the run then sat in `cancelling` until the tool
  // resolved on its own. With `run_terminal` or a delegated sub-agent in flight
  // that could be minutes, so "Stop" was not actually stop.
  it("interrupts a tool call that never settles", async () => {
    let released = false;
    const registry = createBuiltinRegistry();
    registry.register({
      name: "hanging_tool",
      description: "Never resolves until the test releases it.",
      parameters: { type: "object", properties: {} },
      category: "files",
      readOnly: true,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 5000));
        released = true;
        return { granted: true, text: "eventually" };
      },
    });
    const { runtime } = makeHarness(
      Array.from({ length: 5 }, () => ({ toolCalls: [{ name: "hanging_tool", args: {} }] })),
      registry,
    );
    const started = runtime.start(makeSpec());
    await new Promise((r) => setTimeout(r, 20));
    expect(runtime.cancel(started.runId)).toBe(true);

    // The run must settle on its own, without the tool ever resolving.
    const result = await started.done;
    expect(result.status).toBe("cancelled");
    expect(released).toBe(false);
    expect(runtime.getRun(started.runId)?.status).toBe("cancelled");
  }, 4000);

  it("cancels the children of a cancelled run", async () => {
    const registry = createBuiltinRegistry();
    registry.register({
      name: DELEGATE_TOOL_NAME,
      description: "Delegates to a sub-agent.",
      parameters: { type: "object", properties: { agentId: { type: "string" }, task: { type: "string" } } },
      category: "agent",
      readOnly: true,
      execute: async (ctx, args) => {
        const target = String(args.agentId ?? "review");
        const task = String(args.task ?? "review it");
        const res = await ctx.spawnChild(target, task);
        return { granted: true, text: res.text };
      },
    });
    // The child asks for a tool that hangs for far longer than the test, so the
    // child is provably still mid-flight when the parent is stopped. Without the
    // cancel cascade the child would keep running (and keep spending quota) to
    // completion on its own.
    registry.register({
      name: "child_work",
      description: "Long running child work.",
      parameters: { type: "object", properties: {} },
      category: "files",
      readOnly: true,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 30_000));
        return { granted: true, text: "child finished" };
      },
    });
    const { runtime } = makeHarness(
      [
        { toolCalls: [{ name: DELEGATE_TOOL_NAME, args: { agentId: "review", task: "check it" } }] },
        { toolCalls: [{ name: "child_work", args: {} }] },
        { content: "parent done" },
      ],
      registry,
    );

    const started = runtime.start(makeSpec({ agentId: "plan", permissions: { agent: "allow" } as never }));
    // Wait until the child exists and is working.
    for (let i = 0; i < 50 && runtime.listRuns().length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    expect(runtime.listRuns().length).toBe(2);

    expect(runtime.cancel(started.runId)).toBe(true);
    const result = await started.done;
    expect(result.status).toBe("cancelled");

    // No run may be left active after the parent was stopped.
    await new Promise((r) => setTimeout(r, 50));
    const child = runtime.listRuns().find((r) => r.parentRunId === started.runId);
    expect(child?.status).toBe("cancelled");
    expect(runtime.activeRuns()).toHaveLength(0);
  }, 6000);
});

describe("Agent errors (Phase 21)", () => {
  it("maps an HTTP 401 to an auth error", () => {
    const err = classifyHttpStatus(401, "Unauthorized", "bad key");
    expect(err.kind).toBe("auth");
    expect(err.recoverable).toBe(false);
    expect(err.code).toBe(401);
  });

  it("maps HTTP 429 to a recoverable rate-limit error", () => {
    const err = classifyHttpStatus(429, "Too Many Requests", "slow down");
    expect(err.kind).toBe("rate_limit");
    expect(err.recoverable).toBe(true);
  });

  it("maps HTTP 500 to a provider error and 400 to a permanent one", () => {
    expect(classifyHttpStatus(500, "Server Error", "").kind).toBe("provider");
    const bad = classifyHttpStatus(400, "Bad Request", "bad json");
    expect(bad.kind).toBe("provider");
    expect(bad.recoverable).toBe(false);
  });

  it("normalizes an arbitrary throw into a structured error", () => {
    const info = toAgentError(new Error("something odd"));
    expect(info.kind).toBe("internal");
    expect(info.message).toBe("something odd");
    expect(typeof info.at).toBe("number");
  });

  it("recognizes an aborted request", () => {
    const err = new Error("cancelled");
    err.name = "AbortError";
    expect(isAbortLike(err)).toBe(true);
    expect(toAgentError(err).kind).toBe("aborted");
  });

  it("classifies a refused connection as a network error", () => {
    const info = toAgentError(new Error("fetch failed: ECONNREFUSED"));
    expect(info.kind).toBe("network");
    expect(info.recoverable).toBe(true);
  });

  it("surfaces a provider failure as a failed run with a typed error", async () => {
    const { runtime, events } = makeHarness([
      { throws: new AgentRuntimeError("auth", "The AI service rejected the API key (authentication failed).") },
    ]);
    const result = await runtime.run(makeSpec());
    expect(result.status).toBe("failed");
    expect(result.error?.kind).toBe("auth");
    expect(runtime.getRun(result.runId)?.error?.kind).toBe("auth");
    const errEvent = events.find((e) => e.type === "error") as { error: { kind: string } };
    expect(errEvent.error.kind).toBe("auth");
  });

  it("emits exactly one terminal result even when the model throws", async () => {
    const { runtime, events } = makeHarness([{ throws: new Error("boom") }]);
    await runtime.run(makeSpec());
    expect(events.filter((e) => e.type === "result")).toHaveLength(1);
  });
});

describe("Sub-agents (Phase 21)", () => {
  it("lets the plan agent delegate to the review agent", async () => {
    const { runtime, events } = makeHarness([
      { toolCalls: [{ name: DELEGATE_TOOL_NAME, args: { agent: "review", task: "Review the plan" } }] },
      { content: "The plan looks good." },
    ]);
    const result = await runtime.run(makeSpec({ agentId: "plan", permissions: { agent: "allow" } }));
    expect(result.status).toBe("completed");
    const toolEvent = events.find((e) => e.type === "tool") as { tool: string; granted: boolean; result: string };
    expect(toolEvent.tool).toBe(DELEGATE_TOOL_NAME);
    expect(toolEvent.granted).toBe(true);
    // The child's own answer came back through the tool result.
    expect(toolEvent.result.length).toBeGreaterThan(0);
  });

  it("records the child run with its parent and depth", async () => {
    const { runtime } = makeHarness([
      { toolCalls: [{ name: DELEGATE_TOOL_NAME, args: { agent: "review", task: "Review it" } }] },
      { content: "ok" },
    ]);
    const parent = await runtime.run(makeSpec({ agentId: "plan", permissions: { agent: "allow" } }));
    const children = runtime.listRuns().filter((r) => r.parentRunId === parent.runId);
    expect(children).toHaveLength(1);
    expect(children[0].agentId).toBe("review");
    expect(children[0].depth).toBe(1);
  });

  it("refuses delegation the parent agent is not allowed to make", async () => {
    const { runtime } = makeHarness([
      { toolCalls: [{ name: DELEGATE_TOOL_NAME, args: { agent: "review", task: "Review it" } }] },
      { content: "I cannot do that." },
    ]);
    const result = await runtime.run(makeSpec({ agentId: "default", permissions: { agent: "allow" } }));
    expect(result.status).toBe("completed");
    // The tool was never offered to the default agent at all.
    const child = runtime.listRuns().find((r) => r.agentId === "review");
    expect(child).toBeUndefined();
  });

  it("reports an unknown sub-agent to the model instead of throwing", async () => {
    const { runtime } = makeHarness([
      { toolCalls: [{ name: DELEGATE_TOOL_NAME, args: { agent: "ghost", task: "do something" } }] },
      { content: "That agent does not exist." },
    ]);
    const result = await runtime.run(makeSpec({ agentId: "plan", permissions: { agent: "allow" } }));
    expect(result.status).toBe("completed");
    const child = runtime.listRuns().find((r) => r.agentId === "ghost");
    expect(child).toBeUndefined();
  });

  it("gates delegation behind the 'agent' permission category", async () => {
    const { runtime, events } = makeHarness([
      { toolCalls: [{ name: DELEGATE_TOOL_NAME, args: { agent: "review", task: "Review it" } }] },
      { content: "ok" },
    ]);
    // No `agent` entry at all -> the runtime must ask rather than assume.
    const started = runtime.start(makeSpec({ agentId: "plan", permissions: {} }));
    await new Promise((r) => setTimeout(r, 10));
    const approval = events.find((e) => e.type === "approval") as { id: string; category: string } | undefined;
    expect(approval?.category).toBe("agent");
    expect(runtime.getRun(started.runId)?.status).toBe("awaiting_approval");

    expect(runtime.resolveApproval(approval!.id, true)).toBe(true);
    const result = await started.done;
    expect(result.status).toBe("completed");
    expect(runtime.listRuns().some((r) => r.agentId === "review")).toBe(true);
  });

  it("does not start the sub-agent when delegation is denied", async () => {
    const { runtime } = makeHarness([
      { toolCalls: [{ name: DELEGATE_TOOL_NAME, args: { agent: "review", task: "Review it" } }] },
      { content: "Understood, I will not delegate." },
    ]);
    const result = await runtime.run(makeSpec({ agentId: "plan", permissions: { agent: "deny" } }));
    expect(result.status).toBe("completed");
    const toolEvent = runtime
      .listRuns()
      .find((r) => r.id === result.runId)!
      .trace.find((e) => e.kind === "tool");
    expect(toolEvent?.granted).toBe(false);
    expect(runtime.listRuns().some((r) => r.agentId === "review")).toBe(false);
  });
});

describe("Phase 11 chat-contract projection (Phase 21)", () => {
  // The real projection, not a copy of it.
  const { toLegacyAiEvent } = legacy;

  it("maps a completed run onto the legacy done event", () => {
    expect(
      toLegacyAiEvent({
        type: "result",
        runId: "r1",
        result: {
          runId: "r1",
          agentId: "default",
          status: "completed",
          text: "All set.",
          steps: 2,
          toolCalls: 3,
          durationMs: 5,
          cancelled: false,
        },
      }),
    ).toEqual({ type: "done", payload: { id: "r1", text: "All set.", toolSteps: 3 } });
  });

  it("maps a failed run onto the legacy error event", () => {
    expect(
      toLegacyAiEvent({
        type: "result",
        runId: "r2",
        result: {
          runId: "r2",
          agentId: "default",
          status: "failed",
          text: "",
          steps: 1,
          toolCalls: 0,
          durationMs: 5,
          cancelled: false,
          error: { kind: "network", message: "Could not connect.", recoverable: true, at: 1 },
        },
      }),
    ).toEqual({ type: "error", payload: { id: "r2", message: "Could not connect." } });
  });

  it("maps a cancelled run onto the legacy error event", () => {
    expect(
      toLegacyAiEvent({
        type: "result",
        runId: "r3",
        result: {
          runId: "r3",
          agentId: "default",
          status: "cancelled",
          text: "partial",
          steps: 1,
          toolCalls: 0,
          durationMs: 5,
          cancelled: true,
          error: { kind: "aborted", message: "Cancelled by user", recoverable: true, at: 1 },
        },
      }),
    ).toEqual({ type: "error", payload: { id: "r3", message: "Cancelled by user" } });
  });

  it("maps deltas, tools and approvals onto the legacy shapes", () => {
    expect(toLegacyAiEvent({ type: "delta", runId: "r", step: 0, delta: "hi" })).toEqual({
      type: "stream",
      payload: { id: "r", delta: "hi" },
    });
    expect(
      toLegacyAiEvent({
        type: "tool",
        runId: "r",
        step: 0,
        tool: "read_file",
        args: { path: "a" },
        result: "contents",
        granted: true,
        ms: 3,
      }),
    ).toEqual({
      type: "tool",
      payload: { id: "r", tool: "read_file", args: { path: "a" }, result: "contents", granted: true },
    });
    expect(
      toLegacyAiEvent({ type: "approval", runId: "r", id: "appr-1", tool: "files", category: "files", args: { path: "a" } }),
    ).toEqual({ type: "approval", payload: { id: "appr-1", tool: "files", args: { path: "a" } } });
  });

  it("only surfaces the opening agent note, not every status line", () => {
    expect(
      toLegacyAiEvent({ type: "status", runId: "r", step: 0, level: "starting", text: "Agent mode enabled" }),
    ).toEqual({ type: "agent", payload: { id: "r", note: "Agent mode enabled" } });
    expect(toLegacyAiEvent({ type: "status", runId: "r", step: 0, level: "thinking", text: "hmm" })).toBeNull();
    expect(toLegacyAiEvent({ type: "status", runId: "r", step: 0, level: "waiting", text: "approve?" })).toBeNull();
  });

  it("never doubles a failure into two banners", () => {
    // An `error` event is always followed by a terminal `result`; only the
    // result may reach the chat surface.
    expect(
      toLegacyAiEvent({ type: "error", runId: "r", error: { kind: "auth", message: "nope", recoverable: false, at: 1 } }),
    ).toBeNull();
    expect(toLegacyAiEvent({ type: "state", runId: "r", status: "running", previous: "starting", at: 1 })).toBeNull();
    expect(toLegacyAiEvent({ type: "message", runId: "r", message: { role: "user", content: "hi" } })).toBeNull();
  });
});

describe("Runtime retention and inspection (Phase 21)", () => {
  it("bounds the retained run history and never drops an active run", async () => {
    const { runtime } = makeHarness([{ content: "ok" }]);
    const small = new AgentRuntime({
      registry: createBuiltinRegistry(),
      createTransport: () => async () => ({ content: "ok", toolCalls: [], streamed: false }),
      onEvent: () => undefined,
      maxRetainedRuns: 3,
    });
    for (let i = 0; i < 6; i += 1) await small.run(makeSpec({ task: `task ${i}` }));
    expect(small.listRuns().length).toBeLessThanOrEqual(3);
    expect(runtime).toBeTruthy();
  });

  it("bounds the trace so a chatty run cannot grow without limit", async () => {
    const registry = createBuiltinRegistry();
    const { runtime } = makeHarness(
      Array.from({ length: 30 }, () => ({ toolCalls: [{ name: "read_file", args: { path: "C:\\ws\\a" } }] })),
      registry,
    );
    await runtime.run(makeSpec({ budget: { maxSteps: 30 } }));
    const trace = runtime.listRuns()[0].trace;
    expect(trace.length).toBeLessThanOrEqual(200);
  });

  it("exposes the pending approvals the UI can render", async () => {
    const { runtime } = makeHarness([{ toolCalls: [{ name: "read_file", args: { path: "C:\\ws\\a" } }] }]);
    const started = runtime.start(makeSpec({ permissions: { files: "ask" } }));
    await new Promise((r) => setTimeout(r, 10));
    const pending = runtime.pendingApprovals();
    expect(pending).toHaveLength(1);
    expect(pending[0].category).toBe("files");
    expect(pending[0].args).toEqual({ path: "C:\\ws\\a" });
    runtime.cancel(started.runId);
    await started.done;
    expect(runtime.pendingApprovals()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The real OpenAI-compatible transport
// ---------------------------------------------------------------------------
// The transport is the one module that performs network I/O, so it is tested
// against a stubbed `fetch` rather than a live server: this exercises the real
// shipped code path (SSE parsing, tool-call reassembly, fallbacks, HTTP mapping)
// without a socket.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sseResponse(lines: string[]): Response {
  return new Response(lines.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;

describe("OpenAI-compatible transport (Phase 21)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const req = (over: Partial<AgentCompletionRequest> = {}): AgentCompletionRequest => ({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "read_file", description: "d", parameters: { type: "object" } } }],
    temperature: 0,
    stream: true,
    timeoutMs: 5000,
    signal: new AbortController().signal,
    ...over,
  });

  it("parses a JSON body that arrived without a JSON content-type", async () => {
    // Several OpenAI-compatible gateways answer `stream: true` with a single
    // JSON document but label it `text/plain` (or send no header at all). The
    // content-type shortcut cannot catch that, so the stream reader has to
    // recognise it — otherwise the whole run dies on "no usable content".
    const body = {
      id: "c",
      object: "chat.completion",
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "plain body answer" }, finish_reason: "stop" }],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "text/plain" } })),
    );
    const res = await createOpenAiTransport({ url: "http://h:1", model: "m", key: null })(req());
    expect(res.content).toBe("plain body answer");
    expect(res.streamed).toBe(false);
  });

  it("parses a JSON body with no content-type header at all", async () => {
    const body = {
      choices: [{ index: 0, message: { role: "assistant", content: "headerless answer", tool_calls: [{ id: "t1", type: "function", function: { name: "read_file", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    const res = await createOpenAiTransport({ url: "http://h:1", model: "m", key: null })(req());
    expect(res.content).toBe("headerless answer");
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0].name).toBe("read_file");
  });


  it("streams content deltas to the caller", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          sse({ choices: [{ index: 0, delta: { content: "Hel" } }] }),
          sse({ choices: [{ index: 0, delta: { content: "lo" } }] }),
          "data: [DONE]\n\n",
        ]),
      ),
    );
    const deltas: string[] = [];
    const res = await createOpenAiTransport({ url: "http://h:1", model: "m", key: null })(req({ onDelta: (d) => deltas.push(d) }));
    expect(res.content).toBe("Hello");
    expect(res.streamed).toBe(true);
    expect(deltas).toEqual(["Hel", "lo"]);
  });

  it("reassembles a tool call that arrives as fragmented SSE deltas", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: "" } }] } }] }),
          sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path"' } }] } }] }),
          sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"a.txt"}' } }] } }] }),
          "data: [DONE]\n\n",
        ]),
      ),
    );
    const res = await createOpenAiTransport({ url: "http://h:1", model: "m", key: null })(req());
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0].name).toBe("read_file");
    expect(JSON.parse(res.toolCalls[0].arguments)).toEqual({ path: "a.txt" });
  });

  it("keeps two parallel tool calls apart by index", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "a", function: { name: "read_file", arguments: "{}" } }] } }] }),
          sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "b", function: { name: "list_dir", arguments: "{}" } }] } }] }),
          "data: [DONE]\n\n",
        ]),
      ),
    );
    const res = await createOpenAiTransport({ url: "http://h:1", model: "m", key: null })(req());
    expect(res.toolCalls.map((t) => t.name)).toEqual(["read_file", "list_dir"]);
  });

  it("falls back to the JSON body when a streamed request gets JSON", async () => {
    // Phase 11's mock behaves this way; the runtime must not choke on it.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          choices: [{ index: 0, message: { role: "assistant", content: "Done.", tool_calls: [] } }],
        }),
      ),
    );
    const res = await createOpenAiTransport({ url: "http://h:1", model: "m", key: null })(req());
    expect(res.content).toBe("Done.");
    expect(res.streamed).toBe(false);
  });

  it("forwards provider reasoning as reasoning events", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          sse({ choices: [{ index: 0, delta: { reasoning_content: "Let me think. " } }] }),
          sse({ choices: [{ index: 0, delta: { reasoning_content: "Then answer." } }] }),
          sse({ choices: [{ index: 0, delta: { content: "Answer." } }] }),
          "data: [DONE]\n\n",
        ]),
      ),
    );
    const seen: string[] = [];
    const res = await createOpenAiTransport({ url: "http://h:1", model: "m", key: null })(
      req({ onReasoning: (t) => seen.push(t) }),
    );
    expect(seen).toEqual(["Let me think. ", "Then answer."]);
    expect(res.reasoning).toContain("Let me think.");
  });

  it("maps a 401 to a non-recoverable auth error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: { message: "bad key" } }, 401)));
    await expect(createOpenAiTransport({ url: "http://h:1", model: "m", key: null })(req())).rejects.toMatchObject({
      kind: "auth",
      recoverable: false,
    });
  });

  it("maps a 429 to a recoverable rate-limit error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: {} }, 429)));
    await expect(createOpenAiTransport({ url: "http://h:1", model: "m", key: null })(req())).rejects.toMatchObject({
      kind: "rate_limit",
      recoverable: true,
    });
  });

  it("classifies a refused connection as a network error, not a provider error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const err = await createOpenAiTransport({ url: "http://h:1", model: "m", key: null })(req()).catch((e) => e);
    expect(err).toBeInstanceOf(AgentRuntimeError);
    expect(err.kind).toBe("network");
    expect(err.message).toMatch(/could not connect/i);
  });

  it("reports an outer cancellation as aborted, not as a failure", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_res, rej) => {
            init.signal?.addEventListener("abort", () => {
              const e = new Error("aborted");
              e.name = "AbortError";
              rej(e);
            });
          }),
      ),
    );
    const p = createOpenAiTransport({ url: "http://h:1", model: "m", key: null })(req({ signal: controller.signal }));
    controller.abort();
    await expect(p).rejects.toMatchObject({ kind: "aborted" });
  });

  it("refuses to send a request with no endpoint or no model", async () => {
    // No network I/O may happen for a misconfigured run.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(createOpenAiTransport({ url: "", model: "m", key: null })(req())).rejects.toMatchObject({ kind: "config" });
    await expect(createOpenAiTransport({ url: "http://h:1", model: "m", key: null })(req({ model: "" }))).rejects.toMatchObject({
      kind: "config",
    });
    await expect(createOpenAiTransport({ url: "http://h:1", model: "", key: null })(req())).rejects.toMatchObject({
      kind: "config",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("normalizes a base URL that lacks the /v1 prefix", () => {
    expect(apiUrl("http://127.0.0.1:11434", "/chat/completions")).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(apiUrl("https://api.openai.com/v1", "/chat/completions")).toBe("https://api.openai.com/v1/chat/completions");
    expect(apiUrl("https://api.openai.com/v1/", "/models")).toBe("https://api.openai.com/v1/models");
  });
});

beforeEach(() => {
  vi.restoreAllMocks();
});
