// Close Code — Phase 14 integration test: Settings system
// Verifies: 11 categories + schema, defaults, user/workspace scopes with
// precedence (workspace > user > defaults), validation (unknown/drop, clamp),
// persistence across restart, searchable + category-based settings panel UI,
// scope overrides + per-row reset, AI category (external config), and real
// wiring: file excludes, large-file threshold (read-only), content cache /
// tab cap, recent-projects privacy, legacy get/save-settings contract.

const { spawn, execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const EXE = "E:\\closecode\\release\\win-unpacked\\CloseCode.exe";
const PORT = 9236;
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

const LOGF = "C:\\Users\\NITINP~1\\AppData\\Local\\Temp\\opencode\\phase14.log";
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

async function launch(userData, port) {
  const child = spawn(EXE, [`--remote-debugging-port=${port}`], { stdio: "ignore", detached: true, env: { ...process.env, CC_USER_DATA: userData } });
  child.unref();
  let targets = null;
  for (let i = 0; i < 40; i++) { await sleep(800); try { targets = await getJson(`http://127.0.0.1:${port}/json/list`); if (targets && targets.length) break; } catch {} }
  if (!targets) throw new Error("no targets");
  const page = targets.find((t) => t.type === "page") || targets[0];
  return { child, ws: page.webSocketDebuggerUrl };
}

function killAll(pid) {
  try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" }); } catch { try { execSync(`taskkill /F /IM "CloseCode.exe"`, { stdio: "ignore" }); } catch {} }
}

async function main() {
  try { fs.unlinkSync(LOGF); } catch {}
  tlog("phase14 start");

  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cc-phase14-"));
  const userData = path.join(base, "userdata"); fs.mkdirSync(userData, { recursive: true });
  const wsDir = path.join(base, "ws"); fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, "a.txt"), "alpha\n");

  // Workspace files used by wiring checks
  fs.mkdirSync(path.join(wsDir, "phase14-gen"), { recursive: true });
  fs.writeFileSync(path.join(wsDir, "phase14-gen", "x.txt"), "excluded\n");
  const bigPath = path.join(wsDir, "big.log");
  fs.writeFileSync(bigPath, "y".repeat(1.4 * 1024 * 1024), "utf-8"); // 1.4 MB
  fs.writeFileSync(path.join(wsDir, "f1.ts"), "const a = 1;\n");
  fs.writeFileSync(path.join(wsDir, "f2.ts"), "const b = 2;\n");
  fs.writeFileSync(path.join(wsDir, "f3.ts"), "const c = 3;\n");

  const R = [];
  const check = (name, pass, detail) => { R.push({ name, pass }); tlog(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? "  (" + String(detail).slice(0, 140) + ")" : ""}`); };

  // =========================================================
  // Session 1
  // =========================================================
  const s1 = await launch(userData, PORT);
  const ws1 = s1.ws;
  const E = (expr) => evaluate(ws1, expr);

  await sleep(1500);
  await E(`(async()=>{ await window.closeCode.openFolder(${JSON.stringify(wsDir)}); return true; })()`);
  await sleep(500);

  // ---- Categories + schema ----
  const catRes = await E(`window.closeCode.getSettingCategories()`);
  const cats = catRes?.categories ?? [];
  const defs = catRes?.definitions ?? [];
  const EXPECTED_CATS = ["editor", "appearance", "files", "terminal", "git", "language", "formatting", "ai", "extensions", "privacy", "performance"];
  check("categories: all 11 present", cats.length === EXPECTED_CATS.length && EXPECTED_CATS.every((c) => cats.some((x) => x.id === c)), JSON.stringify(cats.map((c) => c.id)));
  check("definitions: schema fields present", defs.length >= 30 && defs.every((d) => d.id && d.category && d.label && d.description && d.type), String(defs.length));
  check("definitions: AI settings external (source ai)", defs.some((d) => d.id === "ai.provider" && d.external === "ai") && defs.some((d) => d.id === "ai.toolMode"));
  const editorDefs = defs.filter((d) => d.category === "editor");
  check("definitions: editor category has monaco-relevant settings", ["fontSize", "tabSize", "wordWrap", "minimap", "cursorBlinking", "bracketPairColorization", "smoothScrolling", "mouseWheelZoom", "autoClosingBrackets"].every((x) => editorDefs.some((d) => d.id === x)));
  const numDef = editorDefs.find((d) => d.id === "fontSize");
  check("definitions: number constraints", numDef?.min === 8 && numDef?.max === 32, JSON.stringify({ min: numDef?.min, max: numDef?.max }));
  const enumDef = editorDefs.find((d) => d.id === "wordWrap");
  check("definitions: enum options", Array.isArray(enumDef?.options) && enumDef.options.length === 4);

  // ---- Defaults ----
  const all1 = await E(`window.closeCode.getAllSettings()`);
  const def = all1?.defaults ?? {};
  check("defaults: expected default values", def?.fontSize === 14 && def?.theme === "dark" && def?.minimap === true && def?.showStatusBar === true);
  check("defaults: performance defaults", def?.largeFileThreshold === 5 && def?.contentCacheMax === 30 && def?.searchDebounceMs === 300);
  check("defaults: new editor defaults", def?.cursorBlinking === "blink" && def?.autoClosingBrackets === "languageDefined" && def?.formatOnPaste === false);
  check("defaults: effective == defaults (no overrides)", JSON.stringify(all1?.effective) === JSON.stringify(all1?.defaults));
  check("snapshot: hasWorkspace true after openFolder", all1?.hasWorkspace === true);

  // ---- User scope + effective (new IPC) ----
  const saveU = await E(`window.closeCode.saveUserSetting({ fontSize: 16, theme: "light" })`);
  check("save-user: ok", saveU?.ok === true, JSON.stringify(saveU?.error));
  const all2 = await E(`window.closeCode.getAllSettings()`);
  check("save-user: user scope has values", all2?.user?.fontSize === 16 && all2?.user?.theme === "light", JSON.stringify(all2?.user));
  check("save-user: effective merges", all2?.effective?.fontSize === 16 && all2?.effective?.theme === "light");
  const legacy = await E(`window.closeCode.getSettings()`);
  check("legacy: getSettings returns merged effective", legacy?.fontSize === 16 && legacy?.theme === "light");

  // ---- Validation ----
  await E(`window.closeCode.saveUserSetting({ fontSize: "abc", bogusKey: 1, minimap: "yes" })`);
  const all3 = await E(`window.closeCode.getAllSettings()`);
  check("validation: unknown keys dropped", !("bogusKey" in all3?.user), JSON.stringify(Object.keys(all3?.user ?? {})));
  check("validation: invalid value dropped (fontSize stays 16)", all3?.user?.fontSize === 16 && !("minimap" in all3?.user));
  await E(`window.closeCode.saveUserSetting({ fontSize: 199 })`);
  const all3b = await E(`window.closeCode.getAllSettings()`);
  check("validation: number clamped to max", all3b?.user?.fontSize === 32, String(all3b?.user?.fontSize));

  // ---- Workspace scope + precedence ----
  const saveW = await E(`window.closeCode.saveWorkspaceSetting({ fontSize: 14 })`);
  check("save-workspace: ok", saveW?.ok === true, JSON.stringify(saveW?.error));
  const wsSettingsPath = path.join(wsDir, ".closecode", "settings.json");
  check("workspace: .closecode/settings.json written on disk", fs.existsSync(wsSettingsPath), wsSettingsPath);
  const onDisk = JSON.parse(fs.readFileSync(wsSettingsPath, "utf-8"));
  check("workspace: file content matches", onDisk?.fontSize === 14, JSON.stringify(onDisk));
  const all4 = await E(`window.closeCode.getAllSettings()`);
  check("precedence: workspace overrides user", all4?.effective?.fontSize === 14 && all4?.user?.fontSize === 32 && all4?.workspace?.fontSize === 14);

  // ---- Legacy save-settings contract ----
  const legacySave = await E(`(async()=>{ const r = await window.closeCode.saveSettings({ wordWrap: "on" }); return { ok: r?.wordWrap === "on", wordWrap: r?.wordWrap }; })()`);
  check("legacy: save-settings returns full settings + applies", legacySave?.ok === true, JSON.stringify(legacySave));
  const all4b = await E(`window.closeCode.getAllSettings()`);
  check("legacy: save-settings writes user scope", all4b?.user?.wordWrap === "on" && all4b?.effective?.wordWrap === "on");

  // ---- Real wiring: file excludes ----
  await E(`window.closeCode.saveWorkspaceSetting({ fileExcludes: ["phase14-gen"] })`);
  const listing = await E(`window.closeCode.listDir(${JSON.stringify(wsDir)})`);
  const names = Array.isArray(listing?.result) ? listing.result.map((e) => e.name) : [];
  check("wiring: workspace fileExcludes hide directory", !names.includes("phase14-gen") && names.includes("a.txt"), JSON.stringify(names));
  await E(`window.closeCode.resetWorkspaceSettings()`);

  // ---- Real wiring: large-file threshold -> read-only warning ----
  await E(`window.closeCode.saveUserSetting({ largeFileThreshold: 1 })`);
  await poll(async () => (await E(`window.__settingsStore?.getState().effective.largeFileThreshold === 1`)) === true, 8000, 150, "renderer effective largeFileThreshold");
  await E(`window.__editorStore.getState().openFileInWorkspace(${JSON.stringify(bigPath)})`);
  await sleep(600);
  const warn = await E(`(window.__editorStore.getState().largeFileWarning || "").replace(/\\\\/g, "/")`);
  check("wiring: large file flagged at 1 MB threshold", String(warn).toLowerCase().includes("big.log"), String(warn));
  const bannerText = await E(`document.body.innerText.includes("editing may be slow")`);
  check("wiring: read-only warning banner shown", bannerText === true);

  // ---- Real wiring: content cache / tab cap ----
  await E(`window.closeCode.saveUserSetting({ contentCacheMax: 2 })`);
  await poll(async () => (await E(`window.__settingsStore?.getState().effective.contentCacheMax === 2`)) === true, 8000, 150, "renderer effective contentCacheMax");
  await E(`window.__editorStore.getState().openFileInWorkspace(${JSON.stringify(path.join(wsDir, "f1.ts"))})`);
  await E(`window.__editorStore.getState().openFileInWorkspace(${JSON.stringify(path.join(wsDir, "f2.ts"))})`);
  await E(`window.__editorStore.getState().openFileInWorkspace(${JSON.stringify(path.join(wsDir, "f3.ts"))})`);
  await sleep(500);
  const tabCount = await E(`window.__editorStore.getState().tabs.length`);
  check("wiring: contentCacheMax caps open tabs", tabCount <= 2, String(tabCount));

  // ---- Privacy: rememberRecentProjects gates recent list ----
  await E(`window.closeCode.saveUserSetting({ rememberRecentProjects: false })`);
  await E(`(async()=>{ await window.closeCode.openFolder(${JSON.stringify(wsDir)}); return true; })()`);
  await sleep(300);
  const recent = await E(`window.closeCode.getRecentProjects()`);
  check("privacy: recent projects empty when disabled", Array.isArray(recent) && recent.length === 0, JSON.stringify(recent));

  // ---- UI: settings panel ----
  await E(`window.__commandRegistry.execute("settings")`);
  await poll(async () => (await E(`!!document.querySelector('[data-settings-panel]')`)) === true, 6000, 120, "settings panel");
  tlog("  diag: " + JSON.stringify(await E(`(() => {
    const s = window.__settingsStore?.getState();
    return {
      panel: !!document.querySelector('[data-settings-panel]'),
      asideCount: document.querySelectorAll('aside').length,
      cats: Array.from(document.querySelectorAll('[data-settings-category]')).map((b) => b.getAttribute('data-settings-category')),
      storeCats: s?.categories?.length ?? -1,
      query: s?.query,
      loading: s?.loading,
      error: s?.error ?? null,
      storeError: window.__settingsStore ? window.__settingsStore.getState().error : null,
      bodyText: (document.body.innerText || '').slice(0, 160).replace(/\\n/g, ' | '),
    };
  })()`)));
  const catButtons = await E(`Array.from(document.querySelectorAll('[data-settings-category]')).map(b => b.getAttribute('data-settings-category'))`);
  check("ui: 11 category buttons + All", EXPECTED_CATS.every((c) => catButtons.includes(c)) && catButtons.includes("all") && catButtons.length === 12, JSON.stringify(catButtons));
  check("ui: search input present", (await E(`!!document.querySelector('[data-settings-search]')`)) === true);
  check("ui: workspace scope enabled (ws open)", (await E(`document.querySelector('[data-settings-scope="workspace"]')?.disabled === false`)) === true);

  // All category (no search) shows every row
  const allRowsAll = await E(`document.querySelectorAll('[data-setting]').length`);
  check("ui: all settings rows rendered (>=30)", allRowsAll >= 30, String(allRowsAll));

  // Select Editor category -> rows subset
  await E(`document.querySelector('[data-settings-category="editor"]').click()`);
  await sleep(200);
  const editorRows = await E(`Array.from(document.querySelectorAll('[data-setting]')).map(r => r.getAttribute('data-setting'))`);
  check("ui: editor category filters rows", editorRows.includes("fontSize") && editorRows.includes("cursorBlinking") && !editorRows.includes("theme"), JSON.stringify(editorRows));

  // Toggle minimap in target scope (user) via the switch
  await E(`document.querySelector('[data-setting="minimap"] [data-setting-toggle]').click()`);
  await poll(async () => {
    const s = await E(`window.closeCode.getAllSettings()`);
    return s?.user?.minimap === false ? true : null;
  }, 8000, 120, "minimap override in user scope");
  check("ui: toggle writes to user scope + effective", (await E(`(async()=>{ const s = await window.closeCode.getAllSettings(); return s.effective.minimap === false && s.user.minimap === false; })()`)) === true);
  check("ui: owner badge shows 'user'", (await E(`document.querySelector('[data-setting="minimap"] [data-setting-owner]')?.getAttribute('data-setting-owner') === "user"`)) === true);
  check("ui: per-row reset appears when overridden", (await E(`!!document.querySelector('[data-setting="minimap"] [data-setting-reset]')`)) === true);

  // Per-row reset clears the override
  await E(`document.querySelector('[data-setting="minimap"] [data-setting-reset]').click()`);
  await poll(async () => {
    const s = await E(`window.closeCode.getAllSettings()`);
    return !("minimap" in (s?.user ?? {})) ? true : null;
  }, 8000, 120, "minimap override cleared");
  check("ui: per-row reset clears override", (await E(`(async()=>{ const s = await window.closeCode.getAllSettings(); return s.effective.minimap === true; })()`)) === true);

  // Scope switch to workspace writes to workspace scope (+ diagnostic if the UI went blank)
  const scopeDiag = await E(`(() => {
    const b = document.querySelector('[data-settings-scope="workspace"]');
    if (b) { b.click(); return null; }
    return JSON.stringify({
      panel: !!document.querySelector('[data-settings-panel]'),
      catButtons: document.querySelectorAll('[data-settings-category]').length,
      body: (document.body.innerText || '').slice(0, 140),
      storeErr: window.__settingsStore.getState().error,
      storeCats: window.__settingsStore.getState().categories.length,
      effectiveKeys: Object.keys(window.__settingsStore.getState().effective).length,
    });
  })()`);
  if (scopeDiag) { tlog("  diag-scope: " + scopeDiag); throw new Error("scope button missing: " + scopeDiag); }
  await sleep(150);
  // showStatusBar belongs to the "appearance" category — show all rows first
  await E(`document.querySelector('[data-settings-category="all"]').click()`);
  await sleep(150);
  await E(`document.querySelector('[data-setting="showStatusBar"] [data-setting-toggle]').click()`);
  await poll(async () => {
    const s = await E(`window.closeCode.getAllSettings()`);
    return s?.workspace?.showStatusBar === false ? true : null;
  }, 8000, 120, "workspace-scope write via panel");
  check("ui: workspace scope toggle writes to workspace", (await E(`(async()=>{ const s = await window.closeCode.getAllSettings(); return s.workspace.showStatusBar === false && s.user.showStatusBar === undefined; })()`)) === true);
  // Restore: reset the workspace override for showStatusBar
  await E(`window.closeCode.saveWorkspaceSetting({ showStatusBar: null })`);

  // Searchable: type "font" -> results filtered + count shown
  await E(`(() => { const input = document.querySelector('[data-settings-search]'); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set; setter.call(input, "font"); input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await sleep(350);
  const resultsCount = await E(`document.querySelector('[data-settings-results-count]')?.textContent?.trim() ?? ""`);
  check("ui: search shows results count", /\d+ sett?ings? match/.test(resultsCount), resultsCount);
  const fontSizeVisible = await E(`!!document.querySelector('[data-setting="fontSize"]') && document.querySelector('[data-setting="fontSize"]').offsetParent !== null`);
  check("ui: search finds fontSize row", fontSizeVisible === true);
  const termDefRows = await E(`Array.from(document.querySelectorAll('[data-setting="terminalFontSize"]')).length`);
  check("ui: search finds terminalFontSize too", termDefRows === 1, String(termDefRows));
  // clear search
  await E(`(() => { const input = document.querySelector('[data-settings-search]'); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set; setter.call(input, ""); input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await sleep(300);

  // AI category renders the external AI sections
  await E(`document.querySelector('[data-settings-category="ai"]').click()`);
  await sleep(250);
  const aiProvider = await E(`document.querySelector('[data-ai-setting="provider"]')?.value ?? null`);
  check("ui: AI provider select rendered (external)", typeof aiProvider === "string" && aiProvider.length > 0, String(aiProvider));
  check("ui: AI key status shown", (await E(`!!document.querySelector('[data-ai-setting="keyStatus"]')`)) === true);
  check("ui: AI stream switch present", (await E(`!!document.querySelector('[data-ai-setting="stream"]')`)) === true);

  // Footer reset (user scope)
  await E(`document.querySelector('[data-settings-category="all"]').click()`);
  await E(`document.querySelector('[data-settings-scope="user"]').click()`);
  await sleep(150);
  await E(`document.querySelector('[data-settings-reset-scope]').click()`);
  await poll(async () => {
    const s = await E(`window.closeCode.getAllSettings()`);
    return Object.keys(s?.user ?? {}).length === 0 ? true : null;
  }, 8000, 120, "user scope reset via footer");
  check("ui: footer resets user scope", (await E(`(async()=>{ const s = await window.closeCode.getAllSettings(); return s.effective === undefined || (Object.keys(s.user).length === 0 && s.effective.showStatusBar === true); })()`)) === true);

  // Ensure workspace override survives for the restart test
  await E(`window.closeCode.saveWorkspaceSetting({ fontSize: 14 })`);
  // (Re)create user overrides AFTER the footer-reset test so persistence across
  // restart has user-scope values to verify.
  await E(`window.closeCode.saveUserSetting({ wordWrap: "on", largeFileThreshold: 1, contentCacheMax: 2, fontSize: 16 })`);

  tlog("  -- restarting app (persistence check) --");
  killAll(s1.child.pid);
  await sleep(1200);

  // =========================================================
  // Session 2: persistence across restart
  // =========================================================
  const s2 = await launch(userData, PORT + 1);
  const E2 = (expr) => evaluate(s2.ws, expr);
  await sleep(1500);
  await E2(`(async()=>{ await window.closeCode.openFolder(${JSON.stringify(wsDir)}); return true; })()`);
  await sleep(400);

  const all5 = await E2(`window.closeCode.getAllSettings()`);
  check("restart: user settings persisted", all5?.user?.wordWrap === "on" && all5?.user?.largeFileThreshold === 1 && all5?.user?.contentCacheMax === 2 && all5?.user?.fontSize === 16, JSON.stringify(all5?.user));
  check("restart: workspace settings persisted on disk", all5?.workspace?.fontSize === 14, JSON.stringify(all5?.workspace));
  check("restart: workspace still overrides user", all5?.effective?.fontSize === 14);
  const legacy2 = await E2(`window.closeCode.getSettings()`);
  check("restart: legacy getSettings reflects merge", legacy2?.fontSize === 14);

  // Reset workspace -> falls back to user
  const rw = await E2(`window.closeCode.resetWorkspaceSettings()`);
  check("reset-workspace: ok", rw?.ok === true, JSON.stringify(rw?.error));
  const all6 = await E2(`window.closeCode.getAllSettings()`);
  check("reset-workspace: file removed + user wins", all6?.effective?.fontSize === 16 && !fs.existsSync(wsSettingsPath), JSON.stringify(all6?.effective?.fontSize));

  // Reset user -> everything back to defaults
  const ru = await E2(`window.closeCode.resetUserSettings()`);
  check("reset-user: ok", ru?.ok === true, JSON.stringify(ru?.error));
  const all7 = await E2(`window.closeCode.getAllSettings()`);
  check("reset-user: effective back to defaults", all7?.effective?.fontSize === 14 && all7?.effective?.theme === "dark" && Object.keys(all7?.user ?? {}).length === 0, JSON.stringify(all7?.effective));
  await poll(async () => {
    const s = await E2(`window.closeCode.getSettings()`);
    return s && s.fontSize === 14 ? true : null;
  }, 8000, 150, "renderer effective reset applied");
  check("reset-user: legacy getSettings returns defaults", true);

  const all = R.every((r) => r.pass);
  tlog(`\n${R.filter((r) => r.pass).length}/${R.length} checks passed`);
  tlog(all ? "PHASE 14 INTEGRATION: PASSED" : "PHASE 14 INTEGRATION: FAILED");
  killAll(s2.child.pid);
  await sleep(500);
  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  process.exit(all ? 0 : 1);
}

main().catch((e) => { tlog("ERR " + (e && e.stack || e)); console.error(e); try { execSync(`taskkill /F /IM "CloseCode.exe"`, { stdio: "ignore" }); } catch {} process.exit(1); });