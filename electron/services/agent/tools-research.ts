// Close Code — AI Agent Runtime — research tools (Phase 32)
//
// The two tools that let an agent *research* rather than merely fetch:
//
//   * `docs_lookup`  — fetch a documentation URL and return only the sections
//     that mention a topic, so a model does not have to page through a whole
//     manual to answer "what does `parse` take?" It cannot search the page for
//     the model (the page is what it is) — when the topic appears nowhere it
//     says so and returns the page anyway.
//   * `research_start` — run the Phase 32 research pipeline (plan → search →
//     fetch → summarize) in-process and hand the model a cited summary plus
//     its numbered source list. The pipeline is the same main-process service
//     the AI panel's research section drives, so an agent's research appears
//     in the same source-tracked record store the user sees.
//
// Both are `web` category tools: the Phase 22 rule that approving in-workspace
// search is not approving network access applies twice over here, because a
// research pipeline sends the question, planned queries and fetched documents
// to the network. `authorize("web", …)` is the only gate — the same one
// `web_fetch` and `web_search` pass through, so a user who already allows
// those sees research behave identically, and one who denies them gets the
// same refusal before a single request is made.

import { deniedResult, errorResult, okResult } from "./result";
import { fetchCapped, htmlToText, parsePublicUrl } from "./tools-web";
import { normalizeResearchUrl } from "../webResearch";
import type { AgentTool, AgentToolOutcome } from "./types";
import type { ResearchRecord } from "../webResearch";

const DOCS_FETCH_TIMEOUT_MS = 30_000;
const MAX_FETCH_BYTES = 2 * 1024 * 1024;
const MAX_DOCS_CHARS = 60_000;
const MAX_QUESTION = 600;
const MAX_FOCUS_URLS = 5;

/**
 * Keep only the blocks of converted text that mention `topic` (plus the short
 * block before each, which is usually the section heading). When nothing
 * matches, hand back the whole page with the honest note rather than an empty
 * result — a docs page that phrases things differently still answered.
 */
function extractSections(
  text: string,
  topic: string,
  maxChars: number,
): { text: string; sections: number; missing: boolean } {
  const lower = topic.toLowerCase();
  const blocks = text
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
  const kept: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    if (!blocks[i].toLowerCase().includes(lower)) continue;
    if (i > 0 && blocks[i - 1].length < 120) kept.push(blocks[i - 1]);
    kept.push(blocks[i]);
  }
  const joined = kept.join("\n\n");
  const missing = kept.length === 0;
  return {
    text: (missing ? text : joined).slice(0, maxChars),
    sections: kept.length,
    missing,
  };
}

export const docsLookupTool: AgentTool = {
  name: "docs_lookup",
  description:
    "Fetch a documentation URL and return just the sections relevant to a topic. " +
    "Pass the doc page's URL and a topic; the page is fetched, converted to text, and only " +
    "the paragraphs mentioning the topic (with their headings) are returned. This saves a model " +
    "from reading an entire manual when it needs one paragraph. If the topic is not found the tool " +
    "says so and returns the whole page. Use `raw: true` to skip conversion. Sends nothing but the URL.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL of the documentation page.", minLength: 1 },
      topic: { type: "string", description: "The term to look up, e.g. \"parse\" or \"stream: true\". Case-insensitive substring match.", minLength: 1 },
      raw: { type: "boolean", description: "Return the response body unconverted instead of extracting text from HTML.", default: false },
    },
    required: ["url", "topic"],
    additionalProperties: false,
  },
  category: "web",
  capabilities: ["network.fetch"],
  readOnly: true,
  destructive: false,
  async execute(ctx, args): Promise<AgentToolOutcome> {
    if (!(await ctx.authorize("web", args))) return deniedResult();

    const url = String(args.url ?? "").trim();
    const parsed = parsePublicUrl(url);
    if ("refusal" in parsed) {
      return errorResult("invalid_input", parsed.refusal, {
        text: `Error: ${parsed.refusal}`,
        hint: "Pass an absolute http:// or https:// URL.",
      });
    }
    if (ctx.signal.aborted) {
      return errorResult("aborted", "The run was stopped before the request was made.", { text: "Error: the run was stopped." });
    }
    const raw = args.raw === true;
    const topic = typeof args.topic === "string" && args.topic.trim() ? args.topic.trim() : "";

    const res = await fetchCapped(
      parsed.url,
      { method: "GET", headers: { accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.5" } },
      ctx.signal,
      DOCS_FETCH_TIMEOUT_MS,
      MAX_FETCH_BYTES,
    );
    if (!res.ok) {
      return errorResult(
        res.status && res.status >= 500 ? "unavailable" : "tool_failed",
        `${parsed.url.href} could not be fetched: ${res.reason}`,
        {
          text: `Error: could not fetch ${parsed.url.href} — ${res.reason}.`,
          ...(res.status ? { hint: `The server answered HTTP ${res.status}.` } : { hint: "Check the URL and the network connection." }),
        },
      );
    }
    if (res.status >= 400) {
      return errorResult("unavailable", `The documentation server answered HTTP ${res.status}.`, {
        text: `Error: ${parsed.url.href} answered HTTP ${res.status}.`,
      });
    }

    const isHtml = /text\/html|application\/xhtml/i.test(res.contentType) || /^\s*<(!doctype|html)/i.test(res.body);
    const text = raw || !isHtml ? res.body : htmlToText(res.body);
    const clipped = text.slice(0, MAX_DOCS_CHARS);

    if (raw || !isHtml || !topic) {
      const body = clipped.slice(0, ctx.maxOutputChars);
      return okResult(body, {
        data: { url: parsed.url.href, status: res.status, bytes: res.body.length, converted: false, ...(topic ? { topic } : {}) },
        meta: { bytes: body.length, count: 1, truncated: clipped.length > ctx.maxOutputChars },
      });
    }

    const sect = extractSections(clipped, topic, MAX_DOCS_CHARS);
    const body = sect.missing
      ? `NOTE: no section of this page mentions "${topic}" — the full converted page follows.\n\n${sect.text}`
      : sect.text;
    return okResult(body.slice(0, ctx.maxOutputChars), {
      data: { url: parsed.url.href, status: res.status, bytes: res.body.length, converted: true, topic, sections: sect.sections, matched: !sect.missing },
      meta: { bytes: body.length, count: sect.missing ? 1 : sect.sections, truncated: body.length > ctx.maxOutputChars || res.truncated },
    });
  },
};

/** The answer plus its sources, numbered exactly as the summarizer saw them. */
function researchSummaryText(record: ResearchRecord): string {
  const fetched = record.sources
    .filter((s) => s.fetchedAt !== undefined)
    .sort((a, b) => (a.fetchedAt ?? 0) - (b.fetchedAt ?? 0));
  const lines = [`RESEARCH: ${record.question}`, "", record.answer, "", "Sources:"];
  fetched.forEach((s, i) => lines.push(`[${i + 1}] ${s.title} — ${s.url}`));
  return lines.join("\n");
}

export const researchStartTool: AgentTool = {
  name: "research_start",
  description:
    "Run a bounded web research task on a question and return a cited summary with its sources. " +
    "The pipeline plans search queries, searches the web, fetches the promising documents, and summarizes " +
    "them with per-fact citations like [1]. Requires the web permission category. With no search key configured " +
    "it still works by fetching the URLs you name in focus_urls directly. The full source-tracked record is kept " +
    "in the same research store the AI panel shows.",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "The research question to answer from external sources.", minLength: 1 },
      focus_urls: {
        type: "array",
        items: { type: "string" },
        description: "Optional absolute http(s) URLs to fetch directly, without searching for them first.",
      },
    },
    required: ["question"],
    additionalProperties: false,
  },
  category: "web",
  capabilities: ["network.search", "network.fetch"],
  readOnly: true,
  destructive: false,
  async execute(ctx, args): Promise<AgentToolOutcome> {
    if (!(await ctx.authorize("web", args))) return deniedResult();

    const question = String(args.question ?? "").trim();
    if (!question) {
      return errorResult("invalid_input", "A research question is required.", {
        text: "Error: research_start needs a non-empty question.",
        hint: "Pass the research question as `question`.",
      });
    }
    if (question.length > MAX_QUESTION) {
      return errorResult("invalid_input", `The research question is too long (max ${MAX_QUESTION} characters).`, {
        text: "Error: the research question is too long.",
      });
    }
    const focusUrls = Array.isArray(args.focus_urls)
      ? args.focus_urls.filter((u): u is string => typeof u === "string").slice(0, MAX_FOCUS_URLS)
      : [];
    if (focusUrls.some((u) => !normalizeResearchUrl(u))) {
      return errorResult("invalid_input", "focus_urls must be absolute http(s) URLs.", {
        text: "Error: focus_urls entries must be absolute http(s) URLs.",
      });
    }
    if (!ctx.research) {
      return errorResult("unavailable", "Research is not available in this context.", {
        text: "Error: research is not available in this context.",
        hint: "The research pipeline is wired into real agent runs only.",
      });
    }

    const record = await ctx.research({ question, focusUrls }, ctx.signal);
    if (record.status === "done" && record.answer) {
      const fetched = record.sources.filter((s) => s.fetchedAt !== undefined);
      return okResult(researchSummaryText(record), {
        data: {
          recordId: record.id,
          question,
          answer: record.answer,
          sources: fetched.map((s) => ({ url: s.url, title: s.title })),
        },
        meta: { count: fetched.length },
      });
    }

    const reason =
      record.error?.message ?? (record.status === "refused" ? "The research was refused." : "The research did not complete.");
    const code =
      record.error?.code === "offline" || record.error?.code === "no_key" || record.status === "refused" ? "unavailable" : "tool_failed";
    return errorResult(code, reason, {
      text: `Error: research did not complete (${record.status}): ${reason}`,
      data: { recordId: record.id, status: record.status, sources: record.sources },
      hint: "The record stays in the research store with its steps and any sources that were gathered.",
    });
  },
};

export const RESEARCH_TOOLS: readonly AgentTool[] = Object.freeze([docsLookupTool, researchStartTool]);