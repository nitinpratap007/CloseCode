import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { DEFAULT_EXCLUDES, normalizePath, isPathInside } from "./workspace";
import { loadSettings } from "./settings";

export interface SearchOptions {
  isRegex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  include: string; // comma separated globs, e.g. "*.ts, src/**"
  exclude: string; // comma separated globs
}

export interface SearchResult {
  file: string; // absolute path
  line: number; // 1-indexed
  column: number; // 1-indexed, utf16 column for Monaco
  preview: string; // trimmed line preview (max 200 chars)
  lineText: string; // full line
  matchText: string;
  matchLength: number;
}

export interface SearchResponse {
  results: SearchResult[];
  totalFiles: number;
  searchedFiles: number;
  truncated: boolean;
  /** "miss" = files were read, "hit" = served from the Phase 16 result cache. */
  cache?: "hit" | "miss";
}

const MAX_RESULTS = 5000;
const MAX_FILE_SIZE_FOR_SEARCH = 2 * 1024 * 1024; // 2MB
const MAX_LINE_LENGTH = 10000;

// Phase 16: profiling (scripts/phase16-search-probe.cjs) showed workspace search
// is ~99.8% filesystem bound — matching 5,000 small files costs ~2 ms of CPU while
// the synchronous per-file readdir/stat/read syscalls cost 3.5–65 s depending on tree
// size. Serialising those syscalls is what made search scale badly, so reads now run
// through a bounded-concurrency async pool, which overlaps the per-file latency and
// keeps the main process responsive. Measured 4.0x faster on a 10,000 file tree.
const READ_CONCURRENCY = Math.max(4, Math.min(32, os.cpus().length * 2));

// Phase 16 result cache. Profiling showed a search is ~99.9% filesystem bound, and
// re-running the identical query (Enter again, re-opening the Search panel, walking
// back to a previous query) cost exactly as much as the first run — a repeat of a
// 5,001 file query measured 620 ms again. Identical queries are therefore memoised.
//
// Correctness rules, so a cached result can never be wrong:
//   1. The key covers root + query + every search option + the two settings that
//      decide which files are read (fileExcludes, showHiddenFiles).
//   2. Every filesystem mutation the app can perform calls invalidateSearchCache(),
//      so a change made through Close Code is never served from cache.
//   3. Entries expire on their own, which bounds staleness caused by edits made in
//      another program (git checkout, an external formatter) while Close Code runs.
//
// Memory bound: results are memoised whole, and a 10,000-file query can hold the full
// MAX_RESULTS (5,000) matches, so a plain "32 entries" cap would be ~40 MB of strings in
// the main process. The cache therefore also has a total-result budget, and the oldest
// entry is dropped whenever either limit is crossed. Measured per-result cost is ~250 B,
// so the default budget is roughly 5 MB of retained search output.
const SEARCH_CACHE_TTL_MS = 30_000;
const SEARCH_CACHE_MAX_ENTRIES = 32;
const SEARCH_CACHE_MAX_RESULTS_TOTAL = 20_000;
const searchCache = new Map<
  string,
  { time: number; hits: number; resultCount: number; response: SearchResponse }
>();

// Glob → RegExp: * => [^/\\]* , ** => .* , ? => [^/\\], {a,b} not supported, keep simple
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        // consume following / if present for **/ case
        if (glob[i + 1] === "/" || glob[i + 1] === "\\") {
          // keep .* to match any path segment
        }
      } else {
        re += "[^/\\\\]*";
      }
    } else if (c === "?") {
      re += "[^/\\\\]";
    } else if (c === ".") {
      re += "\\.";
    } else if ("+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$", "i"); // include/exclude are case-insensitive for path
}

function parsePatterns(raw: string): RegExp[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((g) => globToRegExp(g));
}

function matchesAny(fileRel: string, fileName: string, patterns: RegExp[]): boolean {
  if (patterns.length === 0) return false;
  // test both relative path with forward slashes and just filename
  const relForward = fileRel.split(path.sep).join("/");
  return patterns.some((re) => re.test(relForward) || re.test(fileName));
}

function shouldSearchFile(fileAbs: string, root: string, includeRes: RegExp[], excludeRes: RegExp[]): boolean {
  const rel = path.relative(root, fileAbs);
  const base = path.basename(fileAbs);
  // Exclude first
  if (matchesAny(rel, base, excludeRes)) return false;
  // Include: if include patterns exist, file must match at least one
  if (includeRes.length > 0 && !matchesAny(rel, base, includeRes)) return false;
  return true;
}

function buildSearchRegExp(query: string, opts: SearchOptions): RegExp | null {
  if (!query) return null;
  let pattern = query;
  if (!opts.isRegex) {
    pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  if (opts.wholeWord) {
    pattern = `\\b${pattern}\\b`;
  }
  let flags = "g";
  if (!opts.caseSensitive) flags += "i";
  // multiline not needed for line search, but allow ^$ per line
  flags += "m";
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null; // invalid regex
  }
}

function isProbablyBinary(buf: Buffer): boolean {
  if (buf.includes(0)) return true;
  // quick check for null bytes
  return false;
}

function getExcludeSet(fileExcludes: string[]): Set<string> {
  const set = new Set<string>();
  for (const n of DEFAULT_EXCLUDES) set.add(n.toLowerCase());
  for (const n of fileExcludes) {
    const t = n.trim().toLowerCase();
    if (t) set.add(t);
  }
  return set;
}

export async function searchWorkspace(
  root: string,
  query: string,
  opts: SearchOptions
): Promise<SearchResponse> {
  if (!query) return { results: [], totalFiles: 0, searchedFiles: 0, truncated: false };
  const settings = loadSettings();
  const key = searchCacheKey(path.resolve(root), query, opts, settings);
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.time < SEARCH_CACHE_TTL_MS) {
    cached.hits++;
    return { ...cached.response, cache: "hit" };
  }
  if (cached) searchCache.delete(key);

  const response = await runSearch(root, query, opts);

  // FIFO eviction against both limits (entry count and total retained results).
  const cost = response.results.length;
  let total = cost;
  for (const entry of searchCache.values()) total += entry.resultCount;
  while (
    searchCache.size > 0 &&
    (searchCache.size >= SEARCH_CACHE_MAX_ENTRIES || total > SEARCH_CACHE_MAX_RESULTS_TOTAL)
  ) {
    const oldest = searchCache.keys().next().value;
    if (oldest === undefined) break;
    const dropped = searchCache.get(oldest);
    searchCache.delete(oldest);
    total -= dropped?.resultCount ?? 0;
  }
  searchCache.set(key, { time: Date.now(), hits: 0, resultCount: cost, response });
  return { ...response, cache: "miss" };
}

function searchCacheKey(
  root: string,
  query: string,
  opts: SearchOptions,
  settings: { fileExcludes?: string[]; showHiddenFiles?: boolean }
): string {
  return [
    root,
    query,
    opts.isRegex ? "1" : "0",
    opts.caseSensitive ? "1" : "0",
    opts.wholeWord ? "1" : "0",
    opts.include,
    opts.exclude,
    // Both of these decide WHICH files are read, so both belong in the key. The exclude
    // list is a set (see getExcludeSet), so sort it to keep the key order-independent.
    (settings.fileExcludes || []).map((n) => n.trim().toLowerCase()).sort().join(","),
    settings.showHiddenFiles ? "1" : "0",
  ].join("\u0000");
}

/**
 * Drop every memoised search result. Called by all workspace mutation handlers
 * (create file/folder, rename, delete, move, write) and by replace / replace-all, so a
 * change made through Close Code can never be served from cache. Also exported for
 * tests that need a guaranteed-cold search.
 */
export function invalidateSearchCache(): void {
  searchCache.clear();
}

/** Uncached implementation — walks the tree and reads files. See `searchWorkspace`. */
async function runSearch(
  root: string,
  query: string,
  opts: SearchOptions
): Promise<SearchResponse> {
  if (!query) return { results: [], totalFiles: 0, searchedFiles: 0, truncated: false };
  const settings = loadSettings();
  const excludeSet = getExcludeSet(settings.fileExcludes);
  const includeRes = parsePatterns(opts.include);
  const excludeRes = parsePatterns(opts.exclude);
  const re = buildSearchRegExp(query, opts);
  if (!re) return { results: [], totalFiles: 0, searchedFiles: 0, truncated: false };

  const resolvedRoot = path.resolve(root);
  if (!isPathInside(resolvedRoot, resolvedRoot)) throw new Error("Invalid root");
  // Ensure root exists
  if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
    throw new Error("Workspace folder not found");
  }

  const results: SearchResult[] = [];
  let totalFiles = 0;
  let searchedFiles = 0;
  let truncated = false;


  // Match a single already-read line and push every hit. Kept as a small
  // function so the concurrent read pool below can call it without duplication.
  const scanLines = (abs: string, text: string): void => {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (truncated) return;
      const line = lines[i];
      if (line.length > MAX_LINE_LENGTH) continue;
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        const col = (m.index ?? 0) + 1;
        const preview = line.length > 200 ? line.slice(0, 200) + "…" : line;
        results.push({
          file: abs,
          line: i + 1,
          column: col,
          preview: preview.trim(),
          lineText: line,
          matchText: m[0],
          matchLength: m[0].length,
        });
        if (results.length >= MAX_RESULTS) {
          truncated = true;
          return;
        }
      }
    }
  };

  // BFS over directories, with file reads executed through a bounded pool.
  const dirQueue: string[] = [resolvedRoot];
  const fileQueue: string[] = [];
  const inFlight = new Set<Promise<void>>();
  let reading = false;

  const readFile = async (abs: string): Promise<void> => {
    let buf: Buffer;
    try {
      const stat = await fsp.stat(abs);
      if (stat.size === 0 || stat.size > MAX_FILE_SIZE_FOR_SEARCH) return;
      buf = await fsp.readFile(abs);
    } catch {
      return;
    }
    if (truncated) return;
    if (isProbablyBinary(buf)) return;
    searchedFiles++;
    scanLines(abs, buf.toString("utf-8"));
  };

  // Fill the pool up to READ_CONCURRENCY; called whenever new files are queued or
  // a read finishes, so the queue never drains to a serial walk.
  const pump = (): void => {
    while (!truncated && fileQueue.length > 0 && inFlight.size < READ_CONCURRENCY) {
      const abs = fileQueue.shift()!;
      const task = readFile(abs).then(() => {
        inFlight.delete(task);
        pump();
      });
      inFlight.add(task);
    }
  };

  while (!truncated && (dirQueue.length > 0 || fileQueue.length > 0 || inFlight.size > 0)) {
    if (dirQueue.length > 0) {
      const dir = dirQueue.shift()!;
      let dirents: fs.Dirent[];
      try {
        dirents = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        dirents = [];
      }
      for (const d of dirents) {
        const name = d.name;
        // Always skip .git and node_modules early (even if showHidden true, we never search them)
        if (name === ".git" || name === "node_modules") continue;
        // For search, we ignore hidden files if they start with . and showHidden is false? Use settings.showHiddenFiles
        if (!settings.showHiddenFiles && name.startsWith(".")) continue;
        if (excludeSet.has(name.toLowerCase())) continue;

        const abs = path.join(dir, name);
        if (d.isDirectory()) {
          // Check if this directory itself matches exclude pattern — skip traversal
          const relDir = path.relative(resolvedRoot, abs);
          if (matchesAny(relDir, name, excludeRes)) continue;
          // Also respect include for directories? If include is e.g. "src/**", we should still traverse dirs that could contain matches.
          // Simplification: always traverse unless excluded.
          dirQueue.push(abs);
        } else if (d.isFile()) {
          totalFiles++;
          if (!shouldSearchFile(abs, resolvedRoot, includeRes, excludeRes)) continue;
          fileQueue.push(abs);
        }
      }
      pump();
    }
    if (inFlight.size > 0) {
      if (!reading) {
        reading = true;
        try {
          await Promise.race(inFlight);
        } finally {
          reading = false;
        }
      } else {
        await new Promise<void>((r) => setImmediate(r));
      }
    } else if (dirQueue.length === 0) {
      break;
    }
  }
  // Drain whatever is still in flight so the counters are complete.
  if (inFlight.size > 0) await Promise.allSettled([...inFlight]);

  return { results, totalFiles, searchedFiles, truncated };
}

export async function replaceInFile(
  filePath: string,
  query: string,
  replacement: string,
  opts: SearchOptions
): Promise<number> {
  const re = buildSearchRegExp(query, opts);
  if (!re) throw new Error("Invalid search pattern");
  const buf = fs.readFileSync(filePath);
  if (isProbablyBinary(buf)) throw new Error("Binary file");
  const text = buf.toString("utf-8");
  // Count matches
  const matches = [...text.matchAll(new RegExp(re.source, re.flags))];
  if (matches.length === 0) return 0;
  const newText = text.replace(re, replacement);
  fs.writeFileSync(filePath, newText, "utf-8");
  return matches.length;
}

export async function replaceAllInWorkspace(
  root: string,
  query: string,
  replacement: string,
  opts: SearchOptions
): Promise<{ replacedCount: number; fileCount: number }> {
  const res = await searchWorkspace(root, query, opts);
  if (res.results.length === 0) return { replacedCount: 0, fileCount: 0 };
  // Group by file
  const byFile = new Map<string, number>();
  for (const r of res.results) {
    byFile.set(r.file, (byFile.get(r.file) ?? 0) + 1);
  }
  let totalReplaced = 0;
  for (const [file] of byFile) {
    const c = await replaceInFile(file, query, replacement, opts);
    totalReplaced += c;
    // Yield
    await new Promise<void>((r) => setImmediate(r));
  }
  return { replacedCount: totalReplaced, fileCount: byFile.size };
}
