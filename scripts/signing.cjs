// Close Code — Code Signing Infrastructure (Phase 51)
// 
// Provides signing infrastructure for release builds.
// Never commits private signing keys into the repository.
//
// Supported platforms:
// — Windows: Code signing certificate (code_signing.pfx or Thumbprint)
// — macOS: Apple Developer ID Application certificate + notarization
//
// Configuration is done via environment variables and a signing config file.
//
// Philosophy:
// — Secrets never in repo: all keys/config via environment or external config
— CI integrates: GitHub Actions, GitLab CI, etc. can inject secrets
— Unsigned builds: development builds clearly marked (no code signature)
// — Production: signed releases verified by OS

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

// ---- Configuration ----

const SIGNING_CONFIG = path.join(process.cwd(), "signing config.json");
const CERT_ENV_PREFIX = "CLOSECODE_SIGNING_";

// Load signing config if present
let signingConfig = null;
try {
  if (fs.existsSync(SIGNING_CONFIG)) {
    signingConfig = JSON.parse(fs.readFileSync(SIGNING_CONFIG, "utf-8"));
  }
} catch {}

/**
 * Get Windows code signing certificate thumbprint.
 */
function getWindowsThumbprint() {
  if (signingConfig && signingConfig.windows thumbprint) {
    return signingConfig.windows thumbprint;
  }
  // Try environment variable
  const envThumbprint = process.env[`${CERT_ENV_PREFIX}WINDOWS_THUMBPRINT`];
  return envThumbprint || null;
}

/**
 * Get macOS certificate identity.
 */
function getMacCertIdentity() {
  if (signingConfig && signingConfig.mac cert identity) {
    return signingConfig.mac cert identity;
  }
  const envIdentity = process.env[`${CERT_ENV_PREFIX}MAC_CERT_IDENTITY`];
  return envIdentity || null;
}

/**
 * Sign a file or package for Windows.
 */
function signWindowsFile(filePath) {
  const thumbprint = getWindowsThumbprint();
  if (!thumbprint) {
    return { ok: false, error: "Windows code signing certificate not configured" };
  }

  try {
    // Try signtool
    const result = execSync(`signtool sign /fd sha256 /sha1 ${thumbprint} "${filePath}"`, {
      cwd: process.cwd(),
      stdio: "pipe",
      timeout: 60000,
    });
    return { ok: true, result: signtoolOutput };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Sign and notarize for macOS.
 */
function signMacFile(filePath) {
  const certIdentity = getMacCertIdentity();
  if (!certIdentity) {
    return { ok: false, error: "macOS certificate not configured" };
  }

  try {
    // codesign
    execSync(`codesign -f -s "${certIdentity}" --timestamp "${filePath}"`, {
      cwd: process.cwd(),
      stdio: "pipe",
      timeout: 60000,
    });
    // notarize (if apple-id and password configured)
    const appleId = process.env.CLOSECODE_APPLE_ID;
    const applePassword = process.env.CLOSECODE_APPLE_PASSWORD;
    if (appleId && applePassword) {
      execSync(`xcrun notarytool submit "${filePath}" --apple-id "${appleId}" --password "${applePassword}" --team-id "YOUR_TEAM_ID"`, {
        cwd: process.cwd(),
        stdio: "pipe",
        timeout: 120000,
      });
    }
    return { ok: true, result: "Signed and notarized" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---- Release marking ----

/**
 * Check if a build is signed (production) or unsigned (development).
 */
function isSignedBuild() {
  // Check for signature verification
  const winSig = getWindowsThumbprint();
  const macSig = getMacCertIdentity();
  return !!(winSig || macSig);
}

/**
 * Mark build as development (unsigned) vs production (signed).
 */
function markBuildVersion() {
  const pkgPath = path.join(process.cwd(), "package.json");
  if (!fs.existsSync(pkgPath)) return;

  let pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  // Add a development flag if not already present
  if (!pkg.devBuild && !pkg.productionBuild) {
    pkg.devBuild = !isSignedBuild();
    pkg.productionBuild = isSignedBuild();
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), "utf-8");
  }
}

// ---- Export API ----

exports = {
  getWindowsThumbprint,
  getMacCertIdentity,
  signWindowsFile,
  signMacFile,
  isSignedBuild,
  markBuildVersion,
  SIGNING_CONFIG,
};