// Close Code — context compaction (Phase 28)
//
// Why this exists
// ---------------
// Two things grow without a ceiling, and both get shipped to a model provider
// verbatim:
//
//   * the history replayed when a session is resumed — Phase 27's
//     `resumeHistory()` hands up to 40 turns to `AgentRunSpec.history`, and each
//     turn may be 4 000 chars, so a long session alone is 160 000 chars;
//   * the message log a run accumulates while it works — Phase 21 capped a
//     single tool result at 20 000 chars and the number of tool calls, but
//     never capped the array those results accumulate into, and a model's own
//     `tool_calls.arguments` are not capped at all (a `write_file` carries the
//     whole file).
//
// Past a context window that is a provider error the user cannot act on, or —
// worse, and quietly — a window that drops the oldest messages for us, which is
// exactly the "compaction silently destroys task state" this phase forbids.
//
// What this module does
// ---------------------
// It compresses a message array that is over budget into one that is under it,
// deterministically, in four moves:
//
//   1. Everything *before the active task* is replaced by an extractive digest:
//      lines copied verbatim from those messages. Nothing is generated and
//      nothing is paraphrased — this runs offline, in the main process, on
//      every oversized request, and a fabricated summary would be a fabricated
//      AI response.
//   2. Messages that are expensive to lose — decisions, unresolved issues, and
//      tool results that were not `ok` — are quoted verbatim inside that digest
//      before anything is summarised away.
//   3. The system prompt and the active task are never touched, and messages
//      *after* the task are clamped oldest-first, each cut carrying a marker
//      that says exactly how much was kept.
//   4. If all of that still does not fit, the result is flagged `overflow`
//      rather than quietly dropping the task or the system prompt.
//
// What it deliberately does not do
// --------------------------------
// It never mutates its input, never writes to disk, and never rewrites a run
// record or a session. The caller keeps the full log and gets a new array for
// the wire. That is what makes "compaction does not silently destroy task
// state" something a test can prove instead of something the report asserts:
// the original is still there afterwards, byte for byte.
//
// The signal lists below are heuristics. They are *selection* heuristics — a
// false positive costs a few hundred characters of budget, a false negative
// costs one line of the digest while the message itself may still be in the
// live window. They have not been measured against a labelled corpus, and the
// report says so.

import type { AgentMessage } from "./types";

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export interface CompactionBudget {
  /**
   * Hard ceiling, in characters, for the payload shipped to the provider.
   *
   * A constant rather than a setting: it is a safety bound, not a preference,
   * and a user-tunable "context limit" would be a knob nobody can reason about
   * across providers. Sized so a fully-loaded resumed session (40 × 4 000 chars)
   * compacts before it is sent, and so a tool-heavy run cannot assemble a
   * payload that only a very large context window would accept.
   */
  maxContextChars: number;
  /** Ceiling for the digest lines that replace the earlier conversation. */
  maxSummaryChars: number;
  /**
   * Ceiling for the verbatim quotes kept inside the digest.
   *
   * Separate from `maxSummaryChars` on purpose: a conversation full of
   * decisions must not be able to crowd out the digest of the rest, and an
   * empty decisions list must not shrink what is preserved.
   */
  maxPreservedChars: number;
  /** Ceiling for one verbatim quote. */
  maxQuoteChars: number;
  /** First (largest) clamp step applied to messages after the active task. */
  maxClampedChars: number;
  /**
   * Messages kept when — and only when — the payload contains no user message
   * at all to treat as the active task. There is then nothing to anchor "what
   * came after", so the tail is what defines it.
   */
  keepTailMessages: number;
}

export const DEFAULT_COMPACTION_BUDGET: CompactionBudget = {
  maxContextChars: 100_000,
  maxSummaryChars: 8_000,
  maxPreservedChars: 12_000,
  maxQuoteChars: 400,
  maxClampedChars: 4_000,
  keepTailMessages: 8,
};

/**
 * The smallest a clamped message is ever taken.
 *
 * The clamp loop halves its cap until it would fall below this, so a payload
 * that cannot fit even fully-clamped messages is reported as `overflow` instead
 * of being chipped at forever.
 */
const MIN_CLAMP_CHARS = 512;

/** Prepended to the head of a cut, so a truncated message says so in-band. */
const CLAMP_MARK = "\n…[truncated for the context budget: kept ";

// ---------------------------------------------------------------------------
// Record
// ---------------------------------------------------------------------------

export type PreservedKind = "decisions" | "issues" | "toolResults";

export interface PreservedCounts {
  decisions: number;
  issues: number;
  toolResults: number;
}

/**
 * What one compaction did, kept on the run so a finished run stays inspectable
 * and pushed over `agent:event` so the panel can say it happened.
 *
 * `digest` is the block that replaced the earlier conversation, verbatim. It is
 * kept rather than summarised away itself for the same reason the run keeps its
 * full message log: what replaced something is part of the record of what
 * happened to it.
 */
export interface CompactionRecord {
  /** When the first pass happened. Carried across later passes of one run. */
  at: number;
  /** How many payloads for this run have been compacted. */
  passes: number;
  /** Step of the latest pass. Absent outside an agent run's step loop. */
  step?: number;
  budgetChars: number;
  beforeChars: number;
  afterChars: number;
  beforeMessages: number;
  afterMessages: number;
  digestChars: number;
  /** Verbatim quotes kept, by kind. */
  kept: PreservedCounts;
  /** Quotes the preservation ceiling would not fit. Never dropped silently. */
  omitted: PreservedCounts;
  /** Digest lines kept, and how many the line budget left out. */
  digestLines: number;
  digestLinesOmitted: number;
  /** Messages whose content (or a model's own tool arguments) was cut. */
  clampedMessages: number;
  /** True when even system + task + clamped payload is over budget. */
  overflow: boolean;
  digest: string;
}

export interface CompactionResult {
  /** The payload to send. Never the input array itself once compacted. */
  messages: AgentMessage[];
  compacted: boolean;
  record: CompactionRecord;
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

/**
 * Phrases that mark a message as carrying a decision.
 *
 * These select, they do not classify: matching is a claim that this line is
 * worth quoting verbatim, not a claim that the message is about decisions.
 */
const DECISION_SOURCES = [
  "decisions?",
  "decided",
  "deciding",
  "chosen",
  "settled on",
  "going with",
  "we will",
  "will use",
  "instead of",
  "rather than",
  "trade-?offs?",
  "rationale",
  "option [ab12]",
];

/** Phrases that mark a message as carrying something still unresolved. */
const ISSUE_SOURCES = [
  "todos?",
  "fixmes?",
  "tbds?",
  "unresolved",
  "open question",
  "not verified",
  "unverified",
  "unproven",
  "blocked",
  "blocking",
  "pending",
  "limitations?",
  "known issues?",
  "test debt",
  "debt",
  "flak(y|es|ed)",
  "caveats?",
  "failed",
  "fails?",
  "failing",
  "not implemented",
  "still broken",
  "does not work",
];

/** Text in a tool result that means the call is worth keeping whole. */
const TOOL_SOURCES = [
  "errors?",
  "failed",
  "failure",
  "denied",
  "refused",
  "not permitted",
  "permission denied",
  "not found",
  "warning",
  "exit code [1-9]",
  "cannot ",
  "unable to",
  "ENOENT",
];

function signalRegExp(sources: string[]): RegExp {
  return new RegExp(`\\b(?:${sources.join("|")})\\b`, "i");
}

// `cannot ` carries a trailing space, so the word boundary above would not do.
const TOOL_RE = new RegExp(`(?:\\b(?:${TOOL_SOURCES.filter((s) => !s.endsWith(" ")).join("|")})\\b|cannot\\s)`, "i");

const DECISION_RE = signalRegExp(DECISION_SOURCES);
const ISSUE_RE = signalRegExp(ISSUE_SOURCES);

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

/** Characters of one message that actually leave the process. */
export function messageChars(message: AgentMessage): number {
  let n = message.content.length;
  if (message.tool_calls) {
    for (const call of message.tool_calls) n += call.arguments.length;
  }
  return n;
}

/** Total characters of a payload, tool-call arguments included. */
export function measureChars(messages: readonly AgentMessage[]): number {
  let total = 0;
  for (const m of messages) total += messageChars(m);
  return total;
}

/**
 * The human-readable form of a tool result.
 *
 * The runtime writes a tool message as `JSON.stringify(outcome.text)`, so its
 * content is one long escaped line. Reading it back is what lets the digest
 * quote a tool result the way a person would read it instead of quoting
 * backslash-n. A result truncated by `TOOL_MESSAGE_CHARS` is not valid JSON, so
 * it falls through to the raw text unchanged.
 */
export function readableContent(message: AgentMessage): string {
  if (message.role !== "tool") return message.content;
  const text = message.content.trim();
  if (!(text.startsWith('"') && text.endsWith('"'))) return message.content;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "string" ? parsed : message.content;
  } catch {
    return message.content;
  }
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

interface PreservedItem {
  kind: PreservedKind;
  /** The tool a `toolResults` quote came from, so the quote can be named. */
  tool?: string;
  quote: string;
}

/** Anything that can tell us whether a message was important. */
export interface SalienceSource {
  has(message: AgentMessage): boolean;
}

function firstMatch(re: RegExp, text: string): number {
  const exec = new RegExp(re.source, re.flags).exec(text);
  return exec ? exec.index : -1;
}

/**
 * Cut a window around `at` that is verbatim, bounded, and honest about being a
 * window — the leading/trailing ellipses are the only characters added, and the
 * tests strip them before checking the rest against the original.
 */
function quoteAround(text: string, at: number, max: number): string {
  const start = Math.max(0, at - 60);
  const slice = text.slice(start, start + max);
  const head = start > 0 ? "…" : "";
  const tail = start + max < text.length ? "…" : "";
  return `${head}${slice}${tail}`;
}

/**
 * Walk the conversation and take out everything marked worth keeping whole.
 *
 * Scanned oldest first, one quote per signal per message, until the
 * preservation ceiling is reached — the remainder is counted as `omitted`, not
 * discarded. Chronological order is deliberate: if the ceiling does bind, it is
 * the earliest decisions (the ones the rest of the conversation rests on) that
 * survive, and the newest are the ones the live window still has.
 */
function collectPreserved(
  messages: readonly AgentMessage[],
  salient: SalienceSource | undefined,
  budget: CompactionBudget,
): { items: PreservedItem[]; kept: PreservedCounts; omitted: PreservedCounts } {
  const items: PreservedItem[] = [];
  const kept: PreservedCounts = { decisions: 0, issues: 0, toolResults: 0 };
  const omitted: PreservedCounts = { decisions: 0, issues: 0, toolResults: 0 };
  let used = 0;

  const add = (kind: PreservedKind, item: PreservedItem): void => {
    const cost = item.quote.length + (item.tool ? item.tool.length + 4 : 0);
    if (used + cost > budget.maxPreservedChars) {
      omitted[kind] += 1;
      return;
    }
    used += cost;
    kept[kind] += 1;
    items.push(item);
  };

  for (const message of messages) {
    if (message.role === "system") continue;
    const text = readableContent(message);

    if (message.role === "tool") {
      const named = salient?.has(message) === true || TOOL_RE.test(text);
      if (!named) continue;
      const at = firstMatch(TOOL_RE, text);
      add("toolResults", {
        kind: "toolResults",
        ...(message.name ? { tool: message.name } : {}),
        quote: at < 0 ? text.slice(0, budget.maxQuoteChars) : quoteAround(text, at, budget.maxQuoteChars),
      });
      continue;
    }

    const decisionAt = firstMatch(DECISION_RE, text);
    if (decisionAt >= 0) {
      add("decisions", { kind: "decisions", quote: quoteAround(text, decisionAt, budget.maxQuoteChars) });
    }
    const issueAt = firstMatch(ISSUE_RE, text);
    if (issueAt >= 0) {
      add("issues", { kind: "issues", quote: quoteAround(text, issueAt, budget.maxQuoteChars) });
    }
  }

  return { items, kept, omitted };
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

/**
 * One digest line.
 *
 * `role | text` with the text taken from the message itself: the label is the
 * only invented part, which is why the extractive test checks everything after
 * the pipe rather than the whole line.
 */
function digestLine(message: AgentMessage, index: number, total: number): string {
  const text = readableContent(message).trim().split("\n")[0] ?? "";
  const clipped = text.length > 220 ? `${text.slice(0, 219)}…` : text;
  if (clipped) return `[${index}/${total}] ${message.role} | ${clipped}`;
  if (message.tool_calls && message.tool_calls.length > 0) {
    const call = message.tool_calls[0];
    const args = call.arguments.length > 80 ? `${call.arguments.slice(0, 79)}…` : call.arguments;
    return `[${index}/${total}] ${message.role} | ${call.name}(${args})`;
  }
  return "";
}

/**
 * Build the block that replaces the earlier conversation.
 *
 * Both ends of the digest are kept when the line budget cannot hold all of it:
 * the opening of a conversation is where the original ask lives, the end is
 * where it was heading, and the middle is the part a summary is allowed to
 * lose. Whatever is left out is counted in the record.
 */
function buildDigest(
  history: readonly AgentMessage[],
  preserved: { items: PreservedItem[]; kept: PreservedCounts; omitted: PreservedCounts },
  budget: CompactionBudget,
  beforeChars: number,
  beforeMessages: number,
): { text: string; lines: number; linesOmitted: number } {
  const informative = history.filter((m) => m.content.trim().length > 0 || (m.tool_calls?.length ?? 0) > 0);
  const lines = informative.map((m, i) => digestLine(m, i + 1, informative.length));

  // Both ends of the digest are kept when the line budget cannot hold it all:
  // the opening of a conversation is where the original ask lives, the end is
  // where it was heading, and the middle is the part a summary is allowed to
  // lose. If everything already fits, nothing is dropped at all.
  let body: string[];
  let omittedLines = 0;
  let keptLines = lines.length;
  const totalChars = lines.reduce((sum, l) => sum + l.length, 0);
  if (totalChars <= budget.maxSummaryChars) {
    body = [...lines];
  } else {
    let headChars = 0;
    let a = 0;
    const headBudget = Math.floor(budget.maxSummaryChars * 0.4);
    while (a < lines.length && headChars + lines[a].length <= headBudget) {
      headChars += lines[a].length;
      a += 1;
    }
    let tailChars = 0;
    let b = lines.length;
    const tailBudget = budget.maxSummaryChars - headBudget;
    while (b > a && tailChars + lines[b - 1].length <= tailBudget) {
      b -= 1;
      tailChars += lines[b].length;
    }
    omittedLines = b - a;
    keptLines = a + (lines.length - b);
    body = lines.slice(0, a);
    if (omittedLines > 0) body.push(`… ${omittedLines} message(s) omitted from this digest …`);
    body.push(...lines.slice(b));
  }

  const out: string[] = [];
  out.push(
    `=== CONTEXT COMPACTION (extractive, deterministic) ===`,
    `The conversation was ${beforeChars} characters across ${beforeMessages} messages, over the ` +
      `${budget.maxContextChars}-character budget for one request. Everything below is copied verbatim ` +
      `from those messages; nothing here was generated or paraphrased.`,
  );

  const section = (title: string, items: PreservedItem[]): void => {
    if (items.length === 0) return;
    out.push("", `## ${title}`);
    for (const item of items) {
      out.push(item.tool ? `- [${item.tool}] ${item.quote}` : `- ${item.quote}`);
    }
  };

  section(`Decisions kept verbatim (${preserved.kept.decisions})`, preserved.items.filter((i) => i.kind === "decisions"));
  section(`Unresolved issues kept verbatim (${preserved.kept.issues})`, preserved.items.filter((i) => i.kind === "issues"));
  section(`Important tool results kept verbatim (${preserved.kept.toolResults})`, preserved.items.filter((i) => i.kind === "toolResults"));

  if (body.length > 0) {
    out.push("", `## Digest of the earlier conversation, oldest first (${body.length} line(s))`, ...body);
  }

  out.push(
    "",
    `=== END CONTEXT COMPACTION (${beforeChars} chars across ${beforeMessages} messages reduced to the block above) ===`,
  );

  return {
    text: out.join("\n"),
    lines: keptLines,
    linesOmitted: omittedLines,
  };
}

// ---------------------------------------------------------------------------
// Clamping
// ---------------------------------------------------------------------------

/** A copy of `message` with its content (and its own tool arguments) cut. */
function clampMessage(message: AgentMessage, cap: number): AgentMessage {
  const next: AgentMessage = { ...message };
  if (next.content.length > cap) {
    next.content =
      `${next.content.slice(0, cap)}${CLAMP_MARK}${cap} of ${next.content.length} chars]`;
  }
  if (next.tool_calls && next.tool_calls.length > 0) {
    let touched = false;
    const calls = next.tool_calls.map((call) => {
      if (call.arguments.length <= cap) return call;
      touched = true;
      return { ...call, arguments: `${call.arguments.slice(0, cap)}…[truncated for the context budget]` };
    });
    if (touched) next.tool_calls = calls;
  }
  return next;
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

export interface CompactionOptions {
  budget?: Partial<CompactionBudget>;
  /**
   * Messages the caller already knows are important — the runtime marks every
   * tool result whose status was not `ok`, which is ground truth rather than
   * the text heuristic above, and it is the one signal that survives a result
   * whose wording does not happen to contain the word "error".
   */
  salient?: SalienceSource;
  now?: () => number;
}

/**
 * Compress an oversized payload. Returns the input untouched when it fits.
 *
 * The four stages are in the file header. The one thing worth knowing here is
 * the order: the digest is built *before* clamping, because its size is part of
 * what the clamp loop has to make room for, and the clamp loop goes
 * oldest-first because the newest messages are the ones the model is in the
 * middle of using.
 */
export function compactMessages(
  input: readonly AgentMessage[],
  options: CompactionOptions = {},
): CompactionResult {
  const budget: CompactionBudget = { ...DEFAULT_COMPACTION_BUDGET, ...(options.budget ?? {}) };
  const now = options.now ? options.now() : Date.now();

  const beforeChars = measureChars(input);
  const beforeMessages = input.length;
  const blank = (): CompactionRecord => ({
    at: now,
    passes: 1,
    budgetChars: budget.maxContextChars,
    beforeChars,
    afterChars: beforeChars,
    beforeMessages,
    afterMessages: beforeMessages,
    digestChars: 0,
    kept: { decisions: 0, issues: 0, toolResults: 0 },
    omitted: { decisions: 0, issues: 0, toolResults: 0 },
    digestLines: 0,
    digestLinesOmitted: 0,
    clampedMessages: 0,
    overflow: false,
    digest: "",
  });

  if (beforeChars <= budget.maxContextChars) {
    return { messages: [...input], compacted: false, record: blank() };
  }

  // --- 1. split the system prompt off, find the active task -----------------
  let head = 0;
  while (head < input.length && input[head].role === "system") head += 1;
  const systemHead = input.slice(0, head);
  const body = input.slice(head);

  let taskAt = -1;
  for (let i = body.length - 1; i >= 0; i -= 1) {
    if (body[i].role === "user") {
      taskAt = i;
      break;
    }
  }

  let history: readonly AgentMessage[];
  let task: AgentMessage | null;
  let live: readonly AgentMessage[];
  if (taskAt >= 0) {
    history = body.slice(0, taskAt);
    task = body[taskAt];
    live = body.slice(taskAt + 1);
  } else {
    // No user message to anchor on: keep a tail verbatim rather than summarise
    // the entire payload into itself.
    const keep = Math.min(budget.keepTailMessages, body.length);
    history = body.slice(0, body.length - keep);
    task = null;
    live = body.slice(body.length - keep);
  }

  // --- 2. preserve what is expensive to lose, then digest the rest ----------
  const preserved = collectPreserved([...history, ...live], options.salient, budget);
  // A digest exists to stand where messages were *removed*. Nothing was removed
  // and nothing was quoted whole only when every message is still going out in
  // the live window — stamping a header-and-footer block into the system prompt
  // then would be noise, so it is skipped. (Removed-but-not-quoted history is
  // never skipped: dropping it without a trace is the silent loss this phase is
  // built to forbid.)
  const needDigest = history.length > 0 || preserved.items.length > 0;
  const digest = needDigest
    ? buildDigest(history, preserved, budget, beforeChars, beforeMessages)
    : { text: "", lines: 0, linesOmitted: 0 };

  const headMessages: AgentMessage[] = [];
  if (needDigest) {
    if (systemHead.length > 0) {
      headMessages.push(
        { ...systemHead[0], content: `${systemHead[0].content}\n\n${digest.text}` },
        ...systemHead.slice(1),
      );
    } else {
      // There is no system message to merge into (the plain chat path only has
      // one when the user shared context), so one is created. The chat path
      // folds system messages into its own prompt, and the agent path already
      // always has one.
      headMessages.push({ role: "system" as const, content: digest.text });
    }
  } else {
    headMessages.push(...systemHead);
  }
  if (task) headMessages.push(task);
  let headChars = measureChars(headMessages);
  let liveChars = measureChars(live);
  let liveOut: AgentMessage[] = [...live];

  // --- 3. clamp the live window, oldest first -------------------------------
  let clamped = 0;
  let cap = budget.maxClampedChars;
  while (headChars + liveChars > budget.maxContextChars && cap >= MIN_CLAMP_CHARS) {
    for (let i = 0; i < liveOut.length && headChars + liveChars > budget.maxContextChars; i += 1) {
      const message = liveOut[i];
      const size = messageChars(message);
      if (size <= cap) continue;
      const next = clampMessage(message, cap);
      liveChars += messageChars(next) - size;
      liveOut[i] = next;
      clamped += 1;
    }
    cap = Math.floor(cap / 2);
  }

  const messages = [...headMessages, ...liveOut];
  const afterChars = measureChars(messages);

  return {
    messages,
    compacted: true,
    record: {
      at: now,
      passes: 1,
      budgetChars: budget.maxContextChars,
      beforeChars,
      afterChars,
      beforeMessages,
      afterMessages: messages.length,
      digestChars: digest.text.length,
      kept: preserved.kept,
      omitted: preserved.omitted,
      digestLines: digest.lines,
      digestLinesOmitted: digest.linesOmitted,
      clampedMessages: clamped,
      overflow: afterChars > budget.maxContextChars,
      digest: digest.text,
    },
  };
}
