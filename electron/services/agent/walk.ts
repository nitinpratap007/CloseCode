// Close Code — AI Agent Runtime — bounded workspace walk (Phase 22)
//
// A shared, synchronous, *bounded* directory walk for the search tools.
//
// It exists because two Phase 22 tools need the same thing — `search_files`
// (substring, from Phase 21) and `grep_files` (regex with line numbers) — and
// because the bounds are security-relevant, not an optimisation. This walk runs
// on the main process, so an unbounded walk over a large workspace freezes the
// whole app while it runs. Everything here exists to make that impossible:
//
//   * **entry budget** — a hard cap on directories examined, so a query that
//     matches nothing still terminates.
//   * **byte budget** — a separate cap on file bodies actually read, which is
//     the worse hazard: a content search over many large files.
//   * **result cap** — stops as soon as the caller has enough to work with.
//   * **depth cap** — bounds pathological nesting.
//
// Three further rules are correctness, not performance:
//
//   * **`.git`, `node_modules` and dotted entries are skipped.** They are either
//     enormous or internal state no tool should report.
//   * **Symlinks are skipped.** A link inside the workspace can point outside it.
//     Following one would read a file the confinement check would then refuse,
//     and report a path that cannot actually be opened.
//   * **The budget is checked at the top of the loop body, before the
//     increment.** Checking at the bottom is wrong in two ways that were both
//     real bugs in Phase 21: a `continue` jumps over a trailing check entirely,
//     and a check placed after the increment lets a parent loop that has just
//     returned from a child recursion count one entry past the budget.

import fs from "fs";
import path from "path";

export interface WalkLimits {
  /** Hard cap on directory entries examined. */
  maxEntries: number;
  /** Hard cap on recursion depth. */
  maxDepth: number;
  /** Stop once this many results have been collected. */
  maxResults: number;
  /** Hard cap on the total bytes of file bodies read. */
  maxBytes: number;
  /** Files larger than this are not read at all (they are still listed). */
  maxFileBytes: number;
}

/** The bounds `search_files` has used since Phase 21, unchanged. */
export const SEARCH_LIMITS: WalkLimits = {
  maxEntries: 5_000,
  maxDepth: 8,
  maxResults: 100,
  maxBytes: 64 * 1024 * 1024,
  maxFileBytes: 1024 * 1024,
};

/** Which budget was spent. `null` means the walk finished the whole tree. */
export type WalkBudget = "entries" | "bytes" | "results";

export interface WalkFile {
  /** Absolute path. */
  full: string;
  /** Path relative to the walk root, with forward slashes. */
  rel: string;
  size: number;
  /**
   * File body, or `null` when it was not read: either the walk was not asked to
   * read bodies, or the file is over `maxFileBytes`.
   */
  content: string | null;
}

/**
 * Produce zero or more results for a file. An array is flattened, so a visitor
 * that yields several hits per file (a content match on many lines) does not have
 * to smuggle them through one return value.
 */
export type WalkVisitor<T> = (file: WalkFile) => T | T[] | null | undefined;

export interface WalkOptions<T> extends WalkLimits {
  /** Read every eligible file body. Off for a name-only search. */
  readContent: boolean;
  /** Reject a file before it is read — e.g. a filename filter. */
  accept?: (file: { full: string; name: string; rel: string }) => boolean;
  visit: WalkVisitor<T>;
}

export interface WalkResult<T> {
  results: T[];
  /** Entries examined. An exact count of the work done, not an approximation. */
  scanned: number;
  bytesRead: number;
  /** A budget was spent, so the results are a prefix of the tree, not all of it. */
  truncated: boolean;
  /** Which budget was spent. */
  budget: WalkBudget | null;
}

function shouldSkip(name: string): boolean {
  return name === ".git" || name === "node_modules" || name.startsWith(".");
}

/**
 * Walk `root` breadth-limited by the budgets in `options`.
 *
 * Synchronous on purpose: the tools that call this run inside a main-process
 * `execute`, and an async walk would interleave thousands of `await`s with the
 * rest of the app's event loop while still holding the main thread for the same
 * total time. Bounding the work is what makes the synchronous choice safe.
 */
export function walkWorkspace<T>(root: string, options: WalkOptions<T>): WalkResult<T> {
  const results: T[] = [];
  let scanned = 0;
  let bytesRead = 0;
  let budget: WalkBudget | null = null;

  const overBudget = (): WalkBudget | null => {
    if (scanned >= options.maxEntries) return "entries";
    if (bytesRead >= options.maxBytes) return "bytes";
    if (results.length >= options.maxResults) return "results";
    return null;
  };

  const walk = (dir: string, depth: number): void => {
    if (depth > options.maxDepth) return;
    if (overBudget()) {
      budget = budget ?? overBudget();
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // An unreadable directory is skipped, not fatal: one locked folder should
      // not fail the whole search.
      return;
    }
    for (const entry of entries) {
      // Top of the body, before the increment. See the note at the top of file.
      const spent = overBudget();
      if (spent) {
        budget = budget ?? spent;
        return;
      }
      scanned += 1;
      if (shouldSkip(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        // A child may have spent the budget; without this the parent loop would
        // keep counting entries after the walk had already decided to stop.
        if (overBudget()) {
          budget = budget ?? overBudget();
          return;
        }
        continue;
      }
      if (results.length >= options.maxResults) {
        budget = budget ?? "results";
        return;
      }

      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        continue;
      }
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (options.accept && !options.accept({ full, name: entry.name, rel })) continue;

      let content: string | null = null;
      if (options.readContent && size <= options.maxFileBytes) {
        if (bytesRead + size > options.maxBytes) {
          budget = budget ?? "bytes";
          return;
        }
        try {
          content = fs.readFileSync(full, "utf-8");
          bytesRead += size;
        } catch {
          continue;
        }
      }

      const produced = options.visit({ full, rel, size, content });
      if (produced === null || produced === undefined) continue;
      if (Array.isArray(produced)) {
        for (const item of produced) results.push(item);
      } else {
        results.push(produced);
      }
    }
  };

  walk(root, 0);

  // A budget can also be spent inside a directory that then completed, so the
  // final state is checked rather than trusting every exit path to have set it.
  const final = overBudget();
  if (final) budget = budget ?? final;

  return { results, scanned, bytesRead, truncated: budget !== null, budget };
}

/** The sentence a bounded search reports, so the model knows it is not seeing everything. */
export function truncationNote(result: { scanned: number; budget: WalkBudget | null }): string {
  switch (result.budget) {
    case "entries":
      return `\n(search stopped after examining ${result.scanned} entries; there may be more matches)`;
    case "bytes":
      return `\n(search stopped after reading a size budget; larger or later files were not searched)`;
    case "results":
      return `\n(showing the first ${result.scanned > 0 ? "matches" : "results"}; more exist)`;
    default:
      return "";
  }
}
