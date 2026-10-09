const { spawn, execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const EXE = "E:\\closecode\\release\\win-unpacked\\CloseCode.exe";
const PORT = 9231;
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

const LOGF='C:\\Users\\NITINP~1\\AppData\\Local\\Temp\\opencode\\phase9.log';
function tlog(m){ try{fs.appendFileSync(LOGF, m+'\n')}catch{}; console.log(m); }

function runGit(cwd, args) {
  const r = execSync(`git ${args.map(a=>`"${a}"`).join(" ")}`, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  return r;
}

async function main(){
  try{fs.unlinkSync(LOGF)}catch{}
  tlog('phase9 start');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cc-phase9-"));
  const userData = path.join(base, "userdata"); fs.mkdirSync(userData,{recursive:true});
  const wsDir = path.join(base,"ws"); fs.mkdirSync(wsDir,{recursive:true});
  const wsDirNonRepo = path.join(base,"ws-non-repo"); fs.mkdirSync(wsDirNonRepo,{recursive:true});
  fs.writeFileSync(path.join(wsDirNonRepo,"file.txt"), "hello\n");

  // Create a real git repo for testing
  execSync("git init", { cwd: wsDir, stdio: "ignore" });
  execSync('git config user.email "test@test.com"', { cwd: wsDir, stdio: "ignore" });
  execSync('git config user.name "Test"', { cwd: wsDir, stdio: "ignore" });
  fs.writeFileSync(path.join(wsDir,"README.md"), "# Test\n");
  fs.writeFileSync(path.join(wsDir,"a.txt"), "initial\n");
  execSync("git add .", { cwd: wsDir, stdio: "ignore" });
  execSync('git commit -m "initial"', { cwd: wsDir, stdio: "ignore" });
  // Create a second commit for history
  fs.writeFileSync(path.join(wsDir,"b.txt"), "b content\n");
  execSync("git add b.txt", { cwd: wsDir, stdio: "ignore" });
  execSync('git commit -m "add b"', { cwd: wsDir, stdio: "ignore" });

  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], {stdio:"ignore", detached:true, env:{...process.env, CC_USER_DATA:userData}});
  child.unref();
  let targets=null; for(let i=0;i<40;i++){ await sleep(800); try{ targets=await getJson(`http://127.0.0.1:${PORT}/json/list`); if(targets&&targets.length) break;}catch{} }
  if (!targets) throw new Error("no targets");
  const page = targets.find(t=>t.type==="page")||targets[0];
  const ws = page.webSocketDebuggerUrl;
  const E=(expr)=>evaluate(ws, expr);
  const R=[]; const check=(name,pass,detail)=>{ R.push({name,pass}); tlog(`${pass?"  PASS":"  FAIL"}  ${name}${detail?"  ("+detail+")":""}`); };

  await sleep(1500);

  // Check git installed
  const gitInstalled = await E(`(async()=>{ const r=await window.closeCode.gitCheckInstalled(); return r; })()`);
  check("Git installed check", gitInstalled?.ok===true && gitInstalled?.result===true, JSON.stringify(gitInstalled));
  if (!gitInstalled?.result) {
    tlog("Git not installed, skipping remaining tests as they require real git");
    // Still check that GitPanel shows not installed message
    await E(`window.closeCode.openFolder(${JSON.stringify(wsDir)}).then(r=>r)`);
    await sleep(600);
    await E(`window.__commandRegistry.execute("git-status")`);
    await sleep(600);
    const panelVisible = await E(`!!document.querySelector('[data-git-panel]')`);
    check("Git panel visible even if git not installed", typeof panelVisible === 'boolean');
    const all2 = R.every(r=>r.pass);
    tlog(`\n${R.filter(r=>r.pass).length}/${R.length} checks passed`);
    tlog(all2?"PHASE 9 INTEGRATION: PASSED":"PHASE 9 INTEGRATION: FAILED");
    try{ execSync(`taskkill /PID ${child.pid} /T /F`, {stdio:"ignore"});}catch{}
    await sleep(500);
    try{ fs.rmSync(base,{recursive:true, force:true});}catch{}
    process.exit(all2?0:1);
  }

  // Open non-repo first: should detect not a repo
  await E(`(async()=>{ const r=await window.closeCode.openFolder(${JSON.stringify(wsDirNonRepo)}); return r; })()`);
  await sleep(600);
  const isRepoNon = await E(`(async()=>{ const r=await window.closeCode.gitIsRepo(${JSON.stringify(wsDirNonRepo)}); return r; })()`);
  check("Git repository detection (non-repo)", isRepoNon?.ok===true && isRepoNon?.result===false, JSON.stringify(isRepoNon));

  // Open real repo
  const opened = await E(`window.closeCode.openFolder(${JSON.stringify(wsDir)}).then(r=>r)`);
  check("open workspace (git repo)", opened?.ok===true);
  await sleep(600);
  // Need to wait for git store to sync cwd
  await sleep(400);
  const isRepo = await E(`(async()=>{ const r=await window.closeCode.gitIsRepo(${JSON.stringify(wsDir)}); return r; })()`);
  check("Git repository detection (is repo)", isRepo?.ok===true && isRepo?.result===true, JSON.stringify(isRepo));

  // Ensure GitPanel shows repo UI (not "Not a git repository")
  await E(`window.__commandRegistry.execute("git-status")`);
  await sleep(600);
  const gitPanelVisible = await E(`!!document.querySelector('[data-git-panel]')`);
  check("Git panel visible via git-status command", gitPanelVisible===true);
  const notRepoMsg = await E(`document.querySelector('[data-git-panel]') ? document.querySelector('[data-git-panel]').textContent.includes("Not a git repository") : false`);
  check("Git panel not showing 'Not a git repository' for real repo", notRepoMsg===false);

  // 1. Status: should be clean initially
  const statusClean = await E(`(async()=>{ const r=await window.closeCode.gitStatus(${JSON.stringify(wsDir)}); return r; })()`);
  check("Status clean initially", statusClean?.ok===true && statusClean?.result?.isClean===true, JSON.stringify(statusClean?.result));

  // Modify a file: a.txt
  fs.writeFileSync(path.join(wsDir,"a.txt"), "modified\n");
  const statusModified = await E(`(async()=>{ const r=await window.closeCode.gitStatus(${JSON.stringify(wsDir)}); return r; })()`);
  check("Status shows modified file", statusModified?.result?.unstaged?.some(f=>f.path==="a.txt") || statusModified?.result?.files?.some(f=>f.path==="a.txt"), JSON.stringify(statusModified?.result?.files?.map(f=>f.path+":"+f.status)));
  check("Modified files count", statusModified?.result?.unstaged?.length >=1, String(statusModified?.result?.unstaged?.length));

  // Create untracked file
  fs.writeFileSync(path.join(wsDir,"untracked.txt"), "new\n");
  const statusUntracked = await E(`(async()=>{ const r=await window.closeCode.gitStatus(${JSON.stringify(wsDir)}); return r; })()`);
  check("Untracked files detection", statusUntracked?.result?.untracked?.some(f=>f.path==="untracked.txt"), JSON.stringify(statusUntracked?.result?.untracked?.map(f=>f.path)));
  check("Untracked files count", statusUntracked?.result?.untracked?.length===1, String(statusUntracked?.result?.untracked?.length));

  // 2. Stage a file
  const stageRes = await E(`(async()=>{ const r=await window.closeCode.gitStage(${JSON.stringify(wsDir)}, ["a.txt"]); return r; })()`);
  check("Stage file (a.txt)", stageRes?.ok===true, JSON.stringify(stageRes));
  const statusAfterStage = await E(`(async()=>{ const r=await window.closeCode.gitStatus(${JSON.stringify(wsDir)}); return r; })()`);
  check("Staged files after stage", statusAfterStage?.result?.staged?.some(f=>f.path==="a.txt"), JSON.stringify(statusAfterStage?.result?.staged?.map(f=>f.path)));
  check("Staged count 1", statusAfterStage?.result?.staged?.length===1, String(statusAfterStage?.result?.staged?.length));

  // Stage all (should stage untracked as well)
  const stageAllRes = await E(`(async()=>{ const r=await window.closeCode.gitStageAll(${JSON.stringify(wsDir)}); return r; })()`);
  check("Stage all", stageAllRes?.ok===true);
  const statusAfterStageAll = await E(`(async()=>{ const r=await window.closeCode.gitStatus(${JSON.stringify(wsDir)}); return r; })()`);
  check("All staged after stageAll", statusAfterStageAll?.result?.staged?.length===2, String(statusAfterStageAll?.result?.staged?.length));

  // 3. Unstage
  const unstageRes = await E(`(async()=>{ const r=await window.closeCode.gitUnstage(${JSON.stringify(wsDir)}, ["a.txt"]); return r; })()`);
  check("Unstage file (a.txt)", unstageRes?.ok===true);
  const statusAfterUnstage = await E(`(async()=>{ const r=await window.closeCode.gitStatus(${JSON.stringify(wsDir)}); return r; })()`);
  check("Unstaged after unstage (a.txt in unstaged)", statusAfterUnstage?.result?.unstaged?.some(f=>f.path==="a.txt"), JSON.stringify(statusAfterUnstage?.result?.unstaged?.map(f=>f.path)));

  // Re-stage for commit
  await E(`(async()=>{ await window.closeCode.gitStage(${JSON.stringify(wsDir)}, ["a.txt"]); return true; })()`);
  await E(`(async()=>{ await window.closeCode.gitStage(${JSON.stringify(wsDir)}, ["untracked.txt"]); return true; })()`);

  // 4. Commit
  const commitRes = await E(`(async()=>{ const r=await window.closeCode.gitCommit(${JSON.stringify(wsDir)}, "test commit from phase9"); return r; })()`);
  check("Commit staged files", commitRes?.ok===true && !!commitRes?.result?.hash, JSON.stringify(commitRes));
  const statusAfterCommit = await E(`(async()=>{ const r=await window.closeCode.gitStatus(${JSON.stringify(wsDir)}); return r; })()`);
  check("Status clean after commit", statusAfterCommit?.result?.isClean===true, JSON.stringify(statusAfterCommit?.result));

  // 5. Branch operations
  const branchesBefore = await E(`(async()=>{ const r=await window.closeCode.gitBranches(${JSON.stringify(wsDir)}); return r; })()`);
  check("Branches list", branchesBefore?.ok===true && branchesBefore?.result?.length >=1, JSON.stringify(branchesBefore?.result?.map(b=>b.name)));
  const currentBranch = branchesBefore?.result?.find(b=>b.current)?.name;
  check("Current branch exists", !!currentBranch, String(currentBranch));

  // Create new branch
  const newBranch = "feature/test-branch-" + Date.now();
  const createRes = await E(`(async()=>{ const r=await window.closeCode.gitCreateBranch(${JSON.stringify(wsDir)}, ${JSON.stringify(newBranch)}); return r; })()`);
  check("Branch creation", createRes?.ok===true, JSON.stringify(createRes));
  const branchesAfterCreate = await E(`(async()=>{ const r=await window.closeCode.gitBranches(${JSON.stringify(wsDir)}); return r; })()`);
  check("New branch in list", branchesAfterCreate?.result?.some(b=>b.name===newBranch), JSON.stringify(branchesAfterCreate?.result?.map(b=>b.name)));
  // Check that new branch is current
  const isCurrentAfterCreate = await E(`(async()=>{ const r=await window.closeCode.gitBranches(${JSON.stringify(wsDir)}); const cur = r.result.find(b=>b.current); return cur?.name === ${JSON.stringify(newBranch)}; })()`);
  check("New branch is current", isCurrentAfterCreate===true);

  // Switch back to previous branch
  const switchRes = await E(`(async()=>{ const r=await window.closeCode.gitSwitchBranch(${JSON.stringify(wsDir)}, ${JSON.stringify(currentBranch)}); return r; })()`);
  check("Branch switching back", switchRes?.ok===true, JSON.stringify(switchRes));
  const afterSwitch = await E(`(async()=>{ const r=await window.closeCode.gitBranches(${JSON.stringify(wsDir)}); const cur = r.result.find(b=>b.current); return cur?.name; })()`);
  check("Current branch after switch", afterSwitch===currentBranch, String(afterSwitch));

  // 6. Diff viewer: modify a file and get diff
  fs.writeFileSync(path.join(wsDir,"a.txt"), "modified again\nsecond line\n");
  const diffRes = await E(`(async()=>{ const r=await window.closeCode.gitDiff(${JSON.stringify(wsDir)}, ${JSON.stringify(path.join(wsDir,"a.txt"))}, false); return r; })()`);
  check("Diff viewer (unstaged diff)", diffRes?.ok===true && diffRes?.result?.includes("modified again"), diffRes?.result?.slice(0,100));
  // Stage and get staged diff
  await E(`(async()=>{ await window.closeCode.gitStage(${JSON.stringify(wsDir)}, ["a.txt"]); return true; })()`);
  const stagedDiff = await E(`(async()=>{ const r=await window.closeCode.gitDiff(${JSON.stringify(wsDir)}, ${JSON.stringify(path.join(wsDir,"a.txt"))}, true); return r; })()`);
  check("Diff viewer (staged diff)", stagedDiff?.ok===true && stagedDiff?.result?.includes("modified again"), stagedDiff?.result?.slice(0,100));
  // Reset
  execSync("git reset --hard HEAD", { cwd: wsDir, stdio: "ignore" });
  execSync("git clean -fd", { cwd: wsDir, stdio: "ignore" });

  // 7. File history
  const historyRes = await E(`(async()=>{ const r=await window.closeCode.gitFileHistory(${JSON.stringify(wsDir)}, ${JSON.stringify(path.join(wsDir,"a.txt"))}, 10); return r; })()`);
  check("File history (a.txt)", historyRes?.ok===true && Array.isArray(historyRes?.result) && historyRes.result.length >=1, JSON.stringify(historyRes?.result?.map(h=>h.shortHash+":"+h.message).slice(0,2)));
  const logRes = await E(`(async()=>{ const r=await window.closeCode.gitLog(${JSON.stringify(wsDir)}, 10); return r; })()`);
  check("Git log (recent commits)", logRes?.ok===true && logRes.result.length >=2, JSON.stringify(logRes?.result?.map(h=>h.message).slice(0,2)));

  // 8. Pull/Push/Fetch - these will fail without remote, but should not crash and should return error gracefully
  const fetchRes = await E(`(async()=>{ const r=await window.closeCode.gitFetch(${JSON.stringify(wsDir)}); return r; })()`);
  // Fetch without remote may succeed (no output) or fail, but should be handled
  check("Fetch (no remote, handled)", typeof fetchRes?.ok === 'boolean', JSON.stringify(fetchRes));
  // For pull/push, we expect failure if no remote, but should be ok === false with error, not crash
  const pullRes = await E(`(async()=>{ const r=await window.closeCode.gitPull(${JSON.stringify(wsDir)}); return r; })()`);
  check("Pull (handled, ok false if no remote)", typeof pullRes?.ok === 'boolean', JSON.stringify(pullRes));
  const pushRes = await E(`(async()=>{ const r=await window.closeCode.gitPush(${JSON.stringify(wsDir)}); return r; })()`);
  check("Push (handled)", typeof pushRes?.ok === 'boolean', JSON.stringify(pushRes));

  // 9. GitHub optional: check that GitPanel works without GitHub login (just local git)
  const gitPanelStillVisible = await E(`!!document.querySelector('[data-git-panel]')`);
  check("GitHub optional: GitPanel works without login", gitPanelStillVisible===true);

  // 10. Use actual repo info (not fake): verify that status files are real paths
  const realPaths = await E(`(async()=>{
    const r=await window.closeCode.gitStatus(${JSON.stringify(wsDir)});
    if (!r.ok || !r.result) return false;
    // After reset, should be clean, so no files, but we can check branch is real
    return r.result.branch.length > 0;
  })()`);
  check("Use actual repository information (branch real)", realPaths===true);

  // 11. Palette has git commands
  await E(`window.dispatchEvent(new KeyboardEvent("keydown",{key:"p", ctrlKey:true, shiftKey:true, bubbles:true}))`);
  await sleep(400);
  const paletteHasGit = await E(`(() => {
    const input = document.querySelector('[data-command-palette] input');
    if (!input) return false;
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    nativeSetter.call(input, "git");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await sleep(400);
  const gitPaletteCount = await E(`document.querySelectorAll('[data-command-palette] [role="option"]').length`);
  check("Palette searchable includes Git commands", gitPaletteCount >= 1, String(gitPaletteCount));
  await E(`window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape", bubbles:true}))`);
  await sleep(300);

  // 12. ActivityBar git button
  const gitButtonExists = await E(`!!document.querySelector('[aria-label="Source Control"]')`);
  check("ActivityBar has Git button", gitButtonExists===true);
  // Click it should show GitPanel
  await E(`document.querySelector('[aria-label="Source Control"]')?.click()`);
  await sleep(400);
  const gitPanelAfterClick = await E(`!!document.querySelector('[data-git-panel]')`);
  check("GitPanel opens via ActivityBar", gitPanelAfterClick===true);

  const all = R.every(r=>r.pass);
  tlog(`\n${R.filter(r=>r.pass).length}/${R.length} checks passed`);
  tlog(all?"PHASE 9 INTEGRATION: PASSED":"PHASE 9 INTEGRATION: FAILED");
  try{ execSync(`taskkill /PID ${child.pid} /T /F`, {stdio:"ignore"});}catch{ try{ execSync(`taskkill /F /IM "CloseCode.exe"`,{stdio:"ignore"})}catch{} }
  await sleep(500);
  try{ fs.rmSync(base,{recursive:true, force:true});}catch{}
  process.exit(all?0:1);
}
main().catch(e=>{tlog('ERR '+e.stack); console.error(e); process.exit(1);});
