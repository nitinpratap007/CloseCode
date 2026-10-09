// Close Code — Phase 11 integration test: AI Assistant
// Runs a real OpenAI-compatible HTTP mock on a random local port and drives the
// packaged app over CDP: config, API-key handling, streaming chat, privacy of
// the context payload, diff preview + apply, agent tool loop w/ permissions,
// and graceful error handling. The editor must stay fully usable without AI.

const { spawn, execSync } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const EXE = "E:\\closecode\\release\\win-unpacked\\CloseCode.exe";
const PORT = 9233;
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

const LOGF = "C:\\Users\\NITINP~1\\AppData\\Local\\Temp\\opencode\\phase11.log";
const APPF = "C:\\Users\\NITINP~1\\AppData\\Local\\Temp\\opencode\\phase11-app.log";
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
// Mock OpenAI-compatible server
// ---------------------------------------------------------------
const MOCK = { bodies: [], streamChunks: [], auth: null, chatCount: 0 };

const NEW_GREETING = `const greeting = "Hello AI!";
function greet(name) {
  return greeting + " " + name;
}
module.exports = { greet };`;

function mockServer() {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "mock-model" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let raw = "";
      MOCK.auth = req.headers.authorization || null;
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        MOCK.chatCount++;
        let body = {};
        try { body = JSON.parse(raw); } catch {}
        MOCK.bodies.push(body);

        const lastMsg = (body.messages || []).map((m) => String(m.content || "")).join("\n");
        const hasToolResult = (body.messages || []).some((m) => m.role === "tool");

        if (body.tools && String(lastMsg).includes("AGENT") && !hasToolResult) {
          const payload = {
            id: "cmpl-mock",
            object: "chat.completion",
            model: body.model,
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{ id: "call_1", type: "function", function: { name: "search_files", arguments: JSON.stringify({ query: "secret" }) } }],
              },
              finish_reason: "tool_calls",
            }],
          };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
          return;
        }

        if (body.tools && hasToolResult) {
          const payload = {
            id: "cmpl-mock-2", object: "chat.completion", model: body.model,
            choices: [{ index: 0, message: { role: "assistant", content: "Done. I searched the workspace and found the requested files." }, finish_reason: "stop" }],
          };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
          return;
        }

        const content = `Here is the updated file:\n\`\`\`js\n${NEW_GREETING}\`\`\``;
        if (body.stream) {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
          const chunks = ["Here is the updated file:\n```js\n", NEW_GREETING, "```"];
          let i = 0;
          const sendNext = () => {
            if (i < chunks.length) {
              const c = chunks[i++];
              MOCK.streamChunks.push(...c.split(""));
              res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
              setTimeout(sendNext, 15);
            } else {
              res.write("data: [DONE]\n\n");
              res.end();
            }
          };
          sendNext();
        } else {
          const payload = {
            id: "cmpl-mock", object: "chat.completion", model: body.model,
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
  tlog("phase11 start");

  const { server, port } = await mockServer();
  const MOCK_BASE = `http://127.0.0.1:${port}`;
  const DEAD_BASE = "http://127.0.0.1:49199"; // nothing listening — connection refused

  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cc-phase11-"));
  const userData = path.join(base, "userdata"); fs.mkdirSync(userData, { recursive: true });
  const wsDir = path.join(base, "ws"); fs.mkdirSync(wsDir, { recursive: true });

  const greetingPath = path.join(wsDir, "greeting.js");
  fs.writeFileSync(greetingPath, `const greeting = "Hello World";
function greet(name) {
  return greeting + " " + name;
}
module.exports = { greet };
`);
  fs.writeFileSync(path.join(wsDir, "secret.txt"), "TOP-SECRET-PASSWORD");

  const applog = fs.openSync(APPF, "w");
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], { stdio: ["ignore", applog, applog], detached: true, env: { ...process.env, CC_USER_DATA: userData } });
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

  // ---- Core editor works WITHOUT AI configured ----
  check("ai store exposed", (await E(`typeof window.__aiStore !== "undefined"`)) === true);
  const opened = await E(`(async()=>{ const r = await window.closeCode.openFolder(${JSON.stringify(wsDir)}); return r && r.ok; })()`);
  check("open workspace", opened === true);
  await E(`(async()=>{ await window.__editorStore.getState().openFileInWorkspace(${JSON.stringify(greetingPath)}); return true; })()`);
  await sleep(500);
  check("file opened in editor", (await E(`window.__editorStore.getState().activePath !== null`)) === true);
  const initialContent = fs.readFileSync(greetingPath, "utf-8");
  check("editor content loaded", (await E(`window.__editorStore.getState().getContent(${JSON.stringify(greetingPath)}).includes("Hello World")`)) === true);

  // ---- AI view / panel UI ----
  await E(`window.__commandRegistry.execute("ai-view")`);
  await poll(async () => (await E(`!!document.querySelector('[data-ai-panel]')`)) === true, 5000, 120, "ai panel renders");
  check("ai-view opens AI panel", true);
  check("ActivityBar AI button", (await E(`!!document.querySelector('[aria-label="AI Assistant"]')`)) === true);
  const aiPanelHello = await E(`!!document.querySelector('[data-ai-messages]')`);
  check("AI panel chat area rendered", aiPanelHello === true);
  await E(`window.__commandRegistry.execute("ai-view")`);
  await sleep(300);
  check("ai-view closes AI panel", (await E(`!document.querySelector('[data-ai-panel]')`)) === true);
  await E(`window.__commandRegistry.execute("ai-view")`);
  await sleep(300);

  // ---- Configure AI: custom (OpenAI-compatible) provider against the mock ----
  const cfgRes = await E(`(async()=>{ const r = await window.closeCode.aiSaveConfig({ provider: "custom", baseUrl: ${JSON.stringify(MOCK_BASE)}, model: "mock-model", stream: true, toolMode: "chat" }); return r; })()`);
  check("ai:save-config ok", cfgRes?.ok === true && cfgRes?.result?.config?.provider === "custom", JSON.stringify(cfgRes?.result?.config && { provider: cfgRes.result.config.provider, model: cfgRes.result.config.model }));

  // ---- API key: stored encrypted in main, never returned to renderer ----
  const keyRes = await E(`window.closeCode.aiSetApiKey("custom", "sk-test-123")`);
  check("ai:set-api-key stores key", keyRes?.ok === true && keyRes?.result?.has === true, JSON.stringify(keyRes));
  const cfgAfterKey = await E(`window.closeCode.aiGetConfig()`);
  const cfgJson = JSON.stringify(cfgAfterKey);
  check("renderer never sees the API key", !!cfgJson && !cfgJson.includes("sk-test-123"), cfgJson.slice(0, 120));
  check("renderer sees has-key flag", cfgAfterKey?.result?.apiKeys?.custom === true);

  // ---- send chat (streaming) and verify ----
  const storeBefore = await E(`window.__aiStore.getState().messages.length`);
  await E(`window.__aiStore.getState().send("Rewrite the greeting to use a friendly message.").then(()=>true)`);
  await poll(async () => {
    const st = await E(`(window.__aiStore.getState().busy)`);
    return st === false;
  }, 30000, 150, "chat completes");
  const errAfterChat = await E(`window.__aiStore.getState().error`);
  tlog(`  [debug] error after chat: ${JSON.stringify(errAfterChat)}  bodies=${MOCK.bodies.length} chatCount=${MOCK.chatCount}`);
  const msgs = await E(`window.__aiStore.getState().messages`);
  const assistantMsg = Array.isArray(msgs) ? msgs[msgs.length - 1] : null;
  check("user message recorded", Array.isArray(msgs) && msgs.length >= 2 && msgs[msgs.length - 2]?.role === "user");
  check("assistant message with model content", !!assistantMsg && assistantMsg.text.includes("Here is the updated file:"), String(assistantMsg && assistantMsg.text).slice(0, 80));
  check("streaming deltas arrived (SSE)", MOCK.streamChunks.length > 10, `${MOCK.streamChunks.length} chars streamed`);
  const finalTextOk = await E(`(()=>{ const m = window.__aiStore.getState().messages; const a = m[m.length-1]; return a.text.length > 50 && !a.streaming; })()`);
  check("streaming text finalized on disk state", finalTextOk === true);

  // mock received the model name + temperature + messages
  const lastBody = MOCK.bodies[MOCK.bodies.length - 1];
  check("mock got model id", lastBody?.model === "mock-model");
  check("mock got Authorization header", MOCK.auth === "Bearer sk-test-123", String(MOCK.auth));
  check("mock got stream flag", lastBody?.stream === true);

  // ---- Privacy: context contains current file, NOT other project files ----
  const sysPrompt = lastBody?.messages?.find((m) => m.role === "system")?.content || "";
  check("context includes current file", sysPrompt.includes("greeting.js") && sysPrompt.includes("Hello World"));
  check("context excludes unrelated files", !sysPrompt.includes("TOP-SECRET-PASSWORD") && !sysPrompt.includes("secret.txt"), sysPrompt.slice(0, 140));
  check("context labels its sections", sysPrompt.includes("Selected code") || sysPrompt.includes("Current file:"));
  const charCount = await E(`window.__aiStore.getState().contextChars`);
  check("context char counter exposed", typeof charCount === "number" && charCount > 0, String(charCount));

  // ---- Diff preview for the suggested change ----
  await poll(async () => {
    const list = await E(`window.__aiStore.getState().suggestedChanges`);
    return Array.isArray(list) && list.length === 1 ? list : null;
  }, 10000, 150, "suggested change appears");
  const change = await E(`window.__aiStore.getState().suggestedChanges[0]`);
  check("suggested change targets active file", change?.file === greetingPath, JSON.stringify(change && change.file));
  check("diff preview rendered (unified)", typeof change?.diff === "string" && change.diff.includes("+") && change.diff.includes("-"), String(change && change.diff).slice(0, 120));
  check("diff preview shows new content", (change?.diff || "").includes("Hello AI"));
  const diffDom = await E(`!!document.querySelector('[data-ai-changes]')`);
  check("diff preview visible in panel DOM", diffDom === true);
  const applyBtn = await E(`!!document.querySelector('[data-ai-change-apply]')`);
  check("Apply button rendered", applyBtn === true);

  // ---- Apply the change: writes file, updates cache + model, tab clean ----
  await E(`window.__aiStore.getState().applyChange(${JSON.stringify(change.id)}).then(()=>true)`);
  await sleep(400);
  const onDisk = fs.readFileSync(greetingPath, "utf-8");
  check("apply wrote file to disk", onDisk === NEW_GREETING, onDisk.slice(0, 40));
  const cacheOk = await E(`window.__editorStore.getState().getContent(${JSON.stringify(greetingPath)})`);
  check("editor cache updated after apply", cacheOk === NEW_GREETING, String(cacheOk).slice(0, 40));
  const dirtyAfter = await E(`window.__editorStore.getState().tabs.find(t => t.path === ${JSON.stringify(greetingPath)})?.dirty`);
  check("applied change not marked dirty", dirtyAfter === false);
  const applied = await E(`window.__aiStore.getState().suggestedChanges[0].applied`);
  check("change marked applied", applied === true);
  await E(`window.__aiStore.getState().discardChange(${JSON.stringify(change.id)})`);
  await sleep(200);
  check("discard removes applied change", (await E(`window.__aiStore.getState().suggestedChanges.length`)) === 0);

  // ---- Chat history shown in panel ----
  const userMsgInDom = await E(`!!document.querySelector('[data-ai-message="user"]')`);
  check("user message rendered in panel", userMsgInDom === true);
  const assistantInDom = await E(`!!document.querySelector('[data-ai-message="assistant"]')`);
  check("assistant message rendered in panel", assistantInDom === true);

  // ---- Models endpoint ----
  const modelsRes = await E(`window.closeCode.aiModels()`);
  check("ai:models lists mock model", modelsRes?.ok === true && (modelsRes?.result?.models || []).includes("mock-model"), JSON.stringify(modelsRes));

  // ---- Agent tool loop with permissions (search allowed, files denied) ----
  await E(`(async()=>{ await window.closeCode.aiSaveConfig({ toolMode: "agent", permissions: { files: "deny", search: "allow", terminal: "deny", git: "deny" } }); return true; })()`);
  const toolLogBefore = MOCK.chatCount;
  await E(`window.__aiStore.getState().send("AGENT search the workspace for something").then(()=>true)`);
  await poll(async () => {
    const st = await E(`window.__aiStore.getState().busy`);
    return st === false;
  }, 30000, 150, "agent loop completes");
  const agentMsg = await E(`window.__aiStore.getState().messages`);
  const lastAgent = agentMsg[agentMsg.length - 1];
  check("agent final answer", !!lastAgent && lastAgent.text.includes("Done."), String(lastAgent && lastAgent.text).slice(0, 60));
  const toolLog = await E(`window.__aiStore.getState().toolLog`);
  check("agent tool executed (search_files)", Array.isArray(toolLog) && toolLog.some((t) => t.tool === "search_files" && t.granted === true), JSON.stringify(toolLog?.slice(0, 2)));
  check("agent did a second round-trip", MOCK.chatCount >= toolLogBefore + 2, `${MOCK.chatCount} vs ${toolLogBefore}`);
  const agentSys = MOCK.bodies[MOCK.bodies.length - 1]?.messages?.find((m) => m.role === "system")?.content || "";
  check("agent request also carried privacy-bounded context", !agentSys.includes("TOP-SECRET-PASSWORD"));
  // permissions row in the config panel
  await E(`window.__aiStore.getState().toggleConfig()`);
  await sleep(200);
  const permRow = await E(`!!document.querySelector('[data-ai-config]')`);
  check("config panel renders", permRow === true);

  // ---- Error handling: unreachable endpoint ----
  await E(`(async()=>{ await window.closeCode.aiSaveConfig({ baseUrl: ${JSON.stringify(DEAD_BASE)} }); return true; })()`);
  await E(`window.__aiStore.getState().send("hello?").then(()=>true)`);
  await poll(async () => {
    const st = await E(`window.__aiStore.getState().busy`);
    return st === false;
  }, 20000, 150, "failed request settles");
  const errState = await E(`window.__aiStore.getState().error`);
  check("connection error surfaced to user", typeof errState === "string" && /could not connect/i.test(errState), String(errState));
  const errBanner = await E(`!!document.querySelector('[data-ai-error]')`);
  check("error banner shown in panel", errBanner === true);
  await E(`window.__aiStore.getState().clearError()`);

  // ---- Restore config (so subsequent flows are deterministic) and verify editor still healthy ----
  await E(`(async()=>{ await window.closeCode.aiSaveConfig({ baseUrl: ${JSON.stringify(MOCK_BASE)}, toolMode: "chat", permissions: { files: "ask", search: "ask", terminal: "ask", git: "ask" } }); return true; })()`);
  const alive = await E(`window.__editorStore.getState().activePath === ${JSON.stringify(greetingPath)}`);
  check("editor remains intact after AI flows", alive === true);
  const short = await E(`window.__getCommandByShortcut("Ctrl+Shift+A")?.id`);
  check("Ctrl+Shift+A maps to ai-view", short === "ai-view", String(short));

  server.close();
  const all = R.every((r) => r.pass);
  tlog(`\n${R.filter((r) => r.pass).length}/${R.length} checks passed`);
  tlog(all ? "PHASE 11 INTEGRATION: PASSED" : "PHASE 11 INTEGRATION: FAILED");
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); } catch { try { execSync(`taskkill /F /IM "CloseCode.exe"`, { stdio: "ignore" }); } catch {} }
  await sleep(500);
  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  process.exit(all ? 0 : 1);
}
main().catch((e) => { tlog("ERR " + (e && e.stack || e)); console.error(e); try { execSync(`taskkill /F /IM "CloseCode.exe"`, { stdio: "ignore" }); } catch {} process.exit(1); });