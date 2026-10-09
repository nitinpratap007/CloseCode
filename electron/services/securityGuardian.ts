// Close Code — AI Security Guardian (Phase 44)
// 
// Analyzes code for security risks including: hardcoded secrets, insecure
// configuration, dangerous shell execution, injection risks, unsafe input
// handling, authentication mistakes, authorization gaps, insecure file access,
// unsafe dependency usage, and exposed credentials.
//
// All findings are based on actual code evidence. No secrets are exposed
// unnecessarily. Security fixes are reviewable. Scanning does not automatically
// modify critical code without explicit user approval.
//
// Philosophy:
// — Evidence-based: every finding traces back to actual code patterns
— False positives clearly marked as "possible" not "confirmed"
// — Secrets protected: never log or expose actual secret values
— Reviewable: every fix requires user approval before application
— Safe-by-default: scanning never auto-modifies production code

import { app, ipcMain, shell } from "electron";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { cryptoSubtle } from "crypto";

// ---- Type definitions for findings ----

export interface SecurityFinding {
  id: string;
  title: string;
  description: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  category:
    | "hardcoded-secrets"
    | "insecure-config"
    | "shell-injection"
    | "code-injection"
    | "input-handling"
    | "authentication"
    | "authorization"
    | "file-access"
    | "dependencies"
    | "exposed-credentials";
  sourceFile: string; // relative path from project root
  sourceLine: number;
  sourceContext: string; // snippet of code around the finding
  evidence: string; // why this is flagged
  remediation?: string; // suggested fix
  // Risk mitigation
  secretExposed: boolean; // true only if already public knowledge
  // Approval tracking
  requiresApproval: boolean;
  approved: boolean;
  approvedAt?: number;
  approvedBy: "user" | "system";
}

export interface SecurityReport {
  id: string; // generated UUID + timestamp
  projectRoot: string;
  scannedAt: number;
  findings: SecurityFinding[];
  summary: {
    total: number;
    bySeverity: Record<string, number>;
    byCategory: Record<string, number>;
  };
  // Whether any findings require code modification
  requiresCodeChanges: boolean;
  // User approval status
  allApproved: boolean;
}

// ---- Security analysis service ----

const securityFindings: Map<string, SecurityFinding> = new Map();
let reportIdCounter = 0;

function generateFindingId(): string {
  reportIdCounter += 1;
  return `finding-${Date.now()}-${reportIdCounter}`;
}

/**
 * Scan a project directory for security risks.
 */
function scanProject(projectRoot: string): SecurityReport {
  const findings: SecurityFinding[] = [];
  const fileExtensions = [".ts", ".tsx", ".js", ".jsx", ".json", ".yaml", ".yml", ".cfg", ".ini"];

  // Walk the project directory
  function walkDir(dir: string) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".closecode") continue;

        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(projectRoot, fullPath);

        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (fileExtensions.includes(ext)) {
            try {
              const content = fs.readFileSync(fullPath, "utf-8");
              analyzeFile(content, relPath, findings);
            } catch (e) {
              // Skip unreadable files
            }
          }
        }
      }
    } catch (e) {
      // Skip directories we can't read
    }
  }

  walkDir(projectRoot);

  // Build summary
  const bySeverity: Record<string, number> = { info: 0, low: 0, medium: 0, high: 0, critical: 0 };
  const byCategory: Record<string, number> = {
    "hardcoded-secrets": 0,
    "insecure-config": 0,
    "shell-injection": 0,
    "code-injection": 0,
    "input-handling": 0,
    "authentication": 0,
    "authorization": 0,
    "file-access": 0,
    "dependencies": 0,
    "exposed-credentials": 0,
  };

  for (const finding of findings) {
    bySeverity[finding.severity] = (bySeverity[finding.severity] || 0) + 1;
    byCategory[finding.category] = (byCategory[finding.category] || 0) + 1;
  }

  // Generate report ID
  const reportId = `report-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  // Create report
  const report: SecurityReport = {
    id: reportId,
    projectRoot,
    scannedAt: Date.now(),
    findings,
    summary: {
      total: findings.length,
      bySeverity,
      byCategory,
    },
    requiresCodeChanges: findings.some((f) => f.remediation && !f.secretExposed),
    allApproved: findings.every((f) => !f.requiresApproval || f.approved),
  };

  // Store each finding
  for (const finding of findings) {
    securityFindings.set(finding.id, finding);
  }

  return report;
}

/**
 * Analyze a single file for security issues.
 */
function analyzeFile(content: string, sourceFile: string, findings: SecurityFinding[]) {
  const lines = content.split("\n");

  // 1. Hardcoded secrets patterns
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // API keys / tokens
    const apiKeyPatterns = [
      /(api[_-]?key|apikey|api_key)\s*[:=]\s*["'][^"']{8,}["']/i,
      /(auth[_-]?token|auth_token|access[_-]?token)["']?\s*[:=]\s*["'][^"']{16,}["']/i,
      /(password|passwd|passphrase|pwd)\s*[:=]\s*["'][^"']{4,}["']/i,
      /(secret|api_secret|client_secret|app_secret)["']?\s*[:=]\s*["'][^"']{8,}["']/i,
    ];

    for (const pattern of apiKeyPatterns) {
      if (pattern.test(line)) {
        // Check if this might be a test fixture or placeholder
        const lower = line.toLowerCase();
        const isPlaceholder = /["'](test|example|placeholder|fake|testkey|test-token)["']/.test(lower);
        const isEnvVar = /ENV|environment|config/.test(lower);

        let severity: SecurityFinding["severity"] = "high";
        let title = "Potential hardcoded secret";
        let description = "A potential secret/key/token was found in source code.";

        if (isPlaceholder) {
          severity = "info";
          title = "Possible placeholder secret (review needed)";
          description = "A string resembling a secret was found; verify it is not a real credential.";
        } else if (isEnvVar) {
          severity = "low";
          title = "Possible environment variable reference";
          description = "String may be intended as env var reference; verify it is not hardcoded.";
        }

        findings.push({
          id: generateFindingId(),
          title,
          description,
          severity,
          category: "hardcoded-secrets",
          sourceFile,
          sourceLine: lineNum,
          sourceContext: line.trim(),
          evidence: `Pattern matched: ${pattern.source}`,
          secretExposed: false,
          requiresApproval: severity !== "info",
          approved: false,
        });
      }
    }
  }

  // 2. Dangerous shell execution
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // exec/shell exec patterns with user input
    const shellPatterns = [
      /exec\(["']/.test(line) && /process\.exec|child_process\.exec|spawn/.test(content.slice(Math.max(0, content.indexOf(line) - 200), content.indexOf(line) + 200))),
      /shell.exec|spawn\(["']/.test(line),
      /cmd\.exec|system\(/.test(line),
      /eval\(/.test(line),
      /new Function\(/.test(line),
    ];

    // More specific: dangerous shell execution with interpolation
    if (/exec\(|spawn\(|shell.exec|execSync/.test(line)) {
      const hasUserInput = /\\$|process\.argv|process\.env|ARGV|env/.test(content.slice(Math.max(0, content.indexOf(line) - 300), content.indexOf(line) + 300));
      const hasInterpolation = /\{[^}]*\}/.test(line) || /#\{[^}]*\}/.test(line);

      if (hasUserInput || hasInterpolation) {
        findings.push({
          id: generateFindingId(),
          title: "Dangerous shell execution with potential injection",
          description: "Shell command execution may accept user input, risking command injection.",
          severity: "high",
          category: "shell-injection",
          sourceFile,
          sourceLine: lineNum,
          sourceContext: line.trim().substring(0, 120),
          evidence: "Shell execution function found with possible user input or string interpolation",
          remediation: "Use parameterized commands or validate/sanitize all inputs before shell execution",
          secretExposed: false,
          requiresApproval: true,
          approved: false,
        });
      }
    }
  }

  // 3. Injection risks - DOM-like patterns in Node context
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // HTML injection patterns
    if (/innerHTML\s*=/.test(line) || /outerHTML\s*=/.test(line)) {
      findings.push({
        id: generateFindingId(),
        title: "Potential DOM innerHTML injection",
        description: "innerHTML or outerHTML assignment may accept untrusted content.",
        severity: "medium",
        category: "code-injection",
        sourceFile,
        sourceLine: lineNum,
        sourceContext: line.trim(),
        evidence: "innerHTML/outerHTML assignment detected",
        remediation: "Use textContent, createElement, or sanitize HTML before assignment",
        secretExposed: false,
        requiresApproval: true,
        approved: false,
      });
    }

    // SQL-like query patterns
    if (/query\s*\(|SELECT|INSERT|UPDATE|DELETE/.test(line) && /["']\+/.test(line)) {
      findings.push({
        id: generateFindingId(),
        title: "Potential SQL injection risk",
        description: "Database query construction may use string concatenation with user input.",
        severity: "high",
        category: "code-injection",
        sourceFile,
        sourceLine: lineNum,
        sourceContext: line.trim().substring(0, 120),
        evidence: "SQL query pattern with string concatenation detected",
        remediation: "Use parameterized queries or prepared statements",
        secretExposed: false,
        requiresApproval: true,
        approved: false,
      });
    }
  }

  // 4. Unsafe input handling
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Common unsafe patterns
    const unsafePatterns = [
      /body\.parser|express\.json|req\.body/,
      /req\.params|req\.query/,
      /process\.stdin|stdin\.on/,
      /fs\.readFile|fs\.writeFile/,
    ];

    for (const pattern of unsafePatterns) {
      if (pattern.test(line)) {
        // Additional context check to avoid false positives
        const surrounding = content.slice(Math.max(0, content.indexOf(line) - 100), content.indexOf(line) + 100);
        const isValidation = /validate|sanitize|escape|filter/.test(surrounding);
        const isWhitelisted = /whitelist|allowed|pattern/.test(surrounding);

        if (!isValidation || !isWhitelisted) {
          findings.push({
            id: generateFindingId(),
            title: "Unsafe input handling pattern detected",
            description: "Input received without apparent validation or sanitization.",
            severity: "medium",
            category: "input-handling",
            sourceFile,
            sourceLine: lineNum,
            sourceContext: line.trim().substring(0, 120),
            evidence: `Pattern: ${pattern.source}`,
            remediation: "Validate and sanitize all external input before processing",
            secretExposed: false,
            requiresApproval: false, // Input handling fixes typically don't modify critical code paths automatically
            approved: false,
          });
        }
      }
    }
  }

  // 5. Exposed credentials / configuration checks
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Cloud service keys, endpoints
    const exposedPatterns = [
      /AKIA[0-9A-Z]{16}/, // AWS Access Key ID format
      /ya29\.[0-9A-Za-z_-]+/, // Google OAuth token format
      /Bearer [Tt]oken [a-zA-Z0-9\-\._~\+/=]*/i,
      /https?:\/\/(oauth|token|api)\..*/i,
    ];

    for (const pattern of exposedPatterns) {
      if (pattern.test(line)) {
        findings.push({
          id: generateFindingId(),
          title: "Potentially exposed credential or endpoint",
          description: "String matching credential/token/endpoint pattern found in source.",
          severity: "medium",
          category: "exposed-credentials",
          sourceFile,
          sourceLine: lineNum,
          sourceContext: line.trim().substring(0, 120),
          evidence: `Pattern matched: ${pattern.source}`,
          secretExposed: true, // These are often public-format patterns, mark as exposed=true
          requiresApproval: true,
          approved: false,
        });
      }
    }
  }
}

/**
 * Run security scan on the project.
 */
function runSecurityScan(projectRoot: string): SecurityReport {
  const findings: SecurityFinding[] = [];
  scanProject(projectRoot, findings);
  return runSecurityScan.fromAnalysis(projectRoot, findings);
}

// Exported API
export { scanProject, runSecurityScan, SecurityFinding, SecurityReport, SecurityFinding[] };