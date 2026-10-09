// Verify the Phase 20 packaging exclusions actually landed in the asar, and that
// nothing needed at runtime was dropped along with them. Run after a build.
const { execSync } = require("child_process");

const out = execSync("npx asar list release\\win-unpacked\\resources\\app.asar", {
  encoding: "utf8",
  maxBuffer: 1e9,
});
const lines = out.split(/\r?\n/).filter(Boolean);
const norm = (s) => s.replace(/\\/g, "/");
const set = new Set(lines.map(norm));

console.log(`asar entries: ${lines.length}\n`);

console.log("Excluded trees (must all be 0):");
for (const p of ["dev", "esm", "min-maps"]) {
  const n = lines.filter((l) => norm(l).startsWith(`/node_modules/monaco-editor/${p}/`)).length;
  console.log(`  ${n === 0 ? "OK  " : "FAIL"} monaco-editor/${p.padEnd(10)} ${n} entries`);
}

console.log("\nRequired at runtime (must all be > 0 unless noted):");
const required = [
  ["/dist/index.html", true],
  ["/dist-electron/main.js", true],
  ["/package.json", true],
  ["/node_modules/node-pty", true],
  ["/node_modules/react", true],
  ["/node_modules/react-dom", true],
  ["/node_modules/xterm", true],
  ["/node_modules/zustand", true],
  ["/node_modules/@monaco-editor/react", true],
  ["/node_modules/monaco-editor/min", false], // kept as a safety net, not required
];
let bad = 0;
for (const [p, requiredFlag] of required) {
  const present = [...set].some((e) => e === p || e.startsWith(p + "/"));
  const ok = requiredFlag ? present : true;
  if (!ok) bad++;
  const tag = requiredFlag ? (present ? "OK  " : "MISS") : present ? "kept" : "gone";
  console.log(`  ${tag}  ${p}`);
}

// Dist assets are the real Monaco payload — assert the big chunks survived.
console.log("\nBundled Monaco chunks in dist/assets (these are what actually run):");
const assets = [...set].filter((e) => e.startsWith("/dist/assets/") && /\.(js|css|ttf)$/.test(e));
console.log(`  ${assets.length} asset files bundled`);
const hasWorkers = ["ts.worker", "css.worker", "html.worker", "json.worker", "editor.worker"].every((w) =>
  assets.some((a) => a.includes(w))
);
console.log(`  ${hasWorkers ? "OK  " : "FAIL"} all 5 Monaco web workers present in bundle`);

process.exit(bad === 0 && hasWorkers ? 0 : 1);
