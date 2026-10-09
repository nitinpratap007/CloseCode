// Close Code — AI Diff Review (Phase 34)
//
// This module provides AI-powered diff analysis and review capabilities:
// - File-level and line-level diff generation with AI summaries
// - Checkpoint creation before major changes (git commits/tags)
// - Checkpoint restoration and comparison
// - Accept/reject workflow for AI-suggested changes

import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { getGitRoot, runGit } from "./git";

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffLine {
  type: "context" | "add" | "remove";
  content: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

export interface FileDiff {
  filePath: string;
  oldPath?: string;
  newPath?: string;
  isNew: boolean;
  isDeleted: boolean;
  isRenamed: boolean;
  hunks: DiffHunk[];
  summary: string;
  aiSummary?: string;
}

export interface DiffReview {
  id: string;
  requestId: string;
  timestamp: number;
  files: FileDiff[];
  overallSummary: string;
  suggestedActions: DiffAction[];
}

export interface DiffAction {
  filePath: string;
  action: "accept" | "reject" | "modify";
  reason?: string;
}

export interface Checkpoint {
  id: string;
  name: string;
  type: "commit" | "tag" | "stash";
  hash: string;
  timestamp: number;
  message: string;
  filesChanged: string[];
  metadata?: Record<string, unknown>;
}

export interface CheckpointCompareResult {
  checkpoint: Checkpoint;
  currentHash: string;
  filesChanged: string[];
  diffSummary: string;
  canRestore: boolean;
}

function runGitSync(cwd: string, args: string[]): { stdout: string; stderr: string; status: number | null } {
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

export function parseDiff(output: string): FileDiff[] {
  if (!output.trim()) return [];
  const files: FileDiff[] = [];
  const lines = output.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.startsWith("diff --git ")) {
      i++;
      continue;
    }
    // Parse file header
    const headerMatch = line.match(/^diff --git a\/(.+?) b\/(.+?)$/);
    if (!headerMatch) {
      i++;
      continue;
    }
    const oldPath = headerMatch[1];
    const newPath = headerMatch[2];
    const isNew = oldPath === "/dev/null";
    const isDeleted = newPath === "/dev/null";
    const isRenamed = oldPath !== newPath && !isNew && !isDeleted;
    const filePath = isNew ? newPath : oldPath;
    i++;
    const hunks: DiffHunk[] = [];
    let oldMode = "";
    let newMode = "";
    // Parse extended headers
    while (i < lines.length && !lines[i].startsWith("@@")) {
      const extLine = lines[i];
      if (extLine.startsWith("old mode ")) oldMode = extLine.slice(9);
      else if (extLine.startsWith("new mode ")) newMode = extLine.slice(9);
      else if (extLine.startsWith("similarity index ")) {
        // similarity info
      }
      i++;
    }
    // Parse hunks
    while (i < lines.length && lines[i].startsWith("@@")) {
      const hunkHeader = lines[i];
      const hunkMatch = hunkHeader.match(/^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
      if (!hunkMatch) {
        i++;
        continue;
      }
      const oldStart = parseInt(hunkMatch[1], 10);
      const oldLines = hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1;
      const newStart = parseInt(hunkMatch[3], 10);
      const newLines = hunkMatch[4] ? parseInt(hunkMatch[4], 10) : 1;
      const hunkLines: DiffLine[] = [];
      let oldLineNum = oldStart;
      let newLineNum = newStart;
      i++;
      while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("diff --git")) {
        const hunkLine = lines[i];
        if (hunkLine.startsWith("+")) {
          hunkLines.push({
            type: "add",
            content: hunkLine.slice(1),
            oldLineNumber: null,
            newLineNumber: newLineNum++,
          });
        } else if (hunkLine.startsWith("-")) {
          hunkLines.push({
            type: "remove",
            content: hunkLine.slice(1),
            oldLineNumber: oldLineNum++,
            newLineNumber: null,
          });
        } else if (hunkLine.startsWith(" ")) {
          hunkLines.push({
            type: "context",
            content: hunkLine.slice(1),
            oldLineNumber: oldLineNum++,
            newLineNumber: newLineNum++,
          });
        } else if (hunkLine.startsWith("\\")) {
          // "No newline at end of file" marker
        }
        i++;
      }
      hunks.push({ oldStart, oldLines, newStart, newLines, lines: hunkLines });
    }
    const summary = `${hunks.length} hunk${hunks.length === 1 ? "" : "s"}, ` +
      `${hunks.reduce((sum, h) => sum + h.lines.filter(l => l.type === "add").length, 0)} addition${hunks.reduce((sum, h) => sum + h.lines.filter(l => l.type === "add").length, 0) === 1 ? "" : "s"}, ` +
      `${hunks.reduce((sum, h) => sum + h.lines.filter(l => l.type === "remove").length, 0)} deletion${hunks.reduce((sum, h) => sum + h.lines.filter(l => l.type === "remove").length, 0) === 1 ? "" : "s"}`;
    files.push({
      filePath,
      oldPath: isNew ? undefined : oldPath,
      newPath: isDeleted ? undefined : newPath,
      isNew,
      isDeleted,
      isRenamed,
      hunks,
      summary,
    });
  }
  return files;
}

export function generateFileLevelSummary(diff: FileDiff): string {
  if (diff.isNew) return `New file: ${diff.filePath} (${diff.summary})`;
  if (diff.isDeleted) return `Deleted file: ${diff.filePath}`;
  if (diff.isRenamed) return `Renamed: ${diff.oldPath} → ${diff.newPath} (${diff.summary})`;
  return `Modified: ${diff.filePath} (${diff.summary})`;
}

export function generateLineLevelSummary(diff: FileDiff, maxLines = 20): string {
  const lines: string[] = [];
  for (const hunk of diff.hunks) {
    if (lines.length >= maxLines) break;
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const l of hunk.lines) {
      if (lines.length >= maxLines) break;
      const prefix = l.type === "add" ? "+" : l.type === "remove" ? "-" : " ";
      const lineNum = l.type === "add" ? l.newLineNumber : l.type === "remove" ? l.oldLineNumber : `${l.oldLineNumber}/${l.newLineNumber}`;
      lines.push(`${prefix}${lineNum}: ${l.content}`);
    }
  }
  if (lines.length >= maxLines) lines.push("... (truncated)");
  return lines.join("\n");
}

export function createCheckpoint(cwd: string, name: string, type: "commit" | "tag" | "stash" = "commit", message?: string): Checkpoint | null {
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) return null;
  let hash = "";
  let actualMessage = message ?? `Checkpoint: ${name}`;
  let filesChanged: string[] = [];
  if (type === "stash") {
    const res = runGitSync(gitRoot, ["stash", "push", "-m", actualMessage, "--include-untracked"]);
    if (res.status !== 0) return null;
    // Get stash hash
    const listRes = runGitSync(gitRoot, ["stash", "list", "--format=%h %s"]);
    const latest = listRes.stdout.split("\n")[0];
    if (latest) {
      const parts = latest.split(" ");
      hash = parts[0];
    }
  } else if (type === "tag") {
    const tagName = `checkpoint/${name}/${Date.now()}`;
    const res = runGitSync(gitRoot, ["tag", "-a", tagName, "-m", actualMessage]);
    if (res.status !== 0) return null;
    const revRes = runGitSync(gitRoot, ["rev-parse", tagName]);
    hash = revRes.stdout.trim();
  } else {
    // Commit - stage all changes first
    const statusRes = runGitSync(gitRoot, ["status", "--porcelain"]);
    if (statusRes.status === 0 && statusRes.stdout.trim()) {
      filesChanged = statusRes.stdout.split("\n").map(l => l.slice(3).trim()).filter(Boolean);
      runGitSync(gitRoot, ["add", "-A"]);
      const commitRes = runGitSync(gitRoot, ["commit", "-m", actualMessage]);
      if (commitRes.status !== 0) return null;
      const hashRes = runGitSync(gitRoot, ["rev-parse", "HEAD"]);
      hash = hashRes.stdout.trim();
    } else {
      // No changes, create empty commit with --allow-empty
      const commitRes = runGitSync(gitRoot, ["commit", "--allow-empty", "-m", actualMessage]);
      if (commitRes.status !== 0) return null;
      const hashRes = runGitSync(gitRoot, ["rev-parse", "HEAD"]);
      hash = hashRes.stdout.trim();
    }
  }
  return {
    id: `chk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    type,
    hash,
    timestamp: Date.now(),
    message: actualMessage,
    filesChanged,
  };
}

export function listCheckpoints(cwd: string): Checkpoint[] {
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) return [];
  const checkpoints: Checkpoint[] = [];
  // Get tags matching checkpoint/*
  const tagRes = runGitSync(gitRoot, ["tag", "-l", "checkpoint/*", "--sort=-creatordate", "--format=%(refname:short)|%(creatordate:iso)|%(*objectname)|%(*authorname)|%(subject)"]);
  if (tagRes.status === 0 && tagRes.stdout.trim()) {
    for (const line of tagRes.stdout.split("\n")) {
      if (!line) continue;
      const [ref, date, objHash, author, subject] = line.split("|");
      if (ref && date) {
        checkpoints.push({
          id: `tag-${ref}`,
          name: ref.replace("checkpoint/", ""),
          type: "tag",
          hash: objHash?.trim() || ref,
          timestamp: new Date(date).getTime(),
          message: subject || "",
          filesChanged: [],
        });
      }
    }
  }
  // Get stashes
  const stashRes = runGitSync(gitRoot, ["stash", "list", "--format=%h|%s|%cr"]);
  if (stashRes.status === 0 && stashRes.stdout.trim()) {
    for (const line of stashRes.stdout.split("\n")) {
      if (!line) continue;
      const [hash, subject, relativeDate] = line.split("|");
      if (hash && subject) {
        checkpoints.push({
          id: `stash-${hash}`,
          name: subject.replace(/^stash @\{/, "").replace(/\}: /, ""),
          type: "stash",
          hash: hash.trim(),
          timestamp: Date.now() - (parseRelativeDate(relativeDate) || 0),
          message: subject,
          filesChanged: [],
        });
      }
    }
  }
  // Sort by timestamp descending
  return checkpoints.sort((a, b) => b.timestamp - a.timestamp);
}

function parseRelativeDate(str: string): number | null {
  // Very rough parsing of git relative dates like "2 hours ago"
  const match = str.match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = {
    second: 1000,
    minute: 60000,
    hour: 3600000,
    day: 86400000,
    week: 604800000,
    month: 2592000000,
    year: 31536000000,
  };
  return multipliers[unit] ? value * multipliers[unit] : null;
}

export function getCheckpoint(cwd: string, id: string): Checkpoint | null {
  const checkpoints = listCheckpoints(cwd);
  return checkpoints.find(c => c.id === id) || null;
}

export function restoreCheckpoint(cwd: string, checkpoint: Checkpoint, mode: "hard" | "soft" | "mixed" = "hard"): { success: boolean; error?: string } {
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) return { success: false, error: "Not a git repository" };
  if (checkpoint.type === "stash") {
    // Apply stash
    const res = runGitSync(gitRoot, ["stash", "apply", checkpoint.hash]);
    if (res.status !== 0) return { success: false, error: res.stderr || "stash apply failed" };
    return { success: true };
  } else {
    // Reset to commit/tag
    const res = runGitSync(gitRoot, ["reset", `--${mode}`, checkpoint.hash]);
    if (res.status !== 0) return { success: false, error: res.stderr || "reset failed" };
    return { success: true };
  }
}

export function compareCheckpoint(cwd: string, checkpoint: Checkpoint): CheckpointCompareResult | null {
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) return null;
  const currentRes = runGitSync(gitRoot, ["rev-parse", "HEAD"]);
  if (currentRes.status !== 0) return null;
  const currentHash = currentRes.stdout.trim();
  const diffRes = runGitSync(gitRoot, ["diff", "--name-only", checkpoint.hash, "HEAD"]);
  let filesChanged: string[] = [];
  if (diffRes.status === 0) {
    filesChanged = diffRes.stdout.split("\n").filter(Boolean);
  }
  const summaryRes = runGitSync(gitRoot, ["diff", "--stat", checkpoint.hash, "HEAD"]);
  const diffSummary = summaryRes.status === 0 ? summaryRes.stdout : "";
  return {
    checkpoint,
    currentHash,
    filesChanged,
    diffSummary,
    canRestore: filesChanged.length > 0 || currentHash !== checkpoint.hash,
  };
}

export function acceptChanges(cwd: string, files: string[]): { success: boolean; error?: string } {
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) return { success: false, error: "Not a git repository" };
  const res = runGitSync(gitRoot, ["add", "--", ...files]);
  if (res.status !== 0) return { success: false, error: res.stderr || "git add failed" };
  return { success: true };
}

export function rejectChanges(cwd: string, files: string[]): { success: boolean; error?: string } {
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) return { success: false, error: "Not a git repository" };
  // Try restore (Git 2.23+), fallback to checkout
  let res = runGitSync(gitRoot, ["restore", "--", ...files]);
  if (res.status !== 0) {
    res = runGitSync(gitRoot, ["checkout", "HEAD", "--", ...files]);
    if (res.status !== 0) return { success: false, error: res.stderr || "restore failed" };
  }
  return { success: true };
}

export function generateAISummaryPrompt(diffs: FileDiff[]): string {
  const parts = ["Analyze the following git diff and provide a concise summary of what changed:"];
  for (const diff of diffs) {
    parts.push(`\n--- ${diff.filePath} (${diff.isNew ? "new" : diff.isDeleted ? "deleted" : diff.isRenamed ? "renamed" : "modified"}) ---`);
    parts.push(generateLineLevelSummary(diff, 10));
  }
  parts.push("\nProvide: 1) A one-sentence overall summary, 2) Key changes per file, 3) Any risks or concerns.");
  return parts.join("\n");
}