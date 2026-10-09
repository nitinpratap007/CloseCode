// Close Code — AI Agent Runtime — context engine (Phase 26)
//
// Until now a run received *no* project context at all. `AgentRunSpec.context`
// existed and was consumed by `buildInitialMessages`, but `agentStore.start()`
// never sent a value, so the field had been plumbing with nothing behind it since
// Phase 21. The one real context builder in the tree, `src/ai/context.ts` (Phase
// 11), belongs to the AI *chat* panel: user-ticked checkboxes over the open
// editor, serialised into one string. It is not deleted and not rewritten — it
// stays the chat panel's job. This module is the agent path's, and it is a
// different problem: it assembles context for a model that has to work
// unattended, so it has to be bounded, ranked and inspectable rather than
// user-curated.
//
// ## Why the main process
//
// Ten signals were asked for. Six of them can only be produced here:
//
//   * git state            — `services/git.ts` shells out to real git
//   * project structure    — needs the file tree
//   * project instructions — `AGENTS.md` and friends, read off disk
//   * previous agent work  — the runtime's own run records
//   * *relevant* code      — relevance ranking needs every candidate's body
//   * the context itself   — `spawnChild` (Phase 25) must give children one too,
//                            and children are main-process objects
//
// Two more can only be produced in the renderer: the Monaco selection and the
// live LSP diagnostics. `tools-project.ts` already took a documented position on
// the second — "the editor's live diagnostics live in the renderer … the main
// process has no way to read them" — and answered it by running `tsc --noEmit`.
// For *context* that workaround is wrong twice over: it costs a full typecheck on
// every run start, and it reports a different set of errors than the red squiggles
// the user is looking at. So the engine does not try to read them. The renderer
// **pushes** them, in an `EditorSnapshot`, over the same IPC that starts the run.
// Main still cannot read the editor; it is being told.
//
// ## What is never sent
//
// The user's request is *not* repeated in the context block. It is already the
// user message (`buildInitialMessages` appends `spec.task`), and putting it in
// both places would spend budget on a duplicate of something the model can
// already see. It is still part of the context the model receives — it just
// arrives by the correct route rather than the wasteful one.
//
// ## Ranking
//
// "Relevant" is computed, not guessed: the task is tokenised (identifiers split
// on `_`/`-`/`$` and on camelCase humps, stopwords dropped) and every candidate
// file in a bounded walk is scored on filename hits, path hits and body hits,
// with each token's contribution capped so one ubiquitous word cannot carry the
// ranking. Files that score zero are not sent. That is the whole of the "irrelevant
// files are excluded" criterion, and it is measured, not asserted.
//
// ## Budgets
//
// One hard total, allocated greedily in a fixed priority order, plus a per-part
// cap. The first part to arrive is the selection — it is the most expensive thing
// to rediscover and the cheapest thing to be explicit about. Project instructions
// rank above it because they change how the model must behave. Open *other* tabs
// rank last, because `read_file` already exists and reading a file on demand costs
// the user nothing up front.
//
// A sub-agent gets a materially smaller budget than its parent. Four children at
// the parent budget would put 96k characters of context into a single delegated
// task, which is exactly the "send the whole project" failure this phase exists
// to prevent.
//
// ## Cancellation
//
// `build` is async and yields between phases, so a cancel that arrives over IPC is
// actually observed rather than queued behind a synchronous walk. The one window
// that cannot be interrupted is a single walk step, bounded to `maxFileBytes`
// (128 KB); the assembly is abandoned regardless, and no context is produced.

import fs from "fs";
import path from "path";
import { getStatus, getGitRoot, type GitStatusFile } from "../git";
import { confineToWorkspace } from "./paths";
import { walkWorkspace, type WalkLimits } from "./walk";
import type {
  ContextBudget,
  ContextFileSummary,
  ContextPartKind,
  ContextStatus,
  ContextSummary,
  EditorDiagnosticSnapshot,
  EditorSelectionSnapshot,
  EditorSnapshot,
} from "./types";

// The context *contracts* live in `types.ts` alongside every other type this
// subsystem shares, so the renderer-facing mirrors and the runtime can never
// describe a context bundle differently. They are re-exported here because
// `context.ts` is what a caller reaches for.
export type {
  ContextBudget,
  ContextFileSummary,
  ContextPartKind,
  ContextStatus,
  ContextSummary,
  ContextSummaryPart,
  EditorDiagnosticSnapshot,
  EditorSelectionSnapshot,
  EditorSnapshot,
} from "./types";

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  totalChars: 24_000,
  maxSelectionChars: 6_000,
  maxInstructionsChars: 4_000,
  maxCurrentFileChars: 6_000,
  maxRelevantFiles: 5,
  maxRelevantFileChars: 2_400,
  maxDocFiles: 2,
  maxDocFileChars: 2_000,
  maxOpenFiles: 3,
  maxOpenFileChars: 1_200,
  maxGitFiles: 40,
  maxDiagnostics: 30,
  maxPreviousChars: 2_500,
  maxPreviousRuns: 3,
  maxStructureLines: 60,
};

/**
 * Phase 26. A sub-agent's budget.
 *
 * Deliberately about a third of the parent's, not a copy of it. `spawnChild`
 * allows four children per run, so parent-sized context would mean ~96k
 * characters riding along with one delegated task, which is precisely the "send
 * the whole project" failure this phase exists to prevent. Previous agent work is
 * switched off entirely: a child is one step further from the conversation that
 * produced those results, and the parent already has them.
 */
export const CHILD_CONTEXT_BUDGET: ContextBudget = {
  totalChars: 8_000,
  maxSelectionChars: 2_000,
  maxInstructionsChars: 2_000,
  maxCurrentFileChars: 2_000,
  maxRelevantFiles: 3,
  maxRelevantFileChars: 1_200,
  maxDocFiles: 1,
  maxDocFileChars: 1_200,
  maxOpenFiles: 1,
  maxOpenFileChars: 800,
  maxGitFiles: 15,
  maxDiagnostics: 15,
  maxPreviousChars: 0,
  maxPreviousRuns: 0,
  maxStructureLines: 24,
};

/** A part in full: the payload stays in the main process. */
export interface ContextPart {
  kind: ContextPartKind;
  label: string;
  chars: number;
  included: boolean;
  truncated: boolean;
  reason?: string;
  text?: string;
  files?: ContextFileSummary[];
}

export interface ContextBundle {
  summary: ContextSummary;
  /** Exactly what `AgentRunSpec.context` will carry. Empty when not built. */
  text: string;
  budget: ContextBudget;
  agentId: string;
  task: string;
  workspace: string | null;
  /** `parentRunId` for a sub-agent's build, so the summary can say so. */
  childOf: string | null;
}

export interface ContextRequest {
  agentId: string;
  task: string;
  workspace: string | null;
  snapshot?: EditorSnapshot | null;
  budget?: ContextBudget;
  /** Rebuild even if an identical request was just served. */
  force?: boolean;
  childOf?: string | null;
  signal?: AbortSignal;
}

/** The minimum an engine needs from the runtime to describe earlier work. */
export interface PriorRun {
  id: string;
  agentId: string;
  task: string;
  status: string;
  createdAt: number;
  result?: { text?: string };
  parentRunId?: string | null;
}

// ---------------------------------------------------------------------------
// Snapshot sanitisation — the untrusted boundary
// ---------------------------------------------------------------------------

const SNAPSHOT_LIMITS = {
  path: 1_024,
  activeContent: 200_000,
  selection: 40_000,
  openPaths: 40,
  diagnostics: 500,
  message: 500,
  line: 1_000_000,
} as const;

function asString(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v.length > max ? v.slice(0, max) : v;
}

function asLine(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

function asStringArray(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (out.length >= maxItems) break;
    const s = asString(item, maxLen);
    if (s.trim()) out.push(s);
  }
  return out;
}

/**
 * Clamp an `EditorSnapshot` that arrived from the renderer.
 *
 * Everything the renderer sends is attacker-influenced in the general case: any
 * script that got into the renderer can call the preload bridge. So this does
 * not trust a single field — every string is length-clamped, every array is
 * item-clamped, every number is coerced, and a value of the wrong type becomes
 * the empty value rather than passing through. Paths are *not* resolved here;
 * they are confined against the workspace later, where the real check lives.
 */
export function sanitizeSnapshot(raw: unknown): EditorSnapshot {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const sel = o.selection && typeof o.selection === "object" ? (o.selection as Record<string, unknown>) : null;
  const selectionText = sel ? asString(sel.text, SNAPSHOT_LIMITS.selection) : "";
  const selection =
    sel && selectionText.trim().length > 0
      ? {
          text: selectionText,
          startLine: asLine(sel.startLine) || 1,
          endLine: asLine(sel.endLine) || 1,
        }
      : null;

  const diagnostics: EditorDiagnosticSnapshot[] = [];
  if (Array.isArray(o.diagnostics)) {
    for (const d of o.diagnostics) {
      if (diagnostics.length >= SNAPSHOT_LIMITS.diagnostics) break;
      if (!d || typeof d !== "object") continue;
      const rec = d as Record<string, unknown>;
      const file = asString(rec.file, SNAPSHOT_LIMITS.path);
      const message = asString(rec.message, SNAPSHOT_LIMITS.message);
      if (!file.trim() || !message.trim()) continue;
      diagnostics.push({
        file,
        line: asLine(rec.line),
        severity: asString(rec.severity, 16) || "info",
        message,
      });
    }
  }

  return {
    activePath: (() => {
      const p = asString(o.activePath, SNAPSHOT_LIMITS.path).trim();
      return p && !p.startsWith("untitled:") ? p : null;
    })(),
    activeContent: asString(o.activeContent, SNAPSHOT_LIMITS.activeContent),
    activeDirty: o.activeDirty === true,
    selection,
    openPaths: asStringArray(o.openPaths, SNAPSHOT_LIMITS.openPaths, SNAPSHOT_LIMITS.path).filter(
      (p) => !p.startsWith("untitled:"),
    ),
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "are", "was", "were", "you", "your",
  "has", "have", "had", "not", "but", "can", "will", "would", "should", "could", "its", "it's",
  "use", "using", "used", "add", "adds", "make", "makes", "made", "get", "gets", "set", "run",
  "runs", "ran", "try", "tries", "fix", "fixes", "fixed", "all", "any", "new", "old", "now",
  "then", "than", "when", "where", "what", "which", "who", "why", "how", "does", "did", "done",
  "let", "lets", "out", "off", "over", "under", "about", "after", "before", "there", "here",
  "them", "they", "his", "her", "she", "him", "some", "each", "more", "most", "other", "such",
  "only", "also", "just", "like", "want", "need", "please", "help", "check", "see", "look",
  "file", "files", "code", "work", "works", "thing", "things", "something", "anything",
]);

/**
 * Meaningful tokens from a task.
 *
 * Identifiers are split three ways because a task is usually written in prose
 * and names the code in camelCase or snake_case: "fix setActivePath in
 * agentStore.ts" has to match `editorStore.ts`, `set` and `Path` both being
 * noise and `active` being the hit. Splitting *before* lowercasing is what
 * makes the camelCase case recoverable.
 */
export function taskTokens(task: string): string[] {
  const words = task.match(/[A-Za-z0-9_$]+/g) ?? [];
  const out = new Set<string>();
  for (const word of words) {
    for (const piece of word.split(/[_\-$]+/)) {
      if (!piece) continue;
      const segments = piece.match(/[A-Z]?[a-z]{2,}[0-9]*|[A-Z]{2,}(?![a-z])/g) ?? [piece];
      for (const seg of segments) {
        const t = seg.toLowerCase();
        if (t.length < 3 || STOPWORDS.has(t)) continue;
        out.add(t);
      }
    }
  }
  return [...out];
}

/**
 * Score one file against the task tokens.
 *
 * Each token contributes at most 6, so a word that appears in every file cannot
 * decide the ranking on its own — the cap is what makes the *path* hit matter.
 * A body hit is worth less than a filename hit, which is worth less than an
 * exact basename hit, because a developer naming a task after a file is the
 * strongest signal available and there is nothing better than it.
 */
export function scoreFile(
  rel: string,
  content: string | null,
  tokens: readonly string[],
): number {
  if (tokens.length === 0) return 0;
  const lowerRel = rel.toLowerCase();
  const base = lowerRel.slice(lowerRel.lastIndexOf("/") + 1);
  const lowerBody = content ? content.toLowerCase() : "";
  let score = 0;
  for (const token of tokens) {
    let s = 0;
    if (base.includes(token)) s += 5;
    else if (lowerRel.includes(token)) s += 2;
    if (lowerBody.includes(token)) s += 1;
    score += Math.min(s, 6);
  }
  return score;
}

/** Below this a file is not "relevant", it merely shares a word with the task. */
export const MIN_RELEVANCE_SCORE = 2;

const NOISE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".avif", ".pdf", ".zip", ".gz",
  ".bz2", ".xz", ".7z", ".tar", ".rar", ".mp3", ".mp4", ".mov", ".avi", ".wav", ".ogg",
  ".woff", ".woff2", ".ttf", ".otf", ".eot", ".wasm", ".exe", ".dll", ".so", ".dylib", ".class",
  ".jar", ".pyc", ".pyo", ".bin", ".dat", ".db", ".sqlite", ".map",
]);

const NOISE_BASENAMES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "composer.lock", "Cargo.lock",
]);

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".rst", ".adoc", ".txt"]);

/**
 * True for a documentation file.
 *
 * `AGENTS.md` and friends are instructions, not documentation, and they are read
 * directly by `collectInstructions`; letting them also rank as docs would put the
 * same bytes in the context twice under two different headings.
 */
export function isDocFile(rel: string): boolean {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  if (INSTRUCTION_FILES.includes(base)) return false;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return DOC_EXTENSIONS.has(base.slice(dot).toLowerCase());
}

/** True for a file that cannot usefully appear in a ranked excerpt. */
export function isNoiseFile(rel: string): boolean {
  const base = rel.slice(rel.lastIndexOf("/") + 1).toLowerCase();
  if (NOISE_BASENAMES.has(base)) return true;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return NOISE_EXTENSIONS.has(base.slice(dot));
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/** Thrown by the walk visitor to abandon a build. Never escapes `build`. */
const ABORTED = Symbol("context-build-aborted");

export interface ContextEngineDeps {
  now?: () => number;
  /**
   * Earlier runs, newest first. Injected rather than reached for, so the engine
   * has no dependency on the runtime module and a test needs no agent at all.
   */
  history?: () => PriorRun[];
  /** Git state, or `null` when the workspace is not a repository. */
  gitStatus?: (root: string) => { branch: string; ahead: number; behind: number; detached: boolean; files: GitStatusFile[] } | null;
  /** Bytes the relevance walk may read. */
  rankMaxBytes?: number;
  /**
   * Phase 31. User (`userData/instructions/`) and project
   * (`.closecode/instructions/`) instruction files, injected for the same
   * reason `history` is: the engine stays filesystem-pure in tests, and the
   * files land in the instructions part under their scope-prefixed names
   * (`user:coding-style.md`, `project:security.md`).
   */
  instructions?: (workspace: string | null) => Array<{ name: string; text: string }>;
}

const INSTRUCTION_FILES = [
  "AGENTS.md",
  "AGENTS.local.md",
  "CLAUDE.md",
  "GEMINI.md",
  "CONTRIBUTING.md",
  ".cursorrules",
  ".windsurfrules",
  ".github/copilot-instructions.md",
];

const RANK_LIMITS: WalkLimits = {
  maxEntries: 4_000,
  maxDepth: 8,
  // Nothing is ever "produced" by the ranking visitor, so this budget never
  // trips — it is set to 1 rather than 0 because a walk with `maxResults: 0`
  // stops before its first entry. `maxEntries`/`maxBytes` are the real bounds.
  maxResults: 1,
  maxBytes: 3 * 1024 * 1024,
  maxFileBytes: 128 * 1024,
};

const PREAMBLE =
  "This is CloseCode's project context, assembled for this task. It is deliberately " +
  "partial: only what ranked as relevant is below, and paths are relative to the " +
  "workspace root. For anything missing, use search_files, grep_files and read_file " +
  "rather than assuming it does not exist.";

const MIN_USEFUL_ROOM = 200;

/**
 * Make `target` abort when `source` does, and return the undo.
 *
 * `AbortSignal.any` would be the one-liner, but it is not in the ES2020 lib this
 * package compiles against, and a manual listener that is never removed is a leak
 * on a signal that can outlive many builds. The returned function is why the
 * caller can build repeatedly without accumulating listeners.
 */
function forwardAbort(source: AbortSignal, target: AbortController): () => void {
  if (source.aborted) {
    target.abort();
    return () => undefined;
  }
  const onAbort = (): void => target.abort();
  source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
}

function heading(label: string): string {
  return `### ${label}\n`;
}

function clip(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const marker = "\n… [truncated by CloseCode]";
  return { text: text.slice(0, Math.max(0, max - marker.length)) + marker, truncated: true };
}

function nowMs(): number {
  return Date.now();
}

function ageLabel(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

interface PartDraft {
  kind: ContextPartKind;
  label: string;
  text: string;
  files?: ContextFileSummary[];
  /**
   * The collector had to shorten this part to fit its own per-part budget.
   *
   * Set separately from `ContextPart.truncated` because there are two different
   * trims: a collector's cap (this) and the total budget's (`pack`). A panel that
   * reported only the second would tell a user their 200 KB selection was "sent
   * whole" when 4 KB of it was — which is exactly the kind of inaccuracy that
   * makes an exact character count worth nothing.
   */
  clipped?: boolean;
}

interface RankedFile {
  rel: string;
  score: number;
  content: string;
  size: number;
}

export class ContextEngine {
  private readonly now: () => number;
  private readonly history: () => PriorRun[];
  private readonly instructions: NonNullable<ContextEngineDeps["instructions"]>;
  private readonly gitStatus: NonNullable<ContextEngineDeps["gitStatus"]>;
  private readonly rankMaxBytes: number;

  private controller: AbortController | null = null;
  private lastRequest: ContextRequest | null = null;
  private lastBundle: ContextBundle | null = null;
  private cache: { key: string; bundle: ContextBundle } | null = null;

  constructor(deps: ContextEngineDeps = {}) {
    this.now = deps.now ?? nowMs;
    this.history = deps.history ?? (() => []);
    this.rankMaxBytes = deps.rankMaxBytes ?? RANK_LIMITS.maxBytes;
    this.instructions = deps.instructions ?? (() => []);
    this.gitStatus =
      deps.gitStatus ??
      ((root: string) => {
        try {
          if (!getGitRoot(root)) return null;
          return getStatus(root);
        } catch {
          // Not a repository, or git is missing. Both mean "no git context",
          // not a failed build, so the run proceeds without it.
          return null;
        }
      });
  }

  /** The most recent bundle, for inspection. Survives cancellation as null. */
  last(): ContextBundle | null {
    return this.lastBundle;
  }

  /**
   * Abandon a build in progress.
   *
   * Returns whether there was one. A false here is not an error — it means the
   * assembly had already finished, which is a perfectly good outcome.
   */
  cancel(): boolean {
    if (!this.controller) return false;
    this.controller.abort();
    return true;
  }

  /** Rebuild the last request from scratch, ignoring the cache. */
  async rebuild(): Promise<ContextBundle | null> {
    if (!this.lastRequest) return null;
    return this.build({ ...this.lastRequest, force: true });
  }

  /**
   * Assemble a context bundle.
   *
   * Only one build runs at a time: starting one aborts whatever was in flight.
   * Two concurrent walks over the same tree would be a main-thread stall for no
   * benefit, and "rebuild" is the operation a second build would mean anyway.
   */
  async build(request: ContextRequest): Promise<ContextBundle> {
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;
    // A caller-supplied signal is *forwarded* to the internal controller rather
    // than used in its place. Substituting it would mean `cancel()` silently
    // stopped working for every caller that passed one, which is the kind of
    // defect that only shows up during a cancellation nobody is watching.
    const detach = request.signal ? forwardAbort(request.signal, controller) : null;
    const signal = controller.signal;
    const started = this.now();
    const budget = request.budget ?? DEFAULT_CONTEXT_BUDGET;
    const snapshot = request.snapshot ?? null;

    const cacheKey = this.cacheKey(request, budget, snapshot);
    if (!request.force && this.cache && this.cache.key === cacheKey) {
      detach?.();
      this.lastBundle = this.cache.bundle;
      this.lastRequest = request;
      this.controller = null;
      return this.cache.bundle;
    }

    const drafts: PartDraft[] = [];
    let filesScanned = 0;
    let filesRanked = 0;

    try {
      // Phase 26. Yield before the first phase so an immediately-issued cancel
      // has a window to land, and so the main thread is free to paint the
      // "assembling context" state the panel shows.
      await this.yield();

      if (signal.aborted) throw ABORTED;
      const instructions = this.collectInstructions(request.workspace, budget, signal);
      if (instructions) drafts.push(instructions);

      await this.yield();
      if (signal.aborted) throw ABORTED;
      const selection = this.collectSelection(snapshot, budget);
      if (selection) drafts.push(selection);

      const previous = this.collectPreviousResults(request, budget, signal);
      if (previous) drafts.push(previous);

      await this.yield();
      if (signal.aborted) throw ABORTED;
      const currentFile = this.collectCurrentFile(request.workspace, snapshot, budget, signal);
      if (currentFile) drafts.push(currentFile);

      // One walk feeds both ranking and the layout summary. They come from the
      // same pass because a project tree is the single most expensive thing this
      // module touches, and paying for it twice per run start is not acceptable.
      const tokens = taskTokens(request.task);
      const walk = this.walkWorkspace(request.workspace, signal);

      const ranked: RankedFile[] = [];
      for (const f of walk.files) {
        if (!f.content) continue;
        const score = scoreFile(f.rel, f.content, tokens);
        if (score >= MIN_RELEVANCE_SCORE) ranked.push({ rel: f.rel, score, content: f.content, size: f.size });
      }
      // Deterministic: relevance first, then path. A tie broken by walk order
      // would make the panel flicker and a test flaky.
      ranked.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));
      filesScanned = walk.scanned;
      filesRanked = ranked.length;

      await this.yield();
      if (signal.aborted) throw ABORTED;

      const relevant = this.collectRelevantCode(ranked, request, snapshot, budget);
      if (relevant) drafts.push(relevant);

      const docs = this.collectDocumentation(ranked, budget);
      if (docs) drafts.push(docs);

      const layout = this.collectStructure(walk.tree, request.workspace, budget);
      if (layout) drafts.push(layout);

      const git = this.collectGit(request.workspace, budget);
      if (git) drafts.push(git);

      const diagnostics = this.collectDiagnostics(snapshot, budget);
      if (diagnostics) drafts.push(diagnostics);

      const openFiles = this.collectOpenFiles(request.workspace, snapshot, budget);
      if (openFiles) drafts.push(openFiles);

      if (signal.aborted) throw ABORTED;
      const bundle = this.finish(request, budget, drafts, "built", started, filesScanned, filesRanked);
      detach?.();
      return bundle;
    } catch (err) {
      detach?.();
      if (err === ABORTED) {
        const bundle = this.finish(request, budget, [], "cancelled", started, filesScanned, filesRanked);
        // A cancelled build is not a cache hit waiting to happen: the point of
        // cancelling is to assemble again, and a stale bundle would be served
        // for a request that was never completed.
        this.cache = null;
        return bundle;
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Phases
  // -------------------------------------------------------------------------

  private collectInstructions(
    workspace: string | null,
    budget: ContextBudget,
    signal: AbortSignal,
  ): PartDraft | null {
    if (!workspace) return null;
    const roots = [workspace];
    // One level down, because a monorepo keeps its rules in the package folder
    // and reading only the root would miss every one of them.
    let subs: string[] = [];
    try {
      subs = fs
        .readdirSync(workspace, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
        .slice(0, 40)
        .map((d) => d.name);
    } catch {
      subs = [];
    }
    for (const sub of subs) roots.push(path.join(workspace, sub));

    const found: Array<{ name: string; text: string }> = [];
    const seen = new Set<string>();
    for (const root of roots) {
      if (signal.aborted) throw ABORTED;
      for (const name of INSTRUCTION_FILES) {
        const file = path.join(root, name);
        if (seen.has(file)) continue;
        seen.add(file);
        let text: string;
        try {
          const st = fs.statSync(file);
          // An instruction file the user has made enormous is not instructions
          // any more; read a bounded head rather than stalling the build.
          if (!st.isFile() || st.size > 256 * 1024) continue;
          text = fs.readFileSync(file, "utf-8");
        } catch {
          continue;
        }
        if (text.trim()) found.push({ name: path.relative(workspace, file).split(path.sep).join("/"), text });
      }
    }
    // Phase 31. User and project instruction files merge into the same part,
    // after the AGENTS.md-style scan, under their scope-prefixed names — so
    // `user:coding-style.md` and `project:security.md` read as what they are.
    // The budget below applies to the merged set, not to either source alone.
    if (signal.aborted) throw ABORTED;
    for (const extra of this.instructions(workspace)) {
      if (extra.text.trim() && !found.some((f) => f.name === extra.name)) {
        found.push({ name: extra.name, text: extra.text });
      }
    }
    if (found.length === 0) return null;

    let remaining = budget.maxInstructionsChars;
    const chunks: string[] = [];
    const files: ContextFileSummary[] = [];
    let clipped = false;
    for (const f of found) {
      if (remaining <= 0) {
        files.push({ path: f.name, score: 0, chars: 0, included: false, reason: "instruction budget spent" });
        continue;
      }
      const c = clip(f.text, remaining);
      if (c.truncated) clipped = true;
      chunks.push(`--- ${f.name} ---\n${c.text}`);
      files.push({
        path: f.name,
        score: 0,
        chars: c.text.length,
        included: true,
        ...(c.truncated ? { reason: "truncated to the instruction budget" } : {}),
      });
      remaining -= c.text.length;
    }
    return { kind: "instructions", label: "Project instructions", text: chunks.join("\n\n"), files, ...(clipped ? { clipped: true } : {}) };
  }

  private collectSelection(snapshot: EditorSnapshot | null, budget: ContextBudget): PartDraft | null {
    const sel = snapshot?.selection;
    if (!sel || !sel.text.trim()) return null;
    const c = clip(sel.text, budget.maxSelectionChars);
    const where = sel.startLine === sel.endLine ? `line ${sel.startLine}` : `lines ${sel.startLine}-${sel.endLine}`;
    const name = snapshot?.activePath ? `${snapshot.activePath} (${where})` : where;
    return {
      kind: "selection",
      label: `Selected code — ${name}`,
      text: "```\n" + c.text + "\n```",
      ...(c.truncated ? { clipped: true } : {}),
    };
  }

  private collectPreviousResults(
    request: ContextRequest,
    budget: ContextBudget,
    signal: AbortSignal,
  ): PartDraft | null {
    if (budget.maxPreviousChars <= 0 || budget.maxPreviousRuns <= 0) return null;
    let runs: PriorRun[];
    try {
      runs = this.history();
    } catch {
      // A history provider that throws must not cost the run its context; the
      // previous-results part is an optimisation, not a requirement.
      return null;
    }
    if (!Array.isArray(runs) || runs.length === 0) return null;

    const chunks: string[] = [];
    const files: ContextFileSummary[] = [];
    let remaining = budget.maxPreviousChars;
    let clipped = false;
    const now = this.now();

    for (const run of runs) {
      if (signal.aborted) throw ABORTED;
      if (chunks.length >= budget.maxPreviousRuns) break;
      // A failed or cancelled run has no answer to reuse, and a child's answer
      // is already in the parent's context by way of `delegate_task`.
      if (run.status !== "completed") continue;
      if (run.id === request.childOf || (request.childOf && run.parentRunId === request.childOf)) continue;
      const text = (run.result?.text ?? "").trim();
      if (!text) continue;
      if (remaining <= 0) {
        files.push({ path: run.id, score: 0, chars: 0, included: false, reason: "previous-results budget spent" });
        continue;
      }
      const c = clip(text, remaining);
      if (c.truncated) clipped = true;
      chunks.push(
        `[${run.agentId}, ${ageLabel(run.createdAt, now)}] task: ${clip(run.task, 160).text}\nresult: ${c.text}`,
      );
      files.push({ path: run.id, score: 0, chars: c.text.length, included: true });
      remaining -= c.text.length;
    }
    if (chunks.length === 0) return null;
    return { kind: "previousResults", label: "Earlier agent work", text: chunks.join("\n\n"), files, ...(clipped ? { clipped: true } : {}) };
  }

  private collectCurrentFile(
    workspace: string | null,
    snapshot: EditorSnapshot | null,
    budget: ContextBudget,
    signal: AbortSignal,
  ): PartDraft | null {
    if (signal.aborted) throw ABORTED;
    const active = snapshot?.activePath ?? null;
    if (!active) return null;
    // The live buffer wins over the file on disk, and that is not a preference:
    // a dirty tab is the code the user is asking about, and sending the saved
    // copy would quietly answer a question about code they are not looking at.
    let body = snapshot?.activeContent ?? "";
    let from = "editor buffer";
    if (!body.trim() && workspace) {
      const confined = confineToWorkspace(active, workspace);
      if (confined) {
        try {
          body = fs.readFileSync(confined, "utf-8");
          from = "disk";
        } catch {
          return null;
        }
      }
    }
    if (!body.trim()) return null;
    const c = clip(body, budget.maxCurrentFileChars);
    const tag = snapshot?.activeDirty ? "unsaved buffer" : "saved file";
    return {
      kind: "currentFile",
      label: `Active file — ${active} (${from}, ${tag})`,
      text: "```\n" + c.text + "\n```",
      ...(c.truncated ? { clipped: true } : {}),
    };
  }

  private collectDocumentation(ranked: RankedFile[], budget: ContextBudget): PartDraft | null {
    if (budget.maxDocFiles <= 0) return null;
    const docs = ranked.filter((f) => isDocFile(f.rel));
    if (docs.length === 0) return null;
    const chunks: string[] = [];
    const files: ContextFileSummary[] = [];
    for (const d of docs) {
      if (chunks.length >= budget.maxDocFiles) {
        files.push({ path: d.rel, score: d.score, chars: 0, included: false, reason: "documentation limit reached" });
        continue;
      }
      const c = clip(d.content, budget.maxDocFileChars);
      chunks.push(`--- ${d.rel} (relevance ${d.score}) ---\n${c.text}`);
      files.push({
        path: d.rel,
        score: d.score,
        chars: c.text.length,
        included: true,
        ...(c.truncated ? { reason: "truncated to the per-file budget" } : {}),
      });
    }
    if (chunks.length === 0) return null;
    return {
      kind: "documentation",
      label: `Relevant documentation — ${chunks.length} file(s)`,
      text: chunks.join("\n\n"),
      files,
    };
  }

  private collectRelevantCode(
    ranked: RankedFile[],
    request: ContextRequest,
    snapshot: EditorSnapshot | null,
    budget: ContextBudget,
  ): PartDraft | null {
    if (ranked.length === 0) return null;
    // Files the user already has in front of them are covered by their own
    // parts. Ranking them again would ship the same bytes twice, which is the
    // one thing a budget is supposed to prevent.
    const already = new Set<string>();
    if (snapshot?.activePath) already.add(snapshot.activePath.toLowerCase());
    for (const p of snapshot?.openPaths ?? []) already.add(p.toLowerCase());

    const chunks: string[] = [];
    const files: ContextFileSummary[] = [];

    for (const f of ranked) {
      if (files.length >= budget.maxRelevantFiles) {
        files.push({ path: f.rel, score: f.score, chars: 0, included: false, reason: "file limit reached" });
        continue;
      }
      if (already.has(f.rel.toLowerCase())) {
        files.push({ path: f.rel, score: f.score, chars: 0, included: false, reason: "already in context" });
        continue;
      }
      // Documentation already shipped under its own heading; sending it again as a
      // code excerpt would double the cost and confuse the model about which one
      // is the project's rule and which is an example.
      if (isDocFile(f.rel)) {
        files.push({ path: f.rel, score: f.score, chars: 0, included: false, reason: "counted as documentation" });
        continue;
      }
      const room = budget.maxRelevantFileChars;
      if (room <= 0) {
        files.push({ path: f.rel, score: f.score, chars: 0, included: false, reason: "per-file budget is zero" });
        continue;
      }
      const c = clip(f.content, room);
      chunks.push(`--- ${f.rel} (relevance ${f.score}) ---\n\`\`\`\n${c.text}\n\`\`\``);
      files.push({
        path: f.rel,
        score: f.score,
        chars: c.text.length,
        included: true,
        ...(c.truncated ? { reason: "truncated to the per-file budget" } : {}),
      });
    }
    if (chunks.length === 0) return null;
    // Counted against the *code* candidates only. Reporting "5 of 7 matched" when
    // two of the seven were documentation sent under its own heading would make
    // the panel describe a filtering decision that never happened.
    const codeCandidates = ranked.filter((f) => !isDocFile(f.rel)).length;
    return {
      kind: "relevantCode",
      label: `Relevant code — ${chunks.length} file(s) of ${codeCandidates} that matched the task`,
      text: chunks.join("\n\n"),
      files,
    };
  }

  private collectStructure(
    tree: TreeNode[],
    workspace: string | null,
    budget: ContextBudget,
  ): PartDraft | null {
    if (tree.length === 0 || !workspace) return null;
    const lines: string[] = [];
    let count = 0;
    const overflow = { n: 0 };

    const emitDir = (name: string, node: TreeNode, depth: number): void => {
      if (count >= budget.maxStructureLines) {
        overflow.n += 1;
        return;
      }
      lines.push(`${"  ".repeat(depth)}${name}/ — ${node.files} file(s)`);
      count += 1;
      if (depth >= 1) return;
      const kids = [...node.children.values()].sort((a, b) => b.files - a.files || a.name.localeCompare(b.name));
      for (const kid of kids) emitDir(kid.name, kid, depth + 1);
    };

    for (const dir of tree) {
      if (count >= budget.maxStructureLines) {
        overflow.n += 1;
        break;
      }
      emitDir(dir.name, dir, 0);
    }
    if (overflow.n > 0) {
      lines.push(`… and ${overflow.n} more entr${overflow.n === 1 ? "y" : "ies"} not shown`);
      count += 1;
    }
    if (lines.length === 0) return null;
    return {
      kind: "structure",
      label: "Project layout",
      text: `Workspace: ${workspace}\n${lines.join("\n")}`,
    };
  }

  private collectGit(workspace: string | null, budget: ContextBudget): PartDraft | null {
    if (!workspace) return null;
    let status: ReturnType<NonNullable<ContextEngineDeps["gitStatus"]>>;
    try {
      status = this.gitStatus(workspace);
    } catch {
      return null;
    }
    if (!status) return null;

    const staged = status.files.filter((f) => f.staged).length;
    const head = status.detached
      ? `detached HEAD (${status.branch})`
      : status.branch;
    const sync =
      status.ahead || status.behind
        ? `, ${status.ahead} ahead / ${status.behind} behind`
        : "";
    const changed = status.files.length;
    const summary =
      changed === 0
        ? `Git: on ${head}${sync}. Working tree clean.`
        : `Git: on ${head}${sync}. ${changed} changed file(s)${staged ? `, ${staged} staged` : ""}.`;

    const shown = status.files.slice(0, budget.maxGitFiles);
    const lines = shown.map((f) => `  ${f.status} ${f.path}`);
    if (changed > shown.length) lines.push(`  … ${changed - shown.length} more`);
    if (lines.length === 0) return null;

    const files: ContextFileSummary[] = status.files.map((f) => ({
      path: f.path,
      score: 0,
      chars: 0,
      included: shown.includes(f),
      ...(shown.includes(f) ? {} : { reason: "changed-file limit reached" }),
    }));
    return {
      kind: "git",
      label: "Git state",
      text: lines.length ? `${summary}\n${lines.join("\n")}` : summary,
      files,
    };
  }

  private collectDiagnostics(snapshot: EditorSnapshot | null, budget: ContextBudget): PartDraft | null {
    const all = snapshot?.diagnostics ?? [];
    if (all.length === 0) return null;
    const rank = (s: string): number => (s === "error" ? 0 : s === "warning" ? 1 : 2);
    // Errors before warnings before hints. A task is usually about one error,
    // and it is that error the model needs to see first.
    const sorted = [...all].sort(
      (a, b) => rank(a.severity) - rank(b.severity) || a.file.localeCompare(b.file) || a.line - b.line,
    );
    const shown = sorted.slice(0, budget.maxDiagnostics);
    const lines = shown.map((d) => `  [${d.severity}] ${d.file}:${d.line}: ${d.message}`);
    if (sorted.length > shown.length) lines.push(`  … ${sorted.length - shown.length} more`);
    const files: ContextFileSummary[] = sorted.map((d) => ({
      path: `${d.file}:${d.line}`,
      score: 0,
      chars: 0,
      included: shown.includes(d),
      ...(shown.includes(d) ? {} : { reason: "diagnostic limit reached" }),
    }));
    return {
      kind: "diagnostics",
      label: `Editor diagnostics — ${shown.length} of ${sorted.length}`,
      text: lines.join("\n"),
      files,
    };
  }

  private collectOpenFiles(
    workspace: string | null,
    snapshot: EditorSnapshot | null,
    budget: ContextBudget,
  ): PartDraft | null {
    if (!workspace || !snapshot) return null;
    const active = snapshot.activePath?.toLowerCase() ?? "";
    const others = snapshot.openPaths
      .filter((p) => p.toLowerCase() !== active)
      .filter((p) => !p.toLowerCase().endsWith(".lock"));
    if (others.length === 0) return null;

    const chunks: string[] = [];
    const files: ContextFileSummary[] = [];
    for (const rel of others) {
      if (chunks.length >= budget.maxOpenFiles) {
        files.push({ path: rel, score: 0, chars: 0, included: false, reason: "open-file limit reached" });
        continue;
      }
      const confined = confineToWorkspace(rel, workspace);
      if (!confined) {
        files.push({ path: rel, score: 0, chars: 0, included: false, reason: "outside the workspace" });
        continue;
      }
      let body: string;
      try {
        const st = fs.statSync(confined);
        if (!st.isFile() || st.size > budget.maxOpenFileChars) {
          files.push({ path: rel, score: 0, chars: 0, included: false, reason: "larger than the per-file budget" });
          continue;
        }
        body = fs.readFileSync(confined, "utf-8");
      } catch {
        files.push({ path: rel, score: 0, chars: 0, included: false, reason: "unreadable" });
        continue;
      }
      if (!body.trim()) continue;
      chunks.push(`--- ${rel} (also open in your editor) ---\n\`\`\`\n${body}\n\`\`\``);
      files.push({ path: rel, score: 0, chars: body.length, included: true });
    }
    if (chunks.length === 0) return null;
    return {
      kind: "openFiles",
      label: "Other open files",
      text: chunks.join("\n\n"),
      files,
    };
  }

  // -------------------------------------------------------------------------
  // Walk
  // -------------------------------------------------------------------------

  private walkWorkspace(workspace: string | null, signal: AbortSignal) {
    const files: Array<{ rel: string; size: number; content: string }> = [];
    const tree: TreeNode[] = [];
    if (!workspace) return { files, tree, scanned: 0 };

    const root: TreeNode = { name: path.basename(workspace), files: 0, bytes: 0, children: new Map() };

    const result = walkWorkspace<null>(workspace, {
      ...RANK_LIMITS,
      maxBytes: this.rankMaxBytes,
      readContent: true,
      accept: ({ rel }) => !isNoiseFile(rel),
      visit: (file) => {
        // The one place cancellation is observed inside a synchronous walk. The
        // walk itself cannot be interrupted, so this converts a wasted walk
        // into a discarded one — bounded to a single 128 KB read.
        if (signal.aborted) throw ABORTED;
        files.push({ rel: file.rel, size: file.size, content: file.content ?? "" });
        const segments = file.rel.split("/");
        let node = root;
        node.files += 1;
        node.bytes += file.size;
        for (let i = 0; i < segments.length - 1; i += 1) {
          const seg = segments[i];
          let child = node.children.get(seg);
          if (!child) {
            child = { name: seg, files: 0, bytes: 0, children: new Map() };
            node.children.set(seg, child);
          }
          child.files += 1;
          child.bytes += file.size;
          node = child;
        }
        return null;
      },
    });

    tree.push(root);
    return { files, tree, scanned: result.scanned };
  }

  // -------------------------------------------------------------------------
  // Packing and summarising
  // -------------------------------------------------------------------------

  /**
   * Greedy fill in a fixed priority order.
   *
   * Priority is not a guess — it is the answer to "what is most expensive for
   * the model to be missing?". The selection is first because it is the most
   * specific statement the user can make. Project instructions and ranked
   * documentation come next because they change the *shape* of the answer, not
   * just its detail: a model that has read the conventions reasons differently
   * from one that has only read the code. Other open tabs are last because
   * `read_file` already exists, so a tab that never makes the cut costs the user
   * one tool call and nothing else.
   */
  private pack(
    drafts: PartDraft[],
    budget: ContextBudget,
  ): { parts: ContextPart[]; text: string; dropped: string[]; substantive: boolean } {
    const order: ContextPartKind[] = [
      "preamble",
      "instructions",
      "documentation",
      "selection",
      "previousResults",
      "currentFile",
      "relevantCode",
      "diagnostics",
      "git",
      "structure",
      "openFiles",
    ];
    const byKind = new Map<ContextPartKind, PartDraft>();
    for (const d of drafts) byKind.set(d.kind, d);

    const parts: ContextPart[] = [];
    const blocks: string[] = [];
    const dropped: string[] = [];
    let used = 0;
    let substantive = false;
    // What `blocks.join(SEP)` costs per boundary. Counted against the budget
    // rather than added afterwards, because a budget that the shipped string can
    // exceed by a few characters is not a budget: the panel would show 4,000 and
    // the prompt would carry 4,004, and the two numbers would both be "true".
    const SEP = "\n\n";

    for (const kind of order) {
      const draft = kind === "preamble" ? { kind, label: "How to use this context", text: PREAMBLE } : byKind.get(kind);
      if (!draft) continue;

      const sep = blocks.length > 0 ? SEP.length : 0;
      const head = heading(draft.label);
      const full = head + draft.text;
      if (used + sep + full.length <= budget.totalChars) {
        parts.push({
          kind: draft.kind,
          label: draft.label,
          // `sep` is charged to the part that needs it — the one that has to be
          // pushed onto an existing block. Attributing it to the *previous* part
          // instead would make the numbers add up to the total while each one
          // lied about what that part costs.
          chars: sep + full.length,
          included: true,
          truncated: draft.clipped === true,
          ...(draft.clipped === true ? { reason: "clipped to this part's own budget" } : {}),
          text: draft.text,
          ...(draft.files ? { files: draft.files } : {}),
        });
        blocks.push(full);
        used += sep + full.length;
        if (draft.kind !== "preamble") substantive = true;
        continue;
      }

      const room = budget.totalChars - used - sep;
      if (room > MIN_USEFUL_ROOM + head.length) {
        const slice = clip(draft.text, room - head.length);
        const block = head + slice.text;
        parts.push({
          kind: draft.kind,
          label: draft.label,
          chars: sep + block.length,
          included: true,
          truncated: true,
          reason: "truncated to fit the total context budget",
          text: slice.text,
          ...(draft.files
            ? {
                files: draft.files.map((f) =>
                  f.included ? { ...f, reason: "truncated to fit the total context budget" } : f,
                ),
              }
            : {}),
        });
        blocks.push(block);
        used += sep + block.length;
        if (draft.kind !== "preamble") substantive = true;
        continue;
      }

      const reason =
        used === 0
          ? "the total context budget is smaller than this part's minimum useful size"
          : "the total context budget was already spent by higher-priority parts";
      parts.push({
        kind: draft.kind,
        label: draft.label,
        chars: 0,
        included: false,
        truncated: false,
        reason,
        ...(draft.files
          ? { files: draft.files.map((f) => (f.included ? { ...f, included: false, reason } : f)) }
          : {}),
      });
      dropped.push(`${draft.label}: ${reason}`);
    }

    return { parts, text: blocks.join(SEP), dropped, substantive };
  }

  private finish(
    request: ContextRequest,
    budget: ContextBudget,
    drafts: PartDraft[],
    status: ContextStatus,
    started: number,
    filesScanned: number,
    filesRanked: number,
  ): ContextBundle {
    const packed =
      status === "built"
        ? this.pack(drafts, budget)
        : { parts: [] as ContextPart[], text: "", dropped: [] as string[], substantive: false };

    // Phase 26. "empty" means there was nothing worth saying, not "the budget was
    // small". The preamble is not context: sending a paragraph that explains how
    // to use context, and nothing else, spends tokens to tell the model nothing
    // it did not already know. So a build whose only included part is the
    // preamble is reported as empty and ships nothing.
    const empty = status === "built" && !packed.substantive;
    const finalStatus: ContextStatus = empty ? "empty" : status;
    const text = empty ? "" : packed.text;
    const totalChars = empty ? 0 : packed.parts.reduce((acc, p) => acc + p.chars, 0);
    const builtAt = this.now();

    const summary: ContextSummary = {
      status: finalStatus,
      totalChars,
      budgetChars: budget.totalChars,
      ms: Math.max(0, builtAt - started),
      builtAt,
      filesScanned,
      filesRanked,
      dropped: packed.dropped,
      parts: packed.parts.map((p) => ({
        kind: p.kind,
        label: p.label,
        chars: p.chars,
        included: p.included,
        truncated: p.truncated,
        ...(p.reason ? { reason: p.reason } : {}),
        preview: p.text ? p.text.slice(0, 600) : "",
        ...(p.files ? { files: p.files } : {}),
      })),
    };

    const bundle: ContextBundle = {
      summary,
      text,
      budget,
      agentId: request.agentId,
      task: request.task,
      workspace: request.workspace,
      childOf: request.childOf ?? null,
    };
    this.lastBundle = bundle;
    this.lastRequest = request;
    this.controller = null;
    // Only a completed build is cached. Cancelling must leave the next request
    // free to do real work.
    if (finalStatus === "built") this.cache = { key: this.cacheKey(request, budget, request.snapshot ?? null), bundle };
    return bundle;
  }

  /**
   * Identity of a build, for the cache.
   *
   * Includes the task, the budget and a cheap signature of the snapshot, but
   * deliberately not the wall clock: a rebuild has to be able to say "nothing
   * changed" for the panel while `force` still re-does the work.
   */
  private cacheKey(request: ContextRequest, budget: ContextBudget, snapshot: EditorSnapshot | null): string {
    const sig = snapshot
      ? [
          snapshot.activePath ?? "",
          String(snapshot.activeContent.length),
          snapshot.activeDirty ? "1" : "0",
          snapshot.selection ? `${snapshot.selection.startLine}-${snapshot.selection.endLine}:${snapshot.selection.text.length}` : "-",
          snapshot.openPaths.join(","),
          `${snapshot.diagnostics.length}:${snapshot.diagnostics[0]?.message ?? ""}`,
        ].join("|")
      : "-";
    return [
      request.agentId,
      request.childOf ?? "",
      request.workspace ?? "",
      request.task,
      budget.totalChars,
      budget.maxRelevantFiles,
      sig,
    ].join(" ");
  }

  /** Hand the event loop back so a pending cancel or a paint can run. */
  private yield(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
}

interface TreeNode {
  name: string;
  files: number;
  bytes: number;
  children: Map<string, TreeNode>;
}

/** Stable, hashable digest of a bundle, used by tests and the panel. */
export function contextBundleKey(bundle: ContextBundle): string {
  return [
    bundle.agentId,
    bundle.childOf ?? "",
    bundle.summary.status,
    bundle.summary.totalChars,
    bundle.summary.parts.map((p) => `${p.kind}:${p.included ? 1 : 0}:${p.chars}`).join(","),
  ].join("|");
}
