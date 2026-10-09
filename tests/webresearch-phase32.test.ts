// Phase 32 — web research system.
//
// Structure: the record store (real files in a real temp directory — torn
// bytes, quarantine and bounding are filesystem properties), the pure helpers
// (query parsing, prompts, url normalization, the permission decision), and the
// pipeline over injected services (a stub search, fetch and chat — the pipeline
// itself never touches the network, which is what makes every failure and every
// source a real, typed fact rather than a guess). The acceptance criteria map
// one-to-one onto cases here: research over fetched documents (happy path),
// distinguishable sources (dedupe + indexed citations), permission control
// (refuse/ask/run decision), network failures (typed per-step errors) and
// graceful offline behaviour (typed failed status, sources kept, no crash).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "cc-research-userdata-"));
vi.mock("electron", () => ({
  app: { getPath: () => userData },
}));

import type {
  ResearchRecord,
  ResearchServices,
  ResearchSource,
} from "../electron/services/webResearch";
import {
  MAX_FETCHES,
  MAX_RECORDS,
  buildQueriesPrompt,
  buildSummarizeSystem,
  createResearchRecord,
  getResearchRecord,
  listResearchRecords,
  normalizeResearchUrl,
  parseQueries,
  researchPermissionDecision,
  runResearchPipeline,
  saveResearchRecord,
  setResearchUserDataDir,
} from "../electron/services/webResearch";

let dir: string;

function cleanDir(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-research-"));
  setResearchUserDataDir(dir);
  return dir;
}

beforeEach(() => {
  cleanDir();
});

afterEach(() => {
  setResearchUserDataDir(null);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // disposable
  }
});

const now = (): number => 1_700_000_000_000;
const run = now();

interface Hit {
  title: string;
  url: string;
  description?: string;
}

/** A full set of injected services, every call recorded. */
function makeServices(overrides: {
  queries?: string;
  queriesFail?: { code: string; message: string };
  summary?: string;
  summaryFail?: { code: string; message: string };
  search?: (query: string) => { ok: true; results: Hit[] } | { ok: false; code: string; message: string };
  fetch?: (url: string) => { ok: true; text: string } | { ok: false; code: string; message: string };
} = {}) {
  const chats: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const searches: string[] = [];
  const fetches: string[] = [];
  const services: ResearchServices = {
    now,
    chat: async (messages, _signal) => {
      chats.push({ messages });
      const isSummarize = messages[0].role === "system" && messages[0].content.includes("research summarizer");
      if (isSummarize) {
        if (overrides.summaryFail) {
          return { ok: false, code: overrides.summaryFail.code, message: overrides.summaryFail.message } as Awaited<
            ReturnType<ResearchServices["chat"]>
          >;
        }
        return { ok: true, text: overrides.summary ?? "The answer cites sources like [1]. — mock" };
      }
      if (overrides.queriesFail) {
        return { ok: false, code: overrides.queriesFail.code, message: overrides.queriesFail.message } as Awaited<
          ReturnType<ResearchServices["chat"]>
        >;
      }
      return { ok: true, text: overrides.queries ?? "query one\nquery two" };
    },
    search: async (query, _count, _signal) => {
      searches.push(query);
      if (overrides.search) {
        return overrides.search(query) as Awaited<ReturnType<ResearchServices["search"]>>;
      }
      return {
        ok: true,
        results: [
          { title: "Doc A", url: "https://a.example/doc", description: "A page about A." },
          { title: "Doc B", url: "https://b.example/doc/" },
        ],
      };
    },
    fetch: async (url, _signal) => {
      fetches.push(url);
      if (overrides.fetch) return overrides.fetch(url) as Awaited<ReturnType<ResearchServices["fetch"]>>;
      return { ok: true, text: `Fetched body of ${url} with real content.` };
    },
  };
  return { services, chats, searches, fetches };
}

// ---------------------------------------------------------------------------
// 1. Pure helpers
// ---------------------------------------------------------------------------

describe("1. query planning: parse, prompt, budget", () => {
  it("parses numbered, bulleted and bare query lines, ignoring prose", () => {
    const text = "1. what is the close code api\n- site:docs.example.com install\nbare query fine\n\nThis is prose that is longer than the cap, so it can never be mistaken for a query line by the planner.";
    expect(parseQueries(text)).toEqual(["what is the close code api", "site:docs.example.com install", "bare query fine"]);
  });

  it("drops duplicates and caps at the budget", () => {
    const text = "one\none\nTWO\ntwo\nthree\nfour";
    expect(parseQueries(text, 2)).toEqual(["one", "TWO"]);
  });

  it("builds a planner prompt that carries the question", () => {
    const prompt = buildQueriesPrompt("How are skills discovered?");
    expect(prompt).toContain("How are skills discovered?");
    expect(prompt).toContain("distinct web search queries");
  });

  it("numbers summarize entries in corpus order with exact urls", () => {
    const sys = buildSummarizeSystem([
      { index: 1, title: "Doc A", url: "https://a.example/doc", text: "Body A" },
      { index: 2, title: "Doc B", url: "https://b.example/doc", text: "Body B" },
    ]);
    expect(sys).toContain('[1] "Doc A" — https://a.example/doc');
    expect(sys).toContain('[2] "Doc B" — https://b.example/doc');
    expect(sys.indexOf("[1]")).toBeLessThan(sys.indexOf("[2]"));
    expect(sys).toContain("Cite the source of every factual claim");
  });
});

describe("2. url normalization & permission decision", () => {
  it("normalizes trailing slash and fragment so one document is one source", () => {
    expect(normalizeResearchUrl("https://a.example/doc/")).toBe(normalizeResearchUrl("https://a.example/doc"));
    expect(normalizeResearchUrl("https://a.example/doc#section")).toBe(normalizeResearchUrl("https://a.example/doc"));
    expect(normalizeResearchUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeResearchUrl("not a url")).toBeNull();
  });

  it("decides the web gate in main, never in the renderer", () => {
    expect(researchPermissionDecision("deny").action).toBe("refuse");
    expect(researchPermissionDecision("allow").action).toBe("run");
    expect(researchPermissionDecision("ask").action).toBe("ask");
    expect(researchPermissionDecision(undefined).action).toBe("ask");
  });
});

// ---------------------------------------------------------------------------
// 3. The record store
// ---------------------------------------------------------------------------

describe("3. record store: one file per record, atomic, bounded", () => {
  it("saves and reads back a record with its full shape", () => {
    const record = createResearchRecord("Research the close code API.", ["https://a.example/doc"], "allow", run);
    expect(record.status).toBe("queued");
    expect(record.focusUrls).toEqual(["https://a.example/doc"]);
    expect(record.budget.fetches).toBe(MAX_FETCHES);
    expect(saveResearchRecord(record)).toBe(true);

    const back = getResearchRecord(record.id);
    expect(back).not.toBeNull();
    expect(back?.id).toBe(record.id);
    expect(back?.question).toBe("Research the close code API.");
    expect(back?.permission).toBe("allow");
  });

  it("lists newest first and caps the list", () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_RECORDS + 5; i++) {
      const r = createResearchRecord(`q${i}`, [], "allow", run + i);
      ids.push(r.id);
      saveResearchRecord(r);
    }
    const listed = listResearchRecords();
    expect(listed.length).toBe(MAX_RECORDS);
    expect(listed[0].question).toBe(`q${MAX_RECORDS + 4}`);
    // newest-first: the five oldest (q0..q4) are trimmed, so the last kept is q5
    expect(listed[listed.length - 1].question).toBe("q5");
  });

  it("keeps a .bak of the previous write", () => {
    const record = createResearchRecord("q", [], "allow", run);
    saveResearchRecord(record);
    record.status = "running";
    saveResearchRecord(record);
    expect(fs.existsSync(path.join(dir, `${record.id}.json.bak`))).toBe(true);
  });

  it("quarantines corrupt record bytes instead of deleting them and survives a torn read", () => {
    const record = createResearchRecord("q", [], "allow", run);
    saveResearchRecord(record);
    const p = path.join(dir, `${record.id}.json`);
    fs.writeFileSync(p, "{ not json", "utf8");
    expect(getResearchRecord(record.id)).toBeNull();
    expect(fs.existsSync(`${p}.corrupt`)).toBe(true);
    // the list skips it rather than dying
    expect(listResearchRecords()).toEqual([]);
  });

  it("sanitizes hostile rows on the way in", () => {
    const record = createResearchRecord("q", [], "allow", run);
    record.sources = [
      { url: "https://a.example/doc", title: "A", kind: "search", triedAt: run, status: "ok" },
      { url: "https://b.example/doc", title: "B", kind: "search", triedAt: run, status: "pending" },
    ];
    saveResearchRecord(record);
    const corrupted = createResearchRecord("q", [], "allow", run);
    (corrupted as unknown as Record<string, unknown>).status = "banana";
    (corrupted as unknown as Record<string, unknown>).question = ["not", "a", "string"];
    saveResearchRecord(corrupted);
    const back = getResearchRecord(corrupted.id);
    expect(back?.status).toBe("queued");
    expect(back?.question).toBe("");
  });

  it("refuses traversal ids and unknown records", () => {
    expect(getResearchRecord("../../etc/passwd")).toBeNull();
    expect(getResearchRecord("no-such-record")).toBeNull();
  });

  it("creates records with deduped, capped, http-only focus urls", () => {
    const r = createResearchRecord(
      "q",
      ["https://a.example/doc", "https://a.example/doc/", "file:///etc/passwd", "https://b.example/doc", "https://c.example/doc", "https://d.example/doc", "https://e.example/doc", "https://f.example/doc"],
      "ask",
      run,
    );
    expect(r.focusUrls).toHaveLength(MAX_FETCHES);
    expect(r.focusUrls[0]).toBe("https://a.example/doc");
    expect(r.focusUrls.every((u) => /^https?:\/\//.test(u))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. The pipeline
// ---------------------------------------------------------------------------

function collectSources(record: ResearchRecord): ResearchSource[] {
  return record.sources;
}

function fetchText(url: string): string {
  return `Body of ${url}: the CloseCode extension API exposes parse() and format(); sources are distinct per url.`;
}

describe("4. pipeline: happy path — search, fetch, cited summary", () => {
  it("runs plan→search→fetch→summarize and records real steps and sources", async () => {
    const { services, chats, searches, fetches } = makeServices({});
    const record = createResearchRecord("What does parse() take?", [], "allow", run);

    const done = await runResearchPipeline(record, services, {});

    expect(done.status).toBe("done");
    expect(done.answer.length).toBeGreaterThan(0);
    expect(done.completedAt).toBe(run);

    // phases in order, each honest
    expect(done.steps.map((s) => s.kind)).toEqual(["queries", "search", "search", "fetch", "fetch", "summarize"]);
    expect(done.steps.every((s) => s.ok)).toBe(true);
    expect(searches).toEqual(["query one", "query two"]);

    // every fetched url was fetched exactly once; sources dedupe a/b/doc/ vs a/b/doc
    expect(fetches).toHaveLength(2);
    expect(new Set(fetches).size).toBe(2);

    // the summarizer saw numbered sources — the citation contract
    const summarizeCall = chats[chats.length - 1];
    const sys = summarizeCall.messages[0].content;
    expect(sys).toContain('[1] "Doc A" — https://a.example/doc');
    expect(sys).toContain('[2] "Doc B" — https://b.example/doc/');

    // sources are distinguishable: one row per url, each with its own status
    const byUrl = new Map(collectSources(done).map((s) => [s.url, s]));
    expect(byUrl.size).toBe(2);
    expect(byUrl.get("https://a.example/doc")?.status).toBe("ok");
    expect(byUrl.get("https://a.example/doc")?.fetchedAt).toBe(run);
    expect(byUrl.get("https://b.example/doc/")?.status).toBe("ok");
    expect(collectSources(done).every((s) => s.title.length > 0)).toBe(true);
  });

  it("fetches focus urls first, up to the budget, and never more than the budget", async () => {
    const hits: Hit[] = Array.from({ length: 8 }, (_, i) => ({
      title: `Hit ${i}`,
      url: `https://s.example/hit${i}`,
    }));
    const { services, fetches } = makeServices({
      search: () => ({ ok: true, results: hits }),
    });
    const focus = ["https://f.example/1", "https://f.example/2", "https://f.example/3", "https://f.example/4", "https://f.example/5"];
    const record = createResearchRecord("q", focus, "allow", run);

    const done = await runResearchPipeline(record, services, {});

    expect(fetches).toEqual(focus); // focus first, search hits beyond the budget deferred
    expect(fetches).toHaveLength(MAX_FETCHES);
    // the deferred search hits are still recorded as distinguishable sources
    expect(done.sources.some((s) => s.url === "https://s.example/hit0")).toBe(true);
    expect(done.sources.filter((s) => s.url.startsWith("https://s.example/"))[0].fetchedAt).toBeUndefined();
    expect(done.status).toBe("done");
  });

  it("dedupes a focus url that also appears in search results into one row", async () => {
    const { services, fetches } = makeServices({
      search: () => ({ ok: true, results: [{ title: "F", url: "https://f.example/doc" }] }),
    });
    const record = createResearchRecord("q", ["https://f.example/doc"], "allow", run);
    const done = await runResearchPipeline(record, services, {});
    expect(fetches).toHaveLength(1);
    expect(collectSources(done).filter((s) => s.url === "https://f.example/doc")).toHaveLength(1);
    expect(done.status).toBe("done");
  });
});

describe("5. graceful degradations", () => {
  it("no search key → the search step fails typed, focus urls still research", async () => {
    const { services, chats } = makeServices({
      search: () => ({ ok: false, code: "no_key", message: "No web search API key is configured." }),
    });
    const record = createResearchRecord("q", ["https://docs.example/guide"], "allow", run);

    const done = await runResearchPipeline(record, services, {});

    expect(done.status).toBe("done");
    const searchStep = done.steps.find((s) => s.kind === "search");
    expect(searchStep?.ok).toBe(false);
    expect(searchStep?.error?.code).toBe("no_key");
    expect(done.steps.find((s) => s.kind === "fetch")?.ok).toBe(true);
    expect(done.sources.find((s) => s.url === "https://docs.example/guide")?.status).toBe("ok");
    expect(done.answer.length).toBeGreaterThan(0);
    expect(chats[chats.length - 1].messages[0].content).toContain("https://docs.example/guide");
  });

  it("offline: every fetch fails typed, the record fails offline with the sources it tried", async () => {
    const { services } = makeServices({
      search: () => ({ ok: false, code: "offline", message: "could not connect" }),
      fetch: () => ({ ok: false, code: "offline", message: "fetch failed: ENOTFOUND" }),
    });
    const record = createResearchRecord("q", ["https://docs.example/guide"], "allow", run);

    const done = await runResearchPipeline(record, services, {});

    expect(done.status).toBe("failed");
    expect(done.error?.code).toBe("offline");
    expect(done.error?.message.length).toBeGreaterThan(0);
    expect(done.sources.find((s) => s.url === "https://docs.example/guide")?.status).toBe("failed");
    expect(done.steps.filter((s) => !s.ok).length).toBeGreaterThanOrEqual(2); // search + fetch both failed, honestly
  });

  it("summarization failure keeps the fetched sources and says why", async () => {
    const { services, chats } = makeServices({
      summaryFail: { code: "provider", message: "The endpoint answered 500." },
    });
    const record = createResearchRecord("q", ["https://a.example/doc"], "allow", run);

    const done = await runResearchPipeline(record, services, {});

    expect(done.status).toBe("failed");
    expect(done.error?.code).toBe("provider");
    expect(done.answer).toBe("");
    expect(done.sources.find((s) => s.url === "https://a.example/doc")?.status).toBe("ok");
    expect(chats).toHaveLength(2); // planner + summarize; no third call invented
  });

  it("query planning failure falls back to the user's own question as the query", async () => {
    const { services, searches } = makeServices({
      queriesFail: { code: "offline", message: "endpoint unreachable" },
    });
    const record = createResearchRecord("How do I install it?", ["https://docs.example/install"], "allow", run);

    const done = await runResearchPipeline(record, services, {});

    expect(done.steps.find((s) => s.kind === "queries")?.ok).toBe(false);
    expect(searches).toEqual(["How do I install it?"]);
    expect(done.status).toBe("done");
  });

  it("a stopped run becomes a typed aborted failure, not a crash", async () => {
    const { services, searches } = makeServices({});
    const controller = new AbortController();
    controller.abort();
    const record = createResearchRecord("q", [], "allow", run);

    const done = await runResearchPipeline(record, services, { signal: controller.signal });

    expect(done.status).toBe("failed");
    expect(done.error?.code).toBe("aborted");
    expect(searches).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Honesty guards
// ---------------------------------------------------------------------------

describe("6. nothing is invented", () => {
  it("an empty corpus never produces an answer", async () => {
    const { services } = makeServices({
      search: () => ({ ok: true, results: [{ title: "X", url: "https://x.example/empty" }] }),
      fetch: () => ({ ok: false, code: "empty", message: "no readable text" }),
    });
    const record = createResearchRecord("q", [], "allow", run);
    const done = await runResearchPipeline(record, services, {});
    // no readable corpus → failed with the real reason, never a fake answer
    expect(done.status).toBe("failed");
    expect(done.error?.code).toBe("empty");
  });

  it("corpus bytes respect the per-run budget", async () => {
    const { services } = makeServices({
      search: () => ({
        ok: true,
        results: [
          { title: "Big", url: "https://b.example/big" },
          { title: "Small", url: "https://s.example/small" },
        ],
      }),
      fetch: (url) =>
        url === "https://b.example/big"
          ? { ok: true, text: "x".repeat(200_000) }
          : { ok: true, text: "tiny body" },
    });
    const record = createResearchRecord("q", [], "allow", run);
    record.budget.corpusChars = 10_000;
    const done = await runResearchPipeline(record, services, {});
    expect(done.status).toBe("done");
    const big = done.steps.find((s) => s.kind === "fetch" && s.urls[0] === "https://b.example/big");
    expect(big?.detail).toContain("10,000"); // clipped to the remaining corpus budget
  });
});