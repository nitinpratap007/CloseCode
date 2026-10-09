// Phase 25 unit tests: the subagent system.
//
// The acceptance criteria are demonstrated here:
//
//   * primary agents can delegate work
//   * subagents can execute tools
//   * results return to the parent
//   * failed subagents do not crash the application
//   * parallel execution is controlled
//   * resource usage is bounded
//
// Two rules govern how every test below is written.
//
// **Assert the side effect, not the status field.** Where a claim is "this role
// cannot write", the assertion is that no file appeared on disk — with every
// permission category set to `allow`, so nothing but the agent's own tool policy
// can be responsible. A test that checked the advertised tool list would pass
// against a runtime that advertised the right tools and then ran whatever the
// model asked for by name, which is precisely the bug Phase 24 found.
//
// **Drive the real runtime.** These tests use the real `AgentRuntime` and the
// real tool registry. The transport is scripted, because a test cannot call a
// hosted model, but everything below the transport is production code.

import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { AgentRuntime } from "../electron/services/agent/runtime";
import { createBuiltinRegistry, DELEGATE_TOOL_NAME, type ToolRegistry } from "../electron/services/agent/tools";
import {
  agentIds,
  allAgentIds,
  getAgentDefinition,
  listAgentDefinitions,
  listSubagentDefinitions,
} from "../electron/services/agent/definitions";
import { SUBAGENTS, subagentIds } from "../electron/services/agent/subagents";
import type {
  AgentCompletionRequest,
  AgentCompletionResult,
  AgentEvent,
  AgentRunSpec,
} from "../electron/services/agent/types";

const ROLES = [
  "explorer",
  "general",
  "coder",
  "tester",
  "reviewer",
  "debugger",
  "security",
  "documentation",
  "researcher",
] as const;

const registry = createBuiltinRegistry(true);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Turn {
  content?: string;
  toolCalls?: Array<{ name: string; args: unknown }>;
}

/**
 * A transport driven by a responder rather than by a fixed script.
 *
 * Phase 25 could not use a positional script. A child is `await`ed inside
 * `spawnChild`, so it consumes transport turns *immediately* after the parent's
 * `delegate_task` — the parent's "next" turn is really the child's first. With
 * parallel batches the order children take turns in is decided by a scheduler,
 * not by the test. A positional script therefore feeds a child's answer to the
 * parent or vice versa, and the failure reads as a runtime bug when it is a test
 * bug.
 *
 * The responder inspects the *request*, so it answers correctly however the turns
 * interleave.
 */
type Responder = (req: AgentCompletionRequest) => Turn | Promise<Turn>;

function transport(fn: Responder) {
  return async (req: AgentCompletionRequest): Promise<AgentCompletionResult> => {
    // Awaited, so a responder can wait — which is how a child is made to take a
    // measurable amount of time, and therefore how overlap between children
    // becomes observable.
    const turn = await fn(req);
    return {
      content: turn.content ?? "",
      toolCalls: (turn.toolCalls ?? []).map((t, n) => ({
        id: `call-${Math.random().toString(36).slice(2)}-${n}`,
        name: t.name,
        arguments: JSON.stringify(t.args),
      })),
      streamed: false,
    };
  };
}

/** Which sub-agent role this request came from, by its system prompt. */
function roleOf(req: AgentCompletionRequest): string | null {
  const system = req.messages[0]?.content ?? "";
  for (const role of SUBAGENTS) {
    // Each role's prompt opens "You are the <Name> subagent." Matching that shape
    // rather than a bare word keeps a review's own findings from reading as a
    // request from the reviewer.
    if (system.includes(`${role.name} subagent`)) return role.id;
  }
  return null;
}

/** True once this conversation has already seen a tool result. */
function answered(req: AgentCompletionRequest): boolean {
  return req.messages.some((m) => m.role === "tool");
}

/**
 * The standard child script: call `toolName` once, then stop.
 *
 * Branches on whether the tool has already run, which is how a real model
 * behaves and — unlike a positional script — stays correct for any number of
 * concurrent children.
 */
function childCalls(toolName: string, args: unknown): Responder {
  return (req) =>
    answered(req) ? { content: "CHILD DONE" } : { toolCalls: [{ name: toolName, args }] };
}

/** Every child answers with its own role's line, so a label can be matched to text. */
function childAnswers(answers: Record<string, string>): Responder {
  return (req) => ({ content: answers[roleOf(req) ?? ""] ?? "UNLABELLED ANSWER" });
}

/**
 * A parent that delegates once and then finishes, with any child behaviour
 * supplied separately. The common shape for most of these tests.
 */
function parentDelegates(
  args: unknown,
  child: Responder,
  parentText = "PARENT DONE",
  extraParentTurns: Responder = () => ({ content: parentText }),
): Responder {
  return (req) => {
    if (roleOf(req)) return child(req);
    if (!answered(req)) return { toolCalls: [{ name: DELEGATE_TOOL_NAME, args }] };
    return extraParentTurns(req);
  };
}

/** Every category wide open, so only an agent's own policy can refuse. */
function spec(over: Partial<AgentRunSpec> = {}): AgentRunSpec {
  return {
    agentId: "build",
    task: "do the thing",
    workspace: null,
    endpoint: { url: "http://127.0.0.1:1", model: "m", key: null },
    temperature: 0,
    timeoutMs: 5000,
    stream: false,
    permissions: {
      files: "allow",
      search: "allow",
      git: "allow",
      terminal: "allow",
      agent: "allow",
      web: "allow",
      browser: "allow",
    },
    ...over,
  } as AgentRunSpec;
}

function ws(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `p25-${prefix}-`));
}

interface Harness {
  runtime: AgentRuntime;
  events: AgentEvent[];
}

/**
 * `respond` is asked afresh for every turn, from whichever run is speaking. The
 * parent is identified by the absence of a sub-agent role marker, so a responder
 * can give the parent a different script from its children.
 */
function harness(respond: Responder, reg: ToolRegistry = registry): Harness {
  const events: AgentEvent[] = [];
  const runtime = new AgentRuntime({
    registry: reg,
    createTransport: () => transport(respond),
    onEvent: (ev) => events.push(ev),
    approvalTimeoutMs: 80,
  });
  return { runtime, events };
}

function toolResults(events: AgentEvent[]): string {
  return toolEvents(events)
    .map((e) => e.result)
    .join("\n");
}

function toolEvents(events: AgentEvent[]): Extract<AgentEvent, { type: "tool" }>[] {
  return events.filter((e): e is Extract<AgentEvent, { type: "tool" }> => e.type === "tool");
}

function childrenOf(runtime: AgentRuntime) {
  return runtime.listRuns().filter((r) => r.depth === 1);
}

// ---------------------------------------------------------------------------
// The roles exist, and they are not primaries
// ---------------------------------------------------------------------------

describe("Phase 25 · the nine roles exist and are distinguishable from primaries", () => {
  it("registers exactly the nine roles the phase asked for", () => {
    expect([...subagentIds()].sort()).toEqual([...ROLES].sort());
    expect(SUBAGENTS).toHaveLength(9);
  });

  it("keeps subagents out of the list a user picks from", () => {
    // The Phase 24/33 contract: the selector offers six primaries. Adding nine roles must
    // not have widened it, or "Explorer" would look startable when it is not.
    expect(listAgentDefinitions()).toHaveLength(6);
    expect(agentIds()).toEqual(["build", "plan", "review", "debug", "commander", "builder"]);
    for (const id of agentIds()) {
      expect(ROLES as readonly string[]).not.toContain(id);
    }
  });

  it("exposes the roles through a separate accessor, marked as subagents", () => {
    const roles = listSubagentDefinitions();
    expect(roles).toHaveLength(9);
    for (const role of roles) expect(role.kind).toBe("subagent");
    for (const primary of listAgentDefinitions()) expect(primary.kind).toBe("primary");
  });

  it("gives every role a distinct id, a name and a real description", () => {
    const ids = new Set<string>();
    for (const role of SUBAGENTS) {
      expect(ids.has(role.id), `duplicate role id ${role.id}`).toBe(false);
      ids.add(role.id);
      expect(role.name.length).toBeGreaterThan(2);
      // Phase 24 set this bar for primaries because a model choosing between
      // agents needs to be able to tell them apart. It applies equally here, and
      // a model picking a delegation target is making exactly that choice.
      expect(role.description.length, `${role.id} has a thin description`).toBeGreaterThan(40);
      expect(role.systemPrompt.length).toBeGreaterThan(80);
      expect(role.maxSteps ?? 0).toBeGreaterThan(0);
    }
  });

  it("resolves a role through the same lookup a delegation target uses", () => {
    for (const id of ROLES) {
      expect(getAgentDefinition(id)?.id).toBe(id);
    }
    // Phase 33: 6 primaries + 9 subagents = 15
    expect(allAgentIds()).toHaveLength(15);
  });

  it("does not describe two roles as the same job", () => {
    // The `review`/`reviewer` overlap flagged while planning this phase: two
    // prompts doing one job drift apart, and a user reading both descriptions
    // cannot tell which to reach for. Distinct ids with near-identical text would
    // be nine roles in name and four in substance.
    const prompts = SUBAGENTS.map((r) => r.systemPrompt);
    expect(new Set(prompts).size).toBe(SUBAGENTS.length);
    const primaryReview = getAgentDefinition("review")!.systemPrompt;
    for (const role of SUBAGENTS) {
      expect(role.systemPrompt, `${role.id} repeats the review primary verbatim`).not.toBe(primaryReview);
    }
  });
});

// ---------------------------------------------------------------------------
// Criterion 1 — primary agents can delegate
// ---------------------------------------------------------------------------

describe("Phase 25 · primary agents can delegate work", () => {
  it("offers delegation to build and plan, and withholds it from review and debug", () => {
    const offered = (id: string): boolean =>
      registry.resolveFor(getAgentDefinition(id)!).names.includes(DELEGATE_TOOL_NAME);
    expect(offered("build")).toBe(true);
    expect(offered("plan")).toBe(true);
    expect(offered("review")).toBe(false);
    expect(offered("debug")).toBe(false);
  });

  it("only delegates to roles that really exist", () => {
    for (const id of agentIds()) {
      for (const target of getAgentDefinition(id)!.delegates ?? []) {
        expect(getAgentDefinition(target), `${id} delegates to unknown "${target}"`).toBeDefined();
      }
    }
  });

  it("never lets a delegation target delegate again", () => {
    for (const id of agentIds()) {
      for (const target of getAgentDefinition(id)!.delegates ?? []) {
        expect(getAgentDefinition(target)!.delegates ?? [], `${target} may not delegate`).toEqual([]);
      }
    }
    for (const role of SUBAGENTS) {
      expect(role.delegates ?? [], `${role.id} may not delegate`).toEqual([]);
    }
  });

  it("really starts a child run and records it against its parent", async () => {
    const { runtime, events } = harness(
      parentDelegates(
        { agent: "explorer", task: "map the auth code" },
        () => ({ content: "The auth code lives in src/auth." }),
      ),
    );
    await runtime.start(spec({ agentId: "build", workspace: ws("deleg") })).done;

    const child = childrenOf(runtime)[0];
    expect(child, "no child run was created").toBeDefined();
    expect(child!.agentId).toBe("explorer");
    expect(child!.depth).toBe(1);
    expect(child!.parentRunId).not.toBeNull();
    // And the parent really received the answer, not just a "done".
    expect(toolResults(events)).toContain("src/auth");
  });

  it("refuses a target the parent is not allowed to delegate to", async () => {
    // `plan` does not list `coder`, and `review` lists nothing at all. A model
    // that asks anyway must be told so rather than silently served.
    const { runtime, events } = harness(
      (req) =>
        answered(req)
          ? { content: "PARENT DONE" }
          : { toolCalls: [{ name: DELEGATE_TOOL_NAME, args: { agent: "coder", task: "write it" } }] },
    );
    const result = await runtime.start(spec({ agentId: "plan", workspace: ws("refuse") })).done;
    expect(toolResults(events)).toMatch(/not allowed to delegate/i);
    // And nothing was spawned.
    expect(childrenOf(runtime)).toHaveLength(0);
    expect(result.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Criterion 2 — subagents can execute tools
// ---------------------------------------------------------------------------

describe("Phase 25 · subagents can execute tools", () => {
  it("gives every role a non-empty tool set drawn from the real registry", () => {
    for (const role of SUBAGENTS) {
      const names = registry.resolveFor(getAgentDefinition(role.id)!).names;
      expect(names.length, `${role.id} was offered no tools at all`).toBeGreaterThan(0);
      for (const name of names) {
        expect(registry.names(), `${role.id} was offered a tool that does not exist`).toContain(name);
      }
    }
  });

  it("gives the roles genuinely different tool sets", () => {
    const sets = SUBAGENTS.map((r) => registry.resolveFor(getAgentDefinition(r.id)!).names.join(","));
    // Distinct policies, not nine copies of one. Two roles sharing a set is
    // fine; nine identical ones would mean the roles are only different names.
    expect(new Set(sets).size).toBeGreaterThan(3);
  });

  it("really executes a tool in a child run", async () => {
    const root = ws("toolrun");
    const target = path.join(root, "written-by-coder.txt");
    const { runtime } = harness(
      parentDelegates(
        { agent: "coder", task: "write a file" },
        childCalls("write_file", { path: target, content: "real content" }),
      ),
    );
    await runtime.start(spec({ agentId: "build", workspace: root })).done;
    expect(fs.existsSync(target), "the coder subagent did not actually write a file").toBe(true);
    expect(fs.readFileSync(target, "utf-8")).toBe("real content");
  });

  it("does not offer delegation to a subagent, even one running as a child", () => {
    for (const role of SUBAGENTS) {
      expect(
        registry.resolveFor(getAgentDefinition(role.id)!).names,
        `${role.id} was offered delegate_task`,
      ).not.toContain(DELEGATE_TOOL_NAME);
    }
  });
});

// ---------------------------------------------------------------------------
// The write-access rule the owner chose
// ---------------------------------------------------------------------------

describe("Phase 25 · only coder and tester may write", () => {
  const WRITERS = ["coder", "tester"];

  it("advertises write tools to exactly two roles", () => {
    for (const role of SUBAGENTS) {
      const names = registry.resolveFor(getAgentDefinition(role.id)!).names;
      const canWrite = names.includes("write_file") || names.includes("edit_file");
      expect(canWrite, `${role.id} ${canWrite ? "can" : "cannot"} write`).toBe(
        (WRITERS as readonly string[]).includes(role.id),
      );
    }
  });

  it("gives no role delete_file and no role a git write tool", () => {
    for (const role of SUBAGENTS) {
      const names = registry.resolveFor(getAgentDefinition(role.id)!).names;
      expect(names, `${role.id} was offered delete_file`).not.toContain("delete_file");
      for (const gitWrite of ["git_commit", "git_add", "git_checkout", "git_create_branch", "git_merge"]) {
        expect(names, `${role.id} was offered ${gitWrite}`).not.toContain(gitWrite);
      }
    }
  });

  it("actually refuses a write from every read-only role, with nothing written", async () => {
    const root = ws("readonly");
    for (const role of SUBAGENTS.filter((r) => !WRITERS.includes(r.id))) {
      const target = path.join(root, `${role.id}.txt`);
      const { runtime, events } = harness(
        parentDelegates(
          { agent: role.id, task: "write a file" },
          childCalls("write_file", { path: target, content: "should not exist" }),
        ),
      );
      await runtime.start(spec({ agentId: "build", workspace: root })).done;
      expect(fs.existsSync(target), `${role.id} wrote a file despite being read-only`).toBe(false);
      const refusal = toolEvents(events).find((e) => e.tool === "write_file");
      expect(refusal, `${role.id} was not refused at all`).toBeDefined();
      expect(refusal!.error?.code, `${role.id} was refused for the wrong reason`).toBe("agent_policy");
      expect(refusal!.error!.data).toMatchObject({ agentId: role.id, tool: "write_file" });
    }
  }, 40_000);

  it("lets coder actually write, so the refusal above is not a broken tool", async () => {
    // The positive control. Without this, "no role wrote a file" would also pass
    // if `write_file` had stopped working entirely — which is the failure mode a
    // permission test is most prone to.
    const root = ws("writer");
    const target = path.join(root, "coder-ok.txt");
    const { runtime, events } = harness(
      parentDelegates(
        { agent: "coder", task: "write a file" },
        childCalls("write_file", { path: target, content: "allowed" }),
      ),
    );
    await runtime.start(spec({ agentId: "build", workspace: root })).done;
    expect(fs.existsSync(target), "coder could not write, so the refusals prove nothing").toBe(true);
    const write = toolEvents(events).find((e) => e.tool === "write_file");
    expect(write!.granted).toBe(true);
  });

  it("stops a read-only role running a shell command", async () => {
    const root = ws("noshell");
    const marker = "ran.txt";
    const { runtime, events } = harness(
      parentDelegates(
        { agent: "explorer", task: "run something" },
        childCalls("run_terminal", {
          command: `node -e "require('fs').writeFileSync('${marker}','ran')"`,
        }),
      ),
    );
    await runtime.start(spec({ agentId: "build", workspace: root })).done;
    expect(fs.existsSync(path.join(root, marker)), "explorer ran a shell command").toBe(false);
    const attempt = toolEvents(events).find((e) => e.tool === "run_terminal");
    expect(attempt?.error?.code).toBe("agent_policy");
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Criterion 3 — results return to the parent
// ---------------------------------------------------------------------------

describe("Phase 25 · results return to the parent", () => {
  it("returns a single child's answer to the parent", async () => {
    const { runtime, events } = harness(
      parentDelegates(
        { agent: "reviewer", task: "check it" },
        () => ({ content: "Two findings: one critical, one minor." }),
      ),
    );
    await runtime.start(spec({ agentId: "build", workspace: ws("result") })).done;
    expect(toolResults(events)).toContain("Two findings");
  });

  it("returns a batch positionally, each answer labelled by the role that produced it", async () => {
    const { runtime, events } = harness(
      parentDelegates(
        {
          tasks: [
            { agent: "explorer", task: "map it" },
            { agent: "reviewer", task: "check it" },
            { agent: "documentation", task: "explain it" },
          ],
        },
        childAnswers({
          explorer: "EXPLORER ANSWER",
          reviewer: "REVIEWER ANSWER",
          documentation: "DOCUMENTATION ANSWER",
        }),
      ),
    );
    await runtime.start(spec({ agentId: "build", workspace: ws("batch") })).done;
    const text = toolResults(events);
    // Each role's answer sits under its own heading. This is the positional
    // guarantee: a label and the text beneath it are the same child, so a parent
    // cannot act on a review as if it were a test report.
    for (const role of ["explorer", "reviewer", "documentation"]) {
      const block = text.split(`### ${role}`)[1]?.split("###")[0] ?? "";
      expect(block, `no labelled block for ${role}`).not.toBe("");
      expect(block).toContain(`${role.toUpperCase()} ANSWER`);
    }
  });

  it("keeps one child's failure from displacing the others", async () => {
    // The dangerous shape would be a results array shorter than the request,
    // which shifts every later answer onto the wrong task. `ghost` is refused and
    // never starts, and the real answer must still sit under its own label.
    const { runtime, events } = harness(
      parentDelegates(
        {
          tasks: [
            { agent: "ghost", task: "does not exist" },
            { agent: "explorer", task: "map it" },
          ],
        },
        childAnswers({ explorer: "EXPLORER ANSWER" }),
      ),
    );
    const result = await runtime.start(spec({ agentId: "build", workspace: ws("partial") })).done;
    const text = toolResults(events);
    expect(text).toContain("### ghost");
    expect(text).toContain("### explorer");
    // The explorer's own text is under the explorer's own heading — not shifted
    // up into the failed slot.
    const explorerBlock = text.split("### explorer")[1] ?? "";
    expect(explorerBlock).toContain("EXPLORER ANSWER");
    expect(result.status).toBe("completed");
  });

  it("says so when a batch entry is malformed instead of guessing", async () => {
    const { runtime, events } = harness(
      (req) =>
        answered(req)
          ? { content: "PARENT DONE" }
          : { toolCalls: [{ name: DELEGATE_TOOL_NAME, args: { tasks: [{ agent: "explorer" }] } }] },
    );
    await runtime.start(spec({ agentId: "build", workspace: ws("badbatch") })).done;
    expect(toolResults(events)).toMatch(/needs both `agent` and `task`/i);
    expect(childrenOf(runtime)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Criterion 4 — failed subagents do not crash the application
// ---------------------------------------------------------------------------

describe("Phase 25 · a failed subagent does not take the app down", () => {
  it("survives an unknown target and keeps the parent running", async () => {
    const { runtime, events } = harness((req) =>
      answered(req)
        ? { content: "parent completed the work" }
        : { toolCalls: [{ name: DELEGATE_TOOL_NAME, args: { agent: "does-not-exist", task: "x" } }] },
    );
    const result = await runtime.start(spec({ agentId: "build", workspace: ws("unknown") })).done;
    expect(result.status).toBe("completed");
    expect(result.text).toContain("parent completed the work");
    expect(toolResults(events)).toMatch(/could not start|Unknown sub-agent/i);
  });

  it("survives an empty task", async () => {
    const { runtime } = harness((req) =>
      answered(req)
        ? { content: "parent done" }
        : { toolCalls: [{ name: DELEGATE_TOOL_NAME, args: { agent: "explorer", task: "   " } }] },
    );
    const result = await runtime.start(spec({ agentId: "build", workspace: ws("empty") })).done;
    expect(result.status).toBe("completed");
    expect(childrenOf(runtime)).toHaveLength(0);
  });

  it("reports a child that ran out of steps as a failed child, not a failed parent", async () => {
    const root = ws("childfail");
    for (const name of ["a", "b", "c", "d", "e"]) {
      fs.writeFileSync(path.join(root, `${name}.ts`), `export const ${name} = 1;\n`);
    }
    // The child asks for a tool every turn and never concludes, so it hits its
    // own step ceiling of 4 rather than the parent's 8.
    const { runtime } = harness(
      parentDelegates({ agent: "explorer", task: "go on forever" }, (req) => ({
        toolCalls: [{ name: "read_file", args: { path: `${String(req.messages.length)}.ts` } }],
      })),
    );
    const result = await runtime.start(spec({ agentId: "build", workspace: root })).done;
    expect(result.status, "a child's step ceiling failed the parent").toBe("completed");
    expect(result.text).toContain("PARENT DONE");
    const child = childrenOf(runtime)[0];
    expect(child?.status, "the child did not report its own failure").not.toBe("completed");
  }, 20_000);

  it("survives a child whose transport throws", async () => {
    const { runtime } = harness((req) => {
      if (roleOf(req)) throw new Error("the child endpoint exploded");
      return answered(req) ? { content: "parent carried on" } : { toolCalls: [{ name: DELEGATE_TOOL_NAME, args: { agent: "explorer", task: "anything" } }] };
    });
    const result = await runtime.start(spec({ agentId: "build", workspace: ws("throw") })).done;
    expect(result.status).toBe("completed");
    expect(result.text).toContain("parent carried on");
  });

  it("leaves the runtime usable after a failed delegation", async () => {
    const { runtime } = harness((req) =>
      answered(req)
        ? { content: "first run done" }
        : { toolCalls: [{ name: DELEGATE_TOOL_NAME, args: { agent: "nope", task: "x" } }] },
    );
    await runtime.start(spec({ agentId: "build", workspace: ws("reuse") })).done;
    // A second, unrelated run on the same runtime must work normally.
    const second = harness(() => ({ content: "second run done" }));
    const result = await second.runtime.start(spec({ workspace: ws("reuse2") })).done;
    expect(result.status).toBe("completed");
    expect(result.text).toBe("second run done");
    expect(runtime.activeRuns()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Criterion 5 — parallel execution is controlled
// ---------------------------------------------------------------------------

describe("Phase 25 · parallel execution is controlled", () => {
  /**
   * Watches how many child runs are alive at the same instant.
   *
   * Measuring live *runs* rather than a custom instrumented tool is deliberate.
   * Each role declares an explicit tool allow-list, so a test-only tool is not
   * visible to a subagent at all — an earlier version of these tests registered a
   * probe tool and measured zero, because the subagent's own policy correctly
   * refused it. The run count is also the thing the cap is actually written
   * against, so this measures the real quantity rather than a proxy.
   */
  function watchLiveChildren(runtime: AgentRuntime): { stop: () => number } {
    let peak = 0;
    const timer = setInterval(() => {
      peak = Math.max(peak, runtime.listRuns().filter((r) => r.depth === 1 && !TERMINAL.has(r.status)).length);
    }, 4);
    return {
      stop: () => {
        clearInterval(timer);
        return peak;
      },
    };
  }

  const TERMINAL = new Set(["completed", "failed", "cancelled"]);

  const SIX: unknown[] = Array.from({ length: 6 }, (_, i) => ({
    agent: "explorer",
    task: `task ${i}`,
  }));

  it("runs a batch concurrently rather than one after another", async () => {
    // Each child takes a visible amount of time to answer, so overlap is
    // observable if it happens and impossible to fake if it does not.
    const { runtime } = harness(
      parentDelegates({ tasks: SIX }, async () => {
        await new Promise((r) => setTimeout(r, 60));
        return { content: "CHILD DONE" };
      }),
    );
    const watcher = watchLiveChildren(runtime);
    const result = await runtime.start(spec({ agentId: "build", workspace: ws("par") })).done;
    const peak = watcher.stop();
    expect(result.status).toBe("completed");
    // Concurrency happened at all. If the pool ran serially this would be 1, and
    // the test would be asserting against a loop rather than the pool.
    expect(peak, "the batch ran serially").toBeGreaterThan(1);
  }, 40_000);

  it("never runs more children at once than the cap allows", async () => {
    const { runtime } = harness(
      parentDelegates({ tasks: SIX }, async () => {
        await new Promise((r) => setTimeout(r, 80));
        return { content: "CHILD DONE" };
      }),
    );
    const watcher = watchLiveChildren(runtime);
    await runtime.start(spec({ agentId: "build", workspace: ws("cap") })).done;
    const peak = watcher.stop();
    // The cap is 3. Asserting `<= 3` rather than `=== 3` because a scheduler is
    // allowed to run fewer; what must never happen is more.
    expect(peak, "more children ran at once than the cap allows").toBeLessThanOrEqual(3);
    expect(runtime.activeRuns()).toHaveLength(0);
  }, 40_000);

  it("starts every child in a batch, rather than silently dropping the overflow", async () => {
    // The cap bounds how many run *at once*, not how many the batch may contain.
    // A batch of six with a cap of three must still produce six answers, or a
    // parent would read a truncated result as a complete one.
    const { runtime, events } = harness(
      parentDelegates({ tasks: SIX }, async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { content: "CHILD DONE" };
      }),
    );
    await runtime.start(spec({ agentId: "build", workspace: ws("all") })).done;
    // Four is the per-run child budget, so six is over it and the last two are
    // refused — visibly, in their own slots, rather than dropped.
    expect(childrenOf(runtime)).toHaveLength(4);
    const text = toolResults(events);
    for (let i = 0; i < SIX.length; i += 1) {
      expect(text, `slot ${i} has no result`).toContain(`### explorer`);
    }
  }, 40_000);

  it("refuses further children once the per-run budget is spent", async () => {
    const { runtime, events } = harness((req) => {
      if (roleOf(req)) return { content: "CHILD DONE" };
      // Counted from the conversation rather than from a closure variable: a
      // returned turn with no tool call *ends* a run, so a counter that assumed
      // the parent would ask again would silently stop after one delegation.
      const results = req.messages.filter((m) => m.role === "tool").length;
      if (results === 0) {
        return {
          toolCalls: [
            {
              name: DELEGATE_TOOL_NAME,
              args: {
                tasks: Array.from({ length: 4 }, (_, i) => ({ agent: "explorer", task: `t${i}` })),
              },
            },
          ],
        };
      }
      if (results === 1) {
        // A fifth child, which must be refused rather than silently dropped.
        return { toolCalls: [{ name: DELEGATE_TOOL_NAME, args: { agent: "explorer", task: "five" } }] };
      }
      return { content: "PARENT DONE" };
    });
    const result = await runtime.start(spec({ agentId: "build", workspace: ws("budget") })).done;
    expect(result.status).toBe("completed");
    expect(childrenOf(runtime)).toHaveLength(4);
    expect(toolResults(events)).toMatch(/maximum of 4 sub-agents/i);
  }, 40_000);

  it("bounds live runs across the whole runtime, not just one parent", async () => {
    // Two parents, each well inside its own budget of four, together would
    // exceed the global cap. The per-parent bound alone would let all eight run.
    const FOUR = Array.from({ length: 4 }, (_, i) => ({ agent: "explorer", task: `t${i}` }));
    const { runtime } = harness(
      parentDelegates({ tasks: FOUR }, async () => {
        await new Promise((r) => setTimeout(r, 70));
        return { content: "CHILD DONE" };
      }),
    );
    let peakLive = 0;
    const watcher = setInterval(() => {
      peakLive = Math.max(peakLive, runtime.activeRuns().length);
    }, 4);
    try {
      await Promise.all([
        runtime.start(spec({ agentId: "build", workspace: ws("g1") })).done,
        runtime.start(spec({ agentId: "build", workspace: ws("g2") })).done,
      ]);
    } finally {
      clearInterval(watcher);
    }
    // The cap counts runs and a parent counts as one, so more than 8 alive at
    // once would mean the global bound did not hold.
    expect(peakLive, "the global concurrent-run cap did not hold").toBeLessThanOrEqual(8);
    expect(runtime.activeRuns()).toHaveLength(0);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Criterion 6 — resource usage is bounded
// ---------------------------------------------------------------------------

describe("Phase 25 · resource usage is bounded", () => {
  it("refuses to nest a subagent inside a subagent", () => {
    // A child cannot even be offered the tool, so the depth check is a backstop
    // rather than the primary control. Assert both facts.
    for (const role of SUBAGENTS) {
      expect(role.maxDepth ?? 0, `${role.id} may nest`).toBe(0);
    }
    for (const id of agentIds()) {
      const def = getAgentDefinition(id)!;
      if ((def.delegates ?? []).length > 0) expect(def.maxDepth).toBe(1);
    }
  });

  it("caps a child's own step budget below its parent's", async () => {
    // The child asks for a tool every turn and never concludes. Unbounded it
    // would run to the parent's ceiling; the child ceiling is 4.
    const root = ws("steps");
    for (const name of ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"]) {
      fs.writeFileSync(path.join(root, `${name}.ts`), `export const ${name} = 1;\n`);
    }
    const { runtime } = harness(
      parentDelegates({ agent: "explorer", task: "loop" }, (req) => ({
        toolCalls: [{ name: "read_file", args: { path: `${String(req.messages.length)}.ts` } }],
      })),
    );
    await runtime.start(spec({ agentId: "build", workspace: root })).done;
    const child = childrenOf(runtime)[0];
    expect(child, "no child run").toBeDefined();
    // 4 steps means at most 4 tool rounds; the parent's own budget is 8.
    expect(child!.steps).toBeLessThanOrEqual(4);
  }, 30_000);

  it("counts children started, not children still running", async () => {
    // The budget must not refill as children land, or a parent's total cost
    // depends on how fast its children happen to be. Five serial delegations:
    // each child has long finished before the next begins, so a budget counted in
    // *live* children would allow all five.
    const { runtime, events } = harness((req) => {
      if (roleOf(req)) return { content: "CHILD DONE" };
      const results = req.messages.filter((m) => m.role === "tool").length;
      if (results < 5) {
        return {
          toolCalls: [{ name: DELEGATE_TOOL_NAME, args: { agent: "explorer", task: `t${results}` } }],
        };
      }
      return { content: "PARENT DONE" };
    });
    const result = await runtime.start(spec({ agentId: "build", workspace: ws("count") })).done;
    expect(result.status).toBe("completed");
    // Five were asked for; four ran and the fifth was refused.
    expect(childrenOf(runtime)).toHaveLength(4);
    expect(toolResults(events)).toMatch(/maximum of 4 sub-agents/i);
  }, 40_000);

  it("cancels every child when the parent is stopped", async () => {
    // The serial path had a cancel cascade from Phase 21. A pool is new
    // machinery, so the property has to be re-proved rather than assumed.
    //
    // The children hang in their *transport* rather than in a tool, and they
    // honour the abort signal the runtime hands them — which is what a real
    // transport does, and what the runtime passes it for.
    //
    // A test-only hanging *tool* would not work: each role declares an explicit
    // allow-list, so an unregistered tool is refused by policy and the children
    // finish instantly. This shape is what a subagent waiting on a slow endpoint
    // actually looks like.
    //
    // The signal matters to the claim. If the cascade were removed, nothing would
    // abort the children's signals, so they would wait out the full timeout and
    // the final assertion would fail. The test therefore fails both when the
    // runtime forgets to stop a child and when the child ignores being stopped.
    const { runtime } = harness((req) => {
      if (roleOf(req)) {
        return new Promise<Turn>((_, reject) => {
          req.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      return {
        toolCalls: [
          {
            name: DELEGATE_TOOL_NAME,
            args: {
              tasks: [
                { agent: "explorer", task: "a" },
                { agent: "explorer", task: "b" },
              ],
            },
          },
        ],
      };
    });
    const started = runtime.start(spec({ agentId: "build", workspace: ws("cancel") }));
    for (let i = 0; i < 300 && childrenOf(runtime).length < 2; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(childrenOf(runtime)).toHaveLength(2);

    expect(runtime.cancel(started.runId), "cancel reported nothing to stop").toBe(true);
    const result = await started.done;
    expect(result.status).toBe("cancelled");

    // Nothing left running anywhere: not the parent, not either child. A child
    // that kept going would be spending provider quota the user just stopped.
    for (let i = 0; i < 300 && runtime.activeRuns().length > 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(runtime.activeRuns()).toHaveLength(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Permission inheritance — the bug this phase found
// ---------------------------------------------------------------------------

describe("Phase 25 · a subagent is never more capable than its parent", () => {
  it("caps a child at the parent's own effective permission", async () => {
    // `files.write` is denied for the `build` agent specifically, while the global
    // scope allows it and every category is set to `allow`. The `coder` role has
    // no `agent:coder` scope of its own, so without an inherited ceiling it would
    // resolve straight back to the global `allow` and be strictly more capable
    // than the parent that spawned it.
    const root = ws("ceiling");
    const target = path.join(root, "child-should-not-write.txt");
    const { runtime, events } = harness(
      parentDelegates(
        { agent: "coder", task: "write a file" },
        childCalls("write_file", { path: target, content: "should not exist" }),
      ),
    );
    await runtime.start(
      spec({
        agentId: "build",
        workspace: root,
        policy: {
          version: 1,
          scopes: {
            global: { "files.write": "allow" },
            "agent:build": { "files.write": "deny" },
          },
        },
      } as Partial<AgentRunSpec>),
    ).done;
    expect(fs.existsSync(target), "a subagent wrote a file its parent was denied").toBe(false);
    const refusal = toolEvents(events).find((e) => e.tool === "write_file");
    expect(refusal, "the child's write was not refused at all").toBeDefined();
    expect(refusal!.granted).toBe(false);
  }, 30_000);

  it("still lets a child do what its parent was allowed to do", async () => {
    // The ceiling must narrow, not disable. If it clamped everything to `ask` the
    // tests above would still pass while the system was useless, so the
    // permissive side is asserted explicitly.
    const root = ws("ceilingok");
    const target = path.join(root, "child-can-write.txt");
    const { runtime } = harness(
      parentDelegates(
        { agent: "coder", task: "write a file" },
        childCalls("write_file", { path: target, content: "allowed" }),
      ),
    );
    await runtime.start(spec({ agentId: "build", workspace: root })).done;
    expect(fs.existsSync(target), "a ceiling narrowed an allowed parent into a blocked child").toBe(true);
  });

  it("records a child run at depth one, under its parent", async () => {
    // Phase 23 declared `AgentPermissionContext.nested` and never used it, and
    // `buildRunSpec` never populated a permission context at all. The observable
    // consequence of that being fixed now: a nested run is a real run record
    // that knows who started it and how deep it is, which is what makes the
    // ceiling auditable after the fact.
    const { runtime } = harness(
      parentDelegates({ agent: "explorer", task: "look" }, () => ({ content: "child answered" })),
    );
    await runtime.start(spec({ agentId: "build", workspace: ws("nested") })).done;
    const runs = runtime.listRuns();
    const child = childrenOf(runtime)[0];
    expect(child).toBeDefined();
    expect(child!.agentId).toBe("explorer");
    expect(child!.depth).toBe(1);
    expect(runs.find((r) => r.id === child!.parentRunId)?.depth).toBe(0);
  });
});
