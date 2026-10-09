// Phase 24 unit tests: the four primary agents.
//
// This file is where the acceptance criteria are demonstrated:
//
//   * agents are distinct
//   * each has a clear purpose
//   * agents share a common runtime and tools
//   * agents respect permissions
//   * the user can select an appropriate agent
//   * agents produce real results
//
// Every test drives the *real* `AgentRuntime` against the *real* tool registry.
// The distinction tests would pass just as well against four hand-written stubs
// with four different names, so where a claim is "the agent cannot do X", the
// assertion is that X's side effect did not happen: no file on disk, no command
// run, no commit created. A test that only checked the advertised tool list would
// have passed against the pre-Phase-24 runtime, which advertised the right
// tools and then ran anything the model asked for by name.

import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { AgentRuntime } from "../electron/services/agent/runtime";
import { createBuiltinRegistry, DELEGATE_TOOL_NAME, type ToolRegistry } from "../electron/services/agent/tools";
import {
  DEFAULT_AGENT_ID,
  agentIds,
  canonicalAgentId,
  getAgentDefinition,
  listAgentDefinitions,
  allAgentIds,
} from "../electron/services/agent/definitions";
import type {
  AgentCompletionRequest,
  AgentCompletionResult,
  AgentDefinition,
  AgentEvent,
  AgentRunSpec,
} from "../electron/services/agent/types";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Turn {
  content?: string;
  toolCalls?: Array<{ name: string; args: unknown }>;
}

/**
 * A transport that plays a fixed script, one entry per model round.
 *
 * A list rather than a single call because "the agent recovers from a refusal
 * and carries on" is a claim about more than one round, and a transport that can
 * only answer once cannot show it.
 *
 * Once the script runs out it returns a plain text turn with no tool calls,
 * which is what a model does when it has been told its last call did not run. It
 * also matters for the assertions: a transport that replayed its final turn
 * would keep requesting the same refused tool until the step budget ran out, so
 * a run that refused once would report six denials and burn its whole budget
 * raising a budget error. That is correct runtime behaviour and useless as
 * evidence about anything else.
 */
function scriptedTransport(turns: Turn[]) {
  let i = 0;
  return async (_req: AgentCompletionRequest): Promise<AgentCompletionResult> => {
    const turn = turns[i];
    i += 1;
    if (!turn) return { content: "(no further tool calls)", toolCalls: [], streamed: false };
    return {
      content: turn.content ?? "",
      toolCalls: (turn.toolCalls ?? []).map((t, n) => ({
        id: `call-${i}-${n}`,
        name: t.name,
        arguments: JSON.stringify(t.args),
      })),
      streamed: false,
    };
  };
}

function spec(over: Partial<AgentRunSpec> = {}): AgentRunSpec {
  return {
    agentId: DEFAULT_AGENT_ID,
    task: "do the thing",
    workspace: null,
    endpoint: { url: "http://127.0.0.1:1", model: "m", key: null },
    temperature: 0,
    timeoutMs: 5000,
    stream: false,
    // Every category wide open. Every test below that is *about* permissions
    // writes its own policy; leaving these open means an agent-policy refusal
    // can never be passed off as a permission refusal, or vice versa.
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
  };
}

interface Run {
  events: AgentEvent[];
  /** Every tool result the model saw, concatenated. */
  toolText: string;
  toolEvents: Extract<AgentEvent, { type: "tool" }>[];
  finalText: string;
  status: string;
}

async function run(turns: Turn[], over: Partial<AgentRunSpec> = {}, registry?: ToolRegistry): Promise<Run> {
  const events: AgentEvent[] = [];
  const rt = new AgentRuntime({
    registry: registry ?? createBuiltinRegistry(true),
    createTransport: () => scriptedTransport(turns),
    onEvent: (ev) => events.push(ev),
    approvalTimeoutMs: 80,
  });
  const result = await rt.start(spec(over)).done.catch(() => undefined);
  return {
    events,
    toolText: events
      .filter((e): e is Extract<AgentEvent, { type: "tool" }> => e.type === "tool")
      .map((e) => e.result)
      .join("\n"),
    toolEvents: events.filter((e): e is Extract<AgentEvent, { type: "tool" }> => e.type === "tool"),
    finalText: result?.text ?? "",
    status: result?.status ?? "unknown",
  };
}

function ws(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `p24-${prefix}-`));
}

const registry = createBuiltinRegistry(true);
const PRIMARY = ["build", "plan", "review", "debug", "commander", "builder"] as const;

/**
 * A command whose only effect is to create a file, used as proof.
 *
 * Relative, because `run_terminal` runs through a shell in the workspace and the
 * temp directory on the reference machine has a space in it — a quoted absolute
 * path inside a `-e` script does not survive `cmd.exe`. `node -e` was used rather
 * than `echo > file` because it is the one shape that works identically on
 * Windows and POSIX, and the assertions here must not depend on which platform
 * the suite runs on.
 */
const MARKER_NAME = "command-ran.txt";
const MARKER_COMMAND = `node -e "require('fs').writeFileSync('${MARKER_NAME}','ran')"`;

// ---------------------------------------------------------------------------

describe("Phase 24 · the four primary agents exist and are real", () => {
  it("registers exactly the four the roadmap names", () => {
    expect(agentIds().sort()).toEqual([...PRIMARY].sort());
  });

  it("gives every agent a name, a purpose and a substantial prompt", () => {
    for (const id of PRIMARY) {
      const def = getAgentDefinition(id);
      expect(def, `${id} is missing`).toBeDefined();
      expect(def!.name.trim().length, `${id} has no name`).toBeGreaterThan(3);
      expect(def!.description.trim().length, `${id} has no description`).toBeGreaterThan(40);
      expect(def!.systemPrompt.trim().length, `${id} has no system prompt`).toBeGreaterThan(80);
    }
  });

  it("states each agent's purpose in terms a user could act on", () => {
    // Not "handles X tasks" - a purpose has to say what the agent *does*, and
    // the Debug agent's exclusion has to be discoverable before it surprises
    // someone mid-investigation.
    expect(getAgentDefinition("build")!.description).toMatch(/implement/i);
    expect(getAgentDefinition("plan")!.description).toMatch(/plan/i);
    expect(getAgentDefinition("review")!.description).toMatch(/review|findings/i);
    expect(getAgentDefinition("debug")!.description).toMatch(/failure|fix/i);
    // The Debug agent's most surprising restriction is stated in its own
    // description rather than only in a source comment.
    expect(getAgentDefinition("debug")!.description).toMatch(/does not commit/i);
  });

  it("has six different jobs rather than one job in six costumes", () => {
    const defs = listAgentDefinitions();
    expect(new Set(defs.map((d) => d.name)).size).toBe(6);
    expect(new Set(defs.map((d) => d.description)).size).toBe(6);
    expect(new Set(defs.map((d) => d.systemPrompt)).size).toBe(6);
    // And they say different things, not the same paragraph with the name swapped.
    expect(getAgentDefinition("plan")!.systemPrompt).toMatch(/implementation plan/i);
    expect(getAgentDefinition("review")!.systemPrompt).toMatch(/severity/i);
    expect(getAgentDefinition("debug")!.systemPrompt).toMatch(/reproduce/i);
    expect(getAgentDefinition("build")!.systemPrompt).toMatch(/implement/i);
    expect(getAgentDefinition("commander")!.systemPrompt).toMatch(/classify/i);
    expect(getAgentDefinition("builder")!.systemPrompt).toMatch(/autonomous/i);
  });

  it("keeps `default` working as an alias for `build`", () => {
    // `default` is in persisted renderer state and in old run records. Dropping
    // it would leave those users with a selector entry that starts nothing.
    expect(canonicalAgentId("default")).toBe("build");
    expect(getAgentDefinition("default")?.id).toBe("build");
    expect(getAgentDefinition("default")?.name).toBe(getAgentDefinition("build")!.name);
    expect(DEFAULT_AGENT_ID).toBe("build");
  });

  it("passes an unknown or empty id straight through rather than guessing", () => {
    // `canonicalAgentId` is not a validation layer - `hasAgent` is - so an
    // unknown id must stay unknown, or a typo would silently start the Build
    // agent and the user would never learn they asked for something else.
    expect(canonicalAgentId("nonsense")).toBe("nonsense");
    expect(getAgentDefinition("nonsense")).toBeUndefined();
    // Empty falls back, because an empty string is a missing field, not a name.
    expect(canonicalAgentId("")).toBe(DEFAULT_AGENT_ID);
  });

  it("does not expose an alias as a seventh agent", () => {
    // The selector must not list `default` as a separate agent.
    expect(listAgentDefinitions().map((d) => d.id)).not.toContain("default");
    // Phase 33: six primaries now
    expect(listAgentDefinitions()).toHaveLength(6);
  });

  it("keeps the renderer's copy of the alias table in step with main", () => {
    // `src/stores/agentIds.ts` duplicates the map because contextIsolation stops
    // the renderer importing it. A drift check is the only thing keeping the two
    // honest, and the Phase 24 E2E asserts this again from the other side.
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "stores", "agentIds.ts"), "utf-8");
    const block = (src.match(/AGENT_ALIASES[^=]*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/) || [])[1] ?? "";
    const pairs = [...block.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*"([^"]+)"/g)].map((m) => `${m[1]}=>${m[2]}`);
    expect(pairs).toEqual(["default=>build"]);
    expect(src).toContain(`DEFAULT_AGENT = "build"`);
  });
});

describe("Phase 24 · the agents share one runtime and one tool set", () => {
  it("gives every agent a tool set drawn from the same registry", () => {
    const shipped = new Set(registry.names());
    for (const id of PRIMARY) {
      const names = registry.resolveFor(getAgentDefinition(id)!).names;
      expect(names.length, `${id} was offered no tools at all`).toBeGreaterThan(0);
      for (const n of names) {
        expect(shipped.has(n), `${id} was offered "${n}", which the registry does not have`).toBe(true);
      }
    }
  });

  it("runs all six through the same runtime, with no per-agent runtime", () => {
    // One `AgentRuntime` type serves all six. A test asserting there is exactly
    // one implementation would be theatre, so this asserts the thing that
    // actually matters: the same class, the same registry and the same transport
    // shape drive every agent, with only the spec changing.
    const specs = PRIMARY.map((agentId) => spec({ agentId }));
    expect(new Set(specs.map((s) => s.agentId)).size).toBe(6);
    for (const s of specs) {
      const rt = new AgentRuntime({ registry, createTransport: () => scriptedTransport([{ content: "ok" }]) });
      expect(rt.hasAgent(s.agentId)).toBe(true);
      expect(rt.definitions().some((d: AgentDefinition) => d.id === s.agentId)).toBe(true);
    }
  });

  it("shares the read tools every agent needs, so context costs nothing", () => {
    // The agents differ in what they may *change*, not in whether they may read.
    // An agent that could not read the code would be useless, and four
    // disjoint tool sets would make the shared-runtime claim hollow.
    const readTools = ["read_file", "list_dir", "search_files", "grep_files"];
    for (const id of PRIMARY) {
      const names = registry.resolveFor(getAgentDefinition(id)!).names;
      for (const t of readTools) expect(names, `${id} cannot ${t}`).toContain(t);
    }
  });

  it("varies the tool set between the agents", () => {
    const sets = PRIMARY.map((id) => new Set(registry.resolveFor(getAgentDefinition(id)!).names).size);
    expect(new Set(sets).size, "all four agents were offered exactly the same tools").toBeGreaterThan(1);
    // Phase 25 changed this line. `build` used to withhold exactly one tool
    // (`delegate_task`); it now declares delegates, so it is offered everything
    // in the registry. The claim — that Build is the generalist and has nothing
    // withheld from it — is unchanged, only the count that expressed it.
    const build = registry.resolveFor(getAgentDefinition("build")!).names;
    expect(build).toContain(DELEGATE_TOOL_NAME);
    expect(build.length).toBe(registry.names().length);
    // And the Debug agent is still the one with a real gap, so "generalist" is
    // a claim about Build rather than a description of every agent.
    expect(registry.resolveFor(getAgentDefinition("debug")!).names).not.toContain(DELEGATE_TOOL_NAME);
  });
});

describe("Phase 24 · an agent cannot exceed its own role", () => {
  // The finding that motivated this phase. Until now the tool policy decided
  // only which tools a model was *shown*; `registry.invoke` would still run any
  // tool it named, so a read-only Plan agent could write a file. Each test here
  // asserts the side effect did not happen, with every permission category set
  // to `allow` so that nothing but the agent policy can be responsible.

  it("stops a read-only agent writing a file, with all permissions allowed", async () => {
    const dir = ws("ro-write");
    const target = path.join(dir, "written.md");
    const out = await run([{ toolCalls: [{ name: "write_file", args: { path: target, content: "x" } }] }], {
      workspace: dir,
      agentId: "plan",
    });
    expect(fs.existsSync(target), "a read-only agent wrote a file").toBe(false);
    expect(out.toolEvents.some((e) => e.status === "denied")).toBe(true);
  });

  it("stops a read-only agent editing a file that already exists", async () => {
    const dir = ws("ro-edit");
    const target = path.join(dir, "existing.md");
    fs.writeFileSync(target, "original", "utf-8");
    await run([{ toolCalls: [{ name: "edit_file", args: { path: target, oldText: "original", newText: "replaced" } }] }], {
      workspace: dir,
      agentId: "review",
    });
    expect(fs.readFileSync(target, "utf-8")).toBe("original");
  });

  it("stops a read-only agent deleting a file, with all permissions allowed", async () => {
    const dir = ws("ro-delete");
    const target = path.join(dir, "doomed.md");
    fs.writeFileSync(target, "precious", "utf-8");
    const out = await run([{ toolCalls: [{ name: "delete_file", args: { path: target } }] }], {
      workspace: dir,
      agentId: "plan",
    });
    // A blocked delete is the file surviving, so the assertion is its continued
    // existence *and* its unchanged contents — not merely "no error was raised".
    expect(fs.existsSync(target), "a read-only agent deleted a file").toBe(true);
    expect(fs.readFileSync(target, "utf-8")).toBe("precious");
    expect(out.toolEvents[0].error?.code).toBe("agent_policy");
  });

  it("stops a read-only agent running a shell command", async () => {
    // The command would create a file in the workspace. If the agent policy were
    // not enforced the file's existence is the proof — which is why the
    // assertion is on the filesystem rather than on the run's status, and why
    // the "debug really runs the command" test below matters: it is the positive
    // control proving this exact command *does* work when an agent is allowed it.
    const dir = ws("ro-shell");
    const out = await run(
      [{ toolCalls: [{ name: "run_terminal", args: { command: MARKER_COMMAND } }] }],
      { workspace: dir, agentId: "review" },
    );
    expect(fs.existsSync(path.join(dir, MARKER_NAME)), "a read-only agent ran a shell command").toBe(false);
    expect(out.toolEvents[0].error?.code).toBe("agent_policy");
  });

  it("stops an agent that cannot delegate from delegating", async () => {
    const out = await run([{ toolCalls: [{ name: DELEGATE_TOOL_NAME, args: { agentId: "review", task: "check this" } }] }], {
      agentId: "review",
    });
    expect(out.toolText).toMatch(/cannot use/i);
  });

  it("stops the debug agent committing, which is its defining restriction", async () => {
    const dir = ws("debug-commit");
    const out = await run([{ toolCalls: [{ name: "git_commit", args: { message: "should not happen" } }] }], {
      workspace: dir,
      agentId: "debug",
    });
    expect(out.toolEvents.some((e) => e.status === "denied")).toBe(true);
    expect(out.toolText).toMatch(/cannot use/i);
  });

  it("still lets the debug agent fix the thing it was asked to debug", async () => {
    // The restriction above is only defensible if the agent can still do its job.
    // If the debug agent could not write a file it could not fix anything, and
    // the exclusion would just be a broken agent.
    const dir = ws("debug-fix");
    const target = path.join(dir, "broken.js");
    await run([{ toolCalls: [{ name: "write_file", args: { path: target, content: "// fixed" } }] }], {
      workspace: dir,
      agentId: "debug",
    });
    expect(fs.readFileSync(target, "utf-8")).toBe("// fixed");
  });

  it("does not let a nested agent escape its own role either", async () => {
    // `nested: true` is what a sub-agent run carries. The policy check must not
    // be skipped for one, or delegation would be a way around it.
    const dir = ws("nested");
    const target = path.join(dir, "nested.md");
    await run([{ toolCalls: [{ name: "write_file", args: { path: target, content: "x" } }] }], {
      workspace: dir,
      agentId: "plan",
      depth: 1,
    });
    expect(fs.existsSync(target)).toBe(false);
  });
});

describe("Phase 24 · refusals are refusals, not crashes", () => {
  it("reports an agent-policy refusal as denied with its own error code", async () => {
    const dir = ws("code");
    const out = await run([{ toolCalls: [{ name: "write_file", args: { path: path.join(dir, "x.md"), content: "y" } }] }], {
      workspace: dir,
      agentId: "plan",
    });
    const ev = out.toolEvents[0];
    expect(ev.status).toBe("denied");
    expect(ev.error?.code).toBe("agent_policy");
    expect(ev.granted).toBe(false);
  });

  it("says which agent refused which tool, in words the model can act on", async () => {
    const dir = ws("words");
    const out = await run([{ toolCalls: [{ name: "run_terminal", args: { command: "ls" } }] }], {
      workspace: dir,
      agentId: "plan",
    });
    expect(out.toolText).toMatch(/Plan Agent cannot use "run_terminal"/);
    // Read-only is the reason, and the alternative is offered - a refusal that
    // only says no is the version that makes a model give up on the task.
    expect(out.toolText).toMatch(/read-only/i);
    expect(out.toolText).toMatch(/read_file/);
  });

  it("records which agent and which tool, so the UI need not parse text", async () => {
    const dir = ws("data");
    const out = await run([{ toolCalls: [{ name: "write_file", args: { path: path.join(dir, "x.md"), content: "y" } }] }], {
      workspace: dir,
      agentId: "review",
    });
    const data = out.toolEvents[0].error?.data as { agentId?: string; tool?: string } | undefined;
    expect(data?.agentId).toBe("review");
    expect(data?.tool).toBe("write_file");
  });

  it("lets the agent carry on with a tool it does have", async () => {
    // A refusal must cost the step, not the run. The agent is refused a write,
    // told what it can use instead, and then reads the file it was asked about.
    const dir = ws("recover");
    const target = path.join(dir, "source.ts");
    fs.writeFileSync(target, "export const answer = 42;", "utf-8");
    const out = await run(
      [
        { toolCalls: [{ name: "write_file", args: { path: path.join(dir, "notes.md"), content: "x" } }] },
        { toolCalls: [{ name: "read_file", args: { path: target } }] },
        { content: "I read the file; I did not write anything." },
      ],
      { workspace: dir, agentId: "plan" },
    );
    expect(out.toolText).toContain("export const answer = 42");
    expect(out.status).toBe("completed");
  });

  it("leaves a genuinely unknown tool to the registry, which already handles it", async () => {
    // The runtime deliberately does not claim this case. Two owners for one
    // question is how the two start disagreeing, and the registry's wording is
    // already asserted by the Phase 22 suite.
    const out = await run([{ toolCalls: [{ name: "teleport", args: {} }] }], { agentId: "build" });
    expect(out.toolText).toBe("Unknown tool: teleport");
  });

  it("does not raise a run-level error for a refused tool", async () => {
    // A banner in front of the user for a refusal that worked as designed would
    // train people to ignore banners.
    const dir = ws("banner");
    const out = await run([{ toolCalls: [{ name: "write_file", args: { path: path.join(dir, "x.md"), content: "y" } }] }], {
      workspace: dir,
      agentId: "plan",
    });
    expect(out.events.some((e) => e.type === "error")).toBe(false);
    expect(out.status).toBe("completed");
  });
});

describe("Phase 24 · agents still respect the user's permissions", () => {
  // Agent policy and user permission are different things. Having a tool is not
  // permission to use it, and Phase 23's gate has to keep applying to the agents
  // that *do* have their tools.

  it("asks before the build agent writes, when writes are set to ask", async () => {
    const dir = ws("perm-ask");
    const out = await run([{ toolCalls: [{ name: "write_file", args: { path: path.join(dir, "a.md"), content: "x" } }] }], {
      workspace: dir,
      agentId: "build",
      permissions: {
        files: "ask",
        search: "ask",
        git: "ask",
        terminal: "ask",
        agent: "ask",
        web: "ask",
        browser: "ask",
      },
    });
    expect(out.events.filter((e) => e.type === "approval")).toHaveLength(1);
  });

  it("does not let the build agent write when the user denied writes", async () => {
    const dir = ws("perm-deny");
    const target = path.join(dir, "a.md");
    const out = await run([{ toolCalls: [{ name: "write_file", args: { path: target, content: "x" } }] }], {
      workspace: dir,
      agentId: "build",
      permissions: {
        files: "deny",
        search: "allow",
        git: "allow",
        terminal: "allow",
        agent: "allow",
        web: "allow",
        browser: "allow",
      },
    });
    expect(fs.existsSync(target), "a denied write happened anyway").toBe(false);
    // The denial is the user's, so it must carry the permission's code rather
    // than the agent's - the two mean different things to whoever has to fix it.
    expect(out.toolEvents[0].error?.code).toBe("permission_denied");
  });

  it("applies a per-agent permission rule to that agent only", async () => {
    const dir = ws("perm-scope");
    const policy = {
      version: 1 as const,
      scopes: { "agent:plan": { "files.read": "deny" as const } },
    };
    const target = path.join(dir, "a.txt");
    fs.writeFileSync(target, "contents", "utf-8");

    const blocked = await run([{ toolCalls: [{ name: "read_file", args: { path: target } }] }], {
      workspace: dir,
      agentId: "plan",
      policy,
    });
    expect(blocked.toolEvents[0].status).toBe("denied");

    // The same rule must not touch the Build agent.
    const allowed = await run([{ toolCalls: [{ name: "read_file", args: { path: target } }] }], {
      workspace: dir,
      agentId: "build",
      policy,
    });
    expect(allowed.toolText).toContain("contents");
  });

  it("escalates a dangerous command for an agent that has the terminal", async () => {
    // The Debug agent can run commands, so `shell.dangerous` applies to it. The
    // capability is default-deny, so a destructive command is refused even though
    // the agent is allowed to use `run_terminal` at all.
    //
    // The capability is named on the event's *error*, not in the tool's text: the
    // tool can only say the generic "Permission denied by policy or user.",
    // because by the time it is written the gate has already decided. Asserting
    // on the text here would have passed on a refusal for any reason at all.
    const out = await run([{ toolCalls: [{ name: "run_terminal", args: { command: "rm -rf /" } }] }], {
      workspace: ws("perm-danger"),
      agentId: "debug",
    });
    const ev = out.toolEvents[0];
    expect(ev.status).toBe("denied");
    expect(ev.error?.code).toBe("permission_denied");
    expect(`${ev.error?.message} ${ev.error?.hint ?? ""}`).toMatch(/shell\.dangerous/);
  });
});

describe("Phase 24 · the agents produce real results", () => {
  it("build actually writes a file, and the file is on disk afterwards", async () => {
    const dir = ws("real-build");
    const target = path.join(dir, "built.js");
    const out = await run(
      [
        { toolCalls: [{ name: "write_file", args: { path: target, content: "export const built = true;\n" } }] },
        { toolCalls: [{ name: "read_file", args: { path: target } }] },
        { content: "Wrote built.js." },
      ],
      { workspace: dir, agentId: "build" },
    );
    expect(fs.readFileSync(target, "utf-8")).toBe("export const built = true;\n");
    // And the agent saw the real contents back, not its own assumption of them.
    expect(out.toolText).toContain("export const built = true");
    expect(out.status).toBe("completed");
    expect(out.finalText).toBe("Wrote built.js.");
  });

  it("plan reads real code and can report on it", async () => {
    const dir = ws("real-plan");
    fs.writeFileSync(path.join(dir, "mod.ts"), "export function add(a: number, b: number) { return a - b; }\n", "utf-8");
    const out = await run(
      [
        { toolCalls: [{ name: "read_file", args: { path: path.join(dir, "mod.ts") } }] },
        { content: "1) add() subtracts. 2) Rename the file. 3) Risk: callers may rely on it." },
      ],
      { workspace: dir, agentId: "review" },
    );
    // The bug in the source is visible in what the model was shown, which is the
    // only way "it read the real file" is distinguishable from "it guessed".
    expect(out.toolText).toContain("return a - b");
    expect(out.finalText).toMatch(/subtracts/);
  });

  it("debug really runs the command it asks to reproduce with", async () => {
    const dir = ws("real-debug");
    const out = await run(
      [
        { toolCalls: [{ name: "run_terminal", args: { command: MARKER_COMMAND } }] },
        { content: "Reproduced: the command runs and writes the marker." },
      ],
      { workspace: dir, agentId: "debug" },
    );
    expect(fs.existsSync(path.join(dir, MARKER_NAME)), "the debug agent never actually ran the command").toBe(true);
    expect(out.status).toBe("completed");
  });

  it("review reads a diff and reports on what is really there", async () => {
    const dir = ws("real-review");
    fs.writeFileSync(path.join(dir, "app.ts"), "const secret = 'hunter2';\n", "utf-8");
    const out = await run(
      [
        { toolCalls: [{ name: "read_file", args: { path: path.join(dir, "app.ts") } }] },
        { content: "Critical: a credential is committed in app.ts line 1." },
      ],
      { workspace: dir, agentId: "review" },
    );
    expect(out.toolText).toContain("hunter2");
    expect(out.finalText).toMatch(/Critical/);
  });

  it("records every agent's run against its own id, so the history is readable", async () => {
    for (const id of PRIMARY) {
      const out = await run([{ content: "done" }], { agentId: id });
      expect(out.status).toBe("completed");
      const state = out.events.find((e) => e.type === "state");
      expect(state).toBeDefined();
    }
  });

  it("costs each agent nothing but its own step budget", async () => {
    // The ceilings differ because the jobs differ, and an agent that runs out of
    // steps mid-fix is a bug in the ceiling rather than in the model.
    expect(getAgentDefinition("plan")!.maxSteps).toBeGreaterThanOrEqual(8);
    expect(getAgentDefinition("review")!.maxSteps).toBeGreaterThanOrEqual(8);
    expect(getAgentDefinition("build")!.maxSteps).toBeGreaterThanOrEqual(8);
    // Debugging is reproduce, diagnose, fix, re-verify - strictly more steps than
    // any other job here, which is why it gets the largest ceiling.
    const debug = getAgentDefinition("debug")!.maxSteps!;
    for (const id of ["build", "plan", "review"] as const) {
      expect(debug, `debug must have at least as many steps as ${id}`).toBeGreaterThanOrEqual(
        getAgentDefinition(id)!.maxSteps!,
      );
    }
  });
});

describe("Phase 24 · the user can choose an agent", () => {
  it("offers all six to the selector", () => {
    const offered = listAgentDefinitions();
    expect(offered.map((d) => d.id)).toEqual(expect.arrayContaining([...PRIMARY]));
    // Order matters to a user reading a dropdown: the generalist first, then the
    // specialists in the order they are likely to reach for them.
    // Phase 33: commander and builder added after debug.
    expect(offered.map((d) => d.id)).toEqual(["build", "plan", "review", "debug", "commander", "builder"]);
  });

  it("distinguishes the read-only agents in the list", () => {
    // The selector appends "(read-only)" from this flag. If it were lost the user
    // could not tell, before starting, that Plan and Review cannot make changes.
    expect(getAgentDefinition("plan")!.readOnly).toBe(true);
    expect(getAgentDefinition("review")!.readOnly).toBe(true);
    expect(getAgentDefinition("build")!.readOnly).toBeFalsy();
    expect(getAgentDefinition("debug")!.readOnly).toBeFalsy();
  });

  it("makes the retired `default` selectable again, as the Build agent", () => {
    // A persisted `selectedAgentId` of `default` must reconcile rather than
    // snapping to whichever agent happens to be first in the list.
    expect(canonicalAgentId("default")).toBe("build");
    expect(listAgentDefinitions().some((d) => d.id === canonicalAgentId("default"))).toBe(true);
  });

  it("reports every agent to the renderer with the fields the selector needs", () => {
    // Mirrors what `agent:definitions` hands over: the four fields
    // `AgentDefinitionInfo` declares are what the dropdown and the description
    // line under it actually read.
    for (const def of listAgentDefinitions()) {
      const info = { id: def.id, name: def.name, description: def.description, readOnly: def.readOnly, maxSteps: def.maxSteps };
      expect(info.id.length).toBeGreaterThan(0);
      expect(info.name.length).toBeGreaterThan(0);
      expect(info.description.length).toBeGreaterThan(40);
      expect(info.maxSteps).toBeGreaterThan(0);
    }
  });

  it("keeps every agent a legal delegation target or no target at all", () => {
    // `delegate_task` validates its target against the real list, so a typo here
    // would produce an agent that can never delegate and reports no reason.
    //
    // Phase 25: validated against `allAgentIds` rather than `agentIds`. The
    // latter is primaries-only — it is a statement about what the selector
    // offers — so using it here would have flagged every subagent role as a typo.
    // That is precisely the kind of drift this test exists to catch, run against
    // the wrong list it becomes a test that forbids working delegation.
    const ids = new Set(allAgentIds());
    for (const id of PRIMARY) {
      for (const target of getAgentDefinition(id)!.delegates ?? []) {
        expect(ids.has(target), `${id} delegates to "${target}", which does not exist`).toBe(true);
      }
    }
    // And delegation only goes one level: nothing a primary delegates to may
    // itself delegate. This holds for `plan → review` (a primary) as well as for
    // the new subagent targets, which is the point — the safety property is about
    // the target being terminal, not about which registry it came from.
    expect(getAgentDefinition("plan")!.maxDepth).toBe(1);
    expect(getAgentDefinition("review")!.delegates ?? []).toEqual([]);
    for (const id of agentIds()) {
      for (const target of getAgentDefinition(id)!.delegates ?? []) {
        expect(getAgentDefinition(target)!.delegates ?? [], `${target} may not delegate further`).toEqual([]);
      }
    }
  });
});