// CloseCode — full regression sweep.
//
// Phase 20 added a build step that can silently change the packaged artifact
// (productName rename moved Close Code.exe -> CloseCode.exe, and productName
// also moves the userData folder). Both of those break every CDP suite at once
// without any single suite reporting why. This runner is the single command
// that proves the packaged binary still works end to end.
//
//   npm run test:all              # unit + ipc contract + asar + all CDP suites
//   npm run test:all -- --only=phase17,smoke
//   npm run test:all -- --skip=unit
//   npm run test:all -- --verbose     # also print output of passing suites
//
// Exit code is the contract: 0 = every suite passed, 1 = at least one failed,
// 2 = the invocation itself was wrong (no suite matched, vitest not installed).
// CI and the Phase 20 verification steps both depend on this.
// Suites run sequentially on purpose: each launches the packaged executable and
// binds a distinct CDP port, but they share one userData directory and Electron
// single-instance behaviour, so overlapping them produces flaky failures that
// look like real regressions. Sequential is slower and actually trustworthy.

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

/** Resolve vitest's JS entry so the unit suite needs no shell / no npx. */
function vitestEntry() {
  const p = path.join(ROOT, "node_modules", "vitest", "vitest.mjs");
  if (!fs.existsSync(p)) {
    console.error(`vitest entry not found at ${p} — run \`npm install\` first.`);
    process.exit(2);
  }
  return p;
}

/** Ordered cheapest-first: fail fast before spending minutes on Electron. */
const SUITES = [
  { name: "unit", nodeEntry: vitestEntry(), args: ["run"] },
  { name: "ipc-contract", script: "ipc-contract-check.cjs" },
  // Packaging integrity. Cheap (no Electron launch) and it is the only guard
  // that a `files:` exclusion has not silently dropped something the app needs
  // at runtime — electron-builder applies patterns in order, so a mis-ordered
  // negation is a successful build with a broken payload.
  { name: "asar-contents", script: "verify-asar.cjs" },
  { name: "smoke", script: "smoke-test.cjs" },
  { name: "settings", script: "settings-test.cjs" },
  { name: "phase2", script: "phase2-test.cjs" },
  { name: "phase3", script: "phase3-test.cjs" },
  { name: "phase4", script: "phase4-test.cjs" },
  { name: "phase5", script: "phase5-test.cjs" },
  { name: "phase6", script: "phase6-test.cjs" },
  { name: "phase7", script: "phase7-test.cjs" },
  { name: "phase8", script: "phase8-test.cjs" },
  { name: "phase9", script: "phase9-test.cjs" },
  { name: "phase10", script: "phase10-test.cjs" },
  { name: "phase11", script: "phase11-test.cjs" },
  { name: "phase12", script: "phase12-test.cjs" },
  { name: "phase13", script: "phase13-test.cjs" },
  { name: "phase14", script: "phase14-test.cjs" },
  { name: "phase15", script: "phase15-test.cjs" },
  { name: "phase17", script: "phase17-test.cjs" },
  { name: "phase19", script: "e2e-test.cjs" },
  { name: "phase21", script: "phase21-test.cjs" },
];

const argv = process.argv.slice(2);
const onlyArg = argv.find((a) => a.startsWith("--only="));
const skipArg = argv.find((a) => a.startsWith("--skip="));
const verbose = argv.includes("--verbose");

const only = onlyArg ? new Set(onlyArg.slice(7).split(",").map((s) => s.trim())) : null;
const skip = new Set(skipArg ? skipArg.slice(7).split(",").map((s) => s.trim()) : []);

const isWin = process.platform === "win32";

/** A crashed run can leave the app alive and squatting on the CDP port. */
function killStaleApp() {
  if (!isWin) return;
  spawnSync("taskkill", ["/F", "/IM", "CloseCode.exe", "/T"], { stdio: "ignore" });
}

function runSuite(suite) {
  const started = Date.now();
  let res;
  if (suite.script) {
    killStaleApp();
    res = spawnSync(process.execPath, [path.join(ROOT, "scripts", suite.script)], {
      cwd: ROOT,
      encoding: "utf-8",
      shell: false,
    });
  } else if (suite.nodeEntry) {
    // Invoke the tool's JS entry with the current Node binary. Going through
    // `npx` would need `shell: true` on Windows (for the .cmd shim), and
    // spawnSync with shell:true does not escape its args — that is both a real
    // injection surface and a DEP0190 warning on every run.
    res = spawnSync(process.execPath, [suite.nodeEntry, ...suite.args], {
      cwd: ROOT,
      encoding: "utf-8",
      shell: false,
    });
  } else {
    throw new Error(`suite "${suite.name}" has neither script nor nodeEntry`);
  }
  return {
    ...suite,
    pass: res.status === 0,
    code: res.status,
    ms: Date.now() - started,
    out: `${res.stdout || ""}${res.stderr || ""}`,
  };
}

const targets = SUITES.filter(
  (s) => (!only || only.has(s.name)) && !skip.has(s.name) && !skip.has(s.script)
);

if (targets.length === 0) {
  console.error("No suites matched. Valid names:");
  console.error("  " + SUITES.map((s) => s.name).join(", "));
  process.exit(2);
}

console.log(`CloseCode regression sweep — ${targets.length} suite(s)\n`);

const results = [];
for (const suite of targets) {
  process.stdout.write(`  ${suite.name.padEnd(14)} ... `);
  const r = runSuite(suite);
  results.push(r);
  const secs = (r.ms / 1000).toFixed(1);
  console.log(`${r.pass ? "PASS" : `FAIL (exit ${r.code})`}  ${secs}s`);
  if (!r.pass && !verbose) {
    // Show the tail — a CDP suite that dies on launch says why in its last lines.
    const tail = r.out.trim().split(/\r?\n/).slice(-25).join("\n");
    console.log(tail.split("\n").map((l) => "      | " + l).join("\n"));
  }
}

killStaleApp();

const failed = results.filter((r) => !r.pass);
const totalMs = results.reduce((a, r) => a + r.ms, 0);

console.log(`\n${"-".repeat(58)}`);
for (const r of results) {
  console.log(
    `  ${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(14)} ${(r.ms / 1000).toFixed(1).padStart(6)}s`
  );
}
console.log("-".repeat(58));
console.log(
  `${results.length - failed.length}/${results.length} suites passed  ` +
    `(${(totalMs / 60000).toFixed(1)} min total)`
);

// Phase 21: the filename was hardcoded to "phase20-sweep.json", which stopped
// being true the moment another phase added a suite. The sweep is no longer
// phase-specific, so it now writes a phase-neutral name as well. The old path is
// still written so historical references in the docs keep resolving.
const sweepBody =
  JSON.stringify(
    {
      suites: results.map((r) => ({ name: r.name, pass: r.pass, exitCode: r.code, ms: r.ms })),
      passed: results.length - failed.length,
      total: results.length,
      productName: "CloseCode",
      exe: "release/win-unpacked/CloseCode.exe",
    },
    null,
    2
  ) + "\n";

const reportPaths = [
  path.join(ROOT, "reports", "regression-sweep.json"),
  path.join(ROOT, "reports", "phase20-sweep.json"),
];
try {
  for (const reportPath of reportPaths) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, sweepBody);
  }
  console.log(`Report: ${path.relative(ROOT, reportPaths[0])}`);
} catch (e) {
  console.log(`(could not write sweep report: ${e.message})`);
}

if (failed.length) {
  console.log(`\nFAILED: ${failed.map((f) => f.name).join(", ")}`);
  process.exit(1);
}
console.log("\nREGRESSION SWEEP: PASSED");
