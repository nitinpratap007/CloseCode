// @vitest-environment jsdom
//
// Phase 32 — the renderer half of web research.
//
// The main process runs the pipeline and owns the gate; `webResearchStore` is
// the projection and `ResearchSection` renders it: the question + optional
// documentation-URL inputs, live records with steps/sources/answer, the
// Approve/Deny buttons an `ask`-mode run presents, and the permission note.
// Exercised against a fake `window.closeCode`; the pipeline, store durability
// and permission decision live in the main-process suites.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";
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
import { useWebResearchStore, type WebResearchStoreState } from "../src/stores/webResearchStore";
import { useAiStore } from "../src/stores/aiStore";
import ResearchSection from "../src/components/ai/ResearchSection";
import type { AiConfigData, ResearchRecordView } from "../src/types/electron";

let seq = 0;
function record(over: Partial<ResearchRecordView> = {}): ResearchRecordView {
  seq += 1;
  return {
    id: `res-${seq}`,
    question: `Question ${seq}`,
    focusUrls: [],
    status: "done",
    permission: "allow",
    awaitingApproval: false,
    steps: [
      { kind: "queries", at: 1, ok: true, detail: "Planned 1 search query.", urls: [] },
      { kind: "search", at: 2, ok: false, detail: 'Search "x" failed: no key.', urls: [], error: { code: "no_key", message: "No key." } },
      { kind: "fetch", at: 3, ok: true, detail: "Fetched https://docs.example/guide (120 chars).", urls: ["https://docs.example/guide"] },
      { kind: "summarize", at: 4, ok: true, detail: "Summarized 1 source into a cited answer.", urls: ["https://docs.example/guide"] },
    ],
    sources: [
      { url: "https://docs.example/guide", title: "CloseCode Guide", kind: "docs", triedAt: 1, status: "ok", fetchedAt: 3 },
    ],
    answer: "The guide says parse() takes a string. [1]",
    error: undefined,
    createdAt: 1,
    updatedAt: 4,
    completedAt: 4,
    budget: { queries: 3, fetches: 5, corpusChars: 140000, answerChars: 40000 },
    ...over,
  };
}

function configWith(mode: "ask" | "allow" | "deny"): AiConfigData {
  return {
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    localBaseUrl: "",
    model: "gpt-test",
    localModel: "",
    temperature: 0.2,
    timeoutMs: 30000,
    stream: true,
    toolMode: "agent",
    permissions: { web: mode },
  };
}

interface ResearchApi {
  researchList: ReturnType<typeof vi.fn>;
  researchStart: ReturnType<typeof vi.fn>;
  researchRespond: ReturnType<typeof vi.fn>;
  onResearchEvent: ReturnType<typeof vi.fn>;
}

let api: ResearchApi;

beforeEach(() => {
  seq = 0;
  api = {
    researchList: vi.fn(async () => ({ ok: true, records: [] })),
    researchStart: vi.fn(async () => ({ ok: true, record: record() })),
    researchRespond: vi.fn(async () => ({ ok: true })),
    onResearchEvent: vi.fn(() => () => {}),
  };
  (window as unknown as { closeCode: unknown }).closeCode = api;
  useWebResearchStore.setState({
    records: [],
    busy: false,
    question: "",
    focusUrls: "",
    error: null,
  } as Partial<WebResearchStoreState>);
  useAiStore.setState({ config: configWith("allow") } as Partial<ReturnType<typeof useAiStore.getState>>);
});

afterEach(() => {
  cleanup();
});

describe("webResearchStore — projection of the main-process store", () => {
  it("refresh reads the current record list", async () => {
    await act(async () => {
      await useWebResearchStore.getState().refresh();
    });
    expect(api.researchList).toHaveBeenCalledTimes(1);
  });

  it("start refuses an empty question without calling the channel", async () => {
    await act(async () => {
      await useWebResearchStore.getState().start();
    });
    expect(useWebResearchStore.getState().error).toBe("Enter a research question first.");
    expect(api.researchStart).not.toHaveBeenCalled();
  });

  it("start sends the question and parsed documentation urls, then clears the inputs", async () => {
    useWebResearchStore.setState({ question: "How does parse() work?", focusUrls: "  https://docs.example/guide, https://docs.example/api  " });
    await act(async () => {
      await useWebResearchStore.getState().start();
    });
    expect(api.researchStart).toHaveBeenCalledWith({
      question: "How does parse() work?",
      focusUrls: ["https://docs.example/guide", "https://docs.example/api"],
    });
    expect(useWebResearchStore.getState().question).toBe("");
    expect(useWebResearchStore.getState().focusUrls).toBe("");
  });

  it("start surfaces a refusal from main as the honest error", async () => {
    api.researchStart.mockResolvedValue({ ok: false, error: "Web access is set to deny." });
    useWebResearchStore.setState({ question: "q" });
    await act(async () => {
      await useWebResearchStore.getState().start();
    });
    expect(useWebResearchStore.getState().error).toBe("Web access is set to deny.");
  });

  it("respond sends the decision and refreshes", async () => {
    await act(async () => {
      await useWebResearchStore.getState().respond("res-1", true);
    });
    expect(api.researchRespond).toHaveBeenCalledWith("res-1", true);
    expect(api.researchList).toHaveBeenCalled();
  });
});

describe("ResearchSection — what the user sees", () => {
  it("renders the empty state and the web permission note", async () => {
    let view: ReturnType<typeof render> | null = null;
    await act(async () => {
      view = render(<ResearchSection />);
    });
    expect(view!.container.querySelector("[data-research-empty]")).not.toBeNull();
    expect(view!.container.querySelector("[data-research]")).not.toBeNull();
    expect(view!.container.querySelector("[data-research-permission]")?.textContent).toContain("allow");
  });

  it("shows a deny notice when web is denied", async () => {
    useAiStore.setState({ config: configWith("deny") } as Partial<ReturnType<typeof useAiStore.getState>>);
    let view: ReturnType<typeof render> | null = null;
    await act(async () => {
      view = render(<ResearchSection />);
    });
    expect(view!.container.textContent).toContain("research runs will be refused");
  });

  it("renders records with status, sources, steps and the cited answer", async () => {
    api.researchList.mockResolvedValue({ ok: true, records: [record()] });
    let view: ReturnType<typeof render> | null = null;
    await act(async () => {
      view = render(<ResearchSection />);
    });
    const row = view!.container.querySelector("[data-research-record='res-1']");
    expect(row).not.toBeNull();
    expect(view!.container.querySelector("[data-research-status='res-1:done']")?.textContent).toContain("Done");

    // expand the row to see the detail
    fireEvent.click(view!.container.querySelector("[data-research-toggle='res-1']") as Element);
    expect(view!.container.querySelector("[data-research-answer='res-1']")?.textContent).toContain("[1]");
    const source = view!.container.querySelector("[data-research-source='res-1:0']");
    expect(source?.querySelector("[data-research-url]")?.getAttribute("data-research-url")).toBe("https://docs.example/guide");
    // the failed search step is visible as failed, not hidden
    const step = view!.container.querySelector("[data-research-step='res-1:search']");
    expect(step?.textContent).toContain("no_key");
    // the source status chip is distinguishable
    expect(view!.container.querySelector("[data-research-source-status='res-1:0:ok']")).not.toBeNull();
  });

  it("shows Approve/Deny for an ask-mode record and wires them to respond", async () => {
    api.researchList.mockResolvedValue({
      ok: true,
      records: [record({ id: "res-ask", status: "queued", awaitingApproval: true, permission: "ask", steps: [], sources: [], answer: "" })],
    });
    let view: ReturnType<typeof render> | null = null;
    await act(async () => {
      view = render(<ResearchSection />);
    });
    const approve = view!.container.querySelector("[data-research-approve='res-ask']");
    const deny = view!.container.querySelector("[data-research-deny='res-ask']");
    expect(approve).not.toBeNull();
    expect(deny).not.toBeNull();
    fireEvent.click(approve as Element);
    expect(api.researchRespond).toHaveBeenCalledWith("res-ask", true);
  });

  it("starts research through the same action the button calls", async () => {
    let view: ReturnType<typeof render> | null = null;
    await act(async () => {
      view = render(<ResearchSection />);
    });
    const input = view!.container.querySelector("[data-research-input]") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Research the API." } });
    fireEvent.click(view!.container.querySelector("[data-research-start]") as Element);
    expect(api.researchStart).toHaveBeenCalledWith({ question: "Research the API.", focusUrls: [] });
  });
});