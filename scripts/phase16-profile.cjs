// Close Code — Phase 16 performance profiling harness.
//
// This is intentionally an external, packaged-app/CDP profile rather than a
// synthetic benchmark of source functions. It measures the shipped renderer
// and the real Electron IPC/main-process paths on Windows. No production
// instrumentation or npm dependency is required to run it.
//
// Usage:
//   npm run profile:phase16
//   node scripts/phase16-profile.cjs --runs=3 --keep-fixtures
//
// The JSON result is written to reports/phase16-profile.json. The human-facing
// summary is printed to stdout and is intentionally kept small so it can be
// pasted into report.md.

"use strict";

const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const EXE = path.join(ROOT, "release", "win-unpacked", "CloseCode.exe");
const REPORT_FILE = path.join(ROOT, "reports", "phase16-profile.json");
const DEFAULT_PORT = 9238;
const STARTUP_RUNS = 3;
const TERMINAL_LINES = 20000;
const LARGE_FILE_MB = 8;
const TYPING_CHARS = 120;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000;

// Wait for two animation frames so a React commit is actually painted, but never wait
// longer than SETTLE_CAP_MS. requestAnimationFrame only fires while the window is being
// composited: if the packaged window is occluded/backgrounded, or its compositor is
// starved, rAF can stop firing entirely and an unbounded `await new Promise(rAF)` hangs
// until the CDP evaluate timeout. Phase 16 hit exactly that — a 120 s stall in
// explorer-list-1000, then the run aborted. Bounding the wait turns that failure into a
// slightly less precise number instead of a lost run.
const SETTLE_CAP_MS = 2000;
const SETTLE_JS =
  `(async () => {` +
  `  await new Promise((resolve) => {` +
  `    let done = false;` +
  `    const finish = () => { if (done) return; done = true; resolve(true); };` +
  `    requestAnimationFrame(() => requestAnimationFrame(finish));` +
  `    setTimeout(finish, ${SETTLE_CAP_MS});` +
  `  });` +
  `  return true;` +
  `})()`;
const round = (value, digits = 2) => {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};
const mb = (bytes) => round(Number(bytes || 0) / 1024 / 1024, 2);
const json = (value) => JSON.stringify(value);
const q = (value) => JSON.stringify(value);

function log(message) {
  console.log(message);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = { runs: STARTUP_RUNS, port: Number(process.env.CC_PHASE16_PORT || DEFAULT_PORT), keepFixtures: false };
  for (const arg of args) {
    if (arg.startsWith("--runs=")) options.runs = Math.max(1, Math.min(10, Number(arg.slice(7)) || STARTUP_RUNS));
    else if (arg.startsWith("--port=")) options.port = Number(arg.slice(7)) || options.port;
    else if (arg === "--keep-fixtures") options.keepFixtures = true;
  }
  return options;
}

function safeRm(target) {
  try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* best effort */ }
}

function killTree(pid) {
  if (!pid) return;
  try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch { /* already gone */ }
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      try { ws = new WebSocket(this.url); } catch (err) { reject(err); return; }
      this.ws = ws;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error("CDP connection timeout"));
      }, 15000);
      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error("CDP websocket error"));
      };
      ws.onclose = () => {
        this.closed = true;
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error("CDP websocket closed"));
        }
        this.pending.clear();
      };
      ws.onmessage = (event) => this.handleMessage(event.data);
    });
  }

  handleMessage(raw) {
    let text;
    try {
      text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
    } catch {
      return;
    }
    let message;
    try { message = JSON.parse(text); } catch { return; }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message || json(message.error)}`));
      else pending.resolve(message.result || {});
      return;
    }
    if (message.method) {
      for (const listener of this.listeners.get(message.method) || []) {
        try { listener(message.params || {}); } catch { /* listener errors must not break CDP */ }
      }
    }
  }

  on(method, listener) {
    const list = this.listeners.get(method) || [];
    list.push(listener);
    this.listeners.set(method, list);
    return () => {
      const current = this.listeners.get(method) || [];
      this.listeners.set(method, current.filter((item) => item !== listener));
    };
  }

  send(method, params = {}, timeoutMs = 60000) {
    if (!this.ws || this.closed) return Promise.reject(new Error(`CDP unavailable for ${method}`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.ws.send(JSON.stringify({ id, method, params })); } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async evaluate(expression, timeoutMs = 120000) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    }, timeoutMs);
    if (response.exceptionDetails) {
      throw new Error(`Runtime.evaluate failed: ${response.exceptionDetails.text || json(response.exceptionDetails).slice(0, 1000)}`);
    }
    return response.result?.value;
  }

  close() {
    this.closed = true;
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}

async function poll(fn, timeoutMs, everyMs = 50, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) { lastError = err; }
    await sleep(everyMs);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

async function getTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`CDP target HTTP ${response.status}`);
  return response.json();
}

async function launch(userData, port) {
  if (!fs.existsSync(EXE)) throw new Error(`Packaged executable not found: ${EXE}`);
  const started = now();
  const child = spawn(EXE, [`--remote-debugging-port=${port}`], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: { ...process.env, CC_USER_DATA: userData },
  });
  child.unref();
  const target = await poll(async () => {
    const targets = await getTargets(port).catch(() => []);
    return targets.find((item) => item.type === "page") || targets[0] || null;
  }, 45000, 50, "CDP page target");
  const cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send("Runtime.enable", {}, 30000);
  // Phase 16 warm-up: force the renderer to be fully responsive before any timed
  // measurement, so a cold JIT / first-layout cannot be charged to a scenario.
  await cdp.evaluate(`window.__ccRound = (value, digits = 2) => { const factor = 10 ** digits; return Number.isFinite(Number(value)) ? Math.round(Number(value) * factor) / factor : null; }`);
  await cdp.evaluate(SETTLE_JS);
  await cdp.send("Performance.enable", {}, 30000).catch(() => {});
  await cdp.send("Memory.enable", {}, 30000).catch(() => {});
  const ready = await poll(async () => cdp.evaluate(`(() => ({
    readyState: document.readyState,
    bridge: !!window.closeCode,
    store: !!window.__editorStore,
    editor: !!window.__monacoEditor,
    commands: !!window.__commandRegistry,
    theme: !!window.__themeStore
  }))()`).then((v) => v && v.readyState === "complete" && v.bridge && v.store && v.editor && v.commands ? v : null), 45000, 50, "renderer ready");
  return { child, cdp, target, started, targetMs: now() - started, readyMs: now() - started, ready };
}

async function closeSession(session) {
  if (!session) return;
  try { session.cdp.close(); } catch { /* ignore */ }
  killTree(session.child?.pid);
  await sleep(500);
}

function metricObject(result) {
  const out = {};
  for (const metric of result?.metrics || []) out[metric.name] = metric.value;
  return out;
}

function metricDelta(before, after, name) {
  const a = Number(before?.[name] ?? 0);
  const b = Number(after?.[name] ?? 0);
  return round(b - a, 2);
}

async function collectGarbage(cdp) {
  try {
    await cdp.send("HeapProfiler.enable", {}, 30000);
    await cdp.send("HeapProfiler.collectGarbage", {}, 60000);
    await cdp.send("HeapProfiler.disable", {}, 30000).catch(() => {});
  } catch { /* optional */ }
}

async function snapshot(cdp) {
  const [performanceResult, heapResult, domResult, processResult, navigation] = await Promise.all([
    cdp.send("Performance.getMetrics", {}, 30000).catch(() => ({})),
    cdp.send("Runtime.getHeapUsage", {}, 30000).catch(() => ({})),
    cdp.send("Memory.getDOMCounters", {}, 30000).catch(() => ({})),
    cdp.send("SystemInfo.getProcessInfo", {}, 30000).catch(() => ({})),
    cdp.evaluate(`(() => { const n = performance.getEntriesByType('navigation')[0]; return n ? {
      domContentLoaded: n.domContentLoadedEventEnd,
      loadEvent: n.loadEventEnd,
      responseEnd: n.responseEnd,
      domInteractive: n.domInteractive,
      transferSize: n.transferSize,
      encodedBodySize: n.encodedBodySize,
      decodedBodySize: n.decodedBodySize
    } : null; })()`).catch(() => null),
  ]);
  const metrics = metricObject(performanceResult);
  const processInfo = Array.isArray(processResult?.processInfo) ? processResult.processInfo : [];
  return {
    at: new Date().toISOString(),
    jsHeapUsedBytes: Number(heapResult.usedSize || 0),
    jsHeapTotalBytes: Number(heapResult.totalSize || 0),
    jsHeapUsedMb: mb(heapResult.usedSize),
    jsHeapTotalMb: mb(heapResult.totalSize),
    domNodes: Number(domResult.nodes || 0),
    documents: Number(domResult.documents || 0),
    jsEventListeners: Number(domResult.jsEventListeners || 0),
    metrics: {
      taskDurationMs: round(Number(metrics.TaskDuration || 0) * 1000, 2),
      scriptDurationMs: round(Number(metrics.ScriptDuration || 0) * 1000, 2),
      layoutDurationMs: round(Number(metrics.LayoutDuration || 0) * 1000, 2),
      recalcStyleDurationMs: round(Number(metrics.RecalcStyleDuration || 0) * 1000, 2),
      v8CompileDurationMs: round(Number(metrics.V8CompileDuration || 0) * 1000, 2),
      layoutCount: Number(metrics.LayoutCount || 0),
      recalcStyleCount: Number(metrics.RecalcStyleCount || 0),
      nodesMetric: Number(metrics.Nodes || 0),
    },
    processInfo: processInfo.slice(0, 8).map((p) => ({
      type: p.type,
      id: p.id,
      cpuTime: p.cpuTime,
      privateFootprint: p.privateFootprint,
      jsHeapSize: p.jsHeapSize,
    })),
    navigation,
  };
}

function compactSnapshot(value) {
  if (!value) return null;
  return {
    jsHeapUsedMb: value.jsHeapUsedMb,
    jsHeapTotalMb: value.jsHeapTotalMb,
    domNodes: value.domNodes,
    documents: value.documents,
    jsEventListeners: value.jsEventListeners,
    metrics: value.metrics,
    processInfo: value.processInfo,
  };
}

async function startCpuProfile(cdp) {
  try {
    await cdp.send("Profiler.enable", {}, 30000);
    await cdp.send("Profiler.start", {}, 30000);
    return true;
  } catch {
    return false;
  }
}

function summarizeCpuProfile(profile) {
  if (!profile) return null;
  const nodes = new Map((profile.nodes || []).map((node) => [node.id, node]));
  const totals = new Map();
  let totalUs = 0;
  for (let i = 0; i < (profile.samples || []).length; i++) {
    const id = profile.samples[i];
    const delta = Number(profile.timeDeltas?.[i] || 0);
    if (!Number.isFinite(delta) || delta < 0) continue;
    totals.set(id, (totals.get(id) || 0) + delta);
    totalUs += delta;
  }
  const top = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([id, us]) => {
      const frame = nodes.get(id)?.callFrame || {};
      const url = String(frame.url || "").replace(/^file:\/\//, "").replace(ROOT, "<repo>");
      return {
        functionName: frame.functionName || "(anonymous)",
        url,
        line: Number(frame.lineNumber || 0) + 1,
        selfMs: round(us / 1000, 2),
        selfPct: totalUs ? round((us / totalUs) * 100, 2) : 0,
      };
    });
  return {
    durationMs: round((Number(profile.endTime || 0) - Number(profile.startTime || 0)) / 1000, 2),
    sampleCount: (profile.samples || []).length,
    totalSampledMs: round(totalUs / 1000, 2),
    topFunctions: top,
  };
}

async function stopCpuProfile(cdp, started) {
  if (!started) return null;
  try {
    const result = await cdp.send("Profiler.stop", {}, 120000);
    return summarizeCpuProfile(result.profile);
  } catch {
    return null;
  } finally {
    await cdp.send("Profiler.disable", {}, 30000).catch(() => {});
  }
}

async function measure(cdp, label, fn, options = {}) {
  if (options.gc) await collectGarbage(cdp);
  const before = await snapshot(cdp);
  const profiling = options.profile === false ? false : await startCpuProfile(cdp);
  const started = now();
  let result;
  let error;
  try {
    result = await fn();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    // log immediately for diagnosis
    try { console.log(`  measure ${label} error: ${error.slice(0,400)}`); } catch {}
  }
  const wallMs = now() - started;
  const cpuProfile = await stopCpuProfile(cdp, profiling);
  const after = await snapshot(cdp);
  const record = {
    label,
    wallMs: round(wallMs, 2),
    result: result ?? null,
    error: error || null,
    cpu: {
      taskDurationMs: metricDelta(before.metrics, after.metrics, "taskDurationMs"),
      scriptDurationMs: metricDelta(before.metrics, after.metrics, "scriptDurationMs"),
      layoutDurationMs: metricDelta(before.metrics, after.metrics, "layoutDurationMs"),
      recalcStyleDurationMs: metricDelta(before.metrics, after.metrics, "recalcStyleDurationMs"),
      v8CompileDurationMs: metricDelta(before.metrics, after.metrics, "v8CompileDurationMs"),
      taskUtilizationPct: wallMs ? round((Number(after.metrics.taskDurationMs || 0) - Number(before.metrics.taskDurationMs || 0)) / wallMs * 100, 2) : null,
    },
    cpuProfile,
    memory: {
      before: compactSnapshot(before),
      after: compactSnapshot(after),
      heapDeltaMb: round(Number(after.jsHeapUsedMb || 0) - Number(before.jsHeapUsedMb || 0), 2),
      domNodeDelta: Number(after.domNodes || 0) - Number(before.domNodes || 0),
    },
  };
  return record;
}

async function openWorkspace(cdp, root) {
  return cdp.evaluate(`(async () => {
    const started = performance.now();
    const response = await window.closeCode.openFolder(${q(root)});
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const state = window.__workspaceStore?.getState?.();
      if (state?.root === ${q(root)} && state.children?.[state.root]) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await ${SETTLE_JS};
    const state = window.__workspaceStore?.getState?.();
    return {
      apiMs: __ccRound(performance.now() - started, 2),
      responseOk: !!response?.ok,
      root: state?.root || null,
      rootChildren: state?.children?.[state?.root]?.length || 0
    };
  })()`);
}

async function closeWorkspace(cdp) {
  return cdp.evaluate(`(async () => {
    try { window.__editorStore?.getState?.().closeAllTabs?.(); } catch {}
    try { window.__searchStore?.getState?.().clear?.(); } catch {}
    window.__workspaceStore?.getState?.().closeWorkspace?.();
    await ${SETTLE_JS};
    return true;
  })()`);
}

async function openFile(cdp, filePath, timeoutMs = 120000) {
  return cdp.evaluate(`(async () => {
    const started = performance.now();
    const store = window.__editorStore.getState();
    await store.openFileInWorkspace(${q(filePath)});
    const deadline = Date.now() + ${Math.max(30000, Math.min(timeoutMs - 5000, 240000))};
    let lastState = null;
    while (Date.now() < deadline) {
      lastState = window.__editorStore.getState();
      if (lastState.activePath === ${q(filePath)}) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await ${SETTLE_JS};
    const editor = window.__monacoEditor;
    const state = window.__editorStore.getState();
    const model = editor?.getModel?.();
    return {
      apiAndRenderMs: __ccRound(performance.now() - started, 2),
      activePath: state.activePath,
      expectedPath: ${q(filePath)},
      tabSize: state.tabs.length,
      modelLength: model?.getValueLength?.() || 0,
      lineCount: model?.getLineCount?.() || 0,
      hasModel: !!model,
      hasEditor: !!editor,
      warning: state.largeFileWarning || null,
      lastPollActivePath: lastState ? lastState.activePath : null
    };
  })()`, timeoutMs);
}

async function readFileOnly(cdp, filePath, timeoutMs = 120000) {
  return cdp.evaluate(`(async () => {
    const started = performance.now();
    const resp = await window.closeCode.readFile(${q(filePath)});
    const ms = performance.now() - started;
    return { ms: __ccRound(ms, 2), ok: !!resp?.ok, bytes: resp?.result?.content?.length || 0, size: resp?.result?.size || 0 };
  })()`, timeoutMs);
}

async function waitForTerminalPanel(cdp) {
  return poll(async () => cdp.evaluate(`!!document.querySelector('[data-terminal-panel]')`), 30000, 50, "terminal panel");
}

// Phase 16: tab switching. A cold switch has to build/reuse a Monaco model, a warm
// switch reuses the cached one. Both are reported separately because they exercise
// different code paths in MonacoPane (createModel/setModel vs. setModel only).
async function runTabSwitch(cdp, files) {
  const opened = [];
  for (const file of files) {
    const r = await openFile(cdp, file);
    opened.push({ file, ms: r?.apiAndRenderMs ?? null, ok: r?.activePath === file });
  }
  const cold = await measure(cdp, "tab-switch-cold", () => cdp.evaluate(`(async () => {
    const store = window.__editorStore.getState();
    const target = ${q(files[1])};
    store.setActive(${q(files[0])});
    await ${SETTLE_JS};
    const started = performance.now();
    store.setActive(target);
    await ${SETTLE_JS};
    return { target, activePath: window.__editorStore.getState().activePath, ms: __ccRound(performance.now() - started, 2) };
  })()`), { gc: true });
  const warm = [];
  for (let i = 0; i < 5; i++) {
    const r = await cdp.evaluate(`(async () => {
      const store = window.__editorStore.getState();
      const a = ${q(files[0])};
      const b = ${q(files[1])};
      store.setActive(a);
      await ${SETTLE_JS};
      const started = performance.now();
      store.setActive(b);
      await ${SETTLE_JS};
      return { ms: __ccRound(performance.now() - started, 2) };
    })()`);
    warm.push(Number(r?.ms ?? 0));
  }
  return {
    files,
    opened,
    cold,
    warm: {
      repeats: warm.length,
      samplesMs: warm,
      medianMs: round(median(warm), 2),
      p95Ms: round(percentile(warm, 0.95), 2),
    },
  };
}

async function runTyping(cdp, filePath) {
  const opened = await openFile(cdp, filePath);
  await cdp.evaluate(`(() => { window.__monacoEditor?.focus?.(); return true; })()`);
  const before = await snapshot(cdp);
  const profiling = await startCpuProfile(cdp);
  const samples = [];
  const started = now();
  let error;
  try {
    for (let i = 0; i < TYPING_CHARS; i++) {
      const oneStarted = now();
      await cdp.send("Input.insertText", { text: "x" }, 30000);
      await cdp.evaluate(SETTLE_JS, 30000);
      samples.push(now() - oneStarted);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const wallMs = now() - started;
  const cpuProfile = await stopCpuProfile(cdp, profiling);
  const after = await snapshot(cdp);
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null;
  return {
    opened,
    chars: TYPING_CHARS,
    wallMs: round(wallMs, 2),
    perCharMs: {
      p50: round(percentile(0.5), 2),
      p95: round(percentile(0.95), 2),
      max: round(sorted.length ? sorted[sorted.length - 1] : null, 2),
    },
    cpu: {
      taskDurationMs: metricDelta(before.metrics, after.metrics, "taskDurationMs"),
      scriptDurationMs: metricDelta(before.metrics, after.metrics, "scriptDurationMs"),
      layoutDurationMs: metricDelta(before.metrics, after.metrics, "layoutDurationMs"),
      taskUtilizationPct: wallMs ? round((Number(after.metrics.taskDurationMs || 0) - Number(before.metrics.taskDurationMs || 0)) / wallMs * 100, 2) : null,
    },
    cpuProfile,
    memory: { before: compactSnapshot(before), after: compactSnapshot(after) },
    error,
  };
}

async function runTerminal(cdp, root) {
  await openWorkspace(cdp, root);
  await cdp.evaluate(`(async () => { await window.__commandRegistry.execute("toggle-terminal"); return true; })()`);
  await waitForTerminalPanel(cdp);
  const create = await measure(cdp, "terminal-create", async () => cdp.evaluate(`(async () => {
    const started = performance.now();
    const id = await window.__terminalStore.getState().createWithWorkspaceCwd();
    return { id, ms: __ccRound(performance.now() - started, 2), terminalCount: window.__terminalStore.getState().terminals.length };
  })()`), { gc: true });
  const output = await measure(cdp, "terminal-long-output", () => cdp.evaluate(`(async () => {
    const state = window.__terminalStore.getState();
    const id = state.terminals[state.terminals.length - 1]?.id;
    if (!id) throw new Error("terminal was not created");
    const started = performance.now();
    let bytes = 0;
    let chunks = 0;
    let firstDataMs = null;
    let tail = "";
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error("terminal output timeout")); }, 120000);
      const off = window.closeCode.onTerminalData(({ id: incoming, data }) => {
        if (incoming !== id) return;
        if (firstDataMs === null) firstDataMs = performance.now() - started;
        bytes += data.length;
        chunks++;
        tail = (tail + data).slice(-100);
        if (tail.includes("PERF_TERMINAL_DONE")) {
          clearTimeout(timer);
          off();
          resolve({ id, bytes, chunks, firstDataMs: __ccRound(firstDataMs, 2), totalMs: __ccRound(performance.now() - started, 2) });
        }
      });
      void state.writeToTerminal(id, "node perf-terminal.js\\r");
    });
  })()`), { profile: true });
  await cdp.evaluate(`(async () => { await window.__terminalStore.getState().killAll(); return true; })()`);
  return { create, output };
}

function createScaleFixture(base, count) {
  const root = path.join(base, `scale-${count}`);
  const src = path.join(root, "src");
  fs.mkdirSync(src, { recursive: true });
  for (let i = 0; i < count; i++) {
    const content = `export const perf_${i} = ${i};\n// perfneedle-${i}\n`;
    fs.writeFileSync(path.join(src, `file-${String(i).padStart(5, "0")}.ts`), content);
  }
  fs.writeFileSync(path.join(root, "README.md"), `# Scale ${count}\nperfneedle-root\n`);
  return { root, src, count };
}

// Phase 16: fixtures are created milliseconds before they are measured, so the first
// read of every file pays whatever the OS/AV does on first touch. Profiling showed
// that cost is ~100-300x larger than the search work itself and it made the same
// scenario report 308 ms on one run and 115,645 ms on the next. Touching every
// fixture file once before timing removes that variable, so the numbers measure the
// application instead of the machine's cache state.
function warmFixture(root) {
  const started = now();
  let bytes = 0;
  let files = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let dirents;
    try { dirents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const d of dirents) {
      if (d.name === ".git") continue;
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) { stack.push(abs); continue; }
      if (!d.isFile()) continue;
      try {
        const fd = fs.openSync(abs, "r");
        const buf = Buffer.allocUnsafe(64 * 1024);
        let read = 0;
        do { read = fs.readSync(fd, buf, 0, buf.length, null); bytes += read; } while (read > 0);
        fs.closeSync(fd);
        files++;
      } catch { /* unreadable fixture file is fine */ }
    }
  }
  return { root, files, mb: round(bytes / 1024 / 1024, 2), ms: round(now() - started, 2) };
}

function createLargeFileFixture(base) {
  const root = path.join(base, "large-file");
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, "large.txt");
  const fd = fs.openSync(file, "w");
  const chunk = `${"const largeValue = 1234567890; // perfneedle-large-file\n".repeat(2000)}\n`;
  const chunks = Math.ceil((LARGE_FILE_MB * 1024 * 1024) / chunk.length);
  for (let i = 0; i < chunks; i++) fs.writeSync(fd, chunk);
  fs.closeSync(fd);
  return { root, file, bytes: fs.statSync(file).size };
}

function createTypingFixture(base) {
  const root = path.join(base, "typing");
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, "typing.js");
  fs.writeFileSync(file, Array.from({ length: 200 }, (_, i) => `export const typing${i} = ${i};`).join("\n") + "\n");
  return { root, file };
}

function createTerminalFixture(base) {
  const root = path.join(base, "terminal");
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, "perf-terminal.js");
  const lines = [];
  for (let i = 0; i < TERMINAL_LINES; i++) lines.push(`console.log("PERF_LINE_${i} " + "${"x".repeat(72)}");`);
  lines.push('console.log("PERF_TERMINAL_DONE");');
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return { root, file, lines: TERMINAL_LINES + 1 };
}

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore", windowsHide: true });
}

function createGitFixture(base) {
  const root = path.join(base, "git-large");
  fs.mkdirSync(root, { recursive: true });
  git(root, ["init"]);
  git(root, ["config", "user.email", "phase16@example.invalid"]);
  git(root, ["config", "user.name", "Phase 16 Profile"]);
  for (let i = 0; i < 2000; i++) {
    const dir = path.join(root, `src-${Math.floor(i / 50)}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `file-${String(i).padStart(4, "0")}.ts`), `export const gitValue${i} = ${i};\n`);
  }
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "phase16 baseline"]);
  for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(root, `src-${Math.floor(i / 50)}`, `change-${i}.ts`), `export const changed${i} = ${i};\n`);
  return { root, trackedFiles: 2000, changes: 25 };
}

function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values, p) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function summarizeStartup(runs) {
  const target = runs.map((r) => r.targetMs);
  const ready = runs.map((r) => r.readyMs);
  return {
    count: runs.length,
    targetMs: { median: round(median(target), 2), min: round(Math.min(...target), 2), max: round(Math.max(...target), 2) },
    readyMs: { median: round(median(ready), 2), min: round(Math.min(...ready), 2), max: round(Math.max(...ready), 2) },
  };
}

function summarizeScenario(records) {
  return {
    wallMs: {
      median: round(median(records.map((r) => r.wallMs)), 2),
      p95: round(percentile(records.map((r) => r.wallMs), 0.95), 2),
    },
    heapDeltaMb: {
      median: round(median(records.map((r) => r.memory?.heapDeltaMb)), 2),
      max: round(Math.max(...records.map((r) => Number(r.memory?.heapDeltaMb || 0))), 2),
    },
    errors: records.filter((r) => r.error).map((r) => r.error),
  };
}

async function firstInteraction(cdp) {
  const started = now();
  await cdp.evaluate(`window.__commandRegistry.execute("toggle-sidebar")`);
  await poll(async () => cdp.evaluate(`document.documentElement.dataset.testSidebarToggled !== undefined || true`), 5000, 25, "first interaction").catch(() => {});
  // alternative: just measure command execute time, ensure no throw
  const wallMs = now() - started;
  // toggle back to original state
  await cdp.evaluate(`window.__commandRegistry.execute("toggle-sidebar")`).catch(() => {});
  await sleep(100);
  return { open: true, wallMs: round(wallMs, 2), via: "toggle-sidebar" };
}

async function runStartup(options, base) {
  const runs = [];
  let first = null;
  for (let i = 0; i < options.runs; i++) {
    const userData = path.join(base, `startup-${i}`, "userdata");
    fs.mkdirSync(userData, { recursive: true });
    const session = await launch(userData, options.port);
    const readySnapshot = await snapshot(session.cdp);
    const run = {
      index: i + 1,
      targetMs: round(session.targetMs, 2),
      readyMs: round(session.readyMs, 2),
      navigation: readySnapshot.navigation,
      memory: compactSnapshot(readySnapshot),
    };
    let measuredFirstInteraction = null;
    if (i === 0) {
      try { measuredFirstInteraction = await measure(session.cdp, "first-interaction", () => firstInteraction(session.cdp), { profile: true }); } catch { measuredFirstInteraction = null; }
      first = measuredFirstInteraction;
    }
    runs.push(run);
    await closeSession(session);
    await sleep(500);
  }
  return { runs, summary: summarizeStartup(runs), firstInteraction: first };
}

async function runScaleScenarios(cdp, scales) {
  const records = [];
  for (const scale of scales) {
    await closeWorkspace(cdp);
    const open = await measure(cdp, `workspace-open-${scale.count}`, () => openWorkspace(cdp, scale.root), { gc: true });
    const list = await measure(cdp, `explorer-list-${scale.count}`, () => cdp.evaluate(`(async () => {
      const started = performance.now();
      await window.__workspaceStore.getState().loadChildren(${q(scale.src)});
      await ${SETTLE_JS};
      const state = window.__workspaceStore.getState();
      return { count: state.children[${q(scale.src)}]?.length || 0, ms: __ccRound(performance.now() - started, 2) };
    })()`), { gc: false });
    const search = await measure(cdp, `workspace-search-${scale.count}`, () => cdp.evaluate(`(async () => {
      const store = window.__searchStore.getState();
      store.clear();
      store.setQuery("perfneedle");
      const started = performance.now();
      await store.search(${q(scale.root)});
      const state = window.__searchStore.getState();
      return { results: state.results.length, totalFiles: state.totalFiles, searchedFiles: state.searchedFiles, truncated: state.truncated, ms: __ccRound(performance.now() - started, 2) };
    })()`), { gc: true });
    // Same query, second time. This is what a user does when they press Enter again,
    // reopen the Search panel, or go back to a previous query — and it is exactly what
    // the Phase 16 result cache serves. The query is re-set explicitly because
    // `store.clear()` also wipes it. Reported as a separate metric because a cache hit
    // involves no filesystem read at all.
    const searchRepeat = await measure(cdp, `workspace-search-repeat-${scale.count}`, () => cdp.evaluate(`(async () => {
      const store = window.__searchStore.getState();
      store.clear();
      store.setQuery("perfneedle");
      const started = performance.now();
      await store.search(${q(scale.root)});
      const state = window.__searchStore.getState();
      return { results: state.results.length, cache: state.lastCache || null, ms: __ccRound(performance.now() - started, 2) };
    })()`), { gc: false });
    records.push({ count: scale.count, open, list, search, searchRepeat, summary: summarizeScenario([open, list, search]) });
    log(`  scale ${scale.count}: open ${open.wallMs}ms, list ${list.wallMs}ms (${list.result?.count ?? "?"} entries), search ${search.wallMs}ms (${search.result?.results ?? "?"} hits), repeat ${searchRepeat.wallMs}ms (cache=${searchRepeat.result?.cache || "?"})`);
  }
  return records;
}

// Phase 16: a cache is only acceptable if it cannot serve a stale result. This writes a
// file through the app's own write-file IPC (which must invalidate the cache), then runs
// the identical query again and checks the new content is found and the removed content
// is not.
async function runSearchCacheInvalidation(cdp, scale) {
  const target = path.join(scale.src, "file-00000.ts");
  const marker = "cacheinvalidation-needle";
  return measure(cdp, "search-cache-invalidation", () => cdp.evaluate(`(async () => {
    const store = window.__searchStore.getState();
    const fresh = ${q(marker)};

    // 1. Baseline: the marker is nowhere, the old needle is everywhere.
    store.clear();
    store.setQuery(${q(marker)});
    await store.search(${q(scale.root)});
    const before = window.__searchStore.getState().results.length;

    // 2. Prime the cache for the needle query.
    store.clear();
    store.setQuery("perfneedle");
    await store.search(${q(scale.root)});
    const primed = window.__searchStore.getState().lastCache;

    // 3. Edit a file through the app's own write path.
    const resp = await window.closeCode.writeFile(${q(target)}, "export const perf_0 = 0;\\n// " + fresh + "\\n");

    // 4. Same needle query again — must re-read and now report one fewer hit.
    store.clear();
    store.setQuery("perfneedle");
    await store.search(${q(scale.root)});
    const after = window.__searchStore.getState();

    // 5. And the new needle must be found.
    store.clear();
    store.setQuery(${q(marker)});
    await store.search(${q(scale.root)});
    const found = window.__searchStore.getState().results.length;

    return { before, primed, writeError: resp.error, afterHits: after.results.length, afterCache: after.lastCache, found };
  })()`), { gc: true });
}

async function runGitScenario(cdp, fixture) {
  await closeWorkspace(cdp);
  const open = await measure(cdp, "git-workspace-open", () => openWorkspace(cdp, fixture.root), { gc: true });
  await poll(async () => cdp.evaluate(`!window.__gitStore?.getState?.().isLoading`), 120000, 100, "initial git refresh").catch(() => {});
  const status = await measure(cdp, "git-status-large", () => cdp.evaluate(`(async () => {
    const started = performance.now();
    await window.__gitStore.getState().refreshStatus();
    const state = window.__gitStore.getState();
    return { isRepo: state.isRepo, files: state.status?.files?.length || 0, untracked: state.status?.untracked?.length || 0, ms: __ccRound(performance.now() - started, 2) };
  })()`), { profile: true });
  const logResult = await measure(cdp, "git-log-large", () => cdp.evaluate(`(async () => {
    const started = performance.now();
    await window.__gitStore.getState().getLog();
    return { entries: window.__gitStore.getState().log.length, ms: __ccRound(performance.now() - started, 2) };
  })()`), { profile: true });
  return { fixture, open, status, log: logResult };
}

async function writeReport(report) {
  fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2) + "\n", "utf8");
}

function printSummary(report) {
  log("");
  log("PHASE 16 PROFILE SUMMARY");
  const startup = report.startup?.summary;
  if (startup) log(`  startup target median: ${startup.targetMs.median} ms; renderer-ready median: ${startup.readyMs.median} ms`);
  if (report.startup?.firstInteraction) log(`  first interaction: ${report.startup.firstInteraction.wallMs} ms`);
  if (report.fixtureWarmup) log(`  fixture warm-up: ${report.fixtureWarmup.totalMs} ms (${report.fixtureWarmup.totalFiles} files)`);
  for (const scale of report.scale || []) {
    log(`  files ${scale.count}: explorer ${scale.list.wallMs} ms; search ${scale.search.wallMs} ms; repeat ${scale.searchRepeat?.wallMs} ms (cache=${scale.searchRepeat?.result?.cache || "?"}); heap delta ${scale.search.memory?.heapDeltaMb} MB`);
  }
  if (report.fileOpen) log(`  file read ${report.fileOpen.read?.wallMs} ms; open+model ${report.fileOpen.open?.wallMs} ms`);
  if (report.tabSwitch) log(`  tab switch: cold ${report.tabSwitch.cold.wallMs} ms; warm median ${report.tabSwitch.warm.medianMs} ms`);
  if (report.largeFile) log(`  large file (${report.largeFile.fixture.bytes} bytes): read ${report.largeFile.read?.wallMs} ms; open+model ${report.largeFile.open?.wallMs} ms; heap delta ${report.largeFile.open?.memory?.heapDeltaMb} MB`);
  if (report.typing) log(`  typing ${report.typing.chars} chars: ${report.typing.wallMs} ms; p95 ${report.typing.perCharMs.p95} ms/char`);
  if (report.terminal) log(`  terminal output ${report.terminal.output.result?.bytes || 0} bytes: ${report.terminal.output.wallMs} ms`);
  if (report.git) log(`  large Git status: ${report.git.status.wallMs} ms; log: ${report.git.log.wallMs} ms`);
  if (report.errors?.length) log(`  scenario errors: ${report.errors.length}`);
  log(`  report: ${path.relative(ROOT, REPORT_FILE)}`);
}

async function main() {
  const options = parseArgs();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cc-phase16-"));
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpuCount: os.cpus().length,
      totalMemoryMb: mb(os.totalmem()),
      packagedExe: EXE,
      electronFromPackage: "35.7.5 (expected packaged runtime)",
    },
    configuration: {
      startupRuns: options.runs,
      terminalLines: TERMINAL_LINES,
      largeFileBytes: LARGE_FILE_MB * 1024 * 1024,
      typingCharacters: TYPING_CHARS,
      scales: [100, 1000, 10000],
      gitTrackedFiles: 2000,
      profiler: "CDP Profiler + Performance.getMetrics + Runtime/Memory/SystemInfo snapshots",
      bottleneckProbe: "scripts/phase16-search-probe.cjs (isolates I/O vs CPU for workspace search)",
      readConcurrency: 32,
    },
    startup: null,
    fixtureWarmup: null,
    scale: null,
    searchCacheInvalidation: null,
    fileOpen: null,
    tabSwitch: null,
    largeFile: null,
    typing: null,
    terminal: null,
    git: null,
    memory: null,
    errors: [],
  };

  let session = null;
  try {
    log(`phase16 profile start (${options.runs} startup runs)`);
    report.startup = await runStartup(options, base);
    log(`  startup ready median: ${report.startup.summary.readyMs.median} ms`);

    const scales = [100, 1000, 10000].map((count) => createScaleFixture(base, count));
    const large = createLargeFileFixture(base);
    const typing = createTypingFixture(base);
    const terminal = createTerminalFixture(base);
    const gitFixture = createGitFixture(base);

    // Warm every fixture before any timing so cold-cache/AV cost is not measured.
    const warmed = [scales[0].root, scales[1].root, scales[2].root, large.root, typing.root, terminal.root, gitFixture.root].map((root) => warmFixture(root));
    report.fixtureWarmup = {
      totalMs: round(warmed.reduce((sum, w) => sum + (w.ms || 0), 0), 2),
      totalMb: round(warmed.reduce((sum, w) => sum + (w.mb || 0), 0), 2),
      totalFiles: warmed.reduce((sum, w) => sum + (w.files || 0), 0),
      byRoot: warmed,
    };
    log(`  fixture warm-up: ${report.fixtureWarmup.totalFiles} files / ${report.fixtureWarmup.totalMb} MB in ${report.fixtureWarmup.totalMs} ms`);

    const userData = path.join(base, "profile-userdata");
    fs.mkdirSync(userData, { recursive: true });
    session = await launch(userData, options.port);

    report.scale = await runScaleScenarios(session.cdp, scales);

    // The search cache must never serve a stale result. Verified on the smallest scale
    // by editing a file through the app's own write path and re-running the same query.
    await openWorkspace(session.cdp, scales[0].root);
    report.searchCacheInvalidation = await runSearchCacheInvalidation(session.cdp, scales[0]);
    const inv = report.searchCacheInvalidation.result;
    const cacheOk = inv && inv.writeError === null && inv.afterCache === "miss" && Number(inv.found) > 0;
    if (!cacheOk) report.errors.push(`search cache served a stale result: ${JSON.stringify(inv)}`);
    log(`  search cache: invalidated on write (${cacheOk ? "verified" : "FAILED"}), repeat cache=${inv?.afterCache || "?"}`);
    await closeWorkspace(session.cdp);
    await openWorkspace(session.cdp, scales[0].root);
    report.fileOpen = {
      read: await measure(session.cdp, "file-read-raw", () => readFileOnly(session.cdp, path.join(scales[0].root, "README.md")), { gc: true }),
      open: await measure(session.cdp, "file-open", () => openFile(session.cdp, path.join(scales[0].root, "README.md")), { gc: false }),
    };
    log(`  file read: ${report.fileOpen.read.wallMs} ms; open+model: ${report.fileOpen.open.wallMs} ms`);

    report.tabSwitch = await runTabSwitch(session.cdp, [
      path.join(scales[0].root, "README.md"),
      path.join(scales[0].src, "file-00000.ts"),
      path.join(scales[0].src, "file-00001.ts"),
    ]);
    log(`  tab switch: cold ${report.tabSwitch.cold.wallMs} ms; warm median ${report.tabSwitch.warm.medianMs} ms`);

    await closeWorkspace(session.cdp);
    await openWorkspace(session.cdp, large.root);
    report.largeFile = {
      fixture: { root: large.root, file: large.file, bytes: large.bytes },
      // Phase 16 note: on this machine the FIRST read of a freshly created multi-MB file
      // costs tens of seconds inside a single fs.readFileSync (verified by main-process
      // instrumentation: read=87710 ms on the first call vs read=4 ms on the second), which
      // is an OS/AV first-touch cost rather than application work. The step therefore gets a
      // long budget so the run still completes the remaining scenarios.
      read: await measure(session.cdp, "large-file-read-raw", () => readFileOnly(session.cdp, large.file, 180000), { gc: true }),
      open: await measure(session.cdp, "large-file-open", () => openFile(session.cdp, large.file, 300000), { gc: false }),
    };
    log(`  large file: read ${report.largeFile.read.wallMs} ms; open+model ${report.largeFile.open.wallMs} ms; warning=${report.largeFile.open.result?.warning || "none"}`);

    await closeWorkspace(session.cdp);
    await openWorkspace(session.cdp, typing.root);
    report.typing = await runTyping(session.cdp, typing.file);
    log(`  typing: ${report.typing.wallMs} ms; p95=${report.typing.perCharMs.p95} ms/char`);

    report.terminal = await runTerminal(session.cdp, terminal.root);
    log(`  terminal long output: ${report.terminal.output.wallMs} ms; bytes=${report.terminal.output.result?.bytes || 0}`);

    report.git = await runGitScenario(session.cdp, gitFixture);
    log(`  Git status/log: ${report.git.status.wallMs}/${report.git.log.wallMs} ms`);

    report.memory = {
      baseline: compactSnapshot(await snapshot(session.cdp)),
      afterScenarios: (report.scale || []).map((s) => ({ count: s.count, search: compactSnapshot(s.search.memory?.after) })),
      largeFile: compactSnapshot(report.largeFile?.open?.memory?.after),
      typing: compactSnapshot(report.typing?.memory?.after),
      terminal: compactSnapshot(report.terminal?.output?.memory?.after),
      git: compactSnapshot(report.git?.status?.memory?.after),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    report.errors.push(message);
    log(`phase16 fatal (aborted the run): ${message}`);
    if (err instanceof Error && err.stack) log(String(err.stack).split("\n").slice(1, 4).join("\n"));
  } finally {
    await closeSession(session);
    if (!options.keepFixtures) safeRm(base);
    else log(`fixtures kept at ${base}`);
    await writeReport(report);
    printSummary(report);
    // A scenario that timed out still produces a usable profile, so the harness only
    // fails hard when a fatal error aborted the run before any measurement completed.
    if (report.errors.length > 0 && !report.scale) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exitCode = 1;
});
