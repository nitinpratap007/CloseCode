// Close Code — Phase 13 integration test: Extension System
// Fixture extensions are created on the fly, discovered via CC_EXTENSIONS.
// Verifies: discovery, manifest parsing, auto-activation, contributed commands
// (manifest-declared + api.registerCommand), permission gating, vm sandbox
// (no require/process), enable/disable round-trip, invalid manifest loadError,
// incompatible version handling, and the renderer extensions panel.

const { spawn, execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const EXE = "E:\\closecode\\release\\win-unpacked\\CloseCode.exe";
const PORT = 9235;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) { const res = await fetch(url); return res.json(); }
function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const fail = () => { try { ws.close(); } catch {} reject(new Error("CDP timeout: " + expression.slice(0, 80))); };
    const timer = setTimeout(fail, 30000);
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

const LOGF = "C:\\Users\\NITINP~1\\AppData\\Local\\Temp\\opencode\\phase13.log";
function tlog(m) { try { fs.appendFileSync(LOGF, m + "\n"); } catch {} console.log(m); }

async function poll(fn, timeoutMs, everyMs = 150, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(everyMs);
  }
  throw new Error("Timed out waiting for: " + label);
}

function writeFixture(dir, name, manifest, main) {
  const d = path.join(dir, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "extension.json"), JSON.stringify(manifest, null, 2));
  if (main) fs.writeFileSync(path.join(d, "main.js"), main);
}

async function main() {
  try { fs.unlinkSync(LOGF); } catch {}
  tlog("phase13 start");

  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cc-phase13-"));
  const userData = path.join(base, "userdata"); fs.mkdirSync(userData, { recursive: true });
  const wsDir = path.join(base, "ws"); fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, "readme.md"), "# workspace\n");

  // ---- Fixture extensions ----
  const extHome = path.join(base, "extensions-home"); fs.mkdirSync(extHome, { recursive: true });

  writeFixture(extHome, "fixtures.helloworld", {
    id: "fixtures.helloworld",
    name: "helloworld",
    displayName: "Hello World",
    version: "1.0.0",
    publisher: "fixtures",
    description: "Writes a marker file when commanded.",
    engines: { closecode: ">=0.1.0" },
    permissions: ["commands", "files"],
    contributes: { commands: [{ id: "hello.ping", title: "Hello: Ping" }] },
    main: "main.js",
  }, `
function activate(api) {
  api.registerCommand({
    id: "hello.say",
    title: "Hello: Say",
    execute: function () {
      var envProbe = "err";
      try {
        envProbe = typeof require + "/" + typeof process + "/" + typeof fs;
      } catch (e) {
        envProbe = "caught:" + e.message;
      }
      if (api.workspace) {
        api.files.write(api.workspace + "/hello-from-ext.txt", "written by " + api.id);
      }
      api.log("hello.say executed");
      return "ran-ok " + envProbe;
    },
  });
}
function deactivate() { return undefined; }
`);

  writeFixture(extHome, "local.nocmd", {
    id: "local.nocmd",
    name: "nocmd",
    displayName: "No Files Permission",
    version: "0.2.0",
    description: "Requests only the commands permission.",
    permissions: ["commands"],
    main: "main.js",
  }, `
function activate(api) {
  api.registerCommand({
    id: "nocmd.tryfile",
    title: "NoCmd: Try files",
    execute: function () {
      try {
        if (!api.files) return "no-files-api";
        api.files.read("anything");
        return "file-api-present";
      } catch (err) {
        return "err:" + (err && err.message || String(err));
      }
    },
  });
}
`);

  writeFixture(extHome, "local.broken", {
    id: "local.broken",
    name: "broken",
    displayName: "Broken",
    version: "0.0.1",
    description: "Main entry does not exist.",
    permissions: ["commands"],
    main: "missing.js",
  }, null);

  writeFixture(extHome, "local.old", {
    id: "local.old",
    name: "old",
    displayName: "Ancient",
    version: "0.0.9",
    description: "Requires a future Close Code.",
    engines: { closecode: "999.0.0" },
    permissions: ["commands"],
    main: "main.js",
  }, "function activate() {}");

  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], { stdio: "ignore", detached: true, env: { ...process.env, CC_USER_DATA: userData, CC_EXTENSIONS: extHome } });
  child.unref();
  let targets = null;
  for (let i = 0; i < 40; i++) { await sleep(800); try { targets = await getJson(`http://127.0.0.1:${PORT}/json/list`); if (targets && targets.length) break; } catch {} }
  if (!targets) throw new Error("no targets");
  const page = targets.find((t) => t.type === "page") || targets[0];
  const ws = page.webSocketDebuggerUrl;
  const E = (expr) => evaluate(ws, expr);
  const R = [];
  const check = (name, pass, detail) => { R.push({ name, pass }); tlog(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? "  (" + String(detail).slice(0, 120) + ")" : ""}`); };

  await sleep(1500);
  await E(`(async()=>{ await window.closeCode.openFolder(${JSON.stringify(wsDir)}); return true; })()`);

  // ---- Discovery via main ----
  const list = await E(`window.closeCode.extensionList()`);
  const ids = Array.isArray(list) ? list.map((e) => e.id) : [];
  check("discovery: 4 fixture extensions found", ["fixtures.helloworld", "local.nocmd", "local.broken", "local.old"].every((x) => ids.includes(x)), JSON.stringify(ids));
  const hello = list.find((e) => e.id === "fixtures.helloworld");
  check("discovery: fixtures.helloworld enabled by default", hello?.enabled === true);
  check("discovery: manifest fields parsed", hello?.version === "1.0.0" && hello?.publisher === "fixtures" && hello?.permissions?.includes("files"), JSON.stringify({ v: hello?.version, p: hello?.permissions }));
  check("discovery: contributed commands surfaced", Array.isArray(hello?.commands) && hello.commands.some((c) => c.id === "hello.ping"), JSON.stringify(hello?.commands));
  const broken = list.find((e) => e.id === "local.broken");
  check("invalid manifest: loadError surfaced", !!broken?.loadError && broken?.enabled === false, broken?.loadError);
  const old = list.find((e) => e.id === "local.old");
  check("versioning: incompatible version flagged", old?.incompatible === true && old?.enabled === false, JSON.stringify({ incompatible: old?.incompatible }));

  // ---- Contributed commands reach the renderer command registry ----
  await poll(async () => {
    const cs = await E(`window.__getAllCommands().map(c => c.id)`);
    return Array.isArray(cs) && cs.includes("hello.say") && cs.includes("hello.ping") ? cs : null;
  }, 10000, 150, "extension commands in renderer registry");
  const allCmds = await E(`window.__getAllCommands().map(c => c.id)`);
  check("registry: hello.say registered from api.registerCommand", allCmds.includes("hello.say"));
  check("registry: hello.ping registered from manifest contributes", allCmds.includes("hello.ping"));
  check("registry: intercept-free indexes unaffected", allCmds.filter((c) => c === "hello.say" || c === "hello.ping").length === 2);

  // ---- Execute an extension command (files permission granted) ----
  const exec1 = await E(`window.closeCode.extensionExecCommand("hello.say")`);
  check("exec: hello.say ok", exec1?.ok === true, JSON.stringify(exec1));
  check("exec: sandbox has no require/process/fs", String(exec1?.result).includes("undefined/undefined"), String(exec1?.result));
  // Wait for the file write to land (workspace root + files permission allow the path).
  await poll(async () => {
    return fs.existsSync(path.join(wsDir, "hello-from-ext.txt")) ? true : null;
  }, 8000, 150, "extension file write");
  check("exec: extension wrote into workspace via api.files", fs.readFileSync(path.join(wsDir, "hello-from-ext.txt"), "utf-8") === "written by fixtures.helloworld");
  const execManifest = await E(`window.closeCode.extensionExecCommand("hello.ping")`);
  check("exec: manifest-declared command auto-handler", execManifest?.ok === true && execManifest?.result?.__manifestCommand === true, JSON.stringify(execManifest?.result));
  const execUnknown = await E(`window.closeCode.extensionExecCommand("hello.nope")`);
  check("exec: unknown command rejected", execUnknown?.ok === false, JSON.stringify(execUnknown));

  // ---- Permission gating: extension without files permission ----
  const execNoPerm = await E(`window.closeCode.extensionExecCommand("nocmd.tryfile")`);
  check("permissions: no files api without permission", String(execNoPerm?.result) === "no-files-api", String(execNoPerm?.result));

  // ---- Enable/disable round-trip ----
  const dis = await E(`window.closeCode.extensionSetEnabled("fixtures.helloworld", false)`);
  check("disable: ok + list reflects", dis?.ok === true && dis?.result?.find((e) => e.id === "fixtures.helloworld")?.enabled === false, JSON.stringify(dis?.error));
  await poll(async () => {
    const cs = await E(`window.__getAllCommands().map(c => c.id)`);
    return !cs.includes("hello.say") ? cs : null;
  }, 10000, 150, "command removed after disable");
  const afterDisable = await E(`window.__getAllCommands().map(c => c.id)`);
  check("disable: command removed from registry", !afterDisable.includes("hello.say"));
  const execAfterDisable = await E(`window.closeCode.extensionExecCommand("hello.say")`);
  check("disable: execution rejected", execAfterDisable?.ok === false, JSON.stringify(execAfterDisable));
  const en = await E(`window.closeCode.extensionSetEnabled("fixtures.helloworld", true)`);
  check("enable: ok + command restored", en?.ok === true && en?.result?.find((e) => e.id === "fixtures.helloworld")?.enabled === true);
  await poll(async () => {
    const cs = await E(`window.__getAllCommands().map(c => c.id)`);
    return cs.includes("hello.say") ? cs : null;
  }, 10000, 150, "command restored after enable");
  const exec2 = await E(`window.closeCode.extensionExecCommand("hello.say")`);
  check("enable: command executes again", exec2?.ok === true, JSON.stringify(exec2));

  // ---- Cannot enable invalid/incompatible extensions ----
  const tryBroken = await E(`window.closeCode.extensionSetEnabled("local.broken", true)`);
  check("invalid: cannot enable broken extension", tryBroken?.ok === false, JSON.stringify(tryBroken));
  const tryOld = await E(`window.closeCode.extensionSetEnabled("local.old", true)`);
  check("incompatible: cannot enable old extension", tryOld?.ok === false, JSON.stringify(tryOld?.error));

  // ---- Renderer Extensions panel ----
  await E(`window.__commandRegistry.execute("extensions-view")`);
  await poll(async () => (await E(`!!document.querySelector('[data-extensions-panel]')`)) === true, 5000, 120, "extensions panel");
  const rowCount = await E(`document.querySelectorAll('[data-extension]').length`);
  check("panel: extension rows rendered", rowCount === 4, String(rowCount));
  check("panel: fixtures.helloworld toggle on", (await E(`document.querySelector('[data-extension="fixtures.helloworld"] [data-extension-toggle]')?.checked === true`)) === true);
  check("panel: permission chip shown", (await E(`!!document.querySelector('[data-extension="fixtures.helloworld"] [data-extension-permission="files"]')`)) === true);
  check("panel: command chip shown", (await E(`!!document.querySelector('[data-extension="fixtures.helloworld"] [data-extension-command="hello.say"]')`)) === true);
  check("panel: broken extension shows error", (await E(`!!document.querySelector('[data-extension="local.broken"] [data-extension-error]')`)) === true);
  check("panel: broken extension toggle disabled", (await E(`document.querySelector('[data-extension="local.broken"] [data-extension-toggle]')?.disabled === true`)) === true);
  check("panel: incompatible flag shown", (await E(`document.querySelector('[data-extension="local.old"]')?.textContent?.includes("incompatible") === true`)) === true);

  // Toggle via the panel UI (enable -> disable through the checkbox)
  await E(`(document.querySelector('[data-extension="fixtures.helloworld"] [data-extension-toggle]')).click()`);
  await poll(async () => {
    const res = await E(`(async()=>{ const l = await window.closeCode.extensionList(); return l.find(e => e.id === "fixtures.helloworld")?.enabled; })()`);
    return res === false ? true : null;
  }, 10000, 150, "panel toggle disables");
  check("panel: checkbox toggles enabled state", true);
  await E(`(document.querySelector('[data-extension="fixtures.helloworld"] [data-extension-toggle]')).click()`);
  await poll(async () => {
    const res = await E(`(async()=>{ const l = await window.closeCode.extensionList(); return l.find(e => e.id === "fixtures.helloworld")?.enabled; })()`);
    return res === true ? true : null;
  }, 10000, 150, "panel toggle re-enables");
  check("panel: re-enable via checkbox", true);

  // ---- Reload keeps extensions functional ----
  const reloadRes = await E(`window.closeCode.extensionReload()`);
  check("reload: ok", reloadRes?.ok === true, JSON.stringify(reloadRes?.error));
  const exec3 = await E(`window.closeCode.extensionExecCommand("hello.say")`);
  check("reload: command works after reload", exec3?.ok === true, JSON.stringify(exec3));

  const all = R.every((r) => r.pass);
  tlog(`\n${R.filter((r) => r.pass).length}/${R.length} checks passed`);
  tlog(all ? "PHASE 13 INTEGRATION: PASSED" : "PHASE 13 INTEGRATION: FAILED");
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); } catch { try { execSync(`taskkill /F /IM "CloseCode.exe"`, { stdio: "ignore" }); } catch {} }
  await sleep(500);
  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  process.exit(all ? 0 : 1);
}
main().catch((e) => { tlog("ERR " + (e && e.stack || e)); console.error(e); try { execSync(`taskkill /F /IM "CloseCode.exe"`, { stdio: "ignore" }); } catch {} process.exit(1); });