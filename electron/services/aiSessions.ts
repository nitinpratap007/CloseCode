// Close Code — persistent AI sessions (Phase 27)
//
// Before this module there was no such thing as an AI session. `aiStore.messages`
// lived in renderer memory, `AgentRunSpec.history` had been declared since Phase 21
// and was always `[]`, and the runtime's run records were trimmed out of memory by
// `enforceRetention` and dropped outright by `clearFinished`. Closing Close Code
// destroyed every conversation, and there was no `AGENTS.md`-style file the user
// could point a new session at.
//
// This module owns the durable half. It stores three things a session is made of:
//
//   * conversation — the AI chat turns (`turns`)
//   * agent state   — the runs (`runs`), each with its own conversation, result,
//                     status and context summary
//   * tool history  — per run, the trace of what was called and what came back
//
// WHY ONE FILE PER SESSION, not one file for everything:
//
//   A single `sessions.json` means any interrupted write corrupts every session
//   the user has ever had, and "delete one session" is a read-modify-write of the
//   whole store. One file per session means a torn write can only ever damage the
//   session being written, and a delete is one `unlink`. The cost is a directory
//   listing, which `listSessions` answers from an index and reconciles against.
//
// WHY THIS RUNS IN THE MAIN PROCESS:
//
//   The authoritative conversation and tool history live in `AgentRuntime`, not in
//   the renderer. The renderer's copy is deliberately lossy — capped at 25 runs,
//   120 messages and 200 trace entries each. Persisting from the renderer would
//   persist the lossy projection and call it the truth. The renderer sends what it
//   knows; this module decides what is durable.
//
// SECURITY, stated plainly rather than implied:
//
//   * Secrets are redacted before anything reaches the disk, and the count of
//     redactions is stored and surfaced. A tool that echoed a key into its output
//     would otherwise write that key to disk permanently, and "the file is in my
//     own userData folder" is not a defence against a shared machine or a backup.
//   * Session ids are pattern-checked before they are ever joined to a path. The id
//     arrives over IPC from a renderer, so without that check `../../…` is a path
//     traversal that writes wherever it likes.
//   * Nothing is uploaded anywhere. No workspace file contents are copied in; only
//     paths and excerpts the agent already had in context.
//
//   There is deliberately **no encryption at rest**. A key stored in the same
//   `userData` folder as the data it encrypts is not protection, it is a longer
//   filename — real encryption needs an OS keychain, which this machine does not
//   give us. What is actually provided is OS file permissions, redaction of
//   secret-shaped text, and hard size caps.

import fs from "fs";
import path from "path";
import { app } from "electron";
import type { AgentStatus, AgentTraceEntry, ContextSummary } from "./agent/types";

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

/** One turn of the AI chat conversation. */
export interface SessionTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: number;
}

/** The persisted projection of one agent run. */
export interface SessionRunRef {
  id: string;
  agentId: string;
  task: string;
  status: AgentStatus;
  steps: number;
  toolCalls: number;
  createdAt: number;
  updatedAt: number;
  parentRunId: string | null;
  depth: number;
  /** The run's final answer. This is what a resume replays as prior context. */
  resultText: string;
  error?: string;
  /** Tool history, oldest first, bounded by `MAX_TOOL_ENTRIES_PER_RUN`. */
  tools: AgentTraceEntry[];
  /** What context this run was given (summary only — never the payload). */
  contextChars?: number;
  contextStatus?: ContextSummary["status"];
}

export interface AgentSession {
  /** Schema version, so a future migration can tell old files from new ones. */
  version: number;
  id: string;
  name: string;
  workspace: string | null;
  createdAt: number;
  updatedAt: number;
  status: "open" | "closed";
  /** Set when this session was produced by `forkSession`. */
  forkedFrom: string | null;
  /** The AI chat conversation. */
  turns: SessionTurn[];
  /** Agent runs, newest first. */
  runs: SessionRunRef[];
  /** How many secret-shaped strings were redacted before writing. Cumulative. */
  redactions: number;
  /** True when a bound forced something to be dropped. Never set silently. */
  truncated: boolean;
}

/** The cheap projection `listSessions` returns. */
export interface SessionSummary {
  id: string;
  name: string;
  workspace: string | null;
  createdAt: number;
  updatedAt: number;
  status: "open" | "closed";
  forkedFrom: string | null;
  turnCount: number;
  runCount: number;
  toolCallCount: number;
  bytes: number;
  redactions: number;
  truncated: boolean;
  /**
   * True when the file on disk could not be read back as a session. The bytes are
   * moved aside, not deleted — see `quarantine`.
   */
  corrupted: boolean;
  /** Why, when `corrupted`. Human-readable. */
  corruptReason?: string;
  /** Where the moved-aside bytes are, so a user can recover them by hand. */
  corruptFile?: string;
}

export type SessionRead =
  | { ok: true; session: AgentSession }
  | { ok: false; error: string; summary?: SessionSummary };

export type SessionWrite =
  | { ok: true; id: string; name: string }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** An id must be safe to join to a path. See the traversal note above. */
export const SESSION_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const MAX_SESSIONS = 200;
export const MAX_TURNS = 500;
export const MAX_RUNS_PER_SESSION = 200;
export const MAX_TOOL_ENTRIES_PER_RUN = 200;
export const MAX_TURN_CHARS = 20_000;
export const MAX_RESULT_CHARS = 20_000;
export const MAX_TASK_CHARS = 4_000;
export const MAX_NAME_CHARS = 120;
/**
 * A hard ceiling on one session file. Exceeding it drops the oldest runs, then the
 * oldest turns, and sets `truncated` — the alternative (an unbounded file that
 * grows until the disk fills) is not a design, it is a deferred crash.
 */
export const MAX_SESSION_BYTES = 8 * 1024 * 1024;

const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

export const REDACTION_PLACEHOLDER = "«redacted»";

/**
 * Secret shapes worth refusing to write to disk permanently.
 *
 * These are deliberately patterns, not a parser: the goal is not to find every
 * possible secret, it is to ensure that the common ones — a key the user pasted,
 * a shell command with `TOKEN=…` in it, an OpenAI key echoed back by a tool — do
 * not silently become a permanent file. Anything this misses is still protected by
 * the fact that the file lives in the user's own profile.
 */
const SECRET_PATTERNS: RegExp[] = [
  // Provider keys with recognisable prefixes.
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  // Authorization headers.
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  // PEM private keys, block and all.
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
  // `key = "literal"` — quoted, so the closing quote bounds it and nothing else
  // can be swallowed.
  /\b(?:api[_-]?key|apikey|secret|client[_-]?secret|password|passwd|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*(["'])[^"']{6,}\1/gi,
  // `key = barevalue` — unquoted, and deliberately strict.
  //
  // The charset excludes `(`, `)`, `<`, `>`, `[`, `]`, `{`, `}`, `;` and `,`, and
  // the value must be at least 12 characters. That is what stops this from
  // eating source code: `apiKey = getKey()` is six characters and a call, so it
  // survives, while `api_key=supersecretvalue123` is twenty and does not. An
  // earlier, looser version of this pattern redacted `getKey()` out of a
  // conversation — which is a redaction that quietly corrupts the record it is
  // supposed to protect. Under-redacting a function call is the better of the two
  // failures here: it leaves a secret in a file in the user's own profile, where
  // the prefix patterns above still catch the real keys, and it does not destroy
  // anything.
  /\b(?:api[_-]?key|apikey|secret|client[_-]?secret|password|passwd|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*[^\s"'`;,}{()<>\[\]]{12,}/gi,
];

export interface RedactionResult {
  text: string;
  count: number;
}

/**
 * Replace secret-shaped substrings. Returns the count so the caller can persist
 * and display it — a silent redaction is worse than none, because the user would
 * believe the original text was stored.
 */
export function redactSecrets(input: string): RedactionResult {
  if (!input) return { text: input, count: 0 };
  let text = input;
  let count = 0;
  for (const re of SECRET_PATTERNS) {
    // `RegExp.prototype.test` with a /g/ regex is stateful; using `match` avoids
    // lastIndex state leaking between calls on a shared regex object.
    const hits = text.match(re);
    if (!hits || hits.length === 0) continue;
    count += hits.length;
    text = text.replace(re, REDACTION_PLACEHOLDER);
  }
  return { text, count };
}

function redactField(input: string, counter: { n: number }): string {
  const r = redactSecrets(input);
  counter.n += r.count;
  return r.text;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

let sessionsDirOverride: string | null = null;

/** Point the store at a directory. Used by tests, and the only escape hatch. */
export function setSessionsDir(dir: string | null): void {
  sessionsDirOverride = dir;
}

export function getSessionsDir(): string {
  return sessionsDirOverride ?? path.join(app.getPath("userData"), "sessions");
}

export function sessionPath(id: string): string {
  return path.join(getSessionsDir(), `${id}.json`);
}

function backupPath(id: string): string {
  return path.join(getSessionsDir(), `${id}.json.bak`);
}

function indexPath(): string {
  return path.join(getSessionsDir(), "index.json");
}

function activePath(): string {
  return path.join(getSessionsDir(), "active.json");
}

function ensureDir(): void {
  fs.mkdirSync(getSessionsDir(), { recursive: true });
}

/**
 * True when `id` is safe to use as a filename component.
 *
 * This is the store's only trust boundary and it is deliberately paranoid:
 * rejecting `.`, `..`, separators, absolute paths and anything non-alphanumeric
 * means no caller — renderer, IPC payload, or a future import feature — can make
 * the store read or write outside its own directory.
 */
export function isValidSessionId(id: unknown): id is string {
  return typeof id === "string" && SESSION_ID_RE.test(id);
}

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

/**
 * Replace a file's contents without ever leaving a half-written file behind.
 *
 * Write to a temp name in the same directory, then `rename`. `rename` within one
 * volume is atomic, so a crash lands on either the old contents or the new ones.
 * The previous good copy is kept as `.bak` first, so even a filesystem that
 * misreports atomicity has a fallback for `loadSession` to try.
 */
export function writeFileAtomic(file: string, text: string): void {
  ensureDir();
  if (fs.existsSync(file)) {
    try {
      const tmpBak = `${file}.bak.tmp`;
      fs.writeFileSync(tmpBak, fs.readFileSync(file), "utf-8");
      fs.renameSync(tmpBak, `${file}.bak`);
    } catch {
      // A missing backup must not stop a save. The atomic rename below is the
      // real guarantee; `.bak` is a second chance, not the first one.
    }
  }
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, "utf-8");
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const AGENT_STATUSES: readonly AgentStatus[] = [
  "idle", "starting", "running", "awaiting_approval",
  "cancelling", "cancelled", "completed", "failed",
];

function isStr(v: unknown): v is string {
  return typeof v === "string";
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function clampText(v: unknown, max: number): string {
  if (!isStr(v)) return "";
  return v.length > max ? v.slice(0, max) : v;
}

function sanitizeTurn(raw: unknown): SessionTurn | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.text !== "string") return null;
  const role = t.role === "assistant" ? "assistant" : "user";
  return {
    id: isStr(t.id) ? t.id.slice(0, 80) : "",
    role,
    text: t.text,
    at: num(t.at, 0),
  };
}

function sanitizeToolEntry(raw: unknown): AgentTraceEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (t.kind !== "status" && t.kind !== "tool" && t.kind !== "error") return null;
  return {
    at: num(t.at, 0),
    kind: t.kind,
    step: num(t.step, 0),
    ...(isStr(t.level) ? { level: t.level as AgentTraceEntry["level"] } : {}),
    ...(isStr(t.text) ? { text: t.text } : {}),
    ...(isStr(t.tool) ? { tool: t.tool } : {}),
    ...(typeof t.granted === "boolean" ? { granted: t.granted } : {}),
    ...(typeof t.ms === "number" ? { ms: t.ms } : {}),
  };
}

function sanitizeRunRef(raw: unknown): SessionRunRef | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isStr(r.id) || !r.id) return null;
  const status = AGENT_STATUSES.includes(r.status as AgentStatus)
    ? (r.status as AgentStatus)
    : "idle";
  const tools = Array.isArray(r.tools)
    ? r.tools.map(sanitizeToolEntry).filter((x): x is AgentTraceEntry => x !== null)
    : [];
  return {
    id: r.id,
    agentId: isStr(r.agentId) ? r.agentId : "unknown",
    task: clampText(r.task, MAX_TASK_CHARS),
    status,
    steps: num(r.steps, 0),
    toolCalls: num(r.toolCalls, 0),
    createdAt: num(r.createdAt, 0),
    updatedAt: num(r.updatedAt, 0),
    parentRunId: isStr(r.parentRunId) ? r.parentRunId : null,
    depth: num(r.depth, 0),
    resultText: clampText(r.resultText, MAX_RESULT_CHARS),
    ...(isStr(r.error) ? { error: r.error.slice(0, 2_000) } : {}),
    tools: tools.slice(-MAX_TOOL_ENTRIES_PER_RUN),
    ...(typeof r.contextChars === "number" ? { contextChars: r.contextChars } : {}),
    ...(isStr(r.contextStatus) ? { contextStatus: r.contextStatus as ContextSummary["status"] } : {}),
  };
}

export interface ValidationResult {
  session: AgentSession | null;
  /** Entries that were structurally wrong and have been dropped. */
  dropped: number;
  /** True when the file is not a session at all. */
  fatal: string | null;
  /**
   * True when the file is fine but this build must not touch it — currently only
   * the "written by a newer schema" case. Such a file is reported and left exactly
   * where it is: renaming it aside would be a mutation, and a user who downgraded
   * to read their conversations should not find them moved by the downgrade.
   */
  preserve?: boolean;
}

/**
 * Validate a parsed session.
 *
 * Two levels on purpose. A file that is not a session — not an object, no id, no
 * version — is fatal and gets quarantined, because guessing at its contents could
 * surface another program's data as a conversation. A file that *is* a session but
 * has one bad entry is repaired: the bad entry is dropped, the rest is kept, and
 * `dropped` is non-zero so the caller can tell the user rather than pretending a
 * lossy read was a clean one.
 */
export function validateSession(raw: unknown): ValidationResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { session: null, dropped: 0, fatal: "the file is not a JSON object" };
  }
  const o = raw as Record<string, unknown>;
  if (!isStr(o.id) || !o.id) {
    return { session: null, dropped: 0, fatal: "it has no session id" };
  }
  if (typeof o.version !== "number") {
    return { session: null, dropped: 0, fatal: "it has no schema version" };
  }
  if (o.version > SCHEMA_VERSION) {
    // A file from a newer build. Refusing it is the honest answer: this build has
    // no idea what a future field means, and writing over it would destroy it.
    return {
      session: null,
      dropped: 0,
      fatal: `it was written by a newer version (schema v${o.version}, this build reads v${SCHEMA_VERSION})`,
      preserve: true,
    };
  }

  let dropped = 0;
  const turnsRaw = Array.isArray(o.turns) ? o.turns : [];
  const turns: SessionTurn[] = [];
  for (const t of turnsRaw) {
    const s = sanitizeTurn(t);
    if (s) turns.push({ ...s, text: clampText(s.text, MAX_TURN_CHARS) });
    else dropped += 1;
  }
  const runsRaw = Array.isArray(o.runs) ? o.runs : [];
  const runs: SessionRunRef[] = [];
  for (const r of runsRaw) {
    const s = sanitizeRunRef(r);
    if (s) runs.push(s);
    else dropped += 1;
  }

  return {
    session: {
      version: SCHEMA_VERSION,
      id: o.id,
      name: clampText(o.name, MAX_NAME_CHARS) || "Untitled session",
      workspace: isStr(o.workspace) ? o.workspace : null,
      createdAt: num(o.createdAt, 0),
      updatedAt: num(o.updatedAt, 0),
      status: o.status === "closed" ? "closed" : "open",
      forkedFrom: isStr(o.forkedFrom) ? o.forkedFrom : null,
      turns: turns.slice(-MAX_TURNS),
      runs: runs.slice(0, MAX_RUNS_PER_SESSION),
      redactions: num(o.redactions, 0),
      truncated: o.truncated === true,
    },
    dropped,
    fatal: null,
  };
}

// ---------------------------------------------------------------------------
// Quarantine
// ---------------------------------------------------------------------------

/**
 * Move an unreadable file aside instead of deleting it.
 *
 * The user may be able to recover their conversation by hand, and a store that
 * silently deletes the one file it could not parse is a store that can destroy
 * work. The original bytes are preserved and the path is reported back so the UI
 * can show it.
 */
export function quarantine(id: string, reason: string): string {
  const stamp = Date.now();
  const moved: string[] = [];
  // Both files. Leaving the `.bak` behind would strand it: the next load finds no
  // `<id>.json` and reports "no session with that id", so the backup would sit on
  // disk forever, invisible and unrecoverable by any UI.
  for (const from of [sessionPath(id), backupPath(id)]) {
    if (!fs.existsSync(from)) continue;
    const to = `${from}.corrupt-${stamp}`;
    try {
      fs.renameSync(from, to);
      moved.push(to);
    } catch {
      moved.push(`${from} (could not be moved aside; left in place)`);
    }
  }
  return moved.length > 0 ? moved.join(", ") : `${sessionPath(id)} (nothing to move)`;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function parseSessionFile(file: string): { raw: unknown; bytes: number } {
  const text = fs.readFileSync(file, "utf-8");
  return { raw: JSON.parse(text), bytes: Buffer.byteLength(text, "utf-8") };
}

/**
 * Read one session, repairing or quarantining as needed.
 *
 * Two fallback levels, in order, because "corrupt" is not one condition:
 *   1. the file itself
 *   2. its `.bak` from the previous good write
 * Only when both fail is anything moved aside.
 */
export function loadSessionById(id: string): SessionRead {
  if (!isValidSessionId(id)) {
    return { ok: false, error: "That is not a valid session id." };
  }
  const file = sessionPath(id);
  if (!fs.existsSync(file)) {
    return { ok: false, error: "No session with that id exists." };
  }

  const attempts: Array<{ file: string; label: string }> = [{ file, label: "the session file" }];
  const bak = backupPath(id);
  if (fs.existsSync(bak)) attempts.push({ file: bak, label: "its backup copy" });

  let lastReason = attempts.length > 1
    ? "neither the session file nor its backup could be read"
    : "it could not be read";
  /** A file this build must not move — a newer schema it cannot read. */
  let mustPreserve = false;

  for (const attempt of attempts) {
    let raw: unknown;
    try {
      raw = parseSessionFile(attempt.file).raw;
    } catch (err) {
      lastReason = `${attempt.label} is not readable JSON (${err instanceof Error ? err.message : String(err)})`;
      continue;
    }
    const v = validateSession(raw);
    if (!v.session) {
      lastReason = `${attempt.label} could not be understood: ${v.fatal}`;
      if (v.preserve) mustPreserve = true;
      continue;
    }
    // A repaired read is flagged on the session itself. `truncated` is the field the
    // UI already knows how to explain, and "something in here was dropped" is
    // exactly the claim it makes.
    return {
      ok: true,
      session: { ...v.session, truncated: v.session.truncated || v.dropped > 0 },
    };
  }

  // Only move bytes aside when this build is the one that cannot make sense of
  // them. A file from a newer schema is somebody's intact data, not debris.
  const movedTo = mustPreserve ? sessionPath(id) : quarantine(id, lastReason);
  return {
    ok: false,
    error: `This session could not be read: ${lastReason}.`,
    summary: {
      id,
      name: id,
      workspace: null,
      createdAt: 0,
      updatedAt: 0,
      status: "open",
      forkedFrom: null,
      turnCount: 0,
      runCount: 0,
      toolCallCount: 0,
      bytes: 0,
      redactions: 0,
      truncated: false,
      corrupted: true,
      corruptReason: lastReason,
      corruptFile: movedTo,
    },
  };
}

// ---------------------------------------------------------------------------
// Summaries and the index
// ---------------------------------------------------------------------------

function summarise(session: AgentSession, bytes: number): SessionSummary {
  return {
    id: session.id,
    name: session.name,
    workspace: session.workspace,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    status: session.status,
    forkedFrom: session.forkedFrom,
    turnCount: session.turns.length,
    runCount: session.runs.length,
    toolCallCount: session.runs.reduce((n, r) => n + r.toolCalls, 0),
    bytes,
    redactions: session.redactions,
    truncated: session.truncated,
    corrupted: false,
  };
}

function isSummary(v: unknown): v is SessionSummary {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return isStr(o.id) && typeof o.turnCount === "number" && typeof o.runCount === "number";
}

function readIndex(): SessionSummary[] {
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath(), "utf-8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter(isSummary);
  } catch {
    // A damaged index is a cache problem, not a data problem: every session is
    // still on disk as its own file. Rebuilding below is the whole recovery.
    return [];
  }
}

function writeIndex(summaries: SessionSummary[]): void {
  try {
    writeFileAtomic(indexPath(), JSON.stringify(summaries, null, 2));
  } catch {
    // Indexing is an optimisation. Failing to write it must not fail the save
    // that triggered it, or a full disk would become "cannot save a session".
  }
}

/**
 * Filenames in the sessions directory that are *not* sessions.
 *
 * `index.json` and `active.json` are both valid-looking ids, so without this the
 * directory scan would pick them up, try to load them as sessions, fail — and
 * quarantine the store's own bookkeeping files. That is not a hypothetical: the
 * tests caught the store deleting its own index on the first `listSessions`.
 */
const RESERVED_BASENAMES = new Set(["index", "active"]);

/** Every session id that has a file on disk. */
function diskIds(): string[] {
  try {
    return fs
      .readdirSync(getSessionsDir())
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length))
      .filter(isValidSessionId)
      .filter((id) => !RESERVED_BASENAMES.has(id));
  } catch {
    return [];
  }
}

function summaryForUnknown(id: string): SessionSummary {
  const read = loadSessionById(id);
  if (read.ok) {
    let bytes = 0;
    try {
      bytes = fs.statSync(sessionPath(id)).size;
    } catch {
      bytes = 0;
    }
    return summarise(read.session, bytes);
  }
  return read.summary ?? {
    id,
    name: id,
    workspace: null,
    createdAt: 0,
    updatedAt: 0,
    status: "open",
    forkedFrom: null,
    turnCount: 0,
    runCount: 0,
    toolCallCount: 0,
    bytes: 0,
    redactions: 0,
    truncated: false,
    corrupted: true,
    corruptReason: read.error,
  };
}

/**
 * Every session, newest first.
 *
 * Reads the index, then reconciles it against what is actually on disk. The
 * reconcile is a directory listing plus a comparison — no file is read unless the
 * index does not already know about it, which is what keeps the list cheap as the
 * store grows.
 */
export function listSessions(): SessionSummary[] {
  ensureDir();
  const onDisk = new Set(diskIds());
  const indexed = readIndex();
  const known = new Set(indexed.map((s) => s.id));
  const extra = [...onDisk].filter((id) => !known.has(id));
  // The existence check happens *after* the extras are resolved, not before:
  // resolving an extra can quarantine it, and filtering first would leave the very
  // session that was just found unreadable sitting in the list it was resolved for.
  const present = (s: { id: string }): boolean => {
    try {
      return fs.existsSync(sessionPath(s.id));
    } catch {
      return false;
    }
  };
  const merged = [...indexed, ...extra.map(summaryForUnknown)].filter(present);
  if (extra.length > 0 || merged.length !== indexed.length) writeIndex(merged);
  return merged.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Enforce `MAX_SESSION_BYTES` by dropping the oldest history.
 *
 * `Buffer.byteLength`, not `.length`. A cap called `MAX_SESSION_BYTES` that counted
 * UTF-16 code units let a session of non-ASCII text reach roughly three times the
 * intended size on disk — Hindi or Chinese conversation, emoji, anything past the
 * BMP — and the number reported in the UI (which does use `Buffer.byteLength`)
 * disagreed with the limit that produced it.
 */
function boundSize(session: AgentSession): AgentSession {
  if (session.turns.length > MAX_TURNS) session.turns = session.turns.slice(-MAX_TURNS);
  if (session.runs.length > MAX_RUNS_PER_SESSION) session.runs = session.runs.slice(0, MAX_RUNS_PER_SESSION);
  let serialised = JSON.stringify(session);
  let size = Buffer.byteLength(serialised, "utf8");
  while (size > MAX_SESSION_BYTES) {
    if (session.runs.length > 1) {
      session.runs.pop();
    } else if (session.runs.length === 1) {
      const r = session.runs[0];
      r.resultText = "";
      r.task = r.task.slice(0, 1_000);
      r.tools = [];
    } else if (session.turns.length > 1) {
      session.turns.shift();
    } else if (session.turns.length === 1) {
      session.turns[0].text = session.turns[0].text.slice(0, 1_000);
    } else {
      break;
    }
    session.truncated = true;
    serialised = JSON.stringify(session);
    size = Buffer.byteLength(serialised, "utf8");
  }
  return session;
}

function persist(session: AgentSession): { ok: true; bytes: number } | { ok: false; error: string } {
  ensureDir();
  if (!isValidSessionId(session.id)) {
    return { ok: false, error: "Refusing to write a session with an invalid id." };
  }
  const bounded = boundSize(session);
  let text: string;
  try {
    text = JSON.stringify(bounded, null, 2);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  try {
    writeFileAtomic(sessionPath(bounded.id), text);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  // `readIndex` rather than `listSessions`: a save does not need the full
  // reconcile, and calling the reconciling version here made every single write do
  // a directory listing and an existence check for every session — quadratic work on
  // the hottest path in the store, which is one write per chat message.
  const summaries = readIndex().filter((s) => s.id !== bounded.id);
  writeIndex([summarise(bounded, Buffer.byteLength(text, "utf-8")), ...summaries]);
  return { ok: true, bytes: Buffer.byteLength(text, "utf-8") };
}

export function newSessionId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CreateSessionOptions {
  name?: string;
  workspace?: string | null;
  turns?: SessionTurn[];
}

/**
 * Refuse to create a session once the store is full, and say why.
 *
 * `MAX_SESSIONS` was originally declared and never called from anywhere, which is
 * worse than not having it: the constant asserted a bound the code did not keep, so
 * the list could grow without limit and every claim that the store is bounded was
 * resting on a number that did nothing. Both paths that mint a new id go through
 * here — `createSession` and `forkSession` — because a fork that bypassed the cap
 * would be a hole in it.
 *
 * The count comes from `listSessions()`, which reconciles against the directory
 * rather than trusting the index, so an orphaned file left by a crash counts
 * against the budget instead of being invisible. Creating is rare, so paying one
 * directory scan for it is the right trade.
 *
 * The alternative — pruning the oldest to make room — is not offered, because
 * destroying a user's conversation to enforce a quota is exactly the behaviour a
 * session store exists to prevent. Delete is one click away and says what it does.
 */
function ensureSessionBudget(): { ok: true } | { ok: false; error: string } {
  let count: number;
  try {
    count = listSessions().length;
  } catch {
    // An unreadable directory is not a reason to refuse a write — the write itself
    // will report the real failure with a better message.
    return { ok: true };
  }
  if (count < MAX_SESSIONS) return { ok: true };
  return {
    ok: false,
    error:
      `This app already holds ${MAX_SESSIONS} sessions, which is the limit. ` +
      `Delete one you no longer need, then try again — nothing was deleted for you.`,
  };
}

export function createSession(options: CreateSessionOptions = {}): SessionRead {
  ensureDir();
  const budget = ensureSessionBudget();
  if (!budget.ok) return { ok: false, error: budget.error };
  const counter = { n: 0 };
  const now = Date.now();
  const session: AgentSession = {
    version: SCHEMA_VERSION,
    id: newSessionId(),
    name: clampText(options.name, MAX_NAME_CHARS) || defaultName(now),
    workspace: options.workspace ?? null,
    createdAt: now,
    updatedAt: now,
    status: "open",
    forkedFrom: null,
    turns: (options.turns ?? []).slice(-MAX_TURNS).map((t) => ({
      ...t,
      text: redactField(clampText(t.text, MAX_TURN_CHARS), counter),
    })),
    runs: [],
    redactions: counter.n,
    truncated: false,
  };
  const written = persist(session);
  if (!written.ok) return { ok: false, error: written.error };
  setActiveSessionId(session.id);
  return { ok: true, session };
}

function defaultName(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => `${n}`.padStart(2, "0");
  return `Session ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function renameSession(id: string, name: string): SessionWrite {
  const read = loadSessionById(id);
  if (!read.ok) return { ok: false, error: read.error };
  const trimmed = clampText(name.trim(), MAX_NAME_CHARS);
  if (!trimmed) return { ok: false, error: "A session name cannot be empty." };
  read.session.name = trimmed;
  read.session.updatedAt = Date.now();
  const written = persist(read.session);
  return written.ok ? { ok: true, id, name: trimmed } : { ok: false, error: written.error };
}

export function setSessionStatus(id: string, status: "open" | "closed"): SessionWrite {
  const read = loadSessionById(id);
  if (!read.ok) return { ok: false, error: read.error };
  read.session.status = status;
  read.session.updatedAt = Date.now();
  const written = persist(read.session);
  return written.ok ? { ok: true, id, name: read.session.name } : { ok: false, error: written.error };
}

/**
 * Delete a session and everything that belongs to it.
 *
 * Refuses on an invalid id before touching the filesystem, and deletes the backup
 * too — a `.bak` left behind would be a session the user believes they erased,
 * sitting on disk and still loadable.
 */
export function deleteSession(id: string): SessionWrite {
  if (!isValidSessionId(id)) return { ok: false, error: "That is not a valid session id." };
  let existed = false;
  for (const file of [sessionPath(id), backupPath(id)]) {
    if (!fs.existsSync(file)) continue;
    existed = true;
    try {
      fs.unlinkSync(file);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  writeIndex(listSessions().filter((s) => s.id !== id));
  if (getActiveSessionId() === id) setActiveSessionId(null);
  if (!existed) return { ok: false, error: "No session with that id exists." };
  return { ok: true, id, name: id };
}

export function deleteAllSessions(): number {
  const ids = diskIds();
  for (const id of ids) {
    for (const file of [sessionPath(id), backupPath(id)]) {
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch {
        // Best effort. A file we cannot remove is reported by the next `listSessions`
        // as still being there, which is more honest than counting it as deleted.
      }
    }
  }
  writeIndex([]);
  setActiveSessionId(null);
  return ids.length;
}

/**
 * Duplicate a session.
 *
 * The copy is deep and independent: new id, new timestamps, `forkedFrom` set, and
 * its own copies of every turn and run. Editing or deleting the fork cannot touch
 * the original, which is the whole point of forking rather than renaming.
 *
 * The original's redaction count is carried over so the copy does not claim to be
 * cleaner than the thing it came from.
 */
export function forkSession(id: string, name?: string): SessionRead {
  const read = loadSessionById(id);
  if (!read.ok) return { ok: false, error: read.error };
  const budget = ensureSessionBudget();
  if (!budget.ok) return { ok: false, error: budget.error };
  const source = read.session;
  const counter = { n: 0 };
  const now = Date.now();
  const forked: AgentSession = {
    version: SCHEMA_VERSION,
    id: newSessionId(),
    name: clampText(name, MAX_NAME_CHARS) || `${source.name} (fork)`,
    workspace: source.workspace,
    createdAt: now,
    updatedAt: now,
    status: "open",
    forkedFrom: source.id,
    turns: source.turns.map((t) => ({ ...t, text: redactField(t.text, counter) })),
    runs: source.runs.map((r) => ({ ...r, tools: r.tools.map((e) => ({ ...e })) })),
    redactions: source.redactions + counter.n,
    truncated: source.truncated,
  };
  const written = persist(forked);
  if (!written.ok) return { ok: false, error: written.error };
  return { ok: true, session: forked };
}

/** Append one AI chat turn. */
export function appendTurn(id: string, turn: SessionTurn): SessionWrite {
  const read = loadSessionById(id);
  if (!read.ok) return { ok: false, error: read.error };
  const counter = { n: 0 };
  read.session.turns.push({
    id: String(turn.id ?? "").slice(0, 80),
    role: turn.role === "assistant" ? "assistant" : "user",
    text: redactField(clampText(turn.text, MAX_TURN_CHARS), counter),
    at: num(turn.at, Date.now()),
  });
  if (read.session.turns.length > MAX_TURNS) {
    read.session.turns = read.session.turns.slice(-MAX_TURNS);
    read.session.truncated = true;
  }
  read.session.redactions += counter.n;
  read.session.updatedAt = Date.now();
  const written = persist(read.session);
  return written.ok ? { ok: true, id, name: read.session.name } : { ok: false, error: written.error };
}

/**
 * Record one agent run against a session.
 *
 * Replaces an existing entry with the same run id rather than appending, so a run
 * that reports progress and then a result is stored once, in its final state.
 */
export function recordRun(id: string, run: SessionRunRef): SessionWrite {
  const read = loadSessionById(id);
  if (!read.ok) return { ok: false, error: read.error };
  const counter = { n: 0 };
  const entry = sanitizeRunRef({
    ...run,
    task: redactField(clampText(run.task, MAX_TASK_CHARS), counter),
    resultText: redactField(clampText(run.resultText, MAX_RESULT_CHARS), counter),
    tools: run.tools.map((t) => ({ ...t, ...(t.text ? { text: redactField(t.text, counter) } : {}) })),
  });
  if (!entry) return { ok: false, error: "That run record was not usable." };
  read.session.runs = [entry, ...read.session.runs.filter((r) => r.id !== entry.id)];
  if (read.session.runs.length > MAX_RUNS_PER_SESSION) {
    read.session.runs = read.session.runs.slice(0, MAX_RUNS_PER_SESSION);
    read.session.truncated = true;
  }
  read.session.redactions += counter.n;
  read.session.updatedAt = Date.now();
  const written = persist(read.session);
  return written.ok ? { ok: true, id, name: read.session.name } : { ok: false, error: written.error };
}

// ---------------------------------------------------------------------------
// The active pointer
// ---------------------------------------------------------------------------

/**
 * Which session was last open.
 *
 * This is what makes "restarting does not destroy sessions" true in practice: the
 * pointer is how the app knows there is something to resume, rather than starting
 * every launch from an empty conversation and leaving the user's work to be found
 * only if they remembered it existed.
 */
export function getActiveSessionId(): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(activePath(), "utf-8")) as { id?: unknown };
    return isValidSessionId(raw.id) ? raw.id : null;
  } catch {
    return null;
  }
}

export function setActiveSessionId(id: string | null): void {
  try {
    ensureDir();
    if (id === null) {
      if (fs.existsSync(activePath())) fs.unlinkSync(activePath());
      return;
    }
    if (!isValidSessionId(id)) return;
    writeFileAtomic(activePath(), JSON.stringify({ id, at: Date.now() }, null, 2));
  } catch {
    // The pointer is a convenience. Failing to move it must never break the
    // session operation that was actually asked for.
  }
}

/**
 * The conversation to replay when a session is resumed.
 *
 * Agent turns first (they are what the model needs to continue its own work), then
 * chat turns, oldest first. Bounded so a resumed run cannot be handed a history
 * larger than the context budget it would be sent in — the runtime's own history
 * handling bounds it too, but a bound applied twice is cheaper than a 4 MB prompt.
 */
export function resumeHistory(session: AgentSession, maxTurns = 40): Array<{ role: "user" | "assistant"; content: string }> {
  const out: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const run of [...session.runs].reverse()) {
    const text = run.resultText.trim();
    if (!text) continue;
    out.push({ role: "user", content: clampText(run.task, 2_000) });
    out.push({ role: "assistant", content: clampText(text, 4_000) });
  }
  for (const turn of session.turns) {
    if (!turn.text.trim()) continue;
    out.push({ role: turn.role, content: clampText(turn.text, 4_000) });
  }
  return out.slice(-maxTurns);
}