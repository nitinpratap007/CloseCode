const { spawn } = require("child_process");
const { execSync } = require("child_process");

const EXE = "E:\\closecode\\release\\win-unpacked\\CloseCode.exe";
const PORT = 9222;

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getJson(url) {
  const res = await fetch(url);
  return res.json();
}

async function evaluate(wsUrl, expression) {
  const ws = new WebSocket(wsUrl);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP timeout")), 15000);
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
        if (msg.result && msg.result.result) {
          resolve(msg.result.result.value);
        } else {
          resolve(undefined);
        }
      }
    };
    ws.onerror = (e) => {
      clearTimeout(timer);
      reject(e);
    };
  });
}

async function main() {
  console.log("Starting CloseCode (production build)...");
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();

  let targets = null;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try {
      targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
      if (targets && targets.length > 0) break;
    } catch {
      /* not up yet */
    }
  }

  if (!targets || targets.length === 0) {
    console.error("FAIL: no CDP targets found within 30s");
    process.exit(1);
  }

  const page = targets.find((t) => t.type === "page") || targets[0];
  console.log("Target title:", page.title);
  console.log("Target url:", page.url);

  const appInfo = await evaluate(
    page.webSocketDebuggerUrl,
    `(async () => {
      if (!window.closeCode) return { error: "window.closeCode is missing (preload not injected)" };
      const info = await window.closeCode.getAppInfo();
      return info;
    })()`
  );
  console.log("IPC getAppInfo() ->", JSON.stringify(appInfo, null, 2));

const checkHost = await evaluate(
    page.webSocketDebuggerUrl,
    `(async () => {
      const nodeIntegration = typeof require === "function" || typeof process !== "undefined" && typeof process.versions !== "undefined" && process.versions.node;
      const editorHost = !!document.querySelector(".monaco-editor");
      return {
        hasMonacoEditor: editorHost,
        insecureNodeInRenderer: !!nodeIntegration,
        bodyClass: document.body.className,
      };
    })()`
  );
  console.log("Security/UI check ->", JSON.stringify(checkHost, null, 2));

  const settingsCheck = await evaluate(
    page.webSocketDebuggerUrl,
    `(async () => {
      const s = await window.closeCode.getSettings();
      return s;
    })()`
  );
  console.log("IPC getSettings() ->", JSON.stringify(settingsCheck, null, 2));

  // Phase 20: `hasMonacoEditor` used to be a single unchecked read, taken the
  // moment the CDP target appeared. Monaco mounts asynchronously, so on a loaded
  // machine the assertion fired before the editor existed and the whole suite
  // failed for a reason that had nothing to do with the app. The smoke test is
  // exactly the test that must not be flaky, so wait for the real condition
  // instead of sampling it once.
  let monacoReady = false;
  for (let i = 0; i < 60 && !monacoReady; i++) {
    await sleep(500);
    monacoReady = await evaluate(
      page.webSocketDebuggerUrl,
      `!!document.querySelector(".monaco-editor")`
    );
  }
  if (!monacoReady) console.log("WARN: Monaco did not mount within 30s");

  const allPass =
    appInfo && appInfo.version && checkHost && monacoReady &&
    checkHost.insecureNodeInRenderer === false && settingsCheck && settingsCheck.theme;

  console.log(allPass ? "\nALL CHECKS PASSED" : "\nSOME CHECKS FAILED");

  execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
  await sleep(500);
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error("Test error:", err);
  process.exit(1);
});