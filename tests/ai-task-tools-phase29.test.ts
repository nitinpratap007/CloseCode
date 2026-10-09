// Phase 29 — the agent's task tools.
//
// Two layers are exercised here:
//
//   1. The tools as units: each of the seven translates a model request into a
//      service call and describes the outcome honestly — or refuses when the
//      permission gate says no. The service is fake here, so the test is about
//      the tool's own behaviour: argument shaping, the actor it records, and the
//      failure text it returns for a store refusal.
//
//   2. One real runtime run: a model scripted to call `task_create` actually
//      gets a task written through the *real* store, so the whole chain —
//      runtime → registry → tool → service → disk — is proven, not assumed.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createTaskTools, type TaskToolService } from "../electron/services/agent/tools-tasks";
import { type AgentTool, type AgentToolContext, type AgentPermissionRequest } from "../electron/services/agent/types";
import { AgentRuntime, type AgentRuntimeOptions } from "../electron/services/agent/runtime";
import { createBuiltinRegistry } from "../electron/services/agent/tools";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "cc-tasktools-"));
vi.mock("electron", () => ({
  app: { getPath: () => userData },
}));

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function fakeService(over: Partial<TaskToolService> = {}): TaskToolService & {
  history: Record<string, unknown[][]>;
} {
  const history: Record<string, unknown[][]> = {};
  const record =
    <A extends unknown[], R>(key: string, fn: (...a: A) => R) =>
    (...a: A): R => {
      (history[key] ??= []).push(a);
      return fn(...a);
    };
  const merged: TaskToolService = {
    list: () => ({ ok: true as const, tasks: [] }),
    create: () => ({ ok: true as const, task: fakeTask("task_create_dst") }),
    update: () => ({ ok: true as const, task: fakeTask("task_update_dst") }),
    cancel: () => ({ ok: true as const, task: fakeTask("task_cancel_dst", "cancelled") }),
    retry: () => ({ ok: true as const, task: fakeTask("task_retry_dst", "pending", 1) }),
    ...over,
  };
  // Record every method — including overridden ones — so argument assertions
  // work no matter which implementation a test supplies.
  const svc: TaskToolService = {
    list: record("list", merged.list),
    create: record("create", merged.create),
    update: record("update", merged.update),
    cancel: record("cancel", merged.cancel),
    retry: record("retry", merged.retry),
  };
  return Object.assign(svc, { history });
}

let seq = 0;
function fakeTask(id: string, status = "pending", attempts = 0) {
  seq += 1;
  return {
    id,
    title: `fake-${seq}`,
    description: "",
    parentId: null,
    dependencies: [],
    status,
    priority: "medium",
    progress: status === "completed" ? 100 : 0,
    assignee: null,
    workspace: null,
    createdAt: 1,
    updatedAt: 1,
    updatedBy: "fake",
    attempts,
    lastError: null,
    log: [],
  };
}

type CtxLike = {
  agentId?: string;
  workspace?: string | null;
  authorize?: (category: string, args: Record<string, unknown>, request?: AgentPermissionRequest) => Promise<boolean>;
};

function makeCtx(over: CtxLike = {}): AgentToolContext {
  return {
    runId: "run_test",
    agentId: over.agentId ?? "build",
    workspace: over.workspace ?? "C:\\proj",
    signal: new AbortController().signal,
    deadline: Date.now() + 60_000,
    maxOutputChars: 10_000,
    authorize: over.authorize ?? (async () => true),
    log: () => undefined,
    spawnChild: async () => ({ ok: true, resultText: "", runId: "child" }),
    spawnChildren: async () => [],
    confine: (p) => p,
  } as unknown as AgentToolContext;
}

function call(tool: AgentTool, ctx: AgentToolContext, args: Record<string, unknown>): ReturnType<AgentTool["execute"]> {
  return tool.execute(ctx, args);
}

// ---------------------------------------------------------------------------

describe("task tools — permission gate", () => {
  it("every tool refuses (granted:false) when authorize denies", async () => {
    const denied = async (): Promise<boolean> => false;
    for (const tool of createTaskTools(fakeService())) {
      const outcome = await call(tool, makeCtx({ authorize: denied }), {});
      expect(outcome.granted).toBe(false);
    }
  });

  it("the gate is asked for the tasks category with the raw args", async () => {
    let seen: { category: string; args: Record<string, unknown> } | null = null;
    const tools = createTaskTools(fakeService());
    const ctx = makeCtx({
      authorize: async (category, args) => {
        seen = { category, args };
        return true;
      },
    });
    await call(tools[1], ctx, { id: "task_x", priority: "high" });
    expect(seen?.category).toBe("tasks");
    expect(seen?.args).toEqual({ id: "task_x", priority: "high" });
  });
});

describe("task tools — argument shaping and results", () => {
  it("task_create sends a sanitised create and reports the new id", async () => {
    const svc = fakeService();
    const tools = createTaskTools(svc);
    const outcome = await call(tools[0], makeCtx(), {
      title: "  Ship 1.0  ",
      priority: "high",
      description: "never mind",
      dependencies: ["task_a", 42, "task_b"],
      parentId: "task_root",
    });
    expect(outcome.granted).toBe(true);
    expect(outcome.text).toContain("Created task task_create_dst");
    const args = svc.history.create[0] as [string | null, unknown, string];
    expect(args[0]).toBe("C:\\proj"); // workspace from ctx
    const input = args[1] as Record<string, unknown>;
    // The tool forwards the title as given; trimming and clamping are the
    // store's edge responsibilities, covered by the engine suite.
    expect(input.title).toBe("  Ship 1.0  ");
    expect(input.priority).toBe("high");
    expect(input.parentId).toBe("task_root");
    expect(input.dependencies).toEqual(["task_a", "task_b"]); // non-strings dropped
    expect(args[2]).toBe("agent:build"); // actor
  });

  it("task_create needs a title and reports an error, not a success", async () => {
    const tools = createTaskTools(fakeService());
    const outcome = await call(tools[0], makeCtx(), { title: "   " });
    expect(outcome.granted).toBe(true);
    expect(outcome.status).toBe("error");
    expect(outcome.text).toContain("title");
  });

  it("task_update forwards only known, type-matching fields", async () => {
    const svc = fakeService();
    const tools = createTaskTools(svc);
    const outcome = await call(tools[1], makeCtx(), {
      id: "task_1",
      title: "New name",
      progress: 30,
      status: "in_progress",
      assignee: "planner",
      garbage: "ignored",
    });
    expect(outcome.granted).toBe(true);
    const args = svc.history.update[0] as [string | null, string, unknown, string];
    expect(args[1]).toBe("task_1");
    const patch = args[2] as Record<string, unknown>;
    expect(patch).toEqual({ title: "New name", progress: 30, status: "in_progress", assignee: "planner" });
    expect(patch).not.toHaveProperty("garbage");
  });

  it("task_update surfaces a store refusal as a readable error", async () => {
    const svc = fakeService({
      update: () => ({ ok: false as const, error: "Cannot complete “X”: it is waiting on Y." }),
    });
    const tools = createTaskTools(svc);
    const outcome = await call(tools[1], makeCtx(), { id: "task_1", status: "completed" });
    expect(outcome.status).toBe("error");
    expect(outcome.text).toContain("waiting on Y");
  });

  it("task_list sends the filter and describes rows it was given", async () => {
    const svc = fakeService({
      list: () => ({
        ok: true as const,
        tasks: [
          { ...fakeTask("task_a", "pending"), title: "A thing", progress: 20 },
          { ...fakeTask("task_b", "completed"), title: "B thing", progress: 100 },
        ],
      }),
    });
    const tools = createTaskTools(svc);
    const outcome = await call(tools[2], makeCtx(), { status: "pending" });
    expect(outcome.granted).toBe(true);
    expect(outcome.text).toContain("A thing");
    expect(outcome.text).not.toContain("B thing"); // filtered
    const args = svc.history.list[0] as [string | null];
    expect(args[0]).toBe("C:\\proj");
  });

  it("task_complete maps to a completed update and reports the done state", async () => {
    const svc = fakeService();
    const tools = createTaskTools(svc);
    const outcome = await call(tools[3], makeCtx(), { id: "task_1" });
    expect(outcome.text).toContain("Completed task task_1");
    const args = svc.history.update[0] as [string | null, string, unknown, string];
    expect((args[2] as Record<string, unknown>).status).toBe("completed");
  });

  it("task_cancel forwards the optional reason to the service", async () => {
    const svc = fakeService();
    const tools = createTaskTools(svc);
    await call(tools[4], makeCtx(), { id: "task_1", reason: "scope cut" });
    const args = svc.history.cancel[0] as [string | null, string, unknown, string];
    expect(args[1]).toBe("task_1");
    expect(args[2]).toBe("scope cut");
    // No reason → null.
    await call(tools[4], makeCtx(), { id: "task_1" });
    const args2 = svc.history.cancel[1] as [string | null, string, unknown, string];
    expect(args2[2]).toBeNull();
  });

  it("task_retry forwards the id and reports the attempt count", async () => {
    const svc = fakeService();
    const tools = createTaskTools(svc);
    const outcome = await call(tools[5], makeCtx(), { id: "task_1" });
    expect(outcome.text).toContain("attempt 1");
    const args = svc.history.retry[0] as [string | null, string, string];
    expect(args[1]).toBe("task_1");
    expect(args[2]).toBe("agent:build");
  });

  it("task_assign requires both the id and a non-empty assignee", async () => {
    const svc = fakeService();
    const tools = createTaskTools(svc);
    const good = await call(tools[6], makeCtx(), { id: "task_1", assignee: "planner" });
    expect(good.text).toContain("Assigned task task_1 to planner");
    const args = svc.history.update[0] as [string | null, string, unknown, string];
    expect((args[2] as Record<string, unknown>).assignee).toBe("planner");

    const missing = await call(tools[6], makeCtx(), { id: "task_1", assignee: "   " });
    expect(missing.status).toBe("error");
    const missingId = await call(tools[6], makeCtx(), { assignee: "planner" });
    expect(missingId.status).toBe("error");
  });

  it("the registry holds seven task tools in a stable order and marks task_list read-only", async () => {
    const tools = createTaskTools(fakeService());
    expect(tools.map((t) => t.name)).toEqual([
      "task_create",
      "task_update",
      "task_list",
      "task_complete",
      "task_cancel",
      "task_retry",
      "task_assign",
    ]);
    expect(tools.every((t) => t.category === "tasks")).toBe(true);
    expect(tools.find((t) => t.name === "task_list")?.readOnly).toBe(true);
    expect(tools.find((t) => t.name === "task_list")?.destructive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The real chain: runtime → registry → tool → real store → disk
// ---------------------------------------------------------------------------

type Mod = typeof import("../electron/services/aiTasks");

let taskDir: string;
let mod: Mod;

async function load(): Promise<Mod> {
  vi.resetModules();
  const m = await import("../electron/services/aiTasks");
  taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-tt-real-"));
  m.setTasksDir(taskDir);
  return m;
}

function scriptedTransport(script: Array<{ content?: string; toolCalls?: Array<{ name: string; args: unknown }> }>): {
  transport: NonNullable<AgentRuntimeOptions["createTransport"]>;
} {
  let i = 0;
  const transport = async (req: Parameters<NonNullable<AgentRuntimeOptions["createTransport"]>>[0]) => {
    const turn = script[Math.min(i, script.length - 1)];
    i += 1;
    return {
      content: turn.content ?? "",
      toolCalls: (turn.toolCalls ?? []).map((tc, n) => ({
        id: `call-${i}-${n}`,
        name: tc.name,
        arguments: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args),
      })),
      streamed: false,
    };
  };
  return { transport };
}

beforeEach(async () => {
  mod = await load();
});

afterEach(() => {
  try {
    fs.rmSync(taskDir, { recursive: true, force: true });
  } catch {
    // Windows handles: disposable temp dir either way.
  }
});

describe("task tools — one real run writes a real task (Phase 29 integration)", () => {
  it("a model calling task_create lands a task in the store file", async () => {
    const { transport } = scriptedTransport([
      { toolCalls: [{ name: "task_create", args: { title: "Add error handling", priority: "urgent" } }] },
      { content: "Recorded it." },
    ]);
    const runtime = new AgentRuntime({
      registry: createBuiltinRegistry(true, createTaskTools(mod.taskService)),
      createTransport: () => transport,
      onEvent: () => undefined,
    });

    const result = await runtime.run({
      agentId: "build",
      task: "Make sure outstanding work is tracked.",
      workspace: "C:\\real",
      endpoint: { url: "http://127.0.0.1:11434", model: "t", key: null },
      temperature: 0,
      timeoutMs: 5000,
      stream: true,
      permissions: { files: "allow", search: "allow", git: "allow", terminal: "allow", tasks: "allow" },
    });

    expect(result.status).toBe("completed");
    expect(result.toolCalls).toBe(1);
    const list = mod.listTasks("C:\\real");
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.tasks).toHaveLength(1);
    expect(list.tasks[0].title).toBe("Add error handling");
    expect(list.tasks[0].priority).toBe("urgent");
    expect(list.tasks[0].updatedBy).toBe("agent:build");
    // The trace shows the permission gate passed and the call succeeded.
    const trace = runtime.getRun(result.runId)?.trace ?? [];
    expect(trace.some((t) => t.kind === "tool" && (t as { tool?: string }).tool === "task_create")).toBe(true);
  });

  it("a model denied by the permission gate gets a refusal, not a fake success", async () => {
    const { transport } = scriptedTransport([
      { toolCalls: [{ name: "task_create", args: { title: "Should not exist" } }] },
      { content: "Understood." },
    ]);
    const runtime = new AgentRuntime({
      registry: createBuiltinRegistry(true, createTaskTools(mod.taskService)),
      createTransport: () => transport,
      onEvent: () => undefined,
    });
    const result = await runtime.run({
      agentId: "build",
      task: "Whatever it takes.",
      workspace: "C:\\real",
      endpoint: { url: "http://127.0.0.1:11434", model: "t", key: null },
      temperature: 0,
      timeoutMs: 5000,
      stream: true,
      permissions: { tasks: "deny" },
    });
    expect(result.status).toBe("completed");
    const list = mod.listTasks("C:\\real");
    expect(list.ok).toBe(true);
    if (list.ok) expect(list.tasks).toHaveLength(0);
  });
});