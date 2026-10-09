// Close Code — Phase 16 focused diagnostic for the 8.4 MB file-open stall.
//
// The full harness showed `readFile` on an 8.4 MB file never returning within 120 s
// while the renderer profiler reported 99.9% idle. This script isolates the same
// steps with per-step timing so the stall can be attributed to a specific stage
// (IPC transfer, content cache, Monaco model creation, or the editor renderer).
//
// Usage: node scripts/phase16-largefile-probe.cjs [--mb=8]

"use strict";

const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const EXE = path.join(ROOT, "release", "win-unpacked", "CloseCode.exe");
const PORT = 9241;
const STEP_TIMEOUT = 180000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000;
const q = (v) => JSON.stringify(v);

async function getTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

class Cdp {
  constructor(url) { this.url = url; this.id = 1; this.pending = new Map(); this.closed = false; }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = reject;
      ws.onclose = () => { this.closed = true; for (const p of this.pending.values()) { clearTimeout(p.t); p.reject(new Error("closed")); } this.pending.clear(); };
      ws.onmessage = (e) => {
        let m; try { m = JSON.parse(typeof e.data === "string" ? e.data : Buffer.from(e.data).toString("utf8")); } catch { return; }
        if (m.id === undefined) return;
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.t);
        if (m.error) p.reject(new Error(m.error.message || "error"));
        else p.resolve(m.result || {});
      };
    });
  }
  send(method, params = {}, timeout = 60000) {
    if (this.closed) return Promise.reject(new Error("closed"));
    const id = this.id++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, t });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, timeout = 60000) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true }, timeout);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || "eval error");
    return r.result?.value;
  }
}

function createLargeFile(root, mb) {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, "large.txt");
  const fd = fs.openSync(file, "w");
  const chunk = `${"const largeValue = 1234567890; // perfneedle-large-file\n".repeat(2000)}\n`;
  const chunks = Math.ceil((mb * 1024 * 1024) / chunk.length);
  for (let i = 0; i < chunks; i++) fs.writeSync(fd, chunk);
  fs.closeSync(fd);
  return { root, file, bytes: fs.statSync(file).size };
}

async function main() {
  const mbArg = process.argv.slice(2).find((a) => a.startsWith("--mb="));
  const mb = mbArg ? Number(mbArg.slice(5)) || 8 : 8;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cc-largefile-"));
  const fixture = createLargeFile(path.join(base, "ws"), mb);
  console.log(`fixture: ${fixture.file} (${(fixture.bytes / 1048576).toFixed(2)} MB)`);

  // Warm the file so the measurement is not a cold-cache measurement.
  const warmStart = now();
  {
    const fd = fs.openSync(fixture.file, "r");
    const buf = Buffer.allocUnsafe(1 << 20);
    let read = 0;
    do { read = fs.readSync(fd, buf, 0, buf.length, null); } while (read > 0);
    fs.closeSync(fd);
  }
  console.log(`warm read from node: ${(now() - warmStart).toFixed(1)} ms`);

  const userData = path.join(base, "userdata");
  fs.mkdirSync(userData, { recursive: true });
  const mainLog = path.join(base, "main.log");
  const logFd = fs.openSync(mainLog, "a");
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], { cwd: ROOT, detached: true, windowsHide: true, stdio: ["ignore", logFd, logFd], env: { ...process.env, CC_USER_DATA: userData } });
  child.unref();
  let target = null;
  for (let i = 0; i < 90; i++) {
    await sleep(300);
    try { const list = await getTargets(); target = list.find((t) => t.type === "page") || list[0]; if (target) break; } catch { /* retry */ }
  }
  if (!target) throw new Error("no CDP target");
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send("Runtime.enable");
  const ready = async () => cdp.evaluate(`!!window.__editorStore && !!window.__monacoEditor && document.readyState === "complete"`);
  for (let i = 0; i < 60; i++) { if (await ready()) break; await sleep(300); }

  const step = async (label, expression, timeout = STEP_TIMEOUT) => {
    const started = now();
    try {
      const value = await cdp.evaluate(expression, timeout);
      console.log(`  ${label}: ${(now() - started).toFixed(0)} ms  ${JSON.stringify(value)}`);
      return value;
    } catch (err) {
      console.log(`  ${label}: FAILED after ${(now() - started).toFixed(0)} ms  ${err.message}`);
      return null;
    }
  };

  await step("open workspace", `(async () => { const r = await window.closeCode.openFolder(${q(fixture.root)}); return { ok: !!r.ok }; })()`);
  await step("list workspace dir", `(async () => { const t = performance.now(); await window.closeCode.listDir(${q(fixture.root)}); return { ms: Math.round(performance.now() - t) }; })()`);
  await step("readFile #1 (cold in app)", `(async () => { const t = performance.now(); const r = await window.closeCode.readFile(${q(fixture.file)}); return { ms: Math.round(performance.now() - t), ok: !!r.ok, size: r.result?.size, len: r.result?.content?.length, binary: r.result?.binary }; })()`);
  await step("readFile #2 (warm in app)", `(async () => { const t = performance.now(); const r = await window.closeCode.readFile(${q(fixture.file)}); return { ms: Math.round(performance.now() - t), ok: !!r.ok, size: r.result?.size }; })()`);
  await step("cacheContent only", `(async () => { const t = performance.now(); const r = await window.closeCode.readFile(${q(fixture.file)}); window.__cacheContent(${q(fixture.file)}, r.result.content); return { ms: Math.round(performance.now() - t) }; })()`);
  await step("openFileInWorkspace (no model yet)", `(async () => { const t = performance.now(); await window.__editorStore.getState().openFileInWorkspace(${q(fixture.file)}); return { ms: Math.round(performance.now() - t), active: window.__editorStore.getState().activePath, tabs: window.__editorStore.getState().tabs.length }; })()`);
  await step("model attached", `(() => { const m = window.__monacoEditor?.getModel(); return { hasModel: !!m, lines: m?.getLineCount(), len: m?.getValueLength() }; })()`);
  await step("wait 2 frames", `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`);
  await step("openFileInWorkspace #2 (already a tab)", `(async () => { const t = performance.now(); await window.__editorStore.getState().openFileInWorkspace(${q(fixture.file)}); return { ms: Math.round(performance.now() - t) }; })()`);
  await step("tab switch away+back", `(async () => {
    const p = ${q(fixture.file)};
    const other = p.replace("large.txt", "other.txt");
    window.__editorStore.getState().setActive(other);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const t = performance.now();
    window.__editorStore.getState().setActive(p);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { ms: Math.round(performance.now() - t) };
  })()`);

  try { cdp.ws.close(); } catch { /* ignore */ }
  try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch { /* gone */ }
  await sleep(1500);
  console.log("main-process perf log:");
  try {
    for (const line of fs.readFileSync(mainLog, "utf8").split(/\r?\n/)) {
      if (line.includes("[perf-read]")) console.log(`  ${line.trim()}`);
    }
  } catch { console.log("  (no main-process log captured)"); }
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); break; } catch { await sleep(1000); }
  }
}

main().catch((err) => { console.error(err?.stack || err); process.exitCode = 1; });
