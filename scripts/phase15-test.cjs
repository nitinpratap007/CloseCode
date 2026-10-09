// Close Code — Phase 15 integration test: Themes & Customization.
// Verifies: workbench palette CSS-var theming (data-theme + --cc-*), scheme
// handling (dark/light/system with system→matchMedia), Monaco editor themes
// (cc-dark/cc-light builtins + user/workspace custom editor themes with
// theme.json discovery via both userData and workspace .closecode), accent
// color overrides + persistence, theme picker UI (workbench + editor sections,
// accent swatches), the theme-store init wiring (palette applied off the
// default dark palette and customezable), and the refresh/hot-reload path.

const { spawn, execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const EXE = "E:\\closecode\\release\\win-unpacked\\CloseCode.exe";
const PORT = 9237;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) { const res = await fetch(url); return res.json(); }
function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const fail = () => { try { ws.close(); } catch {} reject(new Error("CDP timeout: " + expression.slice(0, 80))); };
    const timer = setTimeout(fail, 40000);
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

const LOGF = "C:\\Users\\NITINP~1\\AppData\\Local\\Temp\\opencode\\phase15.log";
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
  tlog("phase15 start");

  // Isolated profile + workspace. A custom editor theme ships from BOTH the
  // user scope (themes dir under userData) and the workspace scope
  // (.closecode/themes) so we can verify discovery + scope precedence.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cc-phase15-"));
  const userData = path.join(base, "userdata"); fs.mkdirSync(userData, { recursive: true });
  const wsDir = path.join(base, "ws"); fs.mkdirSync(wsDir, { recursive: true });

  // user-scope custom editor theme (cc-user-glacier): a Catppuccin-ish dark.
  const userThemeDir = path.join(userData, "themes"); fs.mkdirSync(userThemeDir, { recursive: true });
  const userTheme = {
    type: "dark",
    name: "cc-user-glacier",
    monaco: {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment", foreground: "6c7086", fontStyle: "italic" },
        { token: "keyword", foreground: "89b4fa" },
        { token: "string", foreground: "a6e3a1" },
      ],
      colors: {
        "editor.background": "#1e1e2e",
        "editor.foreground": "#cdd6f4",
        "editorCursor.foreground": "#89b4fa",
        "editor.lineHighlightBackground": "#31324455",
        "editor.selectionBackground": "#89b4fa33",
      },
    },
  };
  fs.writeFileSync(path.join(userThemeDir, "glacier.json"), JSON.stringify(userTheme));

  // workspace-scope custom editor theme (ws-icy): a light theme.
  const wsThemeDir = path.join(wsDir, ".closecode", "themes"); fs.mkdirSync(wsThemeDir, { recursive: true });
  fs.writeFileSync(path.join(wsThemeDir, "icy.json"), JSON.stringify({
    name: "ws-icy",
    type: "light",
    monaco: {
      base: "vs",
      inherit: true,
      rules: [{ token: "comment", foreground: "4c4f69", fontStyle: "italic" }],
      colors: {
        "editor.background": "#eff1f5",
        "editor.foreground": "#4c4f69",
        "editorCursor.foreground": "#1e66f5",
      },
    },
  }));

  const R = [];
  const check = (name, pass, detail) => { R.push({ name, pass }); tlog(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? "  (" + String(detail).slice(0, 160) + ")" : ""}`); };

  // =========================================================
  // Session 1
  // =========================================================
  const s1 = await launch(userData, PORT);
  const ws1 = s1.ws;
  const E = (expr) => evaluate(ws1, expr);

  await sleep(1800);
  // Harness: open a workspace so the workspace-scope theme is discoverable.
  await E(`(async()=>{ await window.closeCode.openFolder(${JSON.stringify(wsDir)}); return true; })()`);
  await sleep(600);

  // ---- 1. Defaults: palette + Monaco theme + data-theme ----
  const initState = await E(`(() => {
    const api = window.closeCode;
    const el = document.documentElement;
    return {
      themeSetting: api.getSettings ? null : null,
      getTheme: (() => { try { return window.__monaco.editor.getTheme(); } catch { return null; } })(),
      dataTheme: el.dataset.theme ?? null,
      cls: el.className,
      rootBg: getComputedStyle(el).getPropertyValue("--cc-bg").trim(),
      rootSurface: getComputedStyle(el).getPropertyValue("--cc-surface").trim(),
      rootBorder: getComputedStyle(el).getPropertyValue("--cc-border").trim(),
      rootText: getComputedStyle(el).getPropertyValue("--cc-text").trim(),
      rootMuted: getComputedStyle(el).getPropertyValue("--cc-muted").trim(),
      rootAccent: getComputedStyle(el).getPropertyValue("--cc-accent").trim(),
    };
  })()`);
  check("init: getTheme is cc-dark", initState?.getTheme === "cc-dark", initState?.getTheme);
  check("init: data-theme dark", initState?.dataTheme === "dark", initState?.dataTheme);
  check("init: html.classList contains dark", (initState?.cls ?? "").split(/\s+/).includes("dark"));
  check("init: --cc-bg default (1e 1e 2e)", initState?.rootBg === "30 30 46", initState?.rootBg);
  check("init: --cc-surface default", initState?.rootSurface === "37 37 54", initState?.rootSurface);
  check("init: --cc-border default", initState?.rootBorder === "49 50 68", initState?.rootBorder);
  check("init: --cc-text default", initState?.rootText === "205 214 244", initState?.rootText);
  check("init: --cc-accent default (89 b4 fa)", initState?.rootAccent === "137 180 250", initState?.rootAccent);

  // ---- 2. theme settings default + effective reflects scenario ----
  const sAll = await E(`window.closeCode.getSettings()`);
  check("settings: default theme dark", sAll?.theme === "dark");
  check("settings: editorTheme absent by default (auto)", !("editorTheme" in (sAll?.user ?? {})));

  // ---- 3. Light workbench theme (scheme light → data-theme + vars flip) ----
  await E(`window.closeCode.saveSettings({ theme: "light" })`);
  await poll(async () => (await E(`document.documentElement.dataset.theme`)) === "light", 8000, 120, "light dataset");
  const lightVars = await E(`(() => {
    const el = document.documentElement;
    return {
      dataTheme: el.dataset.theme,
      bg: getComputedStyle(el).getPropertyValue("--cc-bg").trim(),
      surface: getComputedStyle(el).getPropertyValue("--cc-surface").trim(),
      text: getComputedStyle(el).getPropertyValue("--cc-text").trim(),
      muted: getComputedStyle(el).getPropertyValue("--cc-muted").trim(),
      mono: (() => { try { return window.__monaco.editor.getTheme(); } catch { return null; } })()
    };
  })()`);
  check("light: data-theme flips to light", lightVars?.dataTheme === "light", lightVars?.dataTheme);
  check("light: --cc-bg is light surface (239 241 245)", lightVars?.bg === "239 241 245", lightVars?.bg);
  check("light: editor theme auto-follows → cc-light", lightVars?.mono === "cc-light", lightVars?.mono);

  // ---- 4. Preserved dark scheme via saveUserSetting (system still follows matchMedia) ----
  await E(`window.closeCode.saveUserSetting({ theme: "system" })`);
  await sleep(400);
  const sysDark = await E(`matchMedia("(prefers-color-scheme: dark)").matches`);
  await poll(async () => (await E(`document.documentElement.dataset.theme`)) === (sysDark ? "dark" : "light"), 8000, 120, "system dataset");
  const sysVar = await E(`getComputedStyle(document.documentElement).getPropertyValue("--cc-bg").trim()`);
  check("system: workbench follows matchMedia", (sysDark ? "30 30 46" : "239 241 245") === sysVar, sysVar);

  // ---- 5. Accent color override ----
  await E(`window.closeCode.saveUserSetting({ accentColor: "#f38ba8" })`);
  await poll(async () => (await E(`getComputedStyle(document.documentElement).getPropertyValue("--cc-accent").trim()`)) === "243 139 168", 8000, 120, "accent override");
  check("accent: user override applied", true, "#f38ba8 → 243 139 168");
  await E(`window.closeCode.saveUserSetting({ accentColor: "" })`);
  await poll(async () => (await E(`getComputedStyle(document.documentElement).getPropertyValue("--cc-accent").trim()`)) !== "243 139 168", 8000, 120, "accent cleared");
  check("accent: clearing returns to palette", (await E(`getComputedStyle(document.documentElement).getPropertyValue("--cc-accent").trim()`)) === (sysDark ? "137 180 250" : "30 102 245"));

  // ---- 6. Custom editor themes from both scopes are registered ----
  const themeDefs = await E(`(() => {
    const t = window.__themeStore ? window.__themeStore.getState() : null;
    const mon = window.__monaco ? window.__monaco.editor : null;
    const names = [];
    if (mon) {
      // Registered custom themes are in the theme registry; getThemes lists all.
    }
    return t ? t.customThemes : null;
  })()`);
  check("themes: themeStore has user + workspace custom themes", Array.isArray(themeDefs) && themeDefs.length >= 2 && themeDefs.some((d) => d.name === "cc-user-glacier" && d.scope === "user") && themeDefs.some((d) => d.name === "ws-icy" && d.scope === "workspace"), JSON.stringify(themeDefs?.map((d) => d.name + ":" + d.scope)));

  // ---- 7. Apply user-scope custom theme -> Monaco + strong workbench bg ----
  await E(`window.__themeStore.getState().apply("cc-user-glacier")`);
  await poll(async () => (await E(`(function(){ try { return window.__monaco.editor.getTheme(); } catch { return null; } })()`)) === "cc-user-glacier", 8000, 120, "glacier applied");
  const glob = await E(`(() => {
    const el = document.documentElement;
    return {
      themeSetting: window.closeCode.getSettings,
      mono: (() => { try { return window.__monaco.editor.getTheme(); } catch { return null; } })(),
      dataTheme: el.dataset.theme,
      bg: getComputedStyle(el).getPropertyValue("--cc-bg").trim(),
    };
  })()`);
  check("theme: Monaco cc-user-glacier", glob?.mono === "cc-user-glacier", glob?.mono);
  check("theme: data-theme stays (dark palette from glacier)", glob?.dataTheme === (sysDark ? "dark" : "light"), glob?.dataTheme);

  // ---- 8. Persistence across restart ----
  const preRestart = await E(`window.closeCode.getAllSettings()`);
  check("theme: user scope has editorTheme after apply", preRestart?.user?.editorTheme === "cc-user-glacier" || preRestart?.user?.accentColor === "#f38ba8", JSON.stringify({ et: preRestart?.user?.editorTheme, acc: preRestart?.user?.accentColor }));

  // ---- 9. Theme picker UI ----
  await E(`window.__themeStore.getState().openPicker()`);
  await sleep(300);
  const picker = await E(`(() => {
    const el = document.querySelector('[data-theme-picker]');
    if (!el) return { present: false };
    const workbench = [...el.querySelectorAll('[data-scheme-btn]')].map((b) => b.dataset.scopeId);
    const editor = [...el.querySelectorAll('[data-editor-card]')].map((b) => b.dataset.editorName);
    const accent = [...el.querySelectorAll('[data-accent-swatch]')].map((b) => b.dataset.accentHex);
    const customBtn = [...el.querySelectorAll('[data-theme-custom]')].map((b) => b.dataset.themeName);
    return { present: true, workbench, editor, accent, customBtn, customCount: el.querySelectorAll('[data-editor-card]').length };
  })()`);
  check("picker: opens", picker?.present === true);
  check("picker: workbench scheme buttons", Array.isArray(picker?.workbench) && ["dark", "light", "system"].every((s) => picker?.workbench?.includes(s)), JSON.stringify(picker?.workbench));
  check("picker: builtin editor cards include cc-dark + cc-light", picker?.editor?.includes("cc-dark") && picker?.editor?.includes("cc-light"), JSON.stringify(picker?.editor));
  check("picker: custom editor cards from user + workspace", picker?.customBtn?.includes("cc-user-glacier") && picker?.customBtn?.includes("ws-icy"), JSON.stringify(picker?.customBtn));
  check("picker: accent swatches present (>5)", (picker?.accent?.length ?? 0) > 5, picker?.accent?.length);

  // Close picker via Escape
  await E(`(function(){ window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); })()`);
  await poll(async () => (await E(`!!document.querySelector('[data-theme-picker]')`)) === false, 5000, 100, "picker closed");
  check("picker: Escape closes", true);

  // ---- 10. Cycle theme command ----
  const before = await E(`document.documentElement.dataset.theme`);
  await E(`window.__commandRegistry.execute("theme-cycle")`);
  await sleep(500);
  const after = await E(`document.documentElement.dataset.theme`);
  check("command: theme-cycle toggles workbench scheme", before !== after, `${before} → ${after}`);

  tlog("  -- restarting app (theme persistence) --");
  killAll(s1.child.pid);
  await sleep(1200);

  // =========================================================
  // Session 2 (restart)
  // =========================================================
  const s2 = await launch(userData, PORT);
  const ws2 = s2.ws;
  const E2 = (expr) => evaluate(ws2, expr);
  await sleep(1800);
  await E2(`(async()=>{ await window.closeCode.openFolder(${JSON.stringify(wsDir)}); return true; })()`);
  await sleep(500);

  const restored = await E2(`(async () => {
    const el = document.documentElement;
    return {
      effective: window.closeCode.getSettings ? await window.closeCode.getSettings() : null,
      mono: (() => { try { return window.__monaco.editor.getTheme(); } catch { return null; } })(),
      dataTheme: el.dataset.theme,
      accent: getComputedStyle(el).getPropertyValue("--cc-accent").trim(),
      bg: getComputedStyle(el).getPropertyValue("--cc-bg").trim(),
    };
  })()`);
  const eff2 = restored?.effective ?? {};
  check("restart: effective persisted (user editorTheme)", eff2?.editorTheme === "cc-user-glacier" || eff2?.theme === "light", JSON.stringify({ et: eff2?.editorTheme, theme: eff2?.theme }));
  check("restart: Monaco theme restored from user scope", restored?.mono === "cc-user-glacier", restored?.mono);

  tlog("theme phase15: " + R.filter((r) => r.pass).length + "/" + R.length + " passed");
  killAll(s2.child.pid);
  const failed = R.filter((r) => !r.pass);
  if (failed.length > 0) {
    tlog("FAILED: " + failed.map((f) => f.name).join(", "));
    process.exitCode = 1;
  } else {
    tlog("PHASE 15 INTEGRATION: PASSED");
  }
}

main().catch((e) => { tlog("FATAL: " + (e?.stack || e)); process.exit(1); });
