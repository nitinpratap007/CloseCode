import { create } from "zustand";
import type { GitStatus, GitBranch, GitLogEntry } from "../types/electron";

interface GitState {
  cwd: string | null;
  isRepo: boolean | null;
  gitInstalled: boolean | null;
  status: GitStatus | null;
  branches: GitBranch[];
  diff: string | null;
  diffFile: string | null;
  fileHistory: GitLogEntry[];
  log: GitLogEntry[];
  isLoading: boolean;
  error: string | null;
  commitMessage: string;
  setCwd: (cwd: string | null) => void;
  setCommitMessage: (msg: string) => void;
  checkGitInstalled: () => Promise<void>;
  checkIsRepo: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  refreshBranches: () => Promise<void>;
  stage: (files: string[]) => Promise<void>;
  unstage: (files: string[]) => Promise<void>;
  stageAll: () => Promise<void>;
  commit: () => Promise<string | null>;
  createBranch: (name: string) => Promise<void>;
  switchBranch: (name: string) => Promise<void>;
  pull: () => Promise<string | null>;
  push: (setUpstream?: boolean) => Promise<string | null>;
  fetch: () => Promise<string | null>;
  getDiff: (filePath?: string, staged?: boolean) => Promise<void>;
  getFileHistory: (filePath: string) => Promise<void>;
  getLog: () => Promise<void>;
  clearError: () => void;
}

export const useGitStore = create<GitState>((set, get) => ({
  cwd: null,
  isRepo: null,
  gitInstalled: null,
  status: null,
  branches: [],
  diff: null,
  diffFile: null,
  fileHistory: [],
  log: [],
  isLoading: false,
  error: null,
  commitMessage: "",

  setCwd: (cwd) => set({ cwd }),
  setCommitMessage: (msg) => set({ commitMessage: msg }),
  clearError: () => set({ error: null }),

  checkGitInstalled: async () => {
    try {
      const res = await window.closeCode.gitCheckInstalled();
      if (res.ok) set({ gitInstalled: !!res.result });
      else set({ gitInstalled: false, error: res.error ?? "git check failed" });
    } catch (e) { set({ gitInstalled: false, error: String(e) }); }
  },

  checkIsRepo: async () => {
    const { cwd } = get();
    if (!cwd) { set({ isRepo: false }); return; }
    try {
      const res = await window.closeCode.gitIsRepo(cwd);
      if (res.ok) set({ isRepo: !!res.result, error: null });
      else set({ isRepo: false, error: res.error ?? null });
    } catch (e) { set({ isRepo: false, error: String(e) }); }
  },

  refreshStatus: async () => {
    const { cwd } = get();
    if (!cwd) return;
    set({ isLoading: true, error: null });
    try {
      const res = await window.closeCode.gitStatus(cwd);
      if (res.ok && res.result) {
        set({ status: res.result, isRepo: true, isLoading: false, error: null });
      } else {
        const msg = res.error ?? "Not a git repository";
        const isNotRepo = msg.toLowerCase().includes("not a git repository");
        set({ status: null, isRepo: isNotRepo ? false : get().isRepo, isLoading: false, error: isNotRepo ? null : msg });
      }
    } catch (e) { set({ isLoading: false, error: String(e) }); }
  },

  refreshBranches: async () => {
    const { cwd } = get();
    if (!cwd) return;
    try {
      const res = await window.closeCode.gitBranches(cwd);
      if (res.ok && res.result) set({ branches: res.result });
      else set({ error: res.error ?? "Failed to get branches" });
    } catch (e) { set({ error: String(e) }); }
  },

  stage: async (files) => {
    const { cwd } = get();
    if (!cwd) return;
    set({ isLoading: true, error: null });
    try {
      const res = await window.closeCode.gitStage(cwd, files);
      if (!res.ok) throw new Error(res.error);
      await get().refreshStatus();
    } catch (e) { set({ error: String(e), isLoading: false }); return; }
    set({ isLoading: false });
  },

  unstage: async (files) => {
    const { cwd } = get();
    if (!cwd) return;
    set({ isLoading: true, error: null });
    try {
      const res = await window.closeCode.gitUnstage(cwd, files);
      if (!res.ok) throw new Error(res.error);
      await get().refreshStatus();
    } catch (e) { set({ error: String(e), isLoading: false }); return; }
    set({ isLoading: false });
  },

  stageAll: async () => {
    const { cwd } = get();
    if (!cwd) return;
    set({ isLoading: true, error: null });
    try {
      const res = await window.closeCode.gitStageAll(cwd);
      if (!res.ok) throw new Error(res.error);
      await get().refreshStatus();
    } catch (e) { set({ error: String(e), isLoading: false }); return; }
    set({ isLoading: false });
  },

  commit: async () => {
    const { cwd, commitMessage } = get();
    if (!cwd) return null;
    if (!commitMessage.trim()) { set({ error: "Commit message is empty" }); return null; }
    set({ isLoading: true, error: null });
    try {
      const res = await window.closeCode.gitCommit(cwd, commitMessage);
      if (!res.ok) throw new Error(res.error);
      set({ commitMessage: "" });
      await get().refreshStatus();
      await get().getLog();
      set({ isLoading: false });
      return res.result?.hash ?? null;
    } catch (e) { set({ error: String(e), isLoading: false }); return null; }
  },

  createBranch: async (name) => {
    const { cwd } = get();
    if (!cwd) return;
    set({ isLoading: true, error: null });
    try {
      const res = await window.closeCode.gitCreateBranch(cwd, name);
      if (!res.ok) throw new Error(res.error);
      await get().refreshBranches();
      await get().refreshStatus();
    } catch (e) { set({ error: String(e), isLoading: false }); return; }
    set({ isLoading: false });
  },

  switchBranch: async (name) => {
    const { cwd } = get();
    if (!cwd) return;
    set({ isLoading: true, error: null });
    try {
      const res = await window.closeCode.gitSwitchBranch(cwd, name);
      if (!res.ok) throw new Error(res.error);
      await get().refreshBranches();
      await get().refreshStatus();
    } catch (e) { set({ error: String(e), isLoading: false }); return; }
    set({ isLoading: false });
  },

  pull: async () => {
    const { cwd } = get();
    if (!cwd) return null;
    set({ isLoading: true, error: null });
    try {
      const res = await window.closeCode.gitPull(cwd);
      if (!res.ok) throw new Error(res.error);
      await get().refreshStatus();
      await get().refreshBranches();
      set({ isLoading: false });
      return res.result ?? null;
    } catch (e) { set({ error: String(e), isLoading: false }); return null; }
  },

  push: async (setUpstream) => {
    const { cwd } = get();
    if (!cwd) return null;
    set({ isLoading: true, error: null });
    try {
      const res = await window.closeCode.gitPush(cwd, !!setUpstream);
      if (!res.ok) throw new Error(res.error);
      await get().refreshStatus();
      set({ isLoading: false });
      return res.result ?? null;
    } catch (e) { set({ error: String(e), isLoading: false }); return null; }
  },

  fetch: async () => {
    const { cwd } = get();
    if (!cwd) return null;
    set({ isLoading: true, error: null });
    try {
      const res = await window.closeCode.gitFetch(cwd);
      if (!res.ok) throw new Error(res.error);
      await get().refreshBranches();
      await get().refreshStatus();
      set({ isLoading: false });
      return res.result ?? null;
    } catch (e) { set({ error: String(e), isLoading: false }); return null; }
  },

  getDiff: async (filePath, staged) => {
    const { cwd } = get();
    if (!cwd) return;
    try {
      const res = await window.closeCode.gitDiff(cwd, filePath, !!staged);
      if (res.ok) set({ diff: res.result ?? "", diffFile: filePath ?? null });
      else set({ error: res.error ?? "Failed to get diff" });
    } catch (e) { set({ error: String(e) }); }
  },

  getFileHistory: async (filePath) => {
    const { cwd } = get();
    if (!cwd) return;
    try {
      const res = await window.closeCode.gitFileHistory(cwd, filePath, 50);
      if (res.ok && res.result) set({ fileHistory: res.result });
      else set({ error: res.error ?? "Failed to get file history" });
    } catch (e) { set({ error: String(e) }); }
  },

  getLog: async () => {
    const { cwd } = get();
    if (!cwd) return;
    try {
      const res = await window.closeCode.gitLog(cwd, 50);
      if (res.ok && res.result) set({ log: res.result });
      else set({ error: res.error ?? "Failed to get log" });
    } catch (e) { set({ error: String(e) }); }
  },
}));
