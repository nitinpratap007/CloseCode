const { spawn, execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const EXE = "E:\\closecode\\release\\win-unpacked\\CloseCode.exe";
const PORT = 9224;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url);
  return res.json();
}

function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => reject(new Error("CDP timeout")), 20000);
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true, awaitPromise: true },
        })
      );
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === 1) {
        clearTimeout(timer);
        ws.close();
        resolve(msg.result?.result?.value);
      }
    };
    ws.onerror = (e) => {
      clearTimeout(timer);
      reject(e);
    };
  });
}

const RESULTS = [];
function check(name, pass, detail) {
  RESULTS.push({ name, pass, detail });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
}

async function main() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cc-phase2-"));
  const userData = path.join(base, "userdata");
  fs.mkdirSync(userData, { recursive: true });

  // ---- Fixtures ----
  const small = path.join(base, "small");
  fs.mkdirSync(path.join(small, "src"), { recursive: true });
  fs.mkdirSync(path.join(small, "assets", "img"), { recursive: true });
  for (let i = 0; i < 30; i++) {
    fs.writeFileSync(path.join(small, "src", `mod${i}.ts`), `export const v${i} = ${i};\n`);
  }
  fs.writeFileSync(path.join(small, "package.json"), JSON.stringify({ name: "small" }));
  fs.writeFileSync(path.join(small, "README.md"), "# small");
  fs.writeFileSync(path.join(small, "assets", "img", "logo.png"), "x");

  const medium = path.join(base, "medium");
  fs.mkdirSync(path.join(medium, "src", "modules"), { recursive: true });
  fs.mkdirSync(path.join(medium, "node_modules", "dep"), { recursive: true });
  fs.mkdirSync(path.join(medium, ".git"), { recursive: true });
  fs.mkdirSync(path.join(medium, "dist"), { recursive: true });
  fs.mkdirSync(path.join(medium, "generated"), { recursive: true });
  for (let i = 0; i < 20; i++) {
    fs.writeFileSync(path.join(medium, "src", `a${i}.ts`), "");
    fs.writeFileSync(path.join(medium, "src", "modules", `m${i}.ts`), "");
  }
  for (let i = 0; i < 40; i++) {
    fs.writeFileSync(path.join(medium, "node_modules", "dep", `f${i}.js`), "");
  }
  fs.writeFileSync(path.join(medium, "generated", "g1.txt"), "");
  fs.writeFileSync(path.join(medium, ".git", "HEAD"), "ref: refs/heads/main\n");

  // 3000-file folder + 5 subdirs of 300 + nested node_modules
  const large = path.join(base, "large");
  fs.mkdirSync(path.join(large, "many"), { recursive: true });
  for (let i = 0; i < 3000; i++) {
    fs.writeFileSync(path.join(large, "many", `file_${String(i).padStart(5, "0")}.json`), "{}");
  }
  for (let s = 0; s < 5; s++) {
    const sub = path.join(large, "many", `sub${s}`);
    fs.mkdirSync(sub, { recursive: true });
    for (let i = 0; i < 300; i++) {
      fs.writeFileSync(path.join(sub, `s${s}_${i}.js`), "");
    }
  }
  fs.mkdirSync(path.join(large, "many", "node_modules", "x"), { recursive: true });
  fs.writeFileSync(path.join(large, "many", "node_modules", "x", "y.js"), "");

  console.log("Fixtures:", { small: countFiles(small), medium: countFiles(medium), large: countFiles(large) });

  console.log("Launching CloseCode (packaged)...");
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], {
    stdio: "ignore",
    detached: true,
    env: { ...process.env, CC_USER_DATA: userData },
  });
  child.unref();

  let targets = null;
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    try {
      targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
      if (targets && targets.length > 0) break;
    } catch {}
  }
  const page = targets.find((t) => t.type === "page") || targets[0];
  if (!page) {
    console.error("FAIL: app did not expose a debug target");
    process.exit(1);
  }
  const ws = page.webSocketDebuggerUrl;

  const E = (expr) => evaluate(ws, expr);

  // 1. Preload surface
  const preload = await E(`Object.keys(window.closeCode ?? {}).join(",")`);
  const need = ["openFolder", "listDir", "createFile", "createFolder", "renameItem", "deleteItem", "moveItem", "readFile", "getRecentProjects", "copyToClipboard"];
  check("preload API surface complete", need.every((k) => preload.includes(k)));

  // 2. Open small workspace
  const opened = await E(`window.closeCode.openFolder(${JSON.stringify(small)}).then(r => r)`);
  check("open-folder (small) succeeds", opened?.ok === true && opened?.result?.root === small, opened?.error);
  const state = await E(`window.closeCode.getWorkspaceState().then(r => r)`);
  check("workspace state reflects root", state?.root === small && state?.name === "small");

  // 3. Small listing
  const smallList = await E(`window.closeCode.listDir(${JSON.stringify(small)}).then(r => r)`);
  const smallNames = smallList?.result?.map((e) => e.name) ?? [];
  check("small root lists dirs first", smallNames[0] === "assets" && smallNames[1] === "src");
  check("small root lists files", smallNames.includes("package.json") && smallNames.includes("README.md"));
  check("small listing count", smallList?.result?.length === 4, `${smallList?.result?.length}`);

  // 3b. Read file contents (while small is the active workspace)
  const read = await E(`window.closeCode.readFile(${JSON.stringify(path.join(small, "README.md"))}).then(r => r)`);
  check("read-file returns content", read?.ok && read?.result?.content === "# small");

  // 4. Medium excludes
  await E(`window.closeCode.openFolder(${JSON.stringify(medium)}).then(r => r)`);
  const medList = await E(`window.closeCode.listDir(${JSON.stringify(medium)}).then(r => r)`);
  const medNames = medList?.result?.map((e) => e.name) ?? [];
  check("node_modules excluded", !medNames.includes("node_modules"));
  check(".git excluded", !medNames.includes(".git"));
  check("dist excluded", !medNames.includes("dist"));
  check("generated visible by default", medNames.includes("generated"));

  // 5. Configurable excludes via settings
  await E(`window.closeCode.saveSettings({ fileExcludes: ["generated"] }).then(r => r)`);
  const excludedNow = await E(`window.closeCode.listDir(${JSON.stringify(medium)}).then(r => r)`);
  check("configurable exclude honored", !(excludedNow.result ?? []).some((e) => e.name === "generated"));
  await E(`window.closeCode.saveSettings({ fileExcludes: [] }).then(r => r)`);

  // 7. CRUD round trip (verified against real disk)
  const root = large;
  await E(`window.closeCode.openFolder(${JSON.stringify(root)}).then(r => r)`);
  const cr = await E(`window.closeCode.createFile(${JSON.stringify(root)}, "created.txt").then(r => r)`);
  check("create-file via IPC", cr?.ok === true);
  check("  file exists on disk", fs.existsSync(path.join(root, "created.txt")));

  const rn = await E(`window.closeCode.renameItem(${JSON.stringify(path.join(root, "created.txt"))}, "renamed.txt").then(r => r)`);
  check("rename via IPC", rn?.ok === true && !fs.existsSync(path.join(root, "created.txt")) && fs.existsSync(path.join(root, "renamed.txt")));

  await E(`window.closeCode.createFolder(${JSON.stringify(root)}, "moveto").then(r => r)`);
  const mv = await E(`window.closeCode.moveItem(${JSON.stringify(path.join(root, "renamed.txt"))}, ${JSON.stringify(path.join(root, "moveto"))}).then(r => r)`);
  check("move via IPC", mv?.ok === true && fs.existsSync(path.join(root, "moveto", "renamed.txt")));

  const del = await E(`window.closeCode.deleteItem(${JSON.stringify(path.join(root, "moveto"))}).then(r => r)`);
  check("delete (recursive) via IPC", del?.ok === true && !fs.existsSync(path.join(root, "moveto")));

  // 7b. Editor save path: write-file IPC round trip (persists to disk)
  const wf = await E(`window.closeCode.writeFile(${JSON.stringify(path.join(root, "saved.txt"))}, "hello saved").then(r => r)`);
  check("write-file via IPC", wf?.error === null, wf?.error);
  check("  content persisted to disk", fs.readFileSync(path.join(root, "saved.txt"), "utf8") === "hello saved");

  // 8. Security: reject outside-root + unsafe names
  const outside = await E(`window.closeCode.readFile(${JSON.stringify(path.join(os.tmpdir(), "outside.txt"))}).then(r => r)`);
  check("path outside root rejected", outside?.ok === false && /outside/i.test(outside?.error ?? ""));
  const badName = await E(`window.closeCode.createFile(${JSON.stringify(root)}, "a/b.txt").then(r => r)`);
  check("unsafe filename rejected", badName?.ok === false);
  const delRoot = await E(`window.closeCode.deleteItem(${JSON.stringify(root)}).then(r => r)`);
  check("root self-delete rejected", delRoot?.ok === false);

  // 9. Large scale performance
  const t0 = Date.now();
  const largeList = await E(`window.closeCode.listDir(${JSON.stringify(path.join(root, "many"))}).then(r => r)`);
  const duration = Date.now() - t0;
  const manyEntries = largeList?.result ?? [];
  check("large folder lists 3005 entries", manyEntries.length === 3005, `${manyEntries.length}`);
  check("large folder listing fast", duration < 2000, `${duration}ms`);
  check("nested node_modules excluded in many/", !manyEntries.some((e) => e.name === "node_modules"));
  const subDir = manyEntries.find((e) => e.name === "sub0");
  const subList = subDir ? await E(`window.closeCode.listDir(${JSON.stringify(subDir.path)}).then(r => r)`) : null;
  check("subdir lazy-lists its 300 files", subList?.result?.length === 300, `${subList?.result?.length}`);

  // 10. Recent projects persisted
  const recent = await E(`window.closeCode.getRecentProjects().then(r => r)`);
  check("recent projects recorded", Array.isArray(recent) && recent.length >= 3 && recent[0].path === large);

  // 11. UI rendered (explorer node count reflected in DOM)
  const dom = await E(`({
    hasExplorer: !!document.querySelector('[role="tree"]'),
    hasTitle: (document.title),
  })`);
  check("explorer DOM present", dom?.hasExplorer === true);

  const allPass = RESULTS.every((r) => r.pass);
  console.log(`\n${RESULTS.filter((r) => r.pass).length}/${RESULTS.length} checks passed`);
  console.log(allPass ? "PHASE 2 INTEGRATION: PASSED" : "PHASE 2 INTEGRATION: FAILED");

  execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
  await sleep(500);
  fs.rmSync(base, { recursive: true, force: true });
  process.exit(allPass ? 0 : 1);
}

function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name));
    else n++;
  }
  return n;
}

main().catch((err) => {
  console.error("Test error:", err);
  process.exit(1);
});