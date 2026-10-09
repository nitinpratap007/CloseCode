// Static IPC contract check: every channel the preload bridge calls must have a
// handler in the main process, otherwise the call rejects at runtime with
// "No handler registered for ...". Run: node scripts/ipc-contract-check.cjs
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const preload = fs.readFileSync(path.join(root, "electron", "preload.ts"), "utf8");

const ipcDir = path.join(root, "electron", "ipc");
const mainParts = [fs.readFileSync(path.join(root, "electron", "main.ts"), "utf8")];
for (const name of fs.readdirSync(ipcDir)) {
  if (name.endsWith(".ts")) mainParts.push(fs.readFileSync(path.join(ipcDir, name), "utf8"));
}
const main = mainParts.join("\n");

// Group 1 is the opening quote character, group 2 is the channel name.
const collect = (src, re) => new Set([...src.matchAll(re)].map((m) => m[2]));

// A channel name is always a quoted string literal, captured together with its own
// quote character so the closing quote has to match the opening one.
const Q = "([\\x60\\x22\\x27])(.*?)\\1";
const invoked = collect(preload, new RegExp("ipcRenderer\\.invoke\\(\\s*" + Q, "g"));
const sent = collect(preload, new RegExp("ipcRenderer\\.send\\(\\s*" + Q, "g"));
const handled = collect(main, new RegExp("ipcMain\\.handle\\(\\s*" + Q, "g"));
const onEvt = collect(main, new RegExp("ipcMain\\.on\\(\\s*" + Q, "g"));

const missingInvoke = [...invoked].filter((c) => !handled.has(c) && !onEvt.has(c)).sort();
const missingSend = [...sent].filter((c) => !onEvt.has(c)).sort();
const unusedHandlers = [...handled].filter((c) => !invoked.has(c)).sort();

console.log("preload ipcRenderer.invoke channels :", invoked.size);
console.log("preload ipcRenderer.send channels   :", sent.size);
console.log("main ipcMain.handle channels        :", handled.size);
console.log("main ipcMain.on channels            :", onEvt.size);
console.log("");
const problems = [];
if (missingInvoke.length) problems.push(["MISSING HANDLER (invoke)", missingInvoke]);
if (missingSend.length) problems.push(["MISSING HANDLER (send)", missingSend]);
if (unusedHandlers.length) problems.push(["UNUSED HANDLER", unusedHandlers]);
if (!problems.length) {
  console.log("OK - every preload channel has a main-process handler, and no handler is dead code.");
} else {
  for (const [label, list] of problems) console.log(`${label} (${list.length}):`, list.join(", "));
}
process.exitCode = problems.length ? 1 : 0;
