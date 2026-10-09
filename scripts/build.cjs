// Close Code — Phase 20 build wrapper.
//
// Why this exists: electron-builder's Windows target invokes `signtool.exe`
// even when no signing certificate is configured. On machines without a
// code-signing certificate that call can hang for minutes (it tries to reach
// a timestamp server). This wrapper turns auto-discovery off so unsigned
// builds complete deterministically, and works the same on win/linux/mac.
//
// Usage:
//   node scripts/build.cjs dev        → --dir   (unpacked development build)
//   node scripts/build.cjs prod       → full default target set for host OS
//   node scripts/build.cjs installer  → --win.nsis (Windows installer)
//   node scripts/build.cjs portable   → --win.zip   (Windows portable zip)
//   node scripts/build.cjs all        → --win --mac --linux
//   node scripts/build.cjs mac        → --mac
//   node scripts/build.cjs linux      → --linux
//
// Set CSC_LINK / CSC_KEY_PASSWORD to sign real release builds, or pass
// `--sign` to re-enable auto-discovery.

const { spawnSync } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CONFIG = "electron-builder.yml";

const TARGETS = {
  dev: ["--dir"],
  prod: [],
  installer: ["--win", "nsis"],
  portable: ["--win", "zip"],
  all: ["--win", "--mac", "--linux"],
  win: ["--win"],
  mac: ["--mac"],
  linux: ["--linux"],
};

const argv = process.argv.slice(2);
const mode = argv.find((a) => !a.startsWith("-")) || "prod";
const extra = argv.filter((a) => a.startsWith("-"));
const wantSign = argv.includes("--sign");

if (!TARGETS[mode]) {
  console.error(`Unknown build mode: ${mode}`);
  console.error(`Valid modes: ${Object.keys(TARGETS).join(", ")}`);
  process.exit(2);
}

const env = { ...process.env };

if (!wantSign) {
  // Skip signtool.exe auto-discovery (the hang we hit without a certificate).
  env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  env.CSC_LINK = env.CSC_LINK || "";
}

const electronBuilder = path.join(
  ROOT,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron-builder.cmd" : "electron-builder"
);

const args = ["--config", CONFIG, ...TARGETS[mode], ...extra];
console.log(`[build] mode=${mode} signing=${wantSign ? "auto" : "disabled"}`);
console.log(`[build] ${electronBuilder} ${args.join(" ")}`);

const res = spawnSync(electronBuilder, args, {
  cwd: ROOT,
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (res.error) {
  console.error("[build] failed to launch electron-builder:", res.error.message);
  process.exit(1);
}
process.exit(res.status === null ? 1 : res.status);
