// Phase 28 unit tests: context compaction.
//
// Two layers, matching the two layers of the feature:
//
//   * the pure engine (`compactMessages`) — driven directly, no Electron, no
//     network. The extractive guarantee is tested here and it is the heart of
//     the phase: every digest line and every preserved quote is walked and
//     proven to be a substring of something that was actually in the input.
//     "Never invented" is the one property this module must never lose, and it
//     is asserted, not hoped for.
//   * the runtime shipping point — `AgentRuntime` with a scripted transport and
//     a small budget, proving the same engine is actually on the wire: the
//     payload it ships is under budget, the run records what happened, and the
//     run's own message log is untouched (compaction does not silently destroy
//     task state).
import { describe, it, expect } from "vitest";
import {
  compactMessages,
  measureChars,
  messageChars,
  readableContent,
  type CompactionRecord,
} from "../electron/services/agent/compaction";
import type { AgentMessage, AgentEvent } from "../electron/services/agent/types";
import { AgentRuntime } from "../electron/services/agent/runtime";
import { createBuiltinRegistry } from "../electron/services/agent/tools";
import type { AgentCompletionRequest, AgentCompletionResult, AgentRunSpec } from "../electron/services/agent/types";
// The renderer's wording for the same record. Imported into a main-process
// test only to pin the two layers together: the runtime's trace line and the
// panel's sentence must never drift apart.
import { formatCompactionNotice } from "../src/lib/compaction";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function user(content: string): AgentMessage {
  return { role: "user", content };
}

function assistant(content: string): AgentMessage {
  return { role: "assistant", content };
}

function system(content: string): AgentMessage {
  return { role: "system", content };
}

/** A long enough message that N of them blow any budget we test with. */
function long(prefix: string, n = 3_000): string {
  return `${prefix} ${"z".repeat(Math.max(0, n - prefix.length - 1))}`;
}

/** History mock with one decision, one unresolved issue, one error tool result. */
function richConversation(): AgentMessage[] {
  return [
    system("You are a test agent."),
    user("Our decision was to use extractive compaction for long sessions."),
    assistant("We will ship it in the main process, never in the renderer."),
    user(long("todo: verify the redaction corpus still passes")),
    assistant("The flaky sweep still fails on phase 7; that is unresolved for now."),
    { role: "tool", tool_call_id: "c1", name: "read_file", content: JSON.stringify("Error: ENOENT no such file") },
    user("Now go do the remaining work."),
  ];
}

/** Everything verbatim in the input, so a digest line can be checked against it. */
function corpusOf(messages: readonly AgentMessage[]): string {
  return messages
    .flatMap((m) => {
      const parts: string[] = [];
      if (m.content) parts.push(m.content);
      const readable = readableContent(m);
      if (readable !== m.content) parts.push(readable);
      for (const c of m.tool_calls ?? []) {
        if (c.name) parts.push(c.name);
        if (c.arguments) parts.push(c.arguments);
      }
      return parts;
    })
    .join("\n");
}

/**
 * The content-bearing lines of a digest: `[i/n] role | text` lines and `- `
 * (preserved quote) lines, with structural labels and explicit ellipsis marks
 * removed. Whatever remains must be verbatim from the input.
 */
function digestContents(digest: string): string[] {
  const out: string[] = [];
  for (const raw of digest.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("- [")) {
      // `- [tool_name] quote` — drop the bracket label, keep the quote.
      out.push(line.slice(line.indexOf("]") + 1).trim());
    } else if (line.startsWith("- ")) {
      out.push(line.slice(2).trim());
    } else {
      const m = /^\[\d+\/\d+\] \w+ \| (.*)$/.exec(line);
      if (m) out.push(m[1].trim());
    }
  }
  return out
    .map((c) => c.replace(/^…/, "").replace(/…$/, "").trim())
    .filter((c) => c.length > 0);
}

/** A `CompactionRecord`-shaped reducer for events. */
function compactionRecords(events: ReadonlyArray<{ type: string; record?: CompactionRecord }>): CompactionRecord[] {
  return events.filter((e) => e.type === "compaction").map((e) => e.record as CompactionRecord);
}

function makeSpec(over: Partial<AgentRunSpec> = {}): AgentRunSpec {
  return {
    agentId: "build",
    task: "Finish the remaining work.",
    workspace: null,
    endpoint: { url: "http://127.0.0.1:11434", model: "test-model", key: null },
    temperature: 0,
    timeoutMs: 5000,
    stream: true,
    permissions: { files: "allow", search: "allow", git: "allow", terminal: "allow" },
    ...over,
  };
}

function scriptedTransport(script: Array<{ content?: string; toolCalls?: Array<{ name: string; args: unknown }> }>): {
  transport: (req: AgentCompletionRequest) => Promise<AgentCompletionResult>;
  calls: AgentCompletionRequest[];
} {
  const calls: AgentCompletionRequest[] = [];
  let i = 0;
  const transport = async (req: AgentCompletionRequest): Promise<AgentCompletionResult> => {
    calls.push(req);
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
  return { transport, calls };
}

// ---------------------------------------------------------------------------
// Measuring (the definition of "over budget" must itself be tested)
// ---------------------------------------------------------------------------

describe("compaction measuring (Phase 28)", () => {
  it("counts content and a model's own tool-call arguments", () => {
    expect(messageChars({ role: "user", content: "abcd" })).toBe(4);
    expect(
      messageChars({
        role: "assistant",
        content: "",
        tool_calls: [{ id: "1", name: "write_file", arguments: '{"path":"a","content":"xyz"}' }],
      }),
    ).toBe(28);
    expect(measureChars([user("ab"), assistant("cd"), system("ef")])).toBe(6);
  });

  it("reports the three roles a payload actually has", () => {
    const messages = [system("s"), user("u"), assistant("a")];
    expect(measureChars(messages)).toBe(3);
  });

  it("turns a JSON-quoted tool result back into readable text", () => {
    const tool: AgentMessage = { role: "tool", name: "list_files", content: JSON.stringify("found 3 files\nsrc/a.ts\nsrc/b.ts") };
    expect(readableContent(tool)).toBe("found 3 files\nsrc/a.ts\nsrc/b.ts");
    // A user message is never treated as JSON-quoted, no matter how it looks.
    expect(readableContent(user('"hello"'))).toBe('"hello"');
    // Truncated JSON falls through to the raw text.
    const truncated = JSON.stringify("abcdef").slice(0, 7);
    expect(readableContent({ role: "tool", name: "x", content: truncated })).toBe(truncated);
  });
});

// ---------------------------------------------------------------------------
// Under budget: identity, no synthesis
// ---------------------------------------------------------------------------

describe("compaction under budget (Phase 28)", () => {
  it("returns the input untouched when it fits", () => {
    const input = [system("sys"), user("hi"), assistant("hello")];
    const result = compactMessages(input);
    expect(result.compacted).toBe(false);
    expect(result.messages).toEqual(input);
    expect(result.record.beforeChars).toBe(measureChars(input));
    expect(result.record.afterChars).toBe(measureChars(input));
    expect(result.record.beforeMessages).toBe(3);
    expect(result.record.overflow).toBe(false);
  });

  it("never marks a run's budget when nothing was over", () => {
    const result = compactMessages([system("s"), user("u")], { budget: { maxContextChars: 10_000 } });
    expect(result.compacted).toBe(false);
  });

  it("handles an empty payload", () => {
    const result = compactMessages([]);
    expect(result.compacted).toBe(false);
    expect(result.messages).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Over budget: structure, pinning, and the extractive guarantee
// ---------------------------------------------------------------------------

describe("compaction over budget (Phase 28)", () => {
  // A small fixed budget: the system prompt and task fit alone, but the history
  // pushes the whole payload over, which is exactly the resumed-session shape.
  const BUDGET = { maxContextChars: 2_800, maxSummaryChars: 900, maxPreservedChars: 1_200, maxQuoteChars: 300 };

  const history = [
    user("The original request: rewrite the module."),
    assistant(long("We decided to keep the public API and change only internals.", 900)),
    user(long("Unresolved: the offline sweep still fails", 900)),
    assistant(long("We will verify tomorrow; the risk is acceptable for now.", 900)),
    user(long("Continue.", 400)),
  ];

  it("compresses, pins the system prompt and the active task verbatim, and reports numbers", () => {
    const task = "Do the rewrite now.";
    const input = [system("You are the test agent."), ...history, user(task)];
    const result = compactMessages(input, { budget: BUDGET, now: () => 1234 });

    expect(result.compacted).toBe(true);
    expect(result.record.beforeChars).toBe(measureChars(input));
    expect(result.record.afterChars).toBeLessThan(result.record.beforeChars);
    expect(result.record.beforeMessages).toBe(input.length);
    expect(result.record.budgetChars).toBe(BUDGET.maxContextChars);
    expect(result.record.at).toBe(1234);

    // The whole payload is under budget.
    expect(measureChars(result.messages)).toBeLessThanOrEqual(BUDGET.maxContextChars);

    const sent = result.messages;
    expect(sent[0].role).toBe("system");
    expect(sent[0].content).toContain("You are the test agent.");
    expect(sent[0].content).toContain("CONTEXT COMPACTION");
    // The task is a standalone user message, byte-for-byte.
    expect(sent[sent.length - 1]).toEqual({ role: "user", content: task });
  });

  it("preserves decisions, unresolved issues, and known tool results verbatim", () => {
    const input = [
      system("sys"),
      ...richConversation(),
    ];
    const result = compactMessages(input, { budget: BUDGET, now: () => 1 });
    const digest = result.record.digest;

    expect(result.record.kept.decisions).toBeGreaterThanOrEqual(1);
    expect(result.record.kept.issues).toBeGreaterThanOrEqual(1);
    expect(result.record.kept.toolResults).toBeGreaterThanOrEqual(1);
    expect(digest).toContain("## Decisions kept verbatim");
    // The decision's own wording, not a rewrite of it.
    const keptDecisions = digest.split("\n").filter((l) => l.trim().startsWith("- "));
    expect(keptDecisions.some((l) => l.includes("extractive compaction"))).toBe(true);
    const keptTools = digest.split("\n").filter((l) => l.trim().startsWith("- ["));
    expect(keptTools.some((l) => l.includes("ENOENT"))).toBe(true);
  });

  it("honours a salient hint even when the wording contains no error signal", () => {
    // The runtime marks non-ok tool results with ground truth. This one says
    // nothing the heuristics would catch; only `salient` saves it.
    const toolMessage: AgentMessage = { role: "tool", tool_call_id: "c", name: "git_diff", content: JSON.stringify("1 file changed, 0 insertions, 0 deletions") };
    const salient = new Set<AgentMessage>([toolMessage]);
    // No tool results at all: nothing to keep, even with the hint present.
    const input = [system("sys"), user(long("old task")), user("The task now."), assistant("ok.")];
    const without = compactMessages(input, { budget: { ...BUDGET } });
    expect(without.record.kept.toolResults).toBe(0);
    // `salient` must work even for a tool message that lives in the live window.
    const input2 = [system("sys"), user(long("Task", 500)), assistant("ok."), toolMessage];
    const marked = compactMessages(input2, { budget: { ...BUDGET, maxContextChars: 300 }, salient: { has: (m) => salient.has(m) } });
    expect(marked.record.kept.toolResults).toBe(1);
  });

  it("never invents content: every digest line and quote is a substring of the input", () => {
    const input = [
      system("sys"),
      user(long("Unresolved: redaction corpus needs revalidation")),
      assistant(long("We will use the extractive digest; the rationale is determinism.", 500)),
      { role: "tool", tool_call_id: "c1", name: "read_file", content: JSON.stringify("Error: ENOENT no such file or directory") },
      user(long("Task: revalidate the corpus")),
      assistant(long("Now doing the work, with many words to make this message long enough for the test.", 400)),
    ];
    const corpus = corpusOf(input);
    const result = compactMessages(input, { budget: { ...BUDGET, maxContextChars: 1_200 }, now: () => 1 });

    const digest = result.record.digest;
    const contents = digestContents(digest);
    expect(contents.length).toBeGreaterThan(3);
    for (const content of contents) {
      expect(corpus.includes(content), `digest line not verbatim: ${JSON.stringify(content)}`).toBe(true);
    }
  });

  it("is deterministic: identical input produces identical output", () => {
    const input = [...richConversation(), user("Task.")];
    const a = compactMessages(input, { budget: BUDGET, now: () => 1 });
    const b = compactMessages(input, { budget: BUDGET, now: () => 1 });
    expect(a.messages).toEqual(b.messages);
    expect(a.record).toEqual(b.record);
  });

  it("does not mutate its input", () => {
    const input = [...richConversation(), user("Task.")];
    const snapshot = JSON.parse(JSON.stringify(input)) as AgentMessage[];
    compactMessages(input, { budget: BUDGET, now: () => 1 });
    expect(input).toEqual(snapshot);
  });

  it("counts what the preservation ceiling left out instead of dropping it silently", () => {
    const many: AgentMessage[] = [];
    for (let i = 0; i < 60; i += 1) {
      many.push(assistant(`We decided to keep item ${i} and reject the alternatives.`));
    }
    const input = [system("sys"), ...many, user("Task.")];
    const result = compactMessages(input, { budget: { ...BUDGET, maxPreservedChars: 600, maxSummaryChars: 1_200 } });
    expect(result.record.kept.decisions).toBeGreaterThan(0);
    expect(result.record.omitted.decisions).toBeGreaterThan(0);
  });

  it("keeps both ends of a long history and says how many middle lines were omitted", () => {
    const input = [system("sys")];
    for (let i = 0; i < 40; i += 1) {
      input.push(user(`conversation turn ${i} — ${"x".repeat(1_000)}`));
    }
    input.push(user("Final task."));
    const result = compactMessages(input, { budget: { ...BUDGET, maxContextChars: 5_000, maxSummaryChars: 700, maxPreservedChars: 500 } });
    const digest = result.record.digest;
    expect(result.record.digestLinesOmitted).toBeGreaterThan(0);
    // The opening is where the original ask lives; it must still be there.
    expect(digest).toContain("conversation turn 0");
    // The newest end too.
    expect(digest).toContain("conversation turn 39");
    expect(digest).toContain("omitted from this digest");
  });

  it("clamps oversized live messages with a visible marker, oldest first", () => {
    const bigTool: AgentMessage = { role: "tool", name: "read_file", content: "x".repeat(9_000) };
    const input = [
      system("sys"),
      user("The task."),
      assistant("ok."),
      bigTool,
      { role: "tool", name: "list_files", content: "y".repeat(9_000) },
    ];
    const result = compactMessages(input, { budget: { ...BUDGET, maxContextChars: 2_000, maxClampedChars: 1_500 } });
    expect(result.record.clampedMessages).toBeGreaterThanOrEqual(2);
    expect(measureChars(result.messages)).toBeLessThanOrEqual(2_000);
    const clamped = result.messages.filter((m) => m.content.includes("truncated for the context budget"));
    expect(clamped.length).toBeGreaterThanOrEqual(2);
    // The marker states how much was kept — the cut is visible, not silent.
    for (const m of clamped) expect(m.content).toMatch(/kept \d+ of \d+ chars/);
  });

  it("clamps a model's own tool-call arguments when they are the bulk of the payload", () => {
    const bigArgs = { path: "a.txt", content: "z".repeat(50_000) };
    const input: AgentMessage[] = [
      system("sys"),
      user("Write the file."),
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c", name: "write_file", arguments: JSON.stringify(bigArgs) }],
      },
    ];
    const result = compactMessages(input, { budget: { ...BUDGET, maxContextChars: 3_000, maxClampedChars: 1_200 } });
    expect(result.record.clampedMessages).toBeGreaterThanOrEqual(1);
    expect(measureChars(result.messages)).toBeLessThanOrEqual(3_000);
    const callsMessage = result.messages.find((m) => m.tool_calls?.length);
    expect(callsMessage?.tool_calls?.[0].arguments).toContain("truncated for the context budget");
  });

  // Flags overflow rather than dropping the system prompt or the task.
  it("flags overflow rather than dropping the system prompt or the task", () => {
    const input = [system("s".repeat(1_200)), user("short task")];
    const result = compactMessages(input, { budget: { ...BUDGET, maxContextChars: 1_000 }, now: () => 1 });
    expect(result.record.overflow).toBe(true);
    // Both were still shipped, in full.
    expect(result.messages[0].content).toBe("s".repeat(1_200));
    expect(result.messages[result.messages.length - 1]).toEqual({ role: "user", content: "short task" });
  });

  it("accepts a partial budget override and a system-less payload", () => {
    const input = [user(long("history", 1_000)), user("task"), assistant("ans")];
    const result = compactMessages(input, { budget: { maxContextChars: 800 } });
    expect(result.compacted).toBe(true);
    // A fresh system message was created to carry the digest.
    expect(result.messages[0].role).toBe("system");
    expect(result.messages[0].content).toContain("CONTEXT COMPACTION");
  });

  it("keeps the tail verbatim when there is no user message to anchor on", () => {
    const input = [] as AgentMessage[];
    for (let i = 0; i < 12; i += 1) {
      input.push(assistant(long(`tool step ${i}`, 1_000)));
    }
    const result = compactMessages(input, { budget: { ...BUDGET, maxContextChars: 10_000 } });
    expect(result.compacted).toBe(true);
    const sent = result.messages;
    // The first message is the system prompt carrying the digest; everything
    // else is the kept tail, verbatim and in order, under the wire budget.
    expect(sent[0].role).toBe("system");
    expect(sent[0].content).toContain("CONTEXT COMPACTION");
    expect(sent.length).toBe(1 + 8); // the system prompt + the kept tail
    expect(measureChars(sent)).toBeLessThanOrEqual(10_000);
    // Every tail message is present byte-for-byte.
    const sentContents = sent.slice(1).map((m) => m.content);
    for (const original of input.slice(4)) {
      expect(sentContents).toContain(original.content);
    }
  });
});

// ---------------------------------------------------------------------------
// Runtime shipping point: the log survives, the wire does not
// ---------------------------------------------------------------------------

describe("compaction at the runtime shipping point (Phase 28)", () => {
  function bigHistory(turns = 12): Array<{ role: "user" | "assistant"; content: string }> {
    return Array.from({ length: turns }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: long(`turn ${i}`, 3_700),
    }));
  }

  it("ships an oversized resumed session compacted and under budget", async () => {
    const history = bigHistory();
    const task = "Finish the remaining work.";
    const { transport, calls } = scriptedTransport([
      { toolCalls: [{ name: "read_file", args: { path: "C:\\ws\\a.txt" } }] },
      { content: "Done." },
    ]);
    const events: AgentEvent[] = [];
    const runtime = new AgentRuntime({
      registry: createBuiltinRegistry(true),
      createTransport: () => transport,
      onEvent: (ev) => events.push(ev),
      compactionBudget: { maxContextChars: 30_000 },
    });

    const result = await runtime.run(makeSpec({ task, history }));
    expect(result.status).toBe("completed");

    // Two model calls (tool request, then the answer), both under budget.
    expect(calls.length).toBe(2);
    for (const call of calls) expect(measureChars(call.messages)).toBeLessThanOrEqual(30_000);

    // The first call's system message carries the digest and the task is exact.
    expect(calls[0].messages[0].role).toBe("system");
    expect(calls[0].messages[0].content).toContain("CONTEXT COMPACTION");
    expect(calls[0].messages[calls[0].messages.length - 1]).toEqual({ role: "user", content: task });

    // The run records it, and events say it happened.
    const record = runtime.getRun(result.runId);
    expect(record?.compaction).toBeDefined();
    expect(record?.compaction?.beforeChars).toBeGreaterThan(record?.compaction?.afterChars ?? 0);
    expect(record?.compaction?.passes).toBe(2);
    expect(record?.compaction?.overflow).toBe(false);
    const records = compactionRecords(events);
    expect(records.length).toBe(2);
    expect(records[1].passes).toBe(2);

    // The run record itself carries exactly one compaction trace line (not one
    // per pass), and its wording matches the renderer's sentence for the *first*
    // pass — the pass that actually happened when the line was written. The
    // record keeps the latest pass (`passes: 2` above); the chip shows that, the
    // trace line says what the run did when it first had to.
    const compactionLines = (record?.trace ?? []).filter((t) => t.kind === "compaction");
    expect(compactionLines).toHaveLength(1);
    expect(compactionLines[0].text).toBe(formatCompactionNotice(records[0]));

    // The run's own log is the full conversation — compaction changed what was
    // *sent*, never what was *said*.
    const keptContents = (record?.messages ?? []).map((m) => m.content);
    for (const h of history) {
      expect(keptContents.some((c) => c === h.content), "history message lost from the run log").toBe(true);
    }
    expect(keptContents).toContain(task);
  });

  it("leaves a small run completely alone", async () => {
    const { transport, calls } = scriptedTransport([{ content: "All good." }]);
    const events: AgentEvent[] = [];
    const runtime = new AgentRuntime({
      registry: createBuiltinRegistry(true),
      createTransport: () => transport,
      onEvent: (ev) => events.push(ev),
    });
    const result = await runtime.run(makeSpec({ task: "Summarise" }));
    expect(result.status).toBe("completed");
    expect(calls).toHaveLength(1);
    expect(events.some((e) => e.type === "compaction")).toBe(false);
    expect(runtime.getRun(result.runId)?.compaction).toBeUndefined();
  });
});