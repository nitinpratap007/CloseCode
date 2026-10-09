// Close Code — AI Agent Runtime — network tools (Phase 22)
//
// These are the first tools in the runtime that send anything off the machine,
// which is why they carry their own permission category (`web`) rather than
// borrowing `search`. A user who has allowed in-workspace search has not agreed
// to let an agent post workspace contents to an arbitrary URL, and the category
// split is what makes that distinction visible in the settings UI.
//
// Two rules hold throughout this file:
//
//   1. **No fabricated results.** `web_search` needs a real API key. Without one
//      it returns a typed `unavailable` error explaining where to get a key. It
//      does not fall back to a canned answer, a scraped search page, or a
//      summary of the model's own knowledge dressed up as a lookup.
//   2. **Nothing is sent that the model did not put in the request.** Neither
//      tool reads the workspace on its own. `web_fetch` sends only its `url`.
//      The model has to explicitly pass content, and doing so is visible in the
//      approval prompt and the run trace.
//
// No HTTP client dependency: Node's built-in `fetch` is used, which is why this
// phase adds nothing to `package.json`.

import { deniedResult, errorResult, okResult } from "./result";
import type { AgentTool, AgentToolOutcome } from "./types";

/**
 * The search backend. Brave Search is a plain REST API over `fetch` — no SDK, no
 * dependency — and it returns real web results with real URLs.
 *
 * The key is not invented, stubbed or defaulted. It reaches the tool through
 * `ctx.webSearch`, which the process wiring fills from the same encrypted
 * main-process key store the AI provider keys already use, so it is never
 * written to disk in plain text and never crosses to the renderer.
 */

const DEFAULT_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

/** Ceilings. A model that asks for a whole book should get a useful refusal. */
const MAX_FETCH_BYTES = 2 * 1024 * 1024;
const MAX_HTML_TEXT = 400_000;
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_SEARCH_TIMEOUT_MS = 20_000;

/**
 * Refuse non-http(s) schemes before any request is made.
 *
 * Without this, `file:///…` would hand a tool the ability to read the user's
 * disk through a URL, bypassing workspace confinement entirely — and
 * `http://127.0.0.1:…` would let a model reach services on the user's machine
 * that the `browser` category would otherwise have to approve.
 */
export function parsePublicUrl(raw: string): { url: URL } | { refusal: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { refusal: `"${raw}" is not a valid URL.` };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { refusal: `Only http and https URLs are supported, not ${url.protocol.replace(":", "")}.` };
  }
  return { url };
}

/** Fetch with a timeout and a byte ceiling, using the run's own abort signal. */
interface FetchOk {
  ok: true;
  status: number;
  body: string;
  contentType: string;
  /** The body hit `maxBytes` and was cut short. Never reported as a whole document. */
  truncated: boolean;
}

export async function fetchCapped(
  url: URL,
  init: RequestInit,
  signal: AbortSignal,
  timeoutMs: number,
  maxBytes: number,
): Promise<FetchOk | { ok: false; reason: string; status?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === "function") timer.unref();
  // Both signals abort the same request: the run's own Stop, and this ceiling.
  const onRunAbort = (): void => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", onRunAbort, { once: true });

  try {
    const res = await fetch(url, { ...init, signal: controller.signal, redirect: "follow" });
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > maxBytes) {
      return { ok: false, reason: `the response declares ${declared} bytes, over the ${maxBytes} limit`, status: res.status };
    }
    const contentType = res.headers.get("content-type") ?? "";
    const reader = res.body?.getReader();
    if (!reader) {
      const text = await res.text();
      return { ok: true, status: res.status, body: text.slice(0, maxBytes), contentType, truncated: text.length > maxBytes };
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // Stop reading rather than buffering an unbounded body into the main
        // process, and record that this happened instead of pretending the
        // document ended here.
        await reader.cancel().catch(() => undefined);
        truncated = true;
        break;
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(Math.min(total, maxBytes));
    let offset = 0;
    for (const c of chunks) {
      if (offset >= merged.length) break;
      merged.set(c.subarray(0, merged.length - offset), offset);
      offset += c.byteLength;
    }
    const body = new TextDecoder("utf-8", { fatal: false }).decode(merged);
    return { ok: true, status: res.status, body, contentType, truncated };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "AbortError" || name === "TimeoutError") {
      return { ok: false, reason: signal.aborted ? "the run was stopped" : `the request exceeded ${Math.round(timeoutMs / 1000)}s` };
    }
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onRunAbort);
  }
}

export const webFetchTool: AgentTool = {
  name: "web_fetch",
  description:
    "Fetch a public http(s) URL and return its contents as text. HTML pages are reduced to readable text. " +
    "Use this to read documentation or a page the user names. It sends nothing but the URL.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL.", minLength: 1 },
      raw: {
        type: "boolean",
        description: "Return the response body unconverted instead of extracting text from HTML.",
        default: false,
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
  category: "web",
  capabilities: ["network.fetch"],
  readOnly: true,
  destructive: false,
  async execute(ctx, args): Promise<AgentToolOutcome> {
    if (!(await ctx.authorize("web", args))) return deniedResult();

    const raw = String(args.url ?? "").trim();
    const parsed = parsePublicUrl(raw);
    if ("refusal" in parsed) {
      return errorResult("invalid_input", parsed.refusal, {
        text: `Error: ${parsed.refusal}`,
        hint: "Pass an absolute http:// or https:// URL.",
      });
    }
    if (ctx.signal.aborted) {
      return errorResult("aborted", "The run was stopped before the request was made.", { text: "Error: the run was stopped." });
    }

    const res = await fetchCapped(
      parsed.url,
      { method: "GET", headers: { accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.5" } },
      ctx.signal,
      DEFAULT_FETCH_TIMEOUT_MS,
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

    const isHtml = /text\/html|application\/xhtml/i.test(res.contentType) || /^\s*<(!doctype|html)/i.test(res.body);
    if (!isHtml || args.raw === true) {
      return okResult(res.body.slice(0, ctx.maxOutputChars), {
        data: { url: parsed.url.href, status: res.status, contentType: res.contentType, bytes: res.body.length, converted: false },
        meta: { bytes: res.body.length, count: 1, truncated: res.body.length > ctx.maxOutputChars },
      });
    }

    const text = htmlToText(res.body).slice(0, MAX_HTML_TEXT);
    return okResult(text.slice(0, ctx.maxOutputChars), {
      data: { url: parsed.url.href, status: res.status, contentType: res.contentType, bytes: res.body.length, converted: true },
      meta: { bytes: text.length, count: 1, truncated: res.body.length > ctx.maxOutputChars || text.length > ctx.maxOutputChars },
    });
  },
};

/**
 * Strip markup down to readable text.
 *
 * Deliberately simple: scripts, styles and comments go, block tags become
 * newlines, and everything else is decoded. It is not a parser and does not
 * pretend to be one — the tool reports that it converted the page, and the model
 * is told to use `raw: true` when it needs the actual markup.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|pre|blockquote|table|ul|ol|dl)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface BraveResult {
  title?: string;
  url?: string;
  description?: string;
}

/**
 * `web_search` — real web results from the Brave Search API.
 *
 * Without a configured key this tool returns a typed `unavailable` failure and
 * says exactly where to add one. It never returns invented results, and it never
 * falls back to scraping a search engine's HTML: that would break on the first
 * markup change and, worse, would look like a working search while quietly
 * returning whatever the first page happened to contain.
 */
export const webSearchTool: AgentTool = {
  name: "web_search",
  description:
    "Search the public web and return real result titles, URLs and snippets. Requires a configured search API key " +
    "in AI settings. Use this when the answer depends on current information or on a specific library's current API.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query.", minLength: 1 },
      count: { type: "integer", description: "How many results to return.", minimum: 1, maximum: 20, default: 8 },
    },
    required: ["query"],
    additionalProperties: false,
  },
  category: "web",
  capabilities: ["network.search"],
  readOnly: true,
  destructive: false,
  async execute(ctx, args): Promise<AgentToolOutcome> {
    if (!(await ctx.authorize("web", args))) return deniedResult();

    const cfg = ctx.webSearch;
    const key = cfg?.apiKey ?? null;
    if (!key) {
      return errorResult("unavailable", "No web search API key is configured.", {
        text:
          "Error: web_search needs a search API key, and none is configured. " +
          "No results were returned — this tool does not guess.",
        hint: "Add a Brave Search API key in the AI panel's configuration section, then try again.",
      });
    }

    const query = String(args.query ?? "").trim();
    const count = typeof args.count === "number" ? args.count : 8;
    const endpoint = new URL(cfg?.endpoint ?? DEFAULT_SEARCH_ENDPOINT);
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("count", String(count));

    const res = await fetchCapped(
      endpoint,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          // Brave authenticates with the key in a header, never in the query
          // string, so it cannot end up in a proxy log or a URL the model echoes.
          "x-subscription-token": key,
        },
      },
      ctx.signal,
      DEFAULT_SEARCH_TIMEOUT_MS,
      MAX_FETCH_BYTES,
    );
    if (!res.ok) {
      return errorResult("unavailable", `The search request failed: ${res.reason}`, {
        text: `Error: the web search request failed — ${res.reason}.`,
        hint: res.status === 401 || res.status === 403
          ? "The search API key was rejected. Check it in AI settings."
          : "The search service may be unavailable or rate limiting. Try again shortly.",
      });
    }
    if (res.status === 401 || res.status === 403) {
      return errorResult("unavailable", "The search API key was rejected.", {
        text: `Error: the search service rejected the API key (HTTP ${res.status}). No results were returned.`,
        hint: "Check the search API key in AI settings.",
      });
    }
    if (res.status === 429) {
      return errorResult("unavailable", "The search service is rate limiting this key.", {
        text: "Error: the search service is rate limiting this key. No results were returned.",
        hint: "Wait before retrying, or reduce how often the agent searches.",
      });
    }
    if (res.status >= 400) {
      return errorResult("unavailable", `The search service rejected the request (HTTP ${res.status}).`, {
        text: `Error: the search service rejected the request (HTTP ${res.status}). ${res.body.slice(0, 200)}`,
        hint: "Simplify the query and try again.",
      });
    }

    let parsed: { web?: { results?: BraveResult[] } };
    try {
      parsed = JSON.parse(res.body) as { web?: { results?: BraveResult[] } };
    } catch (err) {
      return errorResult("unavailable", "The search service returned a body that is not JSON.", {
        text: `Error: the search service returned an unreadable response. ${err instanceof Error ? err.message : ""}`,
        hint: "This looks like a service problem rather than a bad query.",
      });
    }

    const results = (parsed.web?.results ?? []).filter((r) => r.url);
    if (!results.length) {
      return okResult(`No web results for "${query}".`, { meta: { count: 0 } });
    }
    const body = results
      .map((r, i) => `${i + 1}. ${r.title ?? "(untitled)"}\n   ${r.url}\n   ${(r.description ?? "").slice(0, 300)}`)
      .join("\n");
    return okResult(body, {
      data: { query, results: results.map((r) => ({ title: r.title, url: r.url, description: r.description })) },
      meta: { count: results.length },
    });
  },
};

export const WEB_TOOLS: readonly AgentTool[] = Object.freeze([webFetchTool, webSearchTool]);
