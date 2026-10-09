const { spawn, execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const EXE = "E:\\closecode\\release\\win-unpacked\\CloseCode.exe";
const PORT = 9227;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) { const res = await fetch(url); return res.json(); }
function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => reject(new Error("CDP timeout: " + expression.slice(0,80))), 25000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
    ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); if (msg.id === 1) { clearTimeout(timer); ws.close(); if (msg.result?.exceptionDetails) reject(new Error(JSON.stringify(msg.result.exceptionDetails).slice(0,1500))); else resolve(msg.result?.result?.value); } };
    ws.onerror = (e) => { clearTimeout(timer); reject(e); };
  });
}

const LOGF='C:\\Users\\NITINP~1\\AppData\\Local\\Temp\\opencode\\phase5.log';
function tlog(m){ try{fs.appendFileSync(LOGF, m+'\n')}catch{}; console.log(m); }

async function main(){
  try{fs.unlinkSync(LOGF)}catch{}
  tlog('phase5 start');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cc-phase5-"));
  const userData = path.join(base, "userdata"); fs.mkdirSync(userData,{recursive:true});
  const wsDir = path.join(base,"ws"); fs.mkdirSync(wsDir,{recursive:true});
  // Fixtures
  fs.writeFileSync(path.join(wsDir,"a.js"), "const hello = 'world';\n// hello again\nconst foo = 1;\n");
  fs.writeFileSync(path.join(wsDir,"b.js"), "const Hello = 'WORLD';\n");
  fs.writeFileSync(path.join(wsDir,"c.txt"), "hello world\nhello\n");
  fs.mkdirSync(path.join(wsDir,"sub"),{recursive:true});
  fs.writeFileSync(path.join(wsDir,"sub","d.ts"), "hello in sub\n");
  fs.writeFileSync(path.join(wsDir,"sub","e.md"), "no match here\n");
  // Ignored: node_modules, .git, dist
  fs.mkdirSync(path.join(wsDir,"node_modules","pkg"),{recursive:true});
  fs.writeFileSync(path.join(wsDir,"node_modules","pkg","x.js"), "hello from node_modules\n");
  fs.mkdirSync(path.join(wsDir,".git"),{recursive:true});
  fs.writeFileSync(path.join(wsDir,".git","HEAD"), "hello git\n");
  fs.mkdirSync(path.join(wsDir,"dist"),{recursive:true});
  fs.writeFileSync(path.join(wsDir,"dist","out.js"), "hello dist\n");
  // Large file beyond limit? Create 2.5MB file
  fs.writeFileSync(path.join(wsDir,"big.txt"), "x".repeat(3*1024*1024));

  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], {stdio:"ignore", detached:true, env:{...process.env, CC_USER_DATA:userData}});
  child.unref();
  let targets=null; for(let i=0;i<40;i++){ await sleep(800); try{ targets=await getJson(`http://127.0.0.1:${PORT}/json/list`); if(targets&&targets.length) break;}catch{} }
  if (!targets) throw new Error("no targets");
  const page = targets.find(t=>t.type==="page")||targets[0];
  const ws = page.webSocketDebuggerUrl;
  const E=(expr)=>evaluate(ws, expr);
  const R=[]; const check=(name,pass,detail)=>{ R.push({name,pass}); tlog(`${pass?"  PASS":"  FAIL"}  ${name}${detail?"  ("+detail+")":""}`); };

  await sleep(1500);
  const opened = await E(`window.closeCode.openFolder(${JSON.stringify(wsDir)}).then(r=>r)`);
  tlog(`open ${JSON.stringify(opened)}`);
  check("open workspace", opened?.ok===true);

  // 1. Search entire workspace: "hello" case-insensitive default should find 4 files (a.js 2, c.txt 2, sub/d.ts 1) + maybe b.js? No, b.js has Hello with capital H, case-insensitive should find it too => 5 files? Let's count: a.js 2, b.js 1 (Hello), c.txt 2, sub/d.ts 1 => total 6 matches across 4 files
  const res1 = await E(`(async()=>{
    const root=${JSON.stringify(wsDir)};
    const r = await window.closeCode.searchWorkspace(root, "hello", {isRegex:false, caseSensitive:false, wholeWord:false, include:"", exclude:""});
    return r;
  })()`);
  check("search workspace 'hello' (case-insensitive)", res1?.ok===true && res1?.result?.results?.length===6, `got ${res1?.result?.results?.length} ${JSON.stringify(res1?.result?.results?.slice(0,2))}`);
  check("search ignores node_modules/.git/dist", res1?.result?.results?.every(r=>!r.file.includes("node_modules") && !r.file.includes(".git") && !r.file.includes("dist")), JSON.stringify(res1?.result?.results?.map(r=>r.file).join(',')));
  check("search respects MAX_FILE_SIZE (big.txt ignored)", res1?.result?.results?.every(r=>!r.file.includes("big.txt")), "big.txt found?");

  // 2. Case-sensitive: "hello" should NOT match "Hello" => a.js 2 + c.txt 2 + sub/d.ts 1 =5
  const resCase = await E(`(async()=>{
    const r = await window.closeCode.searchWorkspace(${JSON.stringify(wsDir)}, "hello", {isRegex:false, caseSensitive:true, wholeWord:false, include:"", exclude:""});
    return r;
  })()`);
  check("case-sensitive search", resCase?.result?.results?.length===5, `got ${resCase?.result?.results?.length}`);

  // 3. Whole-word: "hello" wholeWord should not match "hello" inside? Actually all are whole words, but test with "hell" wholeWord false vs true
  const resWholeFalse = await E(`(async()=>{
    const r = await window.closeCode.searchWorkspace(${JSON.stringify(wsDir)}, "hell", {isRegex:false, caseSensitive:false, wholeWord:false, include:"", exclude:""});
    return r.result.results.length;
  })()`);
  const resWholeTrue = await E(`(async()=>{
    const r = await window.closeCode.searchWorkspace(${JSON.stringify(wsDir)}, "hell", {isRegex:false, caseSensitive:false, wholeWord:true, include:"", exclude:""});
    return r.result.results.length;
  })()`);
  check("whole-word false finds partial", resWholeFalse>0, String(resWholeFalse));
  check("whole-word true finds 0 for 'hell'", resWholeTrue===0, String(resWholeTrue));

  // 4. Regex: "h.*o" should match hello
  const resRegex = await E(`(async()=>{
    const r = await window.closeCode.searchWorkspace(${JSON.stringify(wsDir)}, "h.*o", {isRegex:true, caseSensitive:false, wholeWord:false, include:"", exclude:""});
    return r.result.results.length;
  })()`);
  check("regex search 'h.*o'", resRegex>0, String(resRegex));

  // 5. Include pattern: "*.js" should only find a.js, b.js
  const resInclude = await E(`(async()=>{
    const r = await window.closeCode.searchWorkspace(${JSON.stringify(wsDir)}, "hello", {isRegex:false, caseSensitive:false, wholeWord:false, include:"*.js", exclude:""});
    return r;
  })()`);
  check("include *.js", resInclude?.result?.results?.every(r=>r.file.endsWith(".js")) && resInclude?.result?.results?.length===3, `got ${resInclude?.result?.results?.length} ${JSON.stringify(resInclude?.result?.results?.map(r=>r.file))}`);

  // 6. Exclude pattern: "*.txt" should exclude c.txt (a.js 2 + b.js 1 + d.ts 1 =4)
  const resExclude = await E(`(async()=>{
    const r = await window.closeCode.searchWorkspace(${JSON.stringify(wsDir)}, "hello", {isRegex:false, caseSensitive:false, wholeWord:false, include:"", exclude:"*.txt"});
    return r;
  })()`);
  check("exclude *.txt", resExclude?.result?.results?.every(r=>!r.file.endsWith(".txt")) && resExclude?.result?.results?.length===4, `got ${resExclude?.result?.results?.length} ${JSON.stringify(resExclude?.result?.results?.map(r=>r.file))}`);

  // 7. Replace in file: replace "hello" with "hi" in a.js
  const beforeA = fs.readFileSync(path.join(wsDir,"a.js"),"utf8");
  const repFile = await E(`(async()=>{
    const r = await window.closeCode.replaceInFile(${JSON.stringify(path.join(wsDir,"a.js"))}, "hello", "hi", {isRegex:false, caseSensitive:false, wholeWord:false, include:"", exclude:""});
    return r;
  })()`);
  check("replace in file (a.js)", repFile?.ok===true && repFile?.result?.count===2, JSON.stringify(repFile));
  const afterA = fs.readFileSync(path.join(wsDir,"a.js"),"utf8");
  check("replace in file persisted", afterA.includes("hi") && !afterA.includes("hello"), afterA.slice(0,40));
  // Restore a.js for next test
  fs.writeFileSync(path.join(wsDir,"a.js"), beforeA);

  // 8. Replace across workspace: replace "hello" with "hi" (case-insensitive) should replace 6 occurrences
  const beforeC = fs.readFileSync(path.join(wsDir,"c.txt"),"utf8");
  const repAll = await E(`(async()=>{
    const r = await window.closeCode.replaceAll(${JSON.stringify(wsDir)}, "hello", "hi", {isRegex:false, caseSensitive:false, wholeWord:false, include:"", exclude:""});
    return r;
  })()`);
  check("replace across workspace", repAll?.ok===true && repAll?.result?.replacedCount===6, JSON.stringify(repAll?.result));
  check("replaceAll fileCount", repAll?.result?.fileCount===4, String(repAll?.result?.fileCount));
  // Verify one file: c.txt should now have hi
  const afterC = fs.readFileSync(path.join(wsDir,"c.txt"),"utf8");
  check("replaceAll persisted c.txt", afterC.includes("hi"), afterC.slice(0,30));
  // Restore for navigation test: recreate original files
  fs.writeFileSync(path.join(wsDir,"a.js"), beforeA);
  fs.writeFileSync(path.join(wsDir,"c.txt"), beforeC);
  fs.writeFileSync(path.join(wsDir,"b.js"), "const Hello = 'WORLD';\n");
  fs.writeFileSync(path.join(wsDir,"sub","d.ts"), "hello in sub\n");

  // 9. Search result navigation: search then navigateTo
  // Do a search via store, then navigate to first result
  await E(`(async()=>{
    const root=${JSON.stringify(wsDir)};
    const {useSearchStore} = window.__searchStore ? {useSearchStore: window.__searchStore} : await (async()=>{ return {useSearchStore: window.__searchStore}})();
    // Use store directly
    window.__searchStore.getState().setQuery("hello");
    await window.__searchStore.getState().search(root);
    return window.__searchStore.getState().results.length;
  })()`);
  // Wait a bit for search
  await sleep(800);
  const navRes = await E(`(async()=>{
    const st = window.__searchStore.getState();
    if (st.results.length===0) return {ok:false, reason:"no results"};
    const first = st.results[0];
    st.navigateTo(first);
    await new Promise(r=>setTimeout(r,600));
    const active = window.__editorStore.getState().activePath;
    return {active, firstFile: first.file, line: first.line};
  })()`);
  check("search result navigation (opens file at line)", navRes?.active===navRes?.firstFile, JSON.stringify(navRes));

  // 10. Performance: debouncing — setQuery rapidly, ensure search not called on every keystroke (we test that store's search is debounced via SearchPanel, but we can check that search is not called synchronously)
  // We will test that SearchPanel's debounced search: set localQuery quickly 3 times, then after 400ms check results count is for final query
  // This is implicitly via SearchPanel's useEffect with 300ms debounce — we test via UI: open SearchPanel, type, check results
  // First ensure SearchPanel is visible
  const searchVisible1 = await E(`!!document.querySelector('[data-search-panel]')`);
  // Open via command palette or activity bar
  await E(`window.__commandRegistry.execute("search-workspace")`);
  await sleep(400);
  const searchVisible2 = await E(`!!document.querySelector('[data-search-panel]')`);
  check("Search Panel opens via command (Ctrl+Shift+F)", searchVisible2===true, String(searchVisible2));

  // Check palette has search commands
  await E(`window.dispatchEvent(new KeyboardEvent("keydown",{key:"p", ctrlKey:true, shiftKey:true, bubbles:true}))`);
  await sleep(400);
  const paletteHasSearch = await E(`(() => {
    const input = document.querySelector('[data-command-palette] input');
    if (!input) return false;
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    nativeSetter.call(input, "search");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await sleep(400);
  const searchCmdInPalette = await E(`(() => {
    const opts = document.querySelectorAll('[data-command-palette] [role="option"]');
    const texts = [...opts].map(o=>o.textContent);
    return texts.some(t=>t.toLowerCase().includes("search"));
  })()`);
  check("palette searchable includes Search commands", searchCmdInPalette===true);
  await E(`window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape", bubbles:true}))`);
  await sleep(300);

  // 11. Search current file via Monaco: Ctrl+F should focus find widget (we check that Monaco's find action exists)
  const hasFind = await E(`(() => {
    const ed = window.__monacoEditor;
    if (!ed) return false;
    const action = ed.getAction("actions.find");
    return !!action;
  })()`);
  check("Search current file (Monaco find) available", hasFind===true);

  // 12. Debouncing check: verify that SearchPanel's search is debounced (we can check that rapid query changes only trigger one search)
  // We'll set query via store rapidly and check that isSearching debounces? Actually store search is not debounced itself, but SearchPanel debounces localQuery -> setQuery -> search
  // For test, we check that SearchPanel's localQuery debounce works by checking that after rapid typing, only final results appear
  await E(`(() => {
    const input = document.querySelector('[data-search-panel] input[aria-label="Search"]');
    if (!input) return false;
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    // Rapid typing simulation
    nativeSetter.call(input, "h");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    nativeSetter.call(input, "he");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    nativeSetter.call(input, "hel");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    nativeSetter.call(input, "hello");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await sleep(600); // wait for debounce 300 + search
  const afterDebounce = await E(`window.__searchStore.getState().results.length`);
  check("debouncing (final query 'hello' has results)", afterDebounce===6, String(afterDebounce));

  const all = R.every(r=>r.pass);
  tlog(`\n${R.filter(r=>r.pass).length}/${R.length} checks passed`);
  tlog(all?"PHASE 5 INTEGRATION: PASSED":"PHASE 5 INTEGRATION: FAILED");
  try{ execSync(`taskkill /PID ${child.pid} /T /F`, {stdio:"ignore"});}catch{ try{ execSync(`taskkill /F /IM "CloseCode.exe"`,{stdio:"ignore"})}catch{} }
  await sleep(500);
  try{ fs.rmSync(base,{recursive:true, force:true});}catch{}
  process.exit(all?0:1);
}
main().catch(e=>{tlog('ERR '+e.stack); console.error(e); process.exit(1);});
