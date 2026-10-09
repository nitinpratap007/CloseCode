// Close Code — Web Research System (Phase 32)
//
// The research facility: a bounded, permission-gated pipeline that turns a
// question into a source-tracked, cited summary. Every network call and every
// model call is real — the search backend is Brave (or an injected stub in
// tests), the fetches go to the URLs the search returned or the user named,
// and the query planning / summarization go through the same OpenAI-compatible
// transport the chat path uses. Nothing is invented, canned or dressed up as a
// lookup.
//
// WHY THE PIPELINE LIVES IN MAIN:
//   The renderer never performs network calls for AI (the Phase 11 rule), the
//   search key is already main-process-only, and the permission decision for a
//   `web` category has to be enforced where it can be enforced, not where it
//   can be ignored.
//
// HONESTY RULES, inherited from Phase 22's web tools:
//   * A failed step is recorded as a failed step with its typed reason. The
//     record's step list and source list are a log of what actually happened.
//   * An unreachable network is an `offline` outcome, never a pretend answer.
//   * A record that cannot be summarized keeps every source it DID gather and
//     says why the answer is missing.
//   * Sources are distinguishable: each url appears once, each has its own
//     title/status/fetchedAt, and the answer cites them by bracketed index
//     against that exact list.

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { app } from "electron";
import { fetchCapped, htmlToText, parsePublicUrl } from "./agent/tools-web";
import { createOpenAiTransport, resolveEndpoint } from "./agent/transport";
import { classifyNetworkError, isAbortLike } from "./agent/errors";

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

export type ResearchStatus = "queued" | "running" | "done" | "failed" | "refused";
export type ResearchStepKind = "queries" | "search" | "fetch" | "summarize";
export type ResearchSourceKind = "search" | "docs";
export type ResearchPermissionMode = "ask" | "allow" | "deny";
export type ResearchFailureCode =
  | "refused"
  | "offline"
  | "no_key"
  | "rate_limited"
  | "http"
  | "invalid"
  | "too_large"
  | "provider"
  | "timeout"
  | "empty"
  | "aborted";

export interface ResearchError {
  code: ResearchFailureCode;
  message: string;
}

export interface ResearchStep {
  kind: ResearchStepKind;
  at: number;
  ok: boolean;
  detail: string;
  /** The source urls this step produced or touched. */
  urls: string[];
  error?: ResearchError;
}

export interface ResearchSource {
  url: string;
  title: string;
  kind: ResearchSourceKind;
  /** When the source first entered the record. */
  triedAt: number;
  /** "ok" = usable result (a search hit) or successfully fetched; "failed" = fetch failed; "pending" = never fetched. */
  status: "ok" | "failed" | "pending";
  fetchedAt?: number;
  snippet?: string;
  error?: ResearchError;
}

export interface ResearchRecord {
  id: string;
  question: string;
  /** Urls the user named up front. Fetched directly, never searched for. */
  focusUrls: string[];
  status: ResearchStatus;
  /** The `web` category mode that governed this run. Recorded, never trusted again. */
  permission: ResearchPermissionMode;
  awaitingApproval: boolean;
  steps: ResearchStep[];
  sources: ResearchSource[];
  answer: string;
  error?: ResearchError;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  budget: { queries: number; fetches: number; corpusChars: number; answerChars: number };
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

export const MAX_QUESTION = 600;
export const MAX_QUERIES = 3;
export const MAX_FETCHES = 5;
export const MAX_FOCUS_URLS = MAX_FETCHES;
export const MAX_FETCH_BYTES = 2 * 1024 * 1024;
export const MAX_HTML_TEXT = 400_000;
export const MAX_CORPUS_CHARS = 140_000;
export const MAX_ANSWER_CHARS = 40_000;
export const MAX_QUERY_LINE = 120;
export const MAX_SOURCES = 20;
export const MAX_STEPS = 60;
export const MAX_RECORDS = 50;
const SEARCH_TIMEOUT_MS = 20_000;
const FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

export interface ResearchBudget {
  queries: number;
  fetches: number;
  corpusChars: number;
  answerChars: number;
}

export function defaultBudget(): ResearchBudget {
  return { queries: MAX_QUERIES, fetches: MAX_FETCHES, corpusChars: MAX_CORPUS_CHARS, answerChars: MAX_ANSWER_CHARS };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export interface ResearchPlannedEntry {
  index: number;
  title: string;
  url: string;
  text: string;
}

/**
 * Turn a model's planner reply into at most `max` search queries.
 *
 * Deliberately tolerant of the common shapes (numbered, bulleted, bare) and
 * deaf to prose: a line that is not a plausible query is dropped, so a model
 * that writes an essay for the planner gets the essay's lines refused rather
 * than searched.
 */
export function parseQueries(text: string, max: number = MAX_QUERIES): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of String(text ?? "").split(/[\r\n]+/)) {
    const line = raw.replace(/^\s*(?:[-*•‣]|\d{1,2}[.):])\s*/, "").trim();
    if (line.length < 2 || line.length > MAX_QUERY_LINE) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= max) break;
  }
  return out;
}

export function buildQueriesPrompt(question: string): string {
  return (
    `You are a web research planner. The user needs current, sourceable answers to the question below.\n\n` +
    `Propose up to ${MAX_QUERIES} distinct web search queries that would find authoritative pages. Rules:\n` +
    `- one query per line, no numbering, no bullets, no commentary\n` +
    `- each query at most ${MAX_QUERY_LINE} characters\n` +
    `- prefer the site-restricted form "site:docs.example.com keyword" when the topic is a well-known library or standard\n` +
    `- make the queries specific enough that the first page of results is on-topic\n\n` +
    `Question: ${question}`
  );
}

export function buildSummarizeSystem(entries: ResearchPlannedEntry[]): string {
  const body = entries.map((e) => `[${e.index}] "${e.title}" — ${e.url}\n${e.text}`).join("\n\n");
  return (
    `You are a research summarizer. Answer the user's research question using ONLY the sources below.\n\n` +
    `Rules:\n` +
    `- Cite the source of every factual claim with its bracketed index, like [1].\n` +
    `- A claim may cite several sources: [1][2].\n` +
    `- Every citation index must exist in the list below.\n` +
    `- Do not invent facts or sources; if the sources do not answer the question, say what is missing.\n` +
    `- Keep the answer under ${MAX_ANSWER_CHARS} characters.\n\n` +
    `Sources:\n${body}`
  );
}

/**
 * The one url normalization: strip fragment and trailing slash so the same
 * document cannot appear twice under two spellings. Returns null for anything
 * that is not an http(s) URL.
 */
export function normalizeResearchUrl(raw: string): string | null {
  try {
    const u = new URL(String(raw ?? "").trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function hostOf(raw: string): string {
  try {
    return new URL(raw).host || raw.slice(0, 100);
  } catch {
    return raw.slice(0, 100);
  }
}

/** What a `web` category mode means for a research request. Decided in main. */
export type ResearchPermissionDecision = { action: "run" } | { action: "ask" } | { action: "refuse" };
export function researchPermissionDecision(mode: string | undefined): ResearchPermissionDecision {
  if (mode === "deny") return { action: "refuse" };
  if (mode === "allow") return { action: "run" };
  return { action: "ask" };
}

// ---------------------------------------------------------------------------
// Injectables — the pipeline talks to the world only through these.
// ---------------------------------------------------------------------------

export interface ResearchSearchHit {
  title: string;
  url: string;
  description?: string;
}

export type ResearchChatOutcome = { ok: true; text: string } | { ok: false; code: ResearchFailureCode; message: string };
export type ResearchSearchOutcome =
  | { ok: true; results: ResearchSearchHit[] }
  | { ok: false; code: ResearchFailureCode; message: string };
export type ResearchFetchOutcome = { ok: true; text: string } | { ok: false; code: ResearchFailureCode; message: string };

export interface ResearchServices {
  now: () => number;
  chat: (messages: Array<{ role: "system" | "user"; content: string }>, signal: AbortSignal) => Promise<ResearchChatOutcome>;
  search: (query: string, count: number, signal: AbortSignal) => Promise<ResearchSearchOutcome>;
  fetch: (url: string, signal: AbortSignal) => Promise<ResearchFetchOutcome>;
}

/**
 * The real services, wired for a running app: model calls through the same
 * transport as the agent loop, search through Brave with the encrypted key,
 * fetches through the same capped fetcher as `web_fetch`. Unit tests inject
 * their own; this is the production path both the panel and the agent tools use.
 */
export function createResearchServices(
  cfg: {
    provider: "local" | "openai" | "custom";
    baseUrl: string;
    localBaseUrl: string;
    model: string;
    localModel: string;
    temperature: number;
    timeoutMs: number;
  },
  search: { apiKey: string | null; endpoint?: string },
  baseSignal: AbortSignal,
): ResearchServices {
  const endpoint = resolveEndpoint(cfg);
  const transport = createOpenAiTransport(endpoint);
  const searchEndpoint = search.endpoint || DEFAULT_SEARCH_ENDPOINT;

  return {
    now: () => Date.now(),

    chat: async (messages, signal) => {
      const merged = mergeSignals(baseSignal, signal);
      try {
        const res = await transport({
          model: endpoint.model,
          messages,
          temperature: cfg.temperature,
          stream: false,
          timeoutMs: cfg.timeoutMs,
          signal: merged,
          onDelta: undefined,
          onReasoning: undefined,
        });
        if (res.toolCalls.length > 0) {
          return { ok: false, code: "provider", message: "The model replied with tool calls where plain text was expected." };
        }
        const text = (res.content ?? "").trim();
        return text ? { ok: true, text } : { ok: false, code: "empty", message: "The model returned an empty answer." };
      } catch (err) {
        return { ok: false, code: researchErrorCode(err, merged), message: researchErrorMessage(err) };
      }
    },

    search: async (query, count, signal) => {
      const key = search.apiKey;
      if (!key) {
        return {
          ok: false,
          code: "no_key",
          message: "No web search API key is configured; the research cannot search, only fetch named URLs.",
        };
      }
      const endpointUrl = new URL(searchEndpoint);
      endpointUrl.searchParams.set("q", query);
      endpointUrl.searchParams.set("count", String(count));
      const res = await fetchCapped(
        endpointUrl,
        { method: "GET", headers: { accept: "application/json", "x-subscription-token": key } },
        mergeSignals(baseSignal, signal),
        SEARCH_TIMEOUT_MS,
        MAX_FETCH_BYTES,
      );
      if (!res.ok) {
        return { ok: false, code: "offline", message: `The search request failed: ${res.reason}` };
      }
      if (res.status === 401 || res.status === 403) {
        return { ok: false, code: "no_key", message: "The search API key was rejected (HTTP " + res.status + ")." };
      }
      if (res.status === 429) {
        return { ok: false, code: "rate_limited", message: "The search service is rate limiting this key." };
      }
      if (res.status >= 400) {
        return { ok: false, code: "http", message: `The search service rejected the request (HTTP ${res.status}).` };
      }
      try {
        const parsed = JSON.parse(res.body) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
        const results = (parsed.web?.results ?? [])
          .filter((r) => typeof r.url === "string" && normalizeResearchUrl(r.url))
          .map((r) => ({ title: r.title ?? "(untitled)", url: r.url as string, ...(r.description ? { description: r.description } : {}) }));
        return { ok: true, results };
      } catch (err) {
        return { ok: false, code: "http", message: `The search service returned an unreadable response: ${err instanceof Error ? err.message : String(err)}` };
      }
    },

    fetch: async (url, signal) => {
      const parsed = parsePublicUrl(url);
      if ("refusal" in parsed) {
        return { ok: false, code: "invalid", message: parsed.refusal };
      }
      const res = await fetchCapped(
        parsed.url,
        { method: "GET", headers: { accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.5" } },
        mergeSignals(baseSignal, signal),
        FETCH_TIMEOUT_MS,
        MAX_FETCH_BYTES,
      );
      if (!res.ok) {
        return {
          ok: false,
          code: res.status && res.status >= 500 ? "http" : "offline",
          message: `${parsed.url.href} could not be fetched: ${res.reason}`,
        };
      }
      const isHtml = /text\/html|application\/xhtml/i.test(res.contentType) || /^\s*<(!doctype|html)/i.test(res.body);
      const text = isHtml ? htmlToText(res.body).slice(0, MAX_HTML_TEXT) : res.body;
      if (!text.trim()) {
        return { ok: false, code: "empty", message: `${parsed.url.href} returned no readable text.` };
      }
      return { ok: true, text: text.slice(0, MAX_HTML_TEXT) };
    },
  };
}

function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted || b.aborted) {
    const c = new AbortController();
    c.abort();
    return c.signal;
  }
  const c = new AbortController();
  const onAbort = (): void => c.abort();
  a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  return c.signal;
}

function researchErrorCode(err: unknown, signal: AbortSignal): ResearchFailureCode {
  if (isAbortLike(err)) return signal.aborted ? "aborted" : "timeout";
  if (classifyNetworkError(err)) return "offline";
  return "provider";
}

function researchErrorMessage(err: unknown): string {
  if (err instanceof Error && /fetch failed|ECONNREFUSED|ENOTFOUND|network/i.test(err.message)) {
    return "Could not reach the AI endpoint — check the network and the configured base URL.";
  }
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

function copyRecord(record: ResearchRecord): ResearchRecord {
  return {
    ...record,
    steps: [...record.steps],
    sources: [...record.sources],
  };
}

function pickFailure(record: ResearchRecord): ResearchError | undefined {
  const last = [...record.steps].reverse().find((s) => s.ok === false && s.error);
  return last?.error;
}

export async function runResearchPipeline(
  record: ResearchRecord,
  services: ResearchServices,
  opts: { signal?: AbortSignal; onUpdate?: (r: ResearchRecord) => void } = {},
): Promise<ResearchRecord> {
  const now = services.now;
  const signal = opts.signal ?? new AbortController().signal;
  const touch = (): void => {
    record.updatedAt = now();
    opts.onUpdate?.(copyRecord(record));
  };
  const pushStep = (
    kind: ResearchStepKind,
    ok: boolean,
    detail: string,
    urls: string[],
    error?: ResearchError,
  ): void => {
    record.steps.push({ kind, at: now(), ok, detail, urls: urls.slice(0, 20), ...(error ? { error } : {}) });
    if (record.steps.length > MAX_STEPS) record.steps = record.steps.slice(-MAX_STEPS);
  };
  const aborted = (): boolean => {
    if (!signal.aborted) return false;
    record.status = "failed";
    record.error = { code: "aborted", message: "The research was stopped before it finished." };
    record.completedAt = now();
    touch();
    return true;
  };

  record.status = "running";
  record.awaitingApproval = false;
  touch();

  // 1. Plan the queries with the model. A failure here falls back to the
  //    user's own question as the single query — recorded, never hidden.
  const qRes = await services.chat(
    [{ role: "system", content: buildQueriesPrompt(record.question) }, { role: "user", content: record.question }],
    signal,
  );
  let queries: string[];
  if (qRes.ok) {
    queries = parseQueries(qRes.text);
    pushStep("queries", true, `Planned ${queries.length} search quer${queries.length === 1 ? "y" : "ies"}.`, []);
  } else {
    queries = [record.question];
    pushStep("queries", false, `Query planning failed (${qRes.code}); searching the question directly.`, [], {
      code: qRes.code,
      message: qRes.message,
    });
  }

  // 2. Search. Each query is one step; a failed search never invents results.
  const searchSources: ResearchSource[] = [];
  for (const q of queries) {
    if (aborted()) return record;
    const s = await services.search(q, 8, signal);
    if (s.ok && s.results.length > 0) {
      const urls: string[] = [];
      for (const hit of s.results) {
        if (!normalizeResearchUrl(hit.url)) continue;
        if (record.sources.some((src) => normalizeResearchUrl(src.url) === normalizeResearchUrl(hit.url))) continue;
        const source: ResearchSource = {
          url: hit.url,
          title: hit.title || hostOf(hit.url),
          kind: "search",
          triedAt: now(),
          status: "ok",
          ...(hit.description ? { snippet: hit.description.slice(0, 600) } : {}),
        };
        record.sources.push(source);
        searchSources.push(source);
        urls.push(hit.url);
        if (record.sources.length > MAX_SOURCES) {
          record.sources = record.sources.slice(-MAX_SOURCES);
        }
      }
      pushStep("search", true, `Search "${q}" returned ${s.results.length} result${s.results.length === 1 ? "" : "s"}.`, urls);
    } else {
      pushStep("search", false, `Search "${q}" ${s.ok ? "returned no results" : `failed: ${s.message}`}.`, [], s.ok ? { code: "empty", message: `No web results for "${q}".` } : { code: s.code, message: s.message });
    }
  }

  // 3. Fetch. Focus urls first (the user named them), then search hits, up to
  //    the fetch budget. Each source row is updated in place — one url, one row.
  const focus: ResearchSource[] = [];
  for (const u of record.focusUrls) {
    const norm = normalizeResearchUrl(u);
    if (!norm) continue;
    if (record.sources.some((src) => normalizeResearchUrl(src.url) === norm)) continue;
    const source: ResearchSource = { url: u, title: hostOf(u), kind: "docs", triedAt: now(), status: "pending" };
    record.sources.push(source);
    focus.push(source);
  }
  const candidates: ResearchSource[] = [];
  const seen = new Set<string>();
  for (const src of [...focus, ...searchSources]) {
    const norm = normalizeResearchUrl(src.url);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    candidates.push(src);
    if (candidates.length >= record.budget.fetches) break;
  }

  const planned: ResearchPlannedEntry[] = [];
  let corpusLeft = record.budget.corpusChars;
  for (const cand of candidates) {
    if (aborted()) return record;
    const f = await services.fetch(cand.url, signal);
    if (f.ok && f.text.trim()) {
      cand.status = "ok";
      cand.fetchedAt = now();
      const clip = Math.min(f.text.length, corpusLeft);
      corpusLeft -= clip;
      planned.push({ index: planned.length + 1, title: cand.title, url: cand.url, text: f.text.slice(0, clip) });
      pushStep("fetch", true, `Fetched ${cand.url} (${clip.toLocaleString()} chars).`, [cand.url]);
    } else {
      // An "ok" fetch that returned no readable text is a failed fetch — the
      // pipeline never feeds an empty page to the summarizer as a source.
      const err: ResearchError = f.ok
        ? { code: "empty", message: `${cand.url} returned no readable text.` }
        : { code: f.code, message: f.message };
      cand.status = "failed";
      cand.error = err;
      pushStep("fetch", false, `Could not fetch ${cand.url}: ${err.message}`, [cand.url], err);
    }
  }

  // 4. Summarize from the fetched corpus only. No corpus, no answer — the
  //    record fails with the first real reason it has.
  if (aborted()) return record;
  if (planned.length === 0) {
    const reason = pickFailure(record);
    const code: ResearchFailureCode = reason?.code ?? "empty";
    const message =
      reason?.message ??
      (record.sources.some((s) => s.status === "ok")
        ? "No document could be fetched, so there is nothing to summarize."
        : "No sources could be reached.");
    record.status = "failed";
    record.error = { code, message };
    record.completedAt = now();
    touch();
    return record;
  }

  const sum = await services.chat(
    [
      { role: "system", content: buildSummarizeSystem(planned) },
      { role: "user", content: record.question },
    ],
    signal,
  );
  if (sum.ok && sum.text.trim()) {
    record.answer = sum.text.trim().slice(0, record.budget.answerChars);
    pushStep("summarize", true, `Summarized ${planned.length} source${planned.length === 1 ? "" : "s"} into a cited answer.`, planned.map((p) => p.url));
    record.status = "done";
  } else {
    const err: ResearchError = sum.ok ? { code: "empty", message: "The summarizer returned an empty answer." } : { code: sum.code, message: sum.message };
    record.status = "failed";
    record.error = err;
    pushStep("summarize", false, `Summarization failed: ${err.message}`, planned.map((p) => p.url), err);
  }
  record.completedAt = now();
  touch();
  return record;
}

// ---------------------------------------------------------------------------
// Durable store — one file per record, written atomically, corrupt bytes
// quarantined aside (never deleted), bounded list.
// ---------------------------------------------------------------------------

let testResearchDir: string | null = null;

/** Test seam. The IPC layer calls this with the real userData dir at startup. */
export function setResearchUserDataDir(dir: string | null): void {
  testResearchDir = dir;
}

function researchDir(): string {
  return testResearchDir ?? path.join(app.getPath("userData"), "ai", "research");
}

function recordPath(id: string): string {
  return path.join(researchDir(), `${id}.json`);
}

function ensure(): void {
  fs.mkdirSync(researchDir(), { recursive: true });
}

function coerceString(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

const STATUSES: readonly ResearchStatus[] = ["queued", "running", "done", "failed", "refused"];

function sanitizeRecord(input: unknown): ResearchRecord | null {
  if (!input || typeof input !== "object") return null;
  const r = input as Record<string, unknown>;
  const id = coerceString(r.id, 64);
  if (!/^[a-z0-9-]{1,64}$/i.test(id)) return null;
  const permission = r.permission === "allow" || r.permission === "deny" ? (r.permission as ResearchPermissionMode) : "ask";
  const createdAt = typeof r.createdAt === "number" && Number.isFinite(r.createdAt) ? r.createdAt : Date.now();
  const updatedAt = typeof r.updatedAt === "number" && Number.isFinite(r.updatedAt) ? r.updatedAt : createdAt;
  const sources = Array.isArray(r.sources)
    ? r.sources
        .filter((s): s is ResearchSource => !!s && typeof s === "object")
        .slice(0, MAX_SOURCES)
        .map((s) => {
          const src = s as unknown as Record<string, unknown>;
          const url = coerceString(src.url, 2000);
          return {
            url,
            title: coerceString(src.title, 300) || hostOf(url) || "(untitled)",
            kind: src.kind === "docs" ? ("docs" as const) : ("search" as const),
            triedAt: typeof src.triedAt === "number" ? src.triedAt : createdAt,
            status: src.status === "failed" ? ("failed" as const) : src.status === "ok" ? ("ok" as const) : ("pending" as const),
            ...(typeof src.fetchedAt === "number" ? { fetchedAt: src.fetchedAt } : {}),
            ...(typeof src.snippet === "string" && src.snippet ? { snippet: src.snippet.slice(0, 600) } : {}),
            ...(src.error && typeof src.error === "object"
              ? { error: { code: coerceString((src.error as Record<string, unknown>).code, 40) as ResearchFailureCode, message: coerceString((src.error as Record<string, unknown>).message, 1000) } }
              : {}),
          } as ResearchSource;
        })
    : [];
  const steps = Array.isArray(r.steps)
    ? r.steps
        .filter((s): s is ResearchStep => !!s && typeof s === "object")
        .slice(-MAX_STEPS)
        .map((s) => {
          const st = s as unknown as Record<string, unknown>;
          const kind = typeof st.kind === "string" && ["queries", "search", "fetch", "summarize"].includes(st.kind) ? (st.kind as ResearchStepKind) : "search";
          return {
            kind,
            at: typeof st.at === "number" ? st.at : createdAt,
            ok: st.ok === true,
            detail: coerceString(st.detail, 500),
            urls: Array.isArray(st.urls) ? st.urls.filter((u): u is string => typeof u === "string").slice(0, 20) : [],
            ...(st.error && typeof st.error === "object"
              ? { error: { code: coerceString((st.error as Record<string, unknown>).code, 40) as ResearchFailureCode, message: coerceString((st.error as Record<string, unknown>).message, 1000) } }
              : {}),
          } as ResearchStep;
        })
    : [];

  const error =
    r.error && typeof r.error === "object"
      ? { code: coerceString((r.error as Record<string, unknown>).code, 40) as ResearchFailureCode, message: coerceString((r.error as Record<string, unknown>).message, 1000) }
      : undefined;

  return {
    id,
    question: coerceString(r.question, MAX_QUESTION),
    focusUrls: Array.isArray(r.focusUrls) ? r.focusUrls.filter((u): u is string => typeof u === "string").slice(0, MAX_FOCUS_URLS) : [],
    status: STATUSES.includes(r.status as ResearchStatus) ? (r.status as ResearchStatus) : "queued",
    permission,
    awaitingApproval: r.awaitingApproval === true,
    steps,
    sources,
    answer: coerceString(r.answer, MAX_ANSWER_CHARS),
    ...(error ? { error } : {}),
    createdAt,
    updatedAt,
    ...(typeof r.completedAt === "number" && Number.isFinite(r.completedAt) ? { completedAt: r.completedAt } : {}),
    budget: {
      queries: typeof (r.budget as Record<string, unknown> | undefined)?.queries === "number" ? Number((r.budget as Record<string, unknown>).queries) : MAX_QUERIES,
      fetches: typeof (r.budget as Record<string, unknown> | undefined)?.fetches === "number" ? Number((r.budget as Record<string, unknown>).fetches) : MAX_FETCHES,
      corpusChars: typeof (r.budget as Record<string, unknown> | undefined)?.corpusChars === "number" ? Number((r.budget as Record<string, unknown>).corpusChars) : MAX_CORPUS_CHARS,
      answerChars: typeof (r.budget as Record<string, unknown> | undefined)?.answerChars === "number" ? Number((r.budget as Record<string, unknown>).answerChars) : MAX_ANSWER_CHARS,
    },
  };
}

export function createResearchRecord(
  question: string,
  focusUrls: string[],
  permission: ResearchPermissionMode,
  now: number,
): ResearchRecord {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const u of focusUrls) {
    const norm = normalizeResearchUrl(u);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    unique.push(u);
    if (unique.length >= MAX_FOCUS_URLS) break;
  }
  return {
    id: `res-${crypto.randomBytes(5).toString("hex")}`,
    question: typeof question === "string" ? question.trim().slice(0, MAX_QUESTION) : "",
    focusUrls: unique,
    status: "queued",
    permission,
    awaitingApproval: false,
    steps: [],
    sources: [],
    answer: "",
    createdAt: now,
    updatedAt: now,
    budget: defaultBudget(),
  };
}

export function listResearchRecords(): ResearchRecord[] {
  try {
    ensure();
    const out: ResearchRecord[] = [];
    for (const name of fs.readdirSync(researchDir())) {
      if (!name.endsWith(".json")) continue;
      try {
        const rec = sanitizeRecord(JSON.parse(fs.readFileSync(path.join(researchDir(), name), "utf-8")));
        if (rec) out.push(rec);
      } catch {
        // a torn record does not take the whole list down
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_RECORDS);
  } catch {
    return [];
  }
}

export function getResearchRecord(id: string): ResearchRecord | null {
  const clean = coerceString(id, 64);
  if (!/^[a-z0-9-]{1,64}$/i.test(clean)) return null;
  try {
    const p = recordPath(clean);
    if (!fs.existsSync(p)) return null;
    return sanitizeRecord(JSON.parse(fs.readFileSync(p, "utf-8")));
  } catch (err) {
    // Move the corrupt bytes aside — never delete them.
    try {
      const p = recordPath(clean);
      fs.renameSync(p, `${p}.corrupt`);
    } catch {
      // already gone
    }
    return null;
  }
}

export function saveResearchRecord(record: ResearchRecord): boolean {
  try {
    ensure();
    const p = recordPath(record.id);
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), "utf-8");
    if (fs.existsSync(p)) fs.copyFileSync(p, `${p}.bak`);
    fs.renameSync(tmp, p);
    return true;
  } catch {
    return false;
  }
}