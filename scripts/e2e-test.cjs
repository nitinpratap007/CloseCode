// CloseCode — Phase 19 E2E integration test: Full workflow.
// Verifies: Launch → Open folder → Create file → Edit → Save → Terminal → Search → Git → Close & reopen.
// Run: npm run test:phase19   (port 9240, isolated CC_USER_DATA)
//
// Two rules this file must follow, both learned the hard way:
//
//  1. Never interpolate a filesystem path into a CDP `Runtime.evaluate`
//     expression as `"${path}"`. os.tmpdir() on this machine returns the 8.3
//     short form `C:\Users\NITINP~1\...`, and in a JS string literal `\N` is an
//     escape that collapses to `N`. The expression still *parses*, so it does
//     not throw — it silently calls the app with a nonexistent directory and the
//     test fails (or worse, passes) for the wrong reason. Always use
//     JSON.stringify(path).
//  2. Await every store action you assert on. `createFile` and `search` are
//     async; calling them fire-and-forget and checking the filesystem
//     immediately races the write and produces a false failure — or, if the
//     call throws inside the promise, a false *pass*.

const { spawn, execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const EXE = "E:\\closecode\\release\\win-unpacked\\CloseCode.exe";
const PORT = 9240;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) { const res = await fetch(url); return res.json(); }
function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const fail = () => { try { ws.close(); } catch {} reject(new Error("CDP timeout: " + expression.slice(0, 80))); };
    const timer = setTimeout(fail, 45000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === 1) {
        clearTimeout(timer); try { ws.close(); } catch {}
        if (msg.result?.exceptionDetails) reject(new Error(JSON.stringify(msg.result.exceptionDetails).slice(0, 1600)));
        else resolve(msg.result?.result?.value);
      }
    };
    ws.onerror = (e) => { clearTimeout(timer); reject(e); };
  });
}

const LOGF = path.join(os.tmpdir(), "phase19.log");
function tlog(m) { try { fs.appendFileSync(LOGF, m + "\n"); } catch {} console.log(m); }

async function poll(fn, timeoutMs, everyMs = 200, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(everyMs);
  }
  throw new Error("Timed out waiting for: " + label);
}

async function launch(userData, port) {
  const child = spawn(EXE, [`--remote-debugging-port=${port}`], { stdio: "ignore", detached: true, env: { ...process.env, CC_USER_DATA: userData } });
  child.unref();
  let targets = null;
  for (let i = 0; i < 60; i++) { await sleep(500); try { targets = await getJson(`http://127.0.0.1:${port}/json/list`); if (targets && targets.length) break; } catch {} }
  if (!targets) throw new Error("no CDP targets");
  const page = targets.find((t) => t.type === "page") || targets[0];
  return { child, ws: page.webSocketDebuggerUrl };
}

async function closeSession(session) {
  try { await execSync(`taskkill /PID ${session.child.pid} /T /F`, { stdio: "ignore" }); } catch {}
  try { await execSync(`taskkill /F /IM "CloseCode.exe"`, { stdio: "ignore" }); } catch {}
}

/** Wait until the renderer has published the store handles we poke at. */
async function waitForStores(ws) {
  await poll(async () => {
    try {
      const v = await evaluate(ws, "[!!window.__editorStore, !!window.__workspaceStore, !!window.__terminalStore, !!window.__searchStore, !!window.__gitStore].join(',')");
      if (v === "true,true,true,true,true") return true;
    } catch {}
    return false;
  }, 20000, 400, "store exposure");
}

async function run() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cc-e2e-"));
  const userData = path.join(base, "userdata");
  const wsRoot = path.join(base, "workspace");
  const newFile = path.join(wsRoot, "test-file.txt");
  fs.mkdirSync(wsRoot, { recursive: true });
  fs.writeFileSync(path.join(wsRoot, "README.md"), "# Hello\n", "utf-8");

  const J = JSON.stringify; // rule 1: every path goes through this
  const session = await launch(userData, PORT);
  const checks = [];
  function ok(name, cond, detail) { checks.push({ name, ok: !!cond }); console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || detail === undefined ? "" : `  -> ${String(detail).slice(0, 300)}`}`); return cond; }

  await waitForStores(session.ws);

  try {
    // 1. Launch application — verified by CDP connection + store exposure above
    ok("Application launches", true);

    // 2. Open folder. The IPC is `openFolder(root)`, not `openWorkspace`.
    const openResult = await evaluate(session.ws, `window.closeCode.openFolder(${J(wsRoot)}).then(r => r)`);
    ok("Folder opens", openResult?.ok === true && !!openResult?.result?.root, JSON.stringify(openResult));

    // 3. Create file. The store signature is createFile(dirPath, name) and it is
    //    async, so it must be awaited before touching the filesystem.
    await evaluate(session.ws, `(function(){ try { window.__workspaceStore.getState().createFile(${J(wsRoot)}, "test-file.txt"); return "started"; } catch(e) { return "err:" + e.message; } })()`);
    await poll(() => fs.existsSync(newFile), 10000, 200, "test-file.txt on disk");
    ok("Create file works", fs.existsSync(newFile), newFile);
    ok("Created file exists on disk", fs.existsSync(newFile), newFile);

    // 4. Edit file — open it and set content through the editor store.
    await evaluate(session.ws, `window.__editorStore.getState().openFileInWorkspace(${J(newFile)}, ${J({ content: "Hello World Edited", size: 20 })})`);
    const tabName = await evaluate(session.ws, `window.__editorStore.getState().tabs.find(t => t.path === ${J(newFile)})?.name ?? "not-found"`);
    ok("File opens in editor", tabName === "test-file.txt", tabName);

    // 5. Save file — the tab must be dirty first, otherwise saveTab is a no-op
    //    and the assertion would pass without ever exercising a write.
    await evaluate(session.ws, `window.__editorStore.getState().markChanged(${J(newFile)})`);
    const saved = await evaluate(session.ws, `(async () => { const s = window.__editorStore.getState(); return await s.saveTab(${J(newFile)}); })()`);
    ok("Save file works", saved === true, saved);
    ok("Saved content is on disk", fs.existsSync(newFile) && fs.readFileSync(newFile, "utf-8").includes("Hello World Edited"), fs.existsSync(newFile) ? fs.readFileSync(newFile, "utf-8").slice(0, 80) : "missing");

    // 6. Open terminal
    const termResult = await evaluate(session.ws, `(function() { try { window.__terminalStore.getState().createTerminal(); return "ok"; } catch(e) { return "err:" + e.message; } })()`);
    ok("Terminal opens", termResult === "ok", termResult);
    const termCount = await evaluate(session.ws, `window.__terminalStore.getState().terminals.length`);
    ok("Terminal has a session", termCount > 0, termCount);

    // 7. Commands are callable
    const cmdResult = await evaluate(session.ws, `(function() { try { return typeof window.__editorStore.getState().closeTab === 'function' ? "cmd-ok" : "cmd-fail"; } catch(e) { return "err"; } })()`);
    ok("Commands are callable", cmdResult === "cmd-ok", cmdResult);

    // 8. Search project. search(root) is async and the query lives in store
    //    state, so set the query first and then await the search.
    await evaluate(session.ws, `window.__searchStore.getState().setQuery("Edited")`);
    await evaluate(session.ws, `window.__searchStore.getState().search(${J(wsRoot)})`);
    const searchHits = await evaluate(session.ws, `window.__searchStore.getState().results.length`);
    ok("Search works", searchHits > 0, `${searchHits} hit(s)`);

    // 9. Git status. Use the IPC surface (`gitIsRepo`) — the zustand store
    //    methods are async, so calling them un-awaited asserts nothing.
    const gitResult = await evaluate(session.ws, `window.closeCode.gitIsRepo(${J(wsRoot)}).then(r => r)`);
    // A plain temp folder is not a repo, so the correct assertion is "callable
    // and answered", not "is a repo".
    ok("Git status callable", gitResult?.ok === true && typeof gitResult.result === "boolean", JSON.stringify(gitResult));

    // 10. Close and reopen project — kill and relaunch, then confirm the
    //     recent-projects list survived the restart.
    await closeSession(session);
    await sleep(2000);
    const session2 = await launch(userData, PORT + 1);
    await waitForStores(session2.ws);

    const recentRaw = await evaluate(session2.ws, `window.closeCode.getRecentProjects().then(r => JSON.stringify(r))`);
    let recent = [];
    try { recent = JSON.parse(recentRaw) || []; } catch { /* keep [] */ }
    ok("Recent projects persist after reopen", recent.length > 0 && recent[0].path === wsRoot, recentRaw);

    await closeSession(session2);
  } finally {
    try { closeSession(session); } catch {}
    fs.rmSync(base, { recursive: true, force: true });
  }

  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.filter((c) => !c.ok).map((c) => c.name);
  tlog(`PHASE 19 E2E: ${passed}/${checks.length} PASS`);
  if (failed.length) tlog(`FAILED: ${failed.join("; ")}`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((err) => { console.error("phase19 fatal:", err); process.exit(1); });
