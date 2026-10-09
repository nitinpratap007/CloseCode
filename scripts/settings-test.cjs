const { spawn, execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const EXE = "E:\\closecode\\release\\win-unpacked\\CloseCode.exe";
const PORT = 9223;
const USER_DATA = path.join(
  os.homedir(),
  "AppData", "Roaming", "CloseCode", "settings.json"
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url);
  return res.json();
}

async function evaluate(wsUrl, expression) {
  const ws = new WebSocket(wsUrl);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP timeout")), 15000);
    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise: true },
      }));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === 1) {
        clearTimeout(timer);
        ws.close();
        resolve(msg.result?.result?.value);
      }
    };
    ws.onerror = (e) => { clearTimeout(timer); reject(e); };
  });
}

async function launchAndWait() {
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], {
    stdio: "ignore", detached: true,
  });
  child.unref();
  let targets = null;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try {
      targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
      if (targets && targets.length > 0) break;
    } catch {}
  }
  const page = targets.find((t) => t.type === "page") || targets[0];
  return { child, page };
}

async function kill(proc) {
  try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: "ignore" }); } catch {}
  await sleep(800);
}

async function main() {
  console.log("--- RUN 1: change settings via IPC ---");
  let { child, page } = await launchAndWait();
  if (!page) { console.error("FAIL: no CDP target"); process.exit(1); }

  const saved = await evaluate(page.webSocketDebuggerUrl, `(async () => {
    const result = await window.closeCode.saveSettings({ fontSize: 18, minimap: false, theme: "system" });
    return result;
  })()`);
  console.log("saveSettings result:", JSON.stringify(saved));

  await kill(child);

  console.log("settings.json on disk:");
  console.log(fs.readFileSync(USER_DATA, "utf-8"));

  console.log("--- RUN 2: read back persisted settings ---");
  ({ child, page } = await launchAndWait());
  if (!page) { console.error("FAIL: no CDP target (2nd run)"); process.exit(1); }

  const loaded = await evaluate(page.webSocketDebuggerUrl, `(async () => {
    return await window.closeCode.getSettings();
  })()`);
  console.log("getSettings after restart:", JSON.stringify(loaded));

  const ok = loaded && loaded.fontSize === 18 && loaded.minimap === false && loaded.theme === "system";
  console.log(ok ? "\nSETTINGS PERSISTENCE PASSED" : "\nSETTINGS PERSISTENCE FAILED");

  await kill(child);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });