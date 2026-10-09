// @vitest-environment jsdom
//
// Phase 28 — the renderer half of context compaction.
//
// The main process decides *that* a payload was compacted and ships the numbers
// in `CompactionRecord`; the renderer decides *what to say about it*. Both
// surfaces are exercised here, against a fake `window.closeCode` so every
// decision is testable without Electron:
//
//   * the agent panel records compaction once per run (not once per pass) and
//     keeps the latest record on the run;
//   * the chat panel shows a compaction note and clears it on the next send;
//   * `AgentSection` actually renders the chip and the trace line a user sees.
//
// The stores are module-level singletons, so the listening/started flags and the
// seeded state are reset between tests and each test installs its own fake API.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
// `aiStore` pulls the whole Monaco graph through `../monaco` (workers, themes)
// and `../ai/context` → `../language/diagnostics` → `monaco-editor`, which does
// not resolve under vitest's node runner. Neither module is the code under test
// here, so both are mocked into their smallest useful shape.
vi.mock("../src/monaco", () => ({
  default: {
    editor: { getModel: () => null, setTheme: () => {}, getTheme: () => "cc-dark" },
    Uri: { file: () => ({}) },
  },
}));
vi.mock("../src/language/diagnostics", () => ({
  useDiagnosticsStore: {
    getState: () => ({ diagnostics: [] }),
    setState: () => {},
    subscribe: () => () => {},
  },
}));
import { useAgentStore } from "../src/stores/agentStore";
import { useAiStore } from "../src/stores/aiStore";
import { useSessionStore } from "../src/stores/sessionStore";
import { useWorkspaceStore } from "../src/stores/workspaceStore";
import AgentSection from "../src/components/ai/AgentSection";
import { formatCompactionNotice } from "../src/lib/compaction";
import type { CompactionRecord, AgentRun, AgentEvent, AiChatEvent } from "../src/types/electron";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function record(over: Partial<CompactionRecord> = {}): CompactionRecord {
  return {
    at: 1_000,
    passes: 1,
    step: 0,
    budgetChars: 100_000,
    beforeChars: 120_000,
    afterChars: 6_240,
    beforeMessages: 41,
    afterMessages: 3,
    digestChars: 5_100,
    kept: { decisions: 2, issues: 1, toolResults: 1 },
    omitted: { decisions: 0, issues: 0, toolResults: 0 },
    digestLines: 14,
    digestLinesOmitted: 0,
    clampedMessages: 1,
    overflow: false,
    digest: "=== CONTEXT COMPACTION (extractive, deterministic) ===",
    ...over,
  };
}

function run(over: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "r1",
    agentId: "build",
    task: "Do the work",
    workspace: null,
    status: "completed",
    parentRunId: null,
    depth: 0,
    steps: 2,
    toolCalls: 1,
    messages: [],
    trace: [],
    createdAt: 100,
    updatedAt: 200,
    ...over,
  };
}

interface AgentApi {
  onAgentEvent: ReturnType<typeof vi.fn>;
  agentRun: ReturnType<typeof vi.fn>;
  push: (ev: AgentEvent) => void;
}

let agentApi: AgentApi;
let aiListeners: Array<(ev: AiChatEvent) => void>;

function installAgentApi(): AgentApi {
  let cb: ((ev: AgentEvent) => void) | null = null;
  const api = {
    onAgentEvent: vi.fn((fn: (ev: AgentEvent) => void) => {
      cb = fn;
      return () => {};
    }),
    onAgentContext: vi.fn(() => () => {}),
    agentDefinitions: vi.fn(async () => ({
      ok: true,
      result: [
        {
          id: "build",
          name: "Build Agent",
          description: "Verifiable implementer",
          statusLine: "",
          readOnly: false,
          systemPrompt: "Build it and prove it.",
        },
      ],
    })),
    agentRuns: vi.fn(async () => ({ ok: true, result: [] })),
    agentContextInspect: vi.fn(async () => ({ ok: true, result: null })),
    agentRun: vi.fn(async () => ({ ok: true, result: null })),
  };
  (window as unknown as { closeCode: unknown }).closeCode = api;
  return {
    onAgentEvent: api.onAgentEvent,
    agentRun: api.agentRun,
    push: (ev) => cb?.(ev),
  };
}

function installAiApi(): { aiChat: ReturnType<typeof vi.fn>; push: (ev: AiChatEvent) => void } {
  aiListeners = [];
  const api = {
    aiChat: vi.fn(async () => ({ ok: true })),
    aiGetConfig: vi.fn(async () => ({ ok: true, result: { config: {}, apiKeys: {} } })),
    aiDetectLocal: vi.fn(async () => ({ ok: true, result: { runtimes: [] } })),
    getSettings: vi.fn(async () => ({ aiContextAutoInclude: false })),
  };
  (window as unknown as { closeCode: unknown }).closeCode = {
    ...api,
    onAiEvent: vi.fn((cb: (ev: AiChatEvent) => void) => {
      aiListeners.push(cb);
      return () => {};
    }),
  };
  return {
    aiChat: api.aiChat,
    push: (ev) => aiListeners.forEach((l) => l(ev)),
  };
}

beforeEach(() => {
  useAgentStore.setState({
    definitions: [],
    runs: [],
    activeRunId: null,
    task: "",
    error: null,
    notice: null,
    listening: false,
    contextEnabled: true,
    contextSummary: null,
    contextBuilding: false,
  });
  useAiStore.setState({
    messages: [],
    busy: false,
    error: null,
    input: "",
    compactionNote: null,
    started: false,
    configOpen: false,
  });
  useSessionStore.setState({
    sessions: [],
    activeId: null,
    current: null,
    resumeHistory: [],
    corrupted: null,
    error: null,
    notice: null,
    busy: false,
    listening: false,
  });
  useWorkspaceStore.setState({ root: "C:\\ws", rootName: "ws" } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The wording
// ---------------------------------------------------------------------------

describe("formatCompactionNotice (Phase 28)", () => {
  it("states the reduction and the pass count in the panel's own sentence", () => {
    expect(formatCompactionNotice(record())).toBe(
      "Context compacted: 120,000 → 6,240 chars, 41 → 3 messages.",
    );
    expect(formatCompactionNotice(record({ passes: 3 }))).toContain("(3 passes)");
  });

  it("says explicitly when even system plus task were over budget", () => {
    expect(formatCompactionNotice(record({ overflow: true }))).toContain(
      "The system prompt and active task alone still exceed the budget.",
    );
  });
});

// ---------------------------------------------------------------------------
// The agent panel store
// ---------------------------------------------------------------------------

describe("agent store · compaction events (Phase 28)", () => {
  it("records one trace line per run and keeps the latest record", () => {
    agentApi = installAgentApi();
    useAgentStore.setState({ runs: [run()], activeRunId: "r1" });
    useAgentStore.getState().startListening();

    act(() => agentApi.push({ type: "compaction", runId: "r1", step: 0, record: record() }));
    let stored = useAgentStore.getState().runs.find((r) => r.id === "r1")!;
    expect(stored.compaction?.passes).toBe(1);
    expect(stored.compaction?.beforeChars).toBe(120_000);
    expect(stored.trace.filter((t) => t.kind === "compaction")).toHaveLength(1);
    expect(stored.trace[0].text).toContain("120,000 → 6,240");

    // A second pass updates the record, but must not add a second trace line:
    // ten lines saying "still over budget" would be noise, not information.
    act(() =>
      agentApi.push({ type: "compaction", runId: "r1", step: 1, record: record({ passes: 2, afterChars: 3_000 }) }),
    );
    stored = useAgentStore.getState().runs.find((r) => r.id === "r1")!;
    expect(stored.compaction?.passes).toBe(2);
    expect(stored.compaction?.afterChars).toBe(3_000);
    expect(stored.trace.filter((t) => t.kind === "compaction")).toHaveLength(1);
  });

  it("ignores a compaction event whose run it has never seen until the pull lands", () => {
    agentApi = installAgentApi();
    useAgentStore.getState().startListening();
    act(() => agentApi.push({ type: "compaction", runId: "r-unknown", step: 0, record: record() }));
    // Nothing is invented locally: the authoritative record is pulled from main.
    expect(useAgentStore.getState().runs).toHaveLength(0);
    expect(agentApi.agentRun).toHaveBeenCalledWith("r-unknown");
  });

  it("keeps the compaction record and its trace line through the result event", () => {
    // The real runtime emits state/status/compaction/message events and finishes
    // with `result`, which rebuilds the run from the outcome payload. Compaction
    // must survive that rebuild exactly like `contextSummary` and `sessionId`
    // do — the E2E run caught it being silently dropped, leaving the chip and
    // trace line without a record to show.
    agentApi = installAgentApi();
    const rec = record({ passes: 2, step: 1 });
    useAgentStore.setState({ runs: [run()], activeRunId: "r1" });
    useAgentStore.getState().startListening();

    act(() => agentApi.push({ type: "state", runId: "r1", status: "running", previous: "starting", at: 1, note: "working" }));
    act(() => agentApi.push({ type: "status", runId: "r1", step: 0, level: "thinking", text: "deciding" }));
    act(() => agentApi.push({ type: "compaction", runId: "r1", step: 0, record: rec }));
    act(() => agentApi.push({ type: "message", runId: "r1", message: { role: "assistant", content: "working" } }));
    act(() => {
      agentApi.push({
        type: "result",
        runId: "r1",
        result: {
          runId: "r1",
          agentId: "build",
          status: "completed",
          text: "done",
          steps: 1,
          toolCalls: 0,
          durationMs: 5,
          cancelled: false,
        },
      });
    });

    const stored = useAgentStore.getState().runs.find((r) => r.id === "r1")!;
    expect(stored.compaction?.passes).toBe(2);
    expect(stored.trace.some((t) => t.kind === "compaction")).toBe(true);
    expect(stored.status).toBe("completed");
    expect(stored.result?.text).toBe("done");
  });

  it("renders the chip and the trace entry for a run that was compacted", () => {
    // rendering needs nothing from the API; the fixture API keeps imports honest
    agentApi = installAgentApi();
    const rec = record({ passes: 2 });
    const compRun = run({
      trace: [
        { at: 1_000, kind: "compaction", step: 0, text: formatCompactionNotice(rec) },
      ],
      compaction: rec,
    });
    useAgentStore.setState({
      runs: [compRun],
      activeRunId: "r1",
      task: "Do the work",
      definitions: [
        {
          id: "build",
          name: "Build Agent",
          description: "Verifiable implementer",
          statusLine: "",
          readOnly: false,
          systemPrompt: "Build it and prove it.",
        },
      ],
      selectedAgentId: "build",
    });

    const { container } = render(<AgentSection state={useAgentStore.getState()} />);
    const chip = container.querySelector("[data-agent-compaction]");
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute("data-agent-compaction")).toBe("120000:6240:2");
    expect(chip?.textContent).toContain("compacted 120.0k → 6.2k ch");
    expect(chip?.textContent).toContain("×2");

    const traceEntry = container.querySelector('[data-agent-trace-entry="compaction"]');
    expect(traceEntry).not.toBeNull();
    expect(traceEntry?.textContent).toContain("Context compacted");
  });
});

// ---------------------------------------------------------------------------
// The chat panel store
// ---------------------------------------------------------------------------

describe("ai store · compaction in plain chat (Phase 28)", () => {
  it("shows a note for the in-flight request and clears it on the next send", async () => {
    const api = installAiApi();
    useAiStore.setState({ input: "long message", messages: [], busy: false, compactionNote: null });
    useAiStore.getState().startListening();

    api.aiChat.mockImplementation(async (req: { id: string }) => {
      // The previous turn's note is gone the moment a new send starts.
      expect(useAiStore.getState().compactionNote).toBeNull();
      api.push({ type: "compaction", payload: { id: req.id, record: record() } });
      api.push({ type: "done", payload: { id: req.id, text: "ok", toolSteps: 0 } });
      return { ok: true };
    });

    await act(async () => {
      await useAiStore.getState().send("first");
      await useAiStore.getState().send("second");
    });

    expect(api.aiChat).toHaveBeenCalledTimes(2);
    expect(useAiStore.getState().compactionNote).toBe(
      "Context compacted: 120,000 → 6,240 chars, 41 → 3 messages.",
    );
  });
});