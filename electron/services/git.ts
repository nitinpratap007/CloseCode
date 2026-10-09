import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

export interface GitStatusFile {
  path: string; // relative to repo root
  absPath: string;
  status: string; // e.g., "M", "A", "D", "??", "MM", "AM"
  staged: boolean;
  unstaged: boolean;
  isUntracked: boolean;
  isStaged: boolean;
  isModified: boolean;
}

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  detached: boolean;
  files: GitStatusFile[];
  staged: GitStatusFile[];
  unstaged: GitStatusFile[];
  untracked: GitStatusFile[];
  isClean: boolean;
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote?: string;
  isRemote: boolean;
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  email: string;
  date: string; // ISO
  relativeDate: string;
}

export function runGit(cwd: string, args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10000,
    windowsHide: true,
  });
  return {
    stdout: (result.stdout as string) ?? "",
    stderr: (result.stderr as string) ?? "",
    status: result.status,
  };
}

function findGitRoot(cwd: string): string | null {
  let cur = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(cur, ".git"))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

export function isGitRepository(cwd: string): boolean {
  if (!cwd || !fs.existsSync(cwd)) return false;
  const root = findGitRoot(cwd);
  if (root) return true;
  const res = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return res.status === 0 && res.stdout.trim() === "true";
}

export function getGitRoot(cwd: string): string | null {
  if (!cwd) return null;
  const direct = findGitRoot(cwd);
  if (direct) return direct;
  const res = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (res.status === 0) {
    const p = res.stdout.trim();
    if (p && fs.existsSync(p)) return path.resolve(p);
  }
  return null;
}

export function getStatus(cwd: string): GitStatus {
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) throw new Error("Not a git repository");
  // Use porcelain v1 with branch info: git status --porcelain=v1 -b -uall
  const res = runGit(gitRoot, ["status", "--porcelain=v1", "-b", "-uall"]);
  if (res.status !== 0) throw new Error(res.stderr || "git status failed");

  const lines = res.stdout.split("\n");
  let branch = "";
  let ahead = 0;
  let behind = 0;
  let detached = false;

  // First line is branch info like "## main...origin/main [ahead 1, behind 2]" or "## HEAD (no branch)"
  const branchLine = lines[0] ?? "";
  if (branchLine.startsWith("## ")) {
    const info = branchLine.slice(3);
    if (info.startsWith("HEAD")) {
      detached = true;
      branch = "HEAD (detached)";
    } else {
      // Extract branch name before "..."
      const dotDot = info.indexOf("...");
      if (dotDot !== -1) {
        branch = info.slice(0, dotDot);
      } else {
        // Check for space before [
        const spaceIdx = info.indexOf(" ");
        branch = spaceIdx !== -1 ? info.slice(0, spaceIdx) : info;
      }
      // Parse ahead/behind
      const aheadMatch = info.match(/ahead (\d+)/);
      const behindMatch = info.match(/behind (\d+)/);
      if (aheadMatch) ahead = parseInt(aheadMatch[1], 10);
      if (behindMatch) behind = parseInt(behindMatch[1], 10);
      if (!branch) branch = "HEAD";
    }
  }

  // Fallback: git branch --show-current
  if (!branch || branch === "HEAD" || detached) {
    const brRes = runGit(gitRoot, ["branch", "--show-current"]);
    if (brRes.status === 0 && brRes.stdout.trim()) {
      branch = brRes.stdout.trim();
      detached = false;
    } else if (!branch) {
      branch = "HEAD (detached)";
      detached = true;
    }
  }

  const files: GitStatusFile[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    // Porcelain v1: XY<space>path[ -> orig path for renames]
    // XY is 2 chars, then space, then path
    if (line.length < 3) continue;
    const x = line[0];
    const y = line[1];
    // const sep = line[2]; // should be space
    let filePath = line.slice(3).trim();
    // Handle renames: "R  original -> new"
    const arrowIdx = filePath.indexOf(" -> ");
    if (arrowIdx !== -1) {
      filePath = filePath.slice(arrowIdx + 4);
    }
    // Remove quotes if present
    if (filePath.startsWith('"') && filePath.endsWith('"')) {
      try { filePath = JSON.parse(filePath); } catch {}
    }
    const abs = path.join(gitRoot, filePath);
    const isUntracked = x === "?" && y === "?";
    const isStaged = x !== " " && x !== "?" && x !== "!";
    const isModified = y !== " " && y !== "?" && y !== "!";
    const staged = isStaged;
    const unstaged = isModified;
    const status = `${x}${y}`.trim() || (isUntracked ? "??" : "");

    files.push({
      path: filePath,
      absPath: abs,
      status,
      staged,
      unstaged,
      isUntracked,
      isStaged: staged,
      isModified: isModified || isUntracked,
    });
  }

  const staged = files.filter((f) => f.staged);
  const unstaged = files.filter((f) => f.unstaged || f.isUntracked);
  const untracked = files.filter((f) => f.isUntracked);

  return {
    branch,
    ahead,
    behind,
    detached,
    files,
    staged,
    unstaged,
    untracked,
    isClean: files.length === 0,
  };
}

export function stageFiles(cwd: string, files: string[]): void {
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) throw new Error("Not a git repository");
  if (files.length === 0) return;
  // Use -- to separate paths from revisions, handle spaces
  const res = runGit(gitRoot, ["add", "--", ...files]);
  if (res.status !== 0) throw new Error(res.stderr || `git add failed: ${files.join(", ")}`);
}

export function unstageFiles(cwd: string, files: string[]): void {
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) throw new Error("Not a git repository");
  if (files.length === 0) return;
  // Prefer git restore --staged (Git 2.23+), fallback to git reset
  let res = runGit(gitRoot, ["restore", "--staged", "--", ...files]);
  if (res.status !== 0) {
    // Fallback
    res = runGit(gitRoot, ["reset", "HEAD", "--", ...files]);
    if (res.status !== 0) throw new Error(res.stderr || `git unstage failed`);
  }
}

export function stageAll(cwd: string): void {
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) throw new Error("Not a git repository");
  const res = runGit(gitRoot, ["add", "-A"]);
  if (res.status !== 0) throw new Error(res.stderr || "git add -A failed");
}

export function commit(cwd: string, message: string): string {
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) throw new Error("Not a git repository");
  if (!message.trim()) throw new Error("Commit message is empty");
  const res = runGit(gitRoot, ["commit", "-m", message]);
  if (res.status !== 0) throw new Error(res.stderr || "git commit failed");
  // Return commit hash
  const logRes = runGit(gitRoot, ["rev-parse", "HEAD"]);
  return logRes.stdout.trim();
}

export function getBranches(cwd: string): GitBranch[] {
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) throw new Error("Not a git repository");
  const res = runGit(gitRoot, ["branch", "-a", "--format=%(refname:short)|%(HEAD)|%(upstream:short)"]);
  // Fallback if format not supported, use simple `git branch -a`
  let lines: string[] = [];
  if (res.status === 0 && res.stdout.trim()) {
    lines = res.stdout.split("\n").filter(Boolean);
  } else {
    const fallback = runGit(gitRoot, ["branch", "-a"]);
    if (fallback.status !== 0) throw new Error(fallback.stderr || "git branch failed");
    lines = fallback.stdout.split("\n").filter(Boolean);
    // Parse fallback: "* main" or "  remotes/origin/main"
    return lines.map((line) => {
      const trimmed = line.trim();
      const current = trimmed.startsWith("*");
      const nameRaw = current ? trimmed.slice(1).trim() : trimmed;
      const isRemote = nameRaw.startsWith("remotes/");
      const name = isRemote ? nameRaw.replace(/^remotes\//, "") : nameRaw;
      return { name, current, isRemote, remote: isRemote ? name : undefined };
    });
  }

  const branches: GitBranch[] = [];
  for (const line of lines) {
    const parts = line.split("|");
    const nameRaw = (parts[0] ?? "").trim();
    const headMarker = (parts[1] ?? "").trim(); // "*" if current
    const upstream = (parts[2] ?? "").trim();
    const current = headMarker === "*";
    const isRemote = nameRaw.includes("/") && (nameRaw.startsWith("origin/") || nameRaw.includes("/"));
    // For local, name is like "main", for remote "origin/main"
    const name = nameRaw;
    branches.push({ name, current, isRemote, remote: upstream || undefined });
  }
  return branches;
}

export function createBranch(cwd: string, name: string): void {
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) throw new Error("Not a git repository");
  if (!name.trim() || /[^a-zA-Z0-9._\-\/]/.test(name) && false) {
    // Allow most chars, git will error if invalid
  }
  const res = runGit(gitRoot, ["checkout", "-b", name]);
  if (res.status !== 0) throw new Error(res.stderr || `Failed to create branch ${name}`);
}

export function switchBranch(cwd: string, name: string): void {
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) throw new Error("Not a git repository");
  // Try git switch first (Git 2.23+), fallback to checkout
  let res = runGit(gitRoot, ["switch", name]);
  if (res.status !== 0) {
    res = runGit(gitRoot, ["checkout", name]);
    if (res.status !== 0) throw new Error(res.stderr || `Failed to switch to ${name}`);
  }
}

export function pull(cwd: string): string {
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) throw new Error("Not a git repository");
  const res = runGit(gitRoot, ["pull"]);
  if (res.status !== 0) throw new Error(res.stderr || "git pull failed");
  return res.stdout;
}

export function push(cwd: string, setUpstream = false): string {
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) throw new Error("Not a git repository");
  const args = setUpstream ? ["push", "-u", "origin", "HEAD"] : ["push"];
  const res = runGit(gitRoot, args);
  if (res.status !== 0) throw new Error(res.stderr || "git push failed");
  return res.stdout;
}

export function fetch(cwd: string): string {
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) throw new Error("Not a git repository");
  const res = runGit(gitRoot, ["fetch"]);
  if (res.status !== 0) throw new Error(res.stderr || "git fetch failed");
  return res.stdout;
}

export function getDiff(cwd: string, filePath?: string, staged = false): string {
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) throw new Error("Not a git repository");
  const args: string[] = ["diff"];
  if (staged) args.push("--staged");
  if (filePath) {
    const rel = path.relative(gitRoot, path.resolve(filePath));
    args.push("--", rel);
  }
  const res = runGit(gitRoot, args);
  if (res.status !== 0) throw new Error(res.stderr || "git diff failed");
  return res.stdout;
}

export function getFileHistory(cwd: string, filePath: string, limit = 50): GitLogEntry[] {
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) throw new Error("Not a git repository");
  const rel = path.relative(gitRoot, path.resolve(filePath));
  const res = runGit(gitRoot, [
    "log",
    `--max-count=${limit}`,
    "--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%aI%x1f%ar",
    "--follow",
    "--",
    rel,
  ]);
  if (res.status !== 0) {
    // No history or file not tracked
    if (res.stderr.includes("unknown revision") || res.stderr.includes("does not have any commits")) return [];
    throw new Error(res.stderr || "git log failed");
  }
  return parseLog(res.stdout);
}

export function getLog(cwd: string, limit = 50): GitLogEntry[] {
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) throw new Error("Not a git repository");
  const res = runGit(gitRoot, [
    "log",
    `--max-count=${limit}`,
    "--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%aI%x1f%ar",
  ]);
  if (res.status !== 0) throw new Error(res.stderr || "git log failed");
  return parseLog(res.stdout);
}

function parseLog(output: string): GitLogEntry[] {
  if (!output.trim()) return [];
  const lines = output.split("\n").filter(Boolean);
  const entries: GitLogEntry[] = [];
  for (const line of lines) {
    const parts = line.split("\x1f");
    if (parts.length < 7) continue;
    const [hash, shortHash, message, author, email, date, relativeDate] = parts;
    entries.push({ hash, shortHash, message, author, email, date, relativeDate });
  }
  return entries;
}

export function checkGitInstalled(): boolean {
  const res = spawnSync("git", ["--version"], { stdio: "ignore", timeout: 2000, windowsHide: true });
  return res.status === 0;
}

export interface RemoteInfo {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export function getRemotes(cwd: string): RemoteInfo[] {
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) throw new Error("Not a git repository");
  const res = runGit(gitRoot, ["remote", "-v"]);
  if (res.status !== 0) throw new Error(res.stderr || "git remote failed");
  const remotes: RemoteInfo[] = [];
  const lines = res.stdout.split("\n").filter(Boolean);
  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length >= 3) {
      const name = parts[0];
      const url = parts[1];
      const type = parts[2].replace(/[()]/g, "");
      let existing = remotes.find((r) => r.name === name);
      if (!existing) {
        existing = { name, fetchUrl: "", pushUrl: "" };
        remotes.push(existing);
      }
      if (type === "fetch") existing.fetchUrl = url;
      else if (type === "push") existing.pushUrl = url;
    }
  }
  return remotes;
}

export function getRemoteBranches(cwd: string): string[] {
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) throw new Error("Not a git repository");
  const res = runGit(gitRoot, ["branch", "-r", "--format=%(refname:short)"]);
  if (res.status !== 0) throw new Error(res.stderr || "git branch -r failed");
  return res.stdout.split("\n").filter(Boolean);
}

export function getMergeBase(cwd: string, branch1: string, branch2: string): string {
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) throw new Error("Not a git repository");
  const res = runGit(gitRoot, ["merge-base", branch1, branch2]);
  if (res.status !== 0) throw new Error(res.stderr || "git merge-base failed");
  return res.stdout.trim();
}

export function getConflictFiles(cwd: string): string[] {
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) throw new Error("Not a git repository");
  const res = runGit(gitRoot, ["diff", "--name-only", "--diff-filter=U"]);
  if (res.status !== 0) throw new Error(res.stderr || "git diff --diff-filter=U failed");
  return res.stdout.split("\n").filter(Boolean);
}

export function getConflictContent(cwd: string, filePath: string): string {
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) throw new Error("Not a git repository");
  const rel = path.relative(gitRoot, path.resolve(filePath));
  const res = runGit(gitRoot, ["diff", "--", rel]);
  if (res.status !== 0) throw new Error(res.stderr || "git diff failed");
  return res.stdout;
}

export function getBranchTrackingInfo(cwd: string): {
  current: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  branches: Array<{ name: string; upstream: string | null; ahead: number; behind: number }>;
} {
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) throw new Error("Not a git repository");
  const res = runGit(gitRoot, ["for-each-ref", "--format=%(refname:short)|%(upstream:short)|%(objectname)", "refs/heads"]);
  if (res.status !== 0) throw new Error(res.stderr || "git for-each-ref failed");
  const branches: Array<{ name: string; upstream: string | null; ahead: number; behind: number }> = [];
  let current: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const lines = res.stdout.split("\n").filter(Boolean);
  for (const line of lines) {
    const parts = line.split("|");
    if (parts.length < 2) continue;
    const name = parts[0];
    const up = parts[1] || null;
    if (up) {
      const aheadRes = runGit(gitRoot, ["rev-list", "--count", `${up}..${name}`]);
      const behindRes = runGit(gitRoot, ["rev-list", "--count", `${name}..${up}`]);
      const a = aheadRes.status === 0 ? parseInt(aheadRes.stdout.trim(), 10) : 0;
      const b = behindRes.status === 0 ? parseInt(behindRes.stdout.trim(), 10) : 0;
      branches.push({ name, upstream: up, ahead: a, behind: b });
      // Check if this is current branch
      const curRes = runGit(gitRoot, ["branch", "--show-current"]);
      if (curRes.status === 0 && curRes.stdout.trim() === name) {
        current = name;
        upstream = up;
        ahead = a;
        behind = b;
      }
    } else {
      branches.push({ name, upstream: null, ahead: 0, behind: 0 });
    }
  }
  return { current, upstream, ahead, behind, branches };
}

export function getCommitDetails(cwd: string, hash: string): {
  hash: string;
  author: string;
  email: string;
  date: string;
  message: string;
  files: Array<{ path: string; status: string }>;
  stats: { insertions: number; deletions: number };
} | null {
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) throw new Error("Not a git repository");
  const res = runGit(gitRoot, [
    "show",
    "--pretty=format:%H%x1f%an%x1f%ae%x1f%aI%x1f%s",
    "--numstat",
    "--no-merges",
    hash,
  ]);
  if (res.status !== 0) return null;
  const lines = res.stdout.split("\n");
  if (!lines.length) return null;
  const header = lines[0].split("\x1f");
  if (header.length < 5) return null;
  const [hashOut, author, email, date, message] = header;
  const files: Array<{ path: string; status: string }> = [];
  let insertions = 0;
  let deletions = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length >= 3) {
      const ins = parts[0] === "-" ? 0 : parseInt(parts[0], 10);
      const del = parts[1] === "-" ? 0 : parseInt(parts[1], 10);
      insertions += ins;
      deletions += del;
      files.push({ path: parts[2], status: ins > 0 || del > 0 ? "modified" : "unchanged" });
    }
  }
  return { hash: hashOut, author, email, date, message, files, stats: { insertions, deletions } };
}

export function getRepositoryStats(cwd: string): {
  totalCommits: number;
  totalBranches: number;
  totalRemotes: number;
  totalTags: number;
  firstCommitDate: string | null;
  lastCommitDate: string | null;
  contributors: number;
} {
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) throw new Error("Not a git repository");
  const commitCount = runGit(gitRoot, ["rev-list", "--count", "--all"]);
  const branchCount = runGit(gitRoot, ["branch", "-a"]);
  const remoteCount = runGit(gitRoot, ["remote"]);
  const tagCount = runGit(gitRoot, ["tag"]);
  const firstCommit = runGit(gitRoot, ["log", "--reverse", "--pretty=format:%aI", "--max-count=1"]);
  const lastCommit = runGit(gitRoot, ["log", "--pretty=format:%aI", "--max-count=1"]);
  const contributors = runGit(gitRoot, ["shortlog", "-sn", "--all"]);
  let totalCommits = 0;
  let totalBranches = 0;
  let totalRemotes = 0;
  let totalTags = 0;
  let firstCommitDate: string | null = null;
  let lastCommitDate: string | null = null;
  let contributorsCount = 0;
  if (commitCount.status === 0) totalCommits = parseInt(commitCount.stdout.trim(), 10);
  if (branchCount.status === 0) totalBranches = branchCount.stdout.split("\n").filter(Boolean).length;
  if (remoteCount.status === 0) totalRemotes = remoteCount.stdout.split("\n").filter(Boolean).length;
  if (tagCount.status === 0) totalTags = tagCount.stdout.split("\n").filter(Boolean).length;
  if (firstCommit.status === 0 && firstCommit.stdout.trim()) firstCommitDate = firstCommit.stdout.trim();
  if (lastCommit.status === 0 && lastCommit.stdout.trim()) lastCommitDate = lastCommit.stdout.trim();
  if (contributors.status === 0) {
    const lines = contributors.stdout.split("\n").filter(Boolean);
    contributorsCount = lines.length;
  }
  return { totalCommits, totalBranches, totalRemotes, totalTags, firstCommitDate, lastCommitDate, contributors: contributorsCount };
}

export function generateCommitMessageFromDiff(diff: string): string {
  // Analyze the diff and generate a conventional commit message
  const files = [...diff.matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1]);
  const additions = (diff.match(/^\+/gm) || []).length;
  const deletions = (diff.match(/^\-/gm) || []).length;
  const isNewFile = diff.includes("new file mode");
  const isDeleted = diff.includes("deleted file mode");
  const isRename = diff.includes("rename from") && diff.includes("rename to");
  
  let type = "chore";
  let scope = "";
  
  // Determine type based on changes
  if (files.some(f => f.includes("test") || f.includes("spec"))) type = "test";
  else if (files.some(f => f.match(/\.(md|txt|rst)$/))) type = "docs";
  else if (files.some(f => f.includes("config") || f.includes(".json") || f.includes(".yaml"))) type = "config";
  else if (files.some(f => f.match(/\.(css|scss|less)$/))) type = "style";
  else if (files.some(f => f.includes("refactor"))) type = "refactor";
  else if (isNewFile && !isDeleted) type = "feat";
  else if (isDeleted) type = "remove";
  else if (isRename) type = "move";
  else if (additions > deletions * 3) type = "feat";
  else if (deletions > additions * 3) type = "remove";
  else type = "fix";
  
  // Try to extract scope from first file path
  if (files.length > 0) {
    const parts = files[0].split("/");
    if (parts.length > 1) scope = parts[0];
  }
  
  const scopeStr = scope ? `(${scope})` : "";
  const fileList = files.slice(0, 3).join(", ") + (files.length > 3 ? "..." : "");
  return `${type}${scopeStr}: ${fileList} (${additions} add, ${deletions} del)`;
}
