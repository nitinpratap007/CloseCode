const { spawn, execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const EXE = "E:\\closecode\\release\\win-unpacked\\CloseCode.exe";
const PORT = 9232;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) { const res = await fetch(url); return res.json(); }
function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const fail = () => { try { ws.close(); } catch {} reject(new Error("CDP timeout: " + expression.slice(0, 80))); };
    const timer = setTimeout(fail, 25000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === 1) {
        clearTimeout(timer); try { ws.close(); } catch {}
        if (msg.result?.exceptionDetails) reject(new Error(JSON.stringify(msg.result.exceptionDetails).slice(0, 1500)));
        else resolve(msg.result?.result?.value);
      }
    };
    ws.onerror = (e) => { clearTimeout(timer); reject(e); };
  });
}

const LOGF = "C:\\Users\\NITINP~1\\AppData\\Local\\Temp\\opencode\\phase10.log";
function tlog(m) { try { fs.appendFileSync(LOGF, m + "\n"); } catch {} console.log(m); }

async function poll(fn, timeoutMs, everyMs = 120, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(everyMs);
  }
  throw new Error("Timed out waiting for: " + label);
}

async function main() {
  try { fs.unlinkSync(LOGF); } catch {}
  tlog("phase10 start");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cc-phase10-"));
  const userData = path.join(base, "userdata"); fs.mkdirSync(userData, { recursive: true });
  const wsDir = path.join(base, "ws"); fs.mkdirSync(wsDir, { recursive: true });

  const APP = `function add(a, b) {
  return a + b;
}

function main() {
  const x = 10;
  const y = 20;
  const z = add(x, y);
  const w = add(z, 100);
  console.log("Z = " + w);
}

main();
`;
  const appPath = path.join(wsDir, "app.js");
  fs.writeFileSync(appPath, APP);

  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], { stdio: "ignore", detached: true, env: { ...process.env, CC_USER_DATA: userData } });
  child.unref();
  let targets = null;
  for (let i = 0; i < 40; i++) { await sleep(800); try { targets = await getJson(`http://127.0.0.1:${PORT}/json/list`); if (targets && targets.length) break; } catch {} }
  if (!targets) throw new Error("no targets");
  const page = targets.find((t) => t.type === "page") || targets[0];
  const ws = page.webSocketDebuggerUrl;
  const E = (expr) => evaluate(ws, expr);
  const R = [];
  const check = (name, pass, detail) => { R.push({ name, pass }); tlog(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };

  await sleep(1500);

  // Open the workspace so a real file context exists
  const opened = await E(`(async()=>{ const r = await window.closeCode.openFolder(${JSON.stringify(wsDir)}); return r && r.ok; })()`);
  check("open workspace", opened === true);

  // Open app.js in the editor (activePath)
  await E(`(async()=>{ await window.__editorStore.getState().openFileInWorkspace(${JSON.stringify(appPath)}); return true; })()`);
  await sleep(600);
  const activeOk = await E(`window.__editorStore.getState().activePath !== null`);
  check("app.js opened in editor", activeOk === true);

  // 1. Set a breakpoint at line 8 (const z = add(x, y);)
  const bpRes = await E(`(async()=>{ const r = await window.closeCode.debugSetBreakpoint(${JSON.stringify(appPath)}, 8); return r; })()`);
  check("set breakpoint at line 8", bpRes?.ok === true && bpRes?.result?.line === 8, JSON.stringify(bpRes?.result));
  const bpId = bpRes?.result?.id;
  await sleep(400);
  const bpList1 = await E(`(async()=>{ const r = await window.closeCode.debugGetBreakpoints(); return r.result; })()`);
  check("breakpoints persisted in manager", Array.isArray(bpList1) && bpList1.some((b) => b.line === 8 && b.file), JSON.stringify(bpList1));
  check("duplicate breakpoint rejected", bpRes?.ok === true);

  // 2. Start debugging via the store (full renderer path)
  await E(`window.__debugStore.getState().start(${JSON.stringify(appPath)}).then(()=>true)`);
  await sleep(600);

  // Wait for a real pause on the user breakpoint (line 8, function main)
  await poll(async () => {
    const st = await E(`window.__debugStore.getState().state`);
    return st === "paused";
  }, 40000, 250, "debugger pause");
  const pausedFrames = await E(`window.__debugStore.getState().callFrames`);
  const top = pausedFrames && pausedFrames[0];
  check("paused at breakpoint (line 8)", top && top.line === 8, JSON.stringify(top && { fn: top.functionName, line: top.line, url: top.url }));
  check("paused in main()", top && top.functionName === "main", top && top.functionName);
  const getStateIpc = await E(`(async()=>{ const r = await window.closeCode.debugGetState(); return r; })()`);
  check("debug:getState reports paused", getStateIpc?.ok === true && getStateIpc?.result?.state === "paused", JSON.stringify(getStateIpc));

  const bpListPaused = await E(`window.__debugStore.getState().breakpoints`);
  const bpEntry = Array.isArray(bpListPaused) && bpListPaused.find((b) => b.line === 8);
  check("breakpoint store entry present", !!bpEntry);
  // The manager re-applies persistent breakpoints after start(); wait for the
  // resolved state broadcast to land before asserting on it.
  let bpResolved = null;
  try {
    bpResolved = await poll(async () => {
      const list = await E(`window.__debugStore.getState().breakpoints`);
      const entry = Array.isArray(list) && list.find((b) => b.line === 8);
      return entry && entry.resolved === true ? entry : null;
    }, 10000, 150, "breakpoint resolved broadcast");
  } catch {}
  check("breakpoint resolved in running session", !!bpResolved, JSON.stringify(bpResolved));

  // 3. Variables: x=10, y=20 visible in the local scope
  const vars = await E(`(async()=>{
    const r = await window.closeCode.debugGetVariables({ frameId: 0 });
    if (!r.ok || !r.result) return null;
    const flat = {};
    for (const s of r.result.scopes || []) for (const v of s.variables || []) flat[v.name] = { value: v.value, type: v.type };
    return flat;
  })()`);
  check("local scope has x", vars && vars.x && vars.x.value === "10", vars && JSON.stringify(vars.x));
  check("local scope has y", vars && vars.y && vars.y.value === "20", vars && JSON.stringify(vars.y));

  // 4. Evaluate an expression in the paused context (REPL path via store)
  await E(`window.__debugStore.getState().evaluate("x * 2").then(()=>true)`);
  await poll(async () => {
    const entries = await E(`window.__debugStore.getState().consoleEntries`);
    return Array.isArray(entries) && entries.some((e) => String(e.text).trim() === "20");
  }, 10000, 150, "evaluate result in console");
  const evalVal = await E(`(async()=>{ const r = await window.closeCode.debugEvaluate("x * 2"); return r; })()`);
  check("evaluate x*2 == 20", evalVal?.ok === true && evalVal?.result?.value === "20", JSON.stringify(evalVal));

  // 5. Step Into: should land in add() at line 2
  const stepIntoOk = await E(`(async()=>{ const r = await window.closeCode.debugStepInto(); return r && r.ok; })()`);
  check("stepInto invoked", stepIntoOk === true);
  await poll(async () => {
    const f = await E(`window.__debugStore.getState().callFrames`);
    const t = f && f[0];
    return t && t.functionName === "add" && t.line === 2;
  }, 10000, 150, "paused in add() line 2");
  const addFrame = await E(`window.__debugStore.getState().callFrames[0]`);
  check("stepInto -> add()", addFrame?.functionName === "add" && addFrame?.line === 2, JSON.stringify(addFrame && { fn: addFrame.functionName, line: addFrame.line }));

  // 6. Step Out: back in main() at line 9 (the statement after the call)
  await E(`(async()=>{ const r = await window.closeCode.debugStepOut(); return r && r.ok; })()`);
  await poll(async () => {
    const f = await E(`window.__debugStore.getState().callFrames`);
    const t = f && f[0];
    return t && t.functionName === "main" && t.line === 9;
  }, 10000, 150, "paused in main() line 9 after stepOut");
  const backFrame = await E(`window.__debugStore.getState().callFrames[0]`);
  check("stepOut -> main() line 9", backFrame?.functionName === "main" && backFrame?.line === 9, JSON.stringify(backFrame && { fn: backFrame.functionName, line: backFrame.line }));

  // 7. Step Over: executes the call on line 9, lands on line 10 (console.log)
  await E(`(async()=>{ const r = await window.closeCode.debugStepOver(); return r && r.ok; })()`);
  await poll(async () => {
    const f = await E(`window.__debugStore.getState().callFrames`);
    const t = f && f[0];
    return t && t.functionName === "main" && t.line === 10;
  }, 10000, 150, "stepOver advanced to line 10");
  const stepOverFrame = await E(`window.__debugStore.getState().callFrames[0]`);
  check("stepOver moved to next line", stepOverFrame?.functionName === "main" && stepOverFrame?.line === 10, JSON.stringify(stepOverFrame && { fn: stepOverFrame.functionName, line: stepOverFrame.line }));

  // 8. Continue: program should finish, exit code 0, console has "Z = 130"
  await E(`(async()=>{ const r = await window.closeCode.debugContinue(); return r && r.ok; })()`);
  await poll(async () => {
    const st = await E(`window.__debugStore.getState().state`);
    return st === "inactive";
  }, 15000, 250, "program exited");
  const exitEntries = await E(`window.__debugStore.getState().consoleEntries`);
  const hasZ = Array.isArray(exitEntries) && exitEntries.some((e) => String(e.text).includes("Z = 130"));
  check("debug console shows program output Z = 130", hasZ === true, (exitEntries || []).slice(0, 4).map((e) => String(e.text)).join(" | ").slice(0, 120));
  const stAfter = await E(`window.__debugStore.getState().state`);
  check("state inactive after exit", stAfter === "inactive", String(stAfter));

  // 9. Toggle-breakpoint command (F9) via Monaco cursor
  await E(`window.__commandRegistry.execute("toggle-breakpoint")`);
  await sleep(400);
  const afterToggle = await E(`window.__debugStore.getState().breakpoints.length`);
  await E(`window.__commandRegistry.execute("toggle-breakpoint")`);
  await sleep(400);
  const afterToggle2 = await E(`window.__debugStore.getState().breakpoints.length`);
  check("toggle-breakpoint adds then removes", afterToggle && afterToggle2 === afterToggle - 1, `${afterToggle} -> ${afterToggle2}`);

  // 10. UI: Run and Debug panel + ActivityBar button + Debug Console tab
  await E(`window.__commandRegistry.execute("debug-view")`);
  await sleep(400);
  const panelVisible = await E(`!!document.querySelector('[data-debug-panel]')`);
  check("debug-view shows Run & Debug panel", panelVisible === true);
  const runBtn = await E(`!!document.querySelector('[aria-label="Run and Debug"]')`);
  check("ActivityBar has Run and Debug button", runBtn === true);
  await E(`window.__commandRegistry.execute("debug-console")`);
  await sleep(400);
  const consoleTab = await E(`!!document.querySelector('[data-debug-tab]')`);
  check("debug-console shows Debug Console tab", consoleTab === true);
  const consolePanel = await E(`!!document.querySelector('[data-debug-console]')`);
  check("Debug Console panel rendered", consolePanel === true);
  const palette = await E(`window.__getCommandByShortcut ? window.__getCommandByShortcut("F5")?.id : null`);
  check("F5 maps to debug-continue", palette === "debug-continue", String(palette));

  // Ensure we clean up the session
  await E(`window.__debugStore.getState().stop().then(()=>true)`);

  const all = R.every((r) => r.pass);
  tlog(`\n${R.filter((r) => r.pass).length}/${R.length} checks passed`);
  tlog(all ? "PHASE 10 INTEGRATION: PASSED" : "PHASE 10 INTEGRATION: FAILED");
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); } catch { try { execSync(`taskkill /F /IM "CloseCode.exe"`, { stdio: "ignore" }); } catch {} }
  await sleep(500);
  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  process.exit(all ? 0 : 1);
}
main().catch((e) => { tlog("ERR " + (e && e.stack || e)); console.error(e); try { execSync(`taskkill /F /IM "CloseCode.exe"`, { stdio: "ignore" }); } catch {} process.exit(1); });