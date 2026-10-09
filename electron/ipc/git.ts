import { ipcMain } from "electron";
import * as git from "../services/git";
import {
  parseDiff,
  createCheckpoint,
  listCheckpoints,
  getCheckpoint,
  restoreCheckpoint,
  compareCheckpoint,
  acceptChanges,
  rejectChanges,
  generateFileLevelSummary,
  generateLineLevelSummary,
} from "../services/aiDiff";

export function registerGitIpc(): void {
  ipcMain.handle("git:isRepo", (_e, cwd: string) => {
    try {
      return { ok: true, result: git.isGitRepository(cwd) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("git:status", (_e, cwd: string) => {
    try {
      const status = git.getStatus(cwd);
      return { ok: true, result: status };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("git:stage", (_e, cwd: string, files: string[]) => {
    try {
      git.stageFiles(cwd, files);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("git:unstage", (_e, cwd: string, files: string[]) => {
    try {
      git.unstageFiles(cwd, files);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("git:stageAll", (_e, cwd: string) => {
    try {
      git.stageAll(cwd);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("git:commit", (_e, cwd: string, message: string) => {
    try {
      const hash = git.commit(cwd, message);
      return { ok: true, result: { hash } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("git:branches", (_e, cwd: string) => {
    try {
      const branches = git.getBranches(cwd);
      return { ok: true, result: branches };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("git:createBranch", (_e, cwd: string, name: string) => {
    try {
      git.createBranch(cwd, name);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("git:switchBranch", (_e, cwd: string, name: string) => {
    try {
      git.switchBranch(cwd, name);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("git:pull", (_e, cwd: string) => {
    try {
      const out = git.pull(cwd);
      return { ok: true, result: out };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("git:push", (_e, cwd: string, setUpstream?: boolean) => {
    try {
      const out = git.push(cwd, !!setUpstream);
      return { ok: true, result: out };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("git:fetch", (_e, cwd: string) => {
    try {
      const out = git.fetch(cwd);
      return { ok: true, result: out };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("git:diff", (_e, cwd: string, filePath?: string, staged?: boolean) => {
    try {
      const diff = git.getDiff(cwd, filePath, !!staged);
      return { ok: true, result: diff };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("git:fileHistory", (_e, cwd: string, filePath: string, limit?: number) => {
    try {
      const history = git.getFileHistory(cwd, filePath, limit ?? 50);
      return { ok: true, result: history };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("git:log", (_e, cwd: string, limit?: number) => {
    try {
      const log = git.getLog(cwd, limit ?? 50);
      return { ok: true, result: log };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("git:checkInstalled", () => {
    try {
      return { ok: true, result: git.checkGitInstalled() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // --- Phase 34: AI Diff Review + Checkpoints ---

  ipcMain.handle("git:diffParsed", (_e, cwd: string, filePath?: string, staged?: boolean) => {
    try {
      const diff = git.getDiff(cwd, filePath, !!staged);
      const parsed = parseDiff(diff);
      return { ok: true, result: parsed.map(f => ({ ...f, aiSummary: generateFileLevelSummary(f), lineSummary: generateLineLevelSummary(f) })) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("git:diffSummary", (_e, cwd: string, filePath?: string, staged?: boolean) => {
    try {
      const diff = git.getDiff(cwd, filePath, !!staged);
      const parsed = parseDiff(diff);
      return { ok: true, result: parsed.map(generateFileLevelSummary).join("\n") };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("git:checkpointCreate", (_e, cwd: string, name: string, type?: "commit" | "tag" | "stash", message?: string) => {
    try {
      const cp = createCheckpoint(cwd, name, type ?? "commit", message);
      return { ok: true, result: cp };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("git:checkpointList", (_e, cwd: string) => {
    try {
      const list = listCheckpoints(cwd);
      return { ok: true, result: list };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("git:checkpointGet", (_e, cwd: string, id: string) => {
    try {
      const cp = getCheckpoint(cwd, id);
      return { ok: true, result: cp };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("git:checkpointRestore", (_e, cwd: string, id: string, mode?: "hard" | "soft" | "mixed") => {
    try {
      const cp = getCheckpoint(cwd, id);
      if (!cp) return { ok: false, error: "Checkpoint not found" };
      const result = restoreCheckpoint(cwd, cp, mode ?? "hard");
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("git:checkpointCompare", (_e, cwd: string, id: string) => {
    try {
      const cp = getCheckpoint(cwd, id);
      if (!cp) return { ok: false, error: "Checkpoint not found" };
      const result = compareCheckpoint(cwd, cp);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("git:acceptChanges", (_e, cwd: string, files: string[]) => {
    try {
      const result = acceptChanges(cwd, files);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("git:rejectChanges", (_e, cwd: string, files: string[]) => {
    try {
      const result = rejectChanges(cwd, files);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
