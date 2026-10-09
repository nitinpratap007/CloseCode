// Close Code — Phase 12 integration test: Local AI
// Verifies:
//   - local runtime detection (ai:detect-local) incl. specific-URL injection
//   - configuring the Local AI provider (localBaseUrl / localModel)
//   - chat through the local provider (SSE and non-streaming)
//   - listing models from the local runtime
//   - graceful degradation when no local AI is available:
//     core editor keeps working, clear error surfaced, no provider needed
// Uses an in-test OpenAI-compatible HTTP mock as the "local runtime".

const { spawn, execSync } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const EXE = "E:\\closecode\\release\\win-unpacked\\CloseCode.exe";
const PORT = 9234;
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

const LOGF = "C:\\Users\\NITINP~1\\AppData\\Local\\Temp\\opencode\\phase12.log";
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

// ---------------------------------------------------------------
// Mock local runtime (OpenAI-compatible)
// ---------------------------------------------------------------
const MOCK = { bodies: [], streamChunks: [], chatCount: 0 };

function mockServer() {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "mock-model" }, { id: "mock-embed" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        MOCK.chatCount++;
        let body = {};
        try { body = JSON.parse(raw); } catch {}
        MOCK.bodies.push(body);
        const lastText = String((body.messages || []).map((m) => m.content || "").join("\n"));
        const isHello = lastText.includes("LOCALHELLO");
        const content = isHello ? "Hello from local mode!" : "local-model response with no special handling";
        if (body.stream) {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
          const chunks = ["Hello ", "from ", "local ", "mode!"];
          let i = 0;
          const sendNext = () => {
            if (i < chunks.length) {
              const c = chunks[i++];
              MOCK.streamChunks.push(...c.split(""));
              res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
              setTimeout(sendNext, 12);
            } else {
              res.write("data: [DONE]\n\n");
              res.end();
            }
          };
          sendNext();
        } else {
          const payload = {
            id: "cmpl-local", object: "chat.completion", model: body.model,
            choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        }
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  try { fs.unlinkSync(LOGF); } catch {}
  tlog("phase12 start");

  const { server, port } = await mockServer();
  const MOCK_BASE = `http://127.0.0.1:${port}`;
  const DEAD_BASE = "http://127.0.0.1:49798"; // nothing listening

  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cc-phase12-"));
  const userData = path.join(base, "userdata"); fs.mkdirSync(userData, { recursive: true });
  const wsDir = path.join(base, "ws"); fs.mkdirSync(wsDir, { recursive: true });
  const sample = path.join(wsDir, "sample.js");
  fs.writeFileSync(sample, `const x = 1;\nconsole.log(x);\n`);
  fs.writeFileSync(path.join(wsDir, "other.txt"), "other file content");

  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], { stdio: "ignore", detached: true, env: { ...process.env, CC_USER_DATA: userData } });
  child.unref();
  let targets = null;
  for (let i = 0; i < 40; i++) { await sleep(800); try { targets = await getJson(`http://127.0.0.1:${PORT}/json/list`); if (targets && targets.length) break; } catch {} }
  if (!targets) throw new Error("no targets");
  const page = targets.find((t) => t.type === "page") || targets[0];
  const ws = page.webSocketDebuggerUrl;
  const E = (expr) => evaluate(ws, expr);
  const R = [];
  const check = (name, pass, detail) => { R.push({ name, pass }); tlog(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? "  (" + String(detail).slice(0, 110) + ")" : ""}`); };

  await sleep(1500);

  // ---- Core editor works before any AI config (no provider needed) ----
  await E(`(async()=>{ await window.closeCode.openFolder(${JSON.stringify(wsDir)}); return true; })()`);
  await E(`(async()=>{ await window.__editorStore.getState().openFileInWorkspace(${JSON.stringify(sample)}); return true; })()`);
  await sleep(500);
  check("editor baseline: file opened without AI", (await E(`window.__editorStore.getState().activePath === ${JSON.stringify(sample)}`)) === true);
  check("editor baseline: content read without AI", (await E(`window.__editorStore.getState().getContent(${JSON.stringify(sample)}).includes("console.log")`)) === true);

  // ---- Local runtime detection ----
  const detMock = await E(`window.closeCode.aiDetectLocal(${JSON.stringify(MOCK_BASE)})`);
  check("detect-local: runtime found via specific URL", detMock?.ok === true && detMock?.result?.found === true, JSON.stringify(detMock?.result));
  check("detect-local: reports models from runtime", Array.isArray(detMock?.result?.runtimes) && detMock.result.runtimes.length > 0 && detMock.result.runtimes[0].models.includes("mock-model"));
  const detDead = await E(`window.closeCode.aiDetectLocal(${JSON.stringify(DEAD_BASE)})`);
  check("detect-local: unavailable runtime -> found false", detDead?.ok === true && detDead?.result?.found === false, JSON.stringify(detDead?.result));
  const detDefault = await E(`window.closeCode.aiDetectLocal()`);
  check("detect-local: default probe is structured & non-fatal", detDefault?.ok === true && typeof detDefault?.result?.found === "boolean" && Array.isArray(detDefault?.result?.runtimes), JSON.stringify(detDefault?.result));

  // ---- UI: provider select offers Local AI; panel opens; detect button exists ----
  await E(`window.__commandRegistry.execute("ai-view")`);
  await poll(async () => (await E(`!!document.querySelector('[data-ai-panel]')`)) === true, 5000, 120, "ai panel renders");
  const providerOpts = await E(`[...document.querySelectorAll('[data-ai-provider-select] option')].map(o => o.value)`);
  check("AI panel offers Local AI provider", Array.isArray(providerOpts) && providerOpts.includes("local"), JSON.stringify(providerOpts));
  check("detect-local button in panel", (await E(`!!document.querySelector('[data-ai-detect]')`)) === true);

  // ---- Configure Local AI provider ----
  const cfgLocal = await E(`window.closeCode.aiSaveConfig({ provider: "local", baseUrl: ${JSON.stringify(MOCK_BASE)}, localBaseUrl: ${JSON.stringify(MOCK_BASE)}, localModel: "mock-model", stream: true, toolMode: "chat" })`);
  check("config: local provider persisted", cfgLocal?.ok === true && cfgLocal?.result?.config?.provider === "local" && cfgLocal?.result?.config?.localModel === "mock-model");
  await E(`window.__aiStore.getState().loadConfig()`);
  const storeCfg = await E(`window.__aiStore.getState().config`);
  check("ai store sees local provider + local model", storeCfg?.provider === "local" && storeCfg?.localModel === "mock-model", JSON.stringify({ provider: storeCfg?.provider, localModel: storeCfg?.localModel }));

  // ---- Local chat (streaming SSE) ----
  await E(`window.__aiStore.getState().send("LOCALHELLO test").then(()=>true)`);
  await poll(async () => (await E(`window.__aiStore.getState().busy`)) === false, 30000, 150, "local chat completes");
  const msgs = await E(`window.__aiStore.getState().messages`);
  const last = Array.isArray(msgs) ? msgs[msgs.length - 1] : null;
  check("local chat: assistant response", !!last && last.text.includes("Hello from local mode!"), String(last && last.text).slice(0, 60));
  check("local chat: streamed via SSE", MOCK.streamChunks.length > 10, `${MOCK.streamChunks.length} chars`);
  const bodyLocal = MOCK.bodies[MOCK.bodies.length - 1];
  check("local chat: mock got local model id", bodyLocal?.model === "mock-model");
  check("local chat: stream flag true", bodyLocal?.stream === true);
  check("local chat: no API key needed", (await E(`window.__aiStore.getState().apiKeys.local`)) === false);
  await E(`window.__aiStore.getState().clearChat()`);
  await sleep(200);

  // ---- Local chat (non-streaming JSON fallback) ----
  await E(`window.closeCode.aiSaveConfig({ stream: false })`);
  await E(`window.__aiStore.getState().send("LOCALHELLO non-stream").then(()=>true)`);
  await poll(async () => (await E(`window.__aiStore.getState().busy`)) === false, 30000, 150, "non-stream chat completes");
  const msgs2 = await E(`window.__aiStore.getState().messages`);
  const last2 = Array.isArray(msgs2) ? msgs2[msgs2.length - 1] : null;
  check("local chat: non-streaming response", !!last2 && last2.text.includes("Hello from local mode!"), String(last2 && last2.text).slice(0, 60));
  const bodyNS = MOCK.bodies[MOCK.bodies.length - 1];
  check("local chat: non-stream body has stream=false", bodyNS?.stream === false);
  check("local chat: non-streaming done event finalized text", (await E(`(()=>{ const m = window.__aiStore.getState().messages; const a = m[m.length-1]; return a.text.length > 10 && !a.streaming; })()`)) === true);
  await E(`window.__aiStore.getState().clearChat()`);

  // ---- Models listing from local runtime ----
  const modelsRes = await E(`window.closeCode.aiModels()`);
  check("local models listed", modelsRes?.ok === true && Array.isArray(modelsRes?.result?.models) && modelsRes.result.models.includes("mock-model"), JSON.stringify(modelsRes?.result?.models));

  // ---- Local AI UNAVAILABLE: everything else keeps working ----
  await E(`window.closeCode.aiSaveConfig({ localBaseUrl: ${JSON.stringify(DEAD_BASE)}, stream: true })`);
  await E(`window.__aiStore.getState().send("ping").then(()=>true)`);
  await poll(async () => (await E(`window.__aiStore.getState().busy`)) === false, 20000, 150, "failed local chat settles");
  const errState = await E(`window.__aiStore.getState().error`);
  check("unavailable local AI: clear error surfaced", typeof errState === "string" && /could not connect/i.test(errState), String(errState));
  check("unavailable local AI: editor tab intact", (await E(`window.__editorStore.getState().activePath === ${JSON.stringify(sample)}`)) === true);
  check("unavailable local AI: Monaco editor alive", (await E(`typeof window.__monacoEditor !== "undefined"`)) === true);
  check("unavailable local AI: another file readable", (await E(`(async()=>{ await window.__editorStore.getState().openFileInWorkspace(${JSON.stringify(path.join(wsDir, "other.txt"))}); return window.__editorStore.getState().getContent(${JSON.stringify(path.join(wsDir, "other.txt"))}); })()`)) === "other file content");
  const editRes = await E(`window.closeCode.writeFile(${JSON.stringify(path.join(wsDir, "other.txt"))}, "edited text")`);
  check("unavailable local AI: file editing still works (IPC write)", editRes?.error == null, JSON.stringify(editRes));
  check("unavailable local AI: edit persisted to disk", fs.readFileSync(path.join(wsDir, "other.txt"), "utf-8") === "edited text");
  await E(`window.closeCode.aiSaveConfig({ localBaseUrl: ${JSON.stringify(MOCK_BASE)} })`);
  await E(`window.__aiStore.getState().clearError()`);

  // ---- Missing model id -> friendly guidance, non-fatal ----
  await E(`window.closeCode.aiSaveConfig({ localModel: "" })`);
  await E(`window.__aiStore.getState().send("hello").then(()=>true)`);
  await poll(async () => (await E(`window.__aiStore.getState().busy`)) === false, 20000, 150, "empty-model chat settles");
  const errModel = await E(`window.__aiStore.getState().error`);
  check("missing model id: friendly error", typeof errModel === "string" && /no model configured/i.test(errModel), String(errModel));
  check("missing model id: editor still alive", (await E(`window.__editorStore.getState().activePath !== null`)) === true);
  await E(`window.closeCode.aiSaveConfig({ localModel: "mock-model" })`);
  await E(`window.__aiStore.getState().clearError()`);

  // ---- Store detectLocal (default probe) does not disturb state ----
  const beforeErr = await E(`window.__aiStore.getState().error`);
  await E(`window.__aiStore.getState().detectLocal()`);
  await sleep(3500);
  check("store detectLocal leaves no error", (await E(`window.__aiStore.getState().error === null`)) === true, `before=${JSON.stringify(beforeErr)}`);
  check("store localDetected is an array", (await E(`Array.isArray(window.__aiStore.getState().localDetected)`)) === true);
  check("busy is false after all flows", (await E(`window.__aiStore.getState().busy === false`)) === true);

  server.close();
  const all = R.every((r) => r.pass);
  tlog(`\n${R.filter((r) => r.pass).length}/${R.length} checks passed`);
  tlog(all ? "PHASE 12 INTEGRATION: PASSED" : "PHASE 12 INTEGRATION: FAILED");
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); } catch { try { execSync(`taskkill /F /IM "CloseCode.exe"`, { stdio: "ignore" }); } catch {} }
  await sleep(500);
  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  process.exit(all ? 0 : 1);
}
main().catch((e) => { tlog("ERR " + (e && e.stack || e)); console.error(e); try { execSync(`taskkill /F /IM "CloseCode.exe"`, { stdio: "ignore" }); } catch {} process.exit(1); });