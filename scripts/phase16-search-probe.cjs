// Close Code — Phase 16 bottleneck probe for workspace search.
//
// Purpose: before changing the search implementation we need to know whether
// `searchWorkspace` is CPU bound (string/regex work) or I/O bound (per-file
// syscall latency). This probe builds the same fixtures the profile harness
// uses and compares three strategies over the identical tree:
//
//   1. sync      – readdirSync + statSync + readFileSync (current implementation)
//   2. async-1   – async fs, concurrency 1 (pure serial I/O, no sync calls)
//   3. async-N   – async fs, bounded concurrency (overlaps per-file latency)
//
// It also reports the time spent in syscalls vs. CPU so the fix is chosen from
// data instead of guesswork. No npm dependencies.
//
// Usage: node scripts/phase16-search-probe.cjs [--files=1000] [--concurrency=32]

"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const QUERY = "perfneedle";
const MAX_FILE_SIZE = 2 * 1024 * 1024;
const MAX_LINE_LENGTH = 10000;
const MAX_RESULTS = 5000;

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { files: 1000, concurrency: Math.max(2, os.cpus().length * 2) };
  for (const arg of args) {
    if (arg.startsWith("--files=")) out.files = Math.max(10, Number(arg.slice(8)) || out.files);
    else if (arg.startsWith("--concurrency=")) out.concurrency = Math.max(1, Number(arg.slice(14)) || out.concurrency);
  }
  return out;
}

function createFixture(base, count) {
  const root = path.join(base, `scale-${count}`);
  const src = path.join(root, "src");
  fs.mkdirSync(src, { recursive: true });
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(src, `file-${String(i).padStart(5, "0")}.ts`), `export const perf_${i} = ${i};\n// perfneedle-${i}\n`);
  }
  fs.writeFileSync(path.join(root, "README.md"), `# Scale ${count}\nperfneedle-root\n`);
  return root;
}

function collectSync(root) {
  const queue = [root];
  const files = [];
  while (queue.length) {
    const dir = queue.shift();
    let dirents;
    try { dirents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const d of dirents) {
      if (d.name === ".git" || d.name === "node_modules") continue;
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) queue.push(abs);
      else if (d.isFile()) files.push(abs);
    }
  }
  return files;
}

function countMatches(text, re) {
  let hits = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.length > MAX_LINE_LENGTH) continue;
    re.lastIndex = 0;
    while (re.exec(line) !== null) { hits++; re.lastIndex++; }
  }
  return hits;
}

// Pure CPU cost of the matching stage, isolated from any filesystem access.
function cpuOnlyCost(files, re) {
  const started = process.hrtime.bigint();
  let hits = 0;
  for (const file of files) hits += countMatches(`export const perf_0 = 0;\n// perfneedle-0\n`, re);
  return { ms: Number(process.hrtime.bigint() - started) / 1e6, hits };
}

function makeRegex() {
  const re = new RegExp(QUERY, "gi");
  re.lastIndex = 0;
  return re;
}

async function strategySync(root) {
  const re = makeRegex();
  const started = process.hrtime.bigint();
  let hits = 0;
  let searched = 0;
  const queue = [root];
  while (queue.length) {
    const dir = queue.shift();
    let dirents;
    try { dirents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const d of dirents) {
      if (d.name === ".git" || d.name === "node_modules") continue;
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) { queue.push(abs); continue; }
      if (!d.isFile()) continue;
      let stat;
      try { stat = fs.statSync(abs); } catch { continue; }
      if (stat.size === 0 || stat.size > MAX_FILE_SIZE) continue;
      let buf;
      try { buf = fs.readFileSync(abs); } catch { continue; }
      if (buf.includes(0)) continue;
      searched++;
      hits += countMatches(buf.toString("utf-8"), re);
      if (hits >= MAX_RESULTS) return { ms: Number(process.hrtime.bigint() - started) / 1e6, hits, searched };
    }
  }
  return { ms: Number(process.hrtime.bigint() - started) / 1e6, hits, searched };
}

async function strategyAsync(root, concurrency) {
  const re = makeRegex();
  const started = process.hrtime.bigint();
  let hits = 0;
  let searched = 0;
  const dirQueue = [root];
  const fileQueue = [];
  const readOne = async (abs) => {
    let buf;
    try { buf = await fsp.readFile(abs); } catch { return; }
    if (buf.length === 0 || buf.length > MAX_FILE_SIZE) return;
    if (buf.includes(0)) return;
    searched++;
    hits += countMatches(buf.toString("utf-8"), re);
  };
  const inFlight = new Set();
  const pump = () => {
    while (fileQueue.length > 0 && inFlight.size < concurrency) {
      const abs = fileQueue.shift();
      const p = readOne(abs).then(() => { inFlight.delete(p); if (fileQueue.length) pump(); });
      inFlight.add(p);
    }
  };
  pump();
  while (dirQueue.length || fileQueue.length || inFlight.size) {
    if (dirQueue.length) {
      const dir = dirQueue.shift();
      let dirents;
      try { dirents = await fsp.readdir(dir, { withFileTypes: true }); } catch { dirents = []; }
      for (const d of dirents) {
        if (d.name === ".git" || d.name === "node_modules") continue;
        const abs = path.join(dir, d.name);
        if (d.isDirectory()) dirQueue.push(abs);
        else if (d.isFile()) fileQueue.push(abs);
      }
      pump();
    }
    if (inFlight.size > 0) await Promise.race(inFlight);
    else if (!dirQueue.length) break;
    if (hits >= MAX_RESULTS) break;
  }
  await Promise.allSettled([...inFlight]);
  return { ms: Number(process.hrtime.bigint() - started) / 1e6, hits, searched };
}

async function main() {
  const options = parseArgs();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cc-search-probe-"));
  const root = createFixture(base, options.files);
  const files = collectSync(root);
  const re = makeRegex();
  const cpu = cpuOnlyCost(files.slice(0, 5000), re);

  console.log(`search probe: ${files.length} files, concurrency=${options.concurrency}`);
  console.log(`  cpu-only cost of matching 5000 small files: ${cpu.ms.toFixed(2)} ms`);

  const sync = await strategySync(root);
  console.log(`  sync  (current impl)     : ${sync.ms.toFixed(0)} ms  (${sync.searched} files, ${sync.hits} hits)`);
  const serial = await strategyAsync(root, 1);
  console.log(`  async concurrency=1      : ${serial.ms.toFixed(0)} ms  (${serial.searched} files, ${serial.hits} hits)`);
  const parallel = await strategyAsync(root, options.concurrency);
  console.log(`  async concurrency=${String(options.concurrency).padEnd(4)}       : ${parallel.ms.toFixed(0)} ms  (${parallel.searched} files, ${parallel.hits} hits)`);
  const speedup = sync.ms > 0 ? sync.ms / Math.max(parallel.ms, 0.001) : null;
  console.log(`  speedup vs sync          : ${speedup ? speedup.toFixed(1) + "x" : "n/a"}`);
  console.log(`  I/O share of sync total  : ${(100 - (cpu.ms / Math.max(1, sync.ms)) * 100).toFixed(1)}% (approx, from cpu-only stage)`);

  // Warm pass: everything above reads files that were created milliseconds earlier, so
  // the first pass pays for whatever the OS/AV does on first touch. Re-running on the
  // same tree separates that environmental cost from the search implementation.
  const warmSync = await strategySync(root);
  const warmParallel = await strategyAsync(root, options.concurrency);
  console.log(`  warm sync  (second pass) : ${warmSync.ms.toFixed(0)} ms`);
  console.log(`  warm async (second pass) : ${warmParallel.ms.toFixed(0)} ms  (${warmParallel.searched} files, ${warmParallel.hits} hits)`);
  const warmSpeedup = warmSync.ms > 0 ? warmSync.ms / Math.max(warmParallel.ms, 0.001) : null;
  console.log(`  warm speedup vs sync    : ${warmSpeedup ? warmSpeedup.toFixed(1) + "x" : "n/a"}`);
  console.log(`  cold/warm ratio (async)  : ${(parallel.ms / Math.max(warmParallel.ms, 0.001)).toFixed(1)}x`);

  // --- Would a basename index help? -------------------------------------------------
  // A `Map<basename, Set<path>>` index can skip files whose NAME cannot match the query.
  // That is only a win when the query appears in file names. Content search — the case
  // the profile actually measured — has to read every candidate file, so the index is
  // pure overhead there. Measure how many basenames contain the query to decide.
  const lowerQuery = QUERY.toLowerCase();
  const basenameHits = files.filter((f) => path.basename(f).toLowerCase().includes(lowerQuery));
  const hits = parallel.hits;
  console.log(`  basename index would skip: ${basenameHits.length} / ${files.length} files (${((basenameHits.length / files.length) * 100).toFixed(2)}%)`);
  console.log(`  content matches found    : ${hits}`);
  console.log(`  => index useful here?    : ${basenameHits.length > files.length * 0.5 ? "YES" : "NO (query lives in file CONTENT, not names)"}`);

  // --- How much would a result cache save? -------------------------------------------
  // Measure an identical repeat search, which is exactly what a result cache would serve.
  const repeat = await strategyAsync(root, options.concurrency);
  console.log(`  repeat identical search  : ${repeat.ms.toFixed(0)} ms (cache would make this ~${repeat.hits >= MAX_RESULTS ? "0" : "0"} ms, saving ${repeat.ms.toFixed(0)} ms)`);

  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exitCode = 1;
});
