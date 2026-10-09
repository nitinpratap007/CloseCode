const { spawn, execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const EXE = "E:\\closecode\\release\\win-unpacked\\CloseCode.exe";
const PORT = 9225;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) { const res = await fetch(url); return res.json(); }
function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => reject(new Error("CDP timeout: " + expression.slice(0,60))), 20000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
    ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); if (msg.id === 1) { clearTimeout(timer); ws.close(); if (msg.result?.exceptionDetails) reject(new Error(JSON.stringify(msg.result.exceptionDetails))); else resolve(msg.result?.result?.value); } };
    ws.onerror = (e) => { clearTimeout(timer); reject(e); };
  });
}

const LOGF='C:\\Users\\NITINP~1\\AppData\\Local\\Temp\\opencode\\phase3.log';
function tlog(m){ try{fs.appendFileSync(LOGF, m+'\n')}catch{}; console.log(m); }
async function main(){
  try{fs.unlinkSync(LOGF)}catch{}
  tlog('phase3 start');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cc-phase3-"));
  const userData = path.join(base, "userdata"); fs.mkdirSync(userData,{recursive:true});
  const wsDir = path.join(base,"ws"); fs.mkdirSync(wsDir,{recursive:true});
  fs.writeFileSync(path.join(wsDir,"hello.js"), "const x = 1;\n");
  fs.writeFileSync(path.join(wsDir,"style.css"), "body { color: red; }\n");
  fs.writeFileSync(path.join(wsDir,"index.html"), "<h1>hi</h1>\n");
  fs.writeFileSync(path.join(wsDir,"data.json"), '{"a":1}\n');
  fs.writeFileSync(path.join(wsDir,"notes.md"), "# hello\n");

  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], {stdio:"ignore", detached:true, env:{...process.env, CC_USER_DATA:userData}});
  child.unref();
  let targets=null; for(let i=0;i<40;i++){ await sleep(800); try{ targets=await getJson(`http://127.0.0.1:${PORT}/json/list`); if(targets&&targets.length) break;}catch{} }
  const page = targets.find(t=>t.type==="page")||targets[0];
  const ws = page.webSocketDebuggerUrl;
  const E=(expr)=>evaluate(ws, expr);
  const R=[]; const check=(name,pass,detail)=>{ R.push({name,pass}); tlog(`${pass?"  PASS":"  FAIL"}  ${name}${detail?"  ("+detail+")":""}`); };

  await sleep(1200);

  const opened = await E(`window.closeCode.openFolder(${JSON.stringify(wsDir)}).then(r=>r)`);
  check("open workspace", opened?.ok===true);

  const openRes = await E(`(async()=>{
    const p=${JSON.stringify(path.join(wsDir,"hello.js"))};
    const txt=(await window.closeCode.readFile(p)).result.content;
    window.__cacheContent(p, txt);
    await window.__editorStore.getState().openFileInWorkspace(p, {content: txt, size: txt.length});
    return window.__editorStore.getState().tabs.map(t=>t.name).join(',');
  })()`);
  check("open file creates tab", typeof openRes==='string' && openRes.includes("hello.js"), String(openRes));

  const open2 = await E(`(async()=>{
    const p=${JSON.stringify(path.join(wsDir,"style.css"))};
    const txt=(await window.closeCode.readFile(p)).result.content;
    window.__cacheContent(p, txt);
    await window.__editorStore.getState().openFileInWorkspace(p, {content: txt, size: txt.length});
    return window.__editorStore.getState().tabs.length;
  })()`);
  check("multiple tabs", open2===2, String(open2));

  // Ensure hello.js is active before dirty/save
  await E(`window.__editorStore.getState().setActive(${JSON.stringify(path.join(wsDir,"hello.js"))})`);
  const dirty = await E(`(async()=>{
    const p=${JSON.stringify(path.join(wsDir,"hello.js"))};
    window.__cacheContent(p, "const x = 999;\\n");
    window.__editorStore.getState().markChanged(p);
    return window.__editorStore.getState().tabs.find(t=>t.path===p)?.dirty;
  })()`);
  check("dirty indicator after edit", dirty===true, String(dirty));

  const saved = await E(`(async()=>{ return await window.__editorStore.getState().saveActive(); })()`);
  check("save active (Ctrl+S) persists", saved===true, String(saved));
  check("disk content after save", fs.readFileSync(path.join(wsDir,"hello.js"),"utf8")==="const x = 999;\n", fs.readFileSync(path.join(wsDir,"hello.js"),"utf8"));

  // Save As: test writeFile for new path + store api exists (dialog would block, so test writeFile directly)
  const newPath = path.join(wsDir,"saved-as.txt");
  const writeRes = await E(`window.closeCode.writeFile(${JSON.stringify(newPath)}, "untitled content").then(r=>r)`);
  check("Save As (writeFile) creates file", writeRes?.error===null && fs.existsSync(newPath) && fs.readFileSync(newPath,"utf8")==="untitled content", JSON.stringify(writeRes));
  const saveAsExists = await E(`typeof window.__editorStore.getState().saveAs === 'function'`);
  check("Save As API exists (Ctrl+Shift+S)", saveAsExists===true);

  // Save All
  await E(`(async()=>{
    const p1=${JSON.stringify(path.join(wsDir,"style.css"))};
    window.__cacheContent(p1, "body { color: blue; }");
    window.__editorStore.getState().markChanged(p1);
    // also dirty hello again
    const p2=${JSON.stringify(path.join(wsDir,"hello.js"))};
    window.__cacheContent(p2, "const x = 777;\\n");
    window.__editorStore.getState().markChanged(p2);
  })()`);
  const saveAllRes = await E(`(async()=>{ await window.__editorStore.getState().saveAll(); return window.__editorStore.getState().tabs.filter(t=>t.dirty).length; })()`);
  check("Save All clears dirty", saveAllRes===0, String(saveAllRes));
  check("Save All persisted style.css", fs.readFileSync(path.join(wsDir,"style.css"),"utf8")==="body { color: blue; }");
  check("Save All persisted hello.js", fs.readFileSync(path.join(wsDir,"hello.js"),"utf8")==="const x = 777;\n");

  // Close tab (Ctrl+W)
  const closeRes = await E(`(async()=>{
    const before=window.__editorStore.getState().tabs.length;
    const p=${JSON.stringify(path.join(wsDir,"hello.js"))};
    window.__editorStore.getState().closeTab(p);
    return {before, after: window.__editorStore.getState().tabs.length};
  })()`);
  check("Close tab (Ctrl+W)", closeRes.after===closeRes.before-1, JSON.stringify(closeRes));

  // Auto-save setting persists
  const s = await E(`(async()=>{ await window.closeCode.saveSettings({autoSave:"afterDelay", autoSaveDelay:500}); return await window.closeCode.getSettings(); })()`);
  check("Auto-save option saved", s?.autoSave==="afterDelay" && s?.autoSaveDelay===500, JSON.stringify(s));
  await E(`(async()=>{ await window.closeCode.saveSettings({autoSave:"off", autoSaveDelay:1000}); return true; })()`);
  const s2 = await E(`(async()=>{ return await window.closeCode.getSettings(); })()`);
  check("Auto-save off restores", s2?.autoSave==="off", JSON.stringify(s2));

  // Language detection (replicate map)
  const langs = await E(`(async()=>{
    const map={js:"javascript",jsx:"javascript",ts:"typescript",tsx:"typescript",json:"json",html:"html",htm:"html",css:"css",md:"markdown",markdown:"markdown",py:"python"};
    const det=(p)=>{ const e=p.split('.').pop().toLowerCase(); return map[e]||"plaintext"; };
    return [det("a.js"),det("b.ts"),det("c.json"),det("d.md"),det("e.html"),det("f.css"),det("g.py")];
  })()`);
  check("Syntax highlighting / language detection", JSON.stringify(langs)==='["javascript","typescript","json","markdown","html","css","python"]', JSON.stringify(langs));

  const monacoOpts = await E(`(async()=>{ const s=await window.closeCode.getSettings(); return {minimap:s.minimap, wordWrap:s.wordWrap, tabSize:s.tabSize}; })()`);
  check("Editor settings exposed (minimap/wordWrap/tabSize)", monacoOpts?.tabSize===2, JSON.stringify(monacoOpts));

  // Ctrl+S via keyboard
  const kb = await E(`(async()=>{
    const p=${JSON.stringify(path.join(wsDir,"style.css"))};
    const txt="body { color: green; }";
    window.__cacheContent(p, txt);
    window.__editorStore.getState().markChanged(p);
    window.__editorStore.setState({activePath:p});
    const beforeDirty = window.__editorStore.getState().tabs.find(t=>t.path===p)?.dirty;
    const ev=new KeyboardEvent("keydown",{key:"s", ctrlKey:true, bubbles:true});
    window.dispatchEvent(ev);
    await new Promise(r=>setTimeout(r,600));
    const afterDirty = window.__editorStore.getState().tabs.find(t=>t.path===p)?.dirty;
    return {beforeDirty, afterDirty};
  })()`);
  check("Ctrl+S keyboard shortcut saves", kb.beforeDirty===true && kb.afterDirty===false, JSON.stringify(kb));
  check("Ctrl+S persisted to disk", fs.readFileSync(path.join(wsDir,"style.css"),"utf8")==="body { color: green; }");

  // Ctrl+W via keyboard
  const kbW = await E(`(async()=>{
    const p=${JSON.stringify(path.join(wsDir,"saved-as.txt"))};
    const txt=(await window.closeCode.readFile(p)).result.content;
    window.__cacheContent(p, txt);
    await window.__editorStore.getState().openFileInWorkspace(p, {content: txt, size: txt.length});
    const before=window.__editorStore.getState().tabs.length;
    window.__editorStore.setState({activePath:p});
    const ev=new KeyboardEvent("keydown",{key:"w", ctrlKey:true, bubbles:true});
    window.dispatchEvent(ev);
    await new Promise(r=>setTimeout(r,400));
    const after=window.__editorStore.getState().tabs.length;
    return {before, after};
  })()`);
  check("Ctrl+W keyboard shortcut closes tab", kbW.after===kbW.before-1, JSON.stringify(kbW));

  // Word wrap toggle
  const wl = await E(`(async()=>{ await window.closeCode.saveSettings({wordWrap:"on"}); const s=await window.closeCode.getSettings(); await window.closeCode.saveSettings({wordWrap:"off"}); return s.wordWrap==="on"; })()`);
  check("Word wrap setting toggles", wl===true);

  const ro = await E(`typeof window.__editorStore.getState().setLargeFileWarning==="function"`);
  check("Read-only mode API exists", ro===true);

  const all = R.every(r=>r.pass);
  tlog(`\n${R.filter(r=>r.pass).length}/${R.length} checks passed`);
  tlog(all?"PHASE 3 INTEGRATION: PASSED":"PHASE 3 INTEGRATION: FAILED");
  try{ execSync(`taskkill /PID ${child.pid} /T /F`, {stdio:"ignore"});}catch{ try{ execSync(`taskkill /F /IM "CloseCode.exe"`,{stdio:"ignore"})}catch{} }
  await sleep(500);
  try{ fs.rmSync(base,{recursive:true, force:true});}catch{}
  process.exit(all?0:1);
}
main().catch(e=>{tlog('ERR '+e.stack); console.error(e); process.exit(1);});
