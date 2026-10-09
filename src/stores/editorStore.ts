import { create } from "zustand";
import type { Tab } from "../types/settings";

const MAX_CACHED_TABS = 30;
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const LARGE_FILE_WARN = 5 * 1024 * 1024;

// Phase 14: mutable performance limits driven by settings (settingsStore -> setPerfLimits).
interface PerfLimits {
  maxFileSize: number;
  warnSize: number;
  cacheMax: number;
}
let perf: PerfLimits = {
  maxFileSize: MAX_FILE_SIZE,
  warnSize: LARGE_FILE_WARN,
  cacheMax: MAX_CACHED_TABS,
};

export function setPerfLimits(opts: { largeFileThreshold?: number | null; contentCacheMax?: number | null }): void {
  const mb = (n: number | null | undefined, fallback: number): number =>
    Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) * 1024 * 1024 : fallback;
  perf = {
    // Hard open-size cap stays fixed; largeFileThreshold only drives the
    // soft "read-only" warning.
    maxFileSize: MAX_FILE_SIZE,
    warnSize: mb(opts.largeFileThreshold, LARGE_FILE_WARN),
    cacheMax: Number.isFinite(Number(opts.contentCacheMax)) && Number(opts.contentCacheMax) > 0 ? Number(opts.contentCacheMax) : MAX_CACHED_TABS,
  };
}

function currentPerf(): PerfLimits {
  return perf;
}

export interface EditorState {
  tabs: Tab[];
  activePath: string | null;
  largeFileWarning: string | null;
  untitledCounter: number;
  /** Tabs that are dirty and not untitled — used for session restore and
    // the beforeunload guard so unsaved code is never silently lost. */
  dirtyTabs: () => Tab[];
  openFileInWorkspace: (path: string, opts?: { content?: string; size?: number }) => Promise<void>;
  newUntitled: () => void;
  setActive: (path: string) => void;
  markChanged: (path: string) => void;
  markClean: (path: string) => void;
  closeTab: (path: string) => boolean;          // false if tab was dirty (not closed)
  closeAllTabs: () => void;
  saveTab: (path: string) => Promise<boolean>;    // true if saved or already clean
  saveActive: () => Promise<boolean>;
  saveAs: (path?: string) => Promise<boolean>;
  saveAll: () => Promise<void>;
  setLargeFileWarning: (path: string | null) => void;
  getContent: (path: string) => string;
}

const contentCache = new Map<string, string>();
let lru: Array<{ path: string; dirty: boolean }> = [];

// Phase 16: profiling showed the typing hot path used to call `editor.getValue()`
// on every keystroke, i.e. one full-document string copy per character. The live
// Monaco model is now the source of truth for the attached file, and the string
// cache is only snapshotted on tab switch / model eviction / save, so a keystroke
// costs O(1) instead of O(document size).
type ContentProvider = (path: string) => string | undefined;
let contentProvider: ContentProvider | null = null;

export function setContentProvider(provider: ContentProvider | null): void {
  contentProvider = provider;
}

export function cacheContent(path: string, content: string): void {
  contentCache.set(path, content);
}

// Explicit writes (tests, AI apply, external callers) must win over the live model,
// so they pin the cached string until the model for that path is re-attached.
const contentOverrides = new Set<string>();

export function overrideContent(path: string, content: string): void {
  contentCache.set(path, content);
  contentOverrides.add(path);
}

export function clearContentOverride(path: string): void {
  contentOverrides.delete(path);
}

export function getCachedContent(path: string): string {
  if (!contentOverrides.has(path)) {
    const live = contentProvider?.(path);
    if (live !== undefined) return live;
  }
  return contentCache.get(path) ?? "";
}

function getDirty(path: string): boolean {
  return useEditorStore.getState().tabs.find((t) => t.path === path)?.dirty ?? false;
}

function evictToMax(): void {
  let guard = 0;
  const max = currentPerf().cacheMax;
  while (lru.length > max && guard++ < 1000) {
    const first = lru[0];
    if (first.dirty) {
      lru = [...lru.slice(1), first];
      continue;
    }
    lru.shift();
    contentCache.delete(first.path);
  }
}

function touch(path: string): void {
  lru = lru.filter((e) => e.path !== path);
  lru.push({ path, dirty: getDirty(path) });
  evictToMax();
}

export const useEditorStore = create<EditorState>((set, get) => ({
  tabs: [],
  activePath: null,
  largeFileWarning: null,
  untitledCounter: 0,

  dirtyTabs: () => get().tabs.filter((t) => t.dirty && !t.path.startsWith("untitled:")),

  openFileInWorkspace: async (path, opts) => {
    const state = get();
    const existing = state.tabs.find((t) => t.path === path);
    if (existing) {
      set({ activePath: path });
      touch(path);
      return;
    }

    let content = opts?.content;
    let size = opts?.size ?? 0;

    if (content === undefined) {
      const resp = await window.closeCode.readFile(path);
      if (!resp.ok || !resp.result) {
        console.error("Failed to open file:", resp.error);
        return;
      }
      content = resp.result.content;
      size = resp.result.size;
      if (resp.result.binary) {
        window.alert("This file appears to be binary and cannot be shown as text.");
        return;
      }
      const maxSize = currentPerf().maxFileSize;
      if (size > maxSize) {
        window.alert(
          `File is larger than ${Math.round(maxSize / 1048576)} MB and cannot be opened in this build.`
        );
        return;
      }
    }

    const name = path.split(/[\\/]/).pop() ?? path;
    cacheContent(path, content);
    // Freshly read disk content is authoritative again for this tab.
    clearContentOverride(path);

    const maxTabs = currentPerf().cacheMax;
    let nextTabs = [...state.tabs, { path, name, dirty: false, size }];
    if (nextTabs.length > maxTabs) {
      const idx = nextTabs.findIndex((t, i) => i > 0 && !t.dirty && t.path !== path);
      if (idx > -1) {
        nextTabs = nextTabs.filter((t) => t.path !== nextTabs[idx].path);
        contentCache.delete(nextTabs[idx].path);
      }
    }

    set({ tabs: nextTabs, activePath: path });
    set({ largeFileWarning: size > currentPerf().warnSize ? path : null });
    touch(path);
  },

  newUntitled: () => {
    const n = get().untitledCounter + 1;
    const path = `untitled:${n}`;
    cacheContent(path, "");
    set({
      untitledCounter: n,
      tabs: [...get().tabs, { path, name: `Untitled-${n}`, dirty: false, size: 0 }],
      activePath: path,
    });
    touch(path);
  },

  setActive: (path: string) => {
    set({ activePath: path });
    touch(path);
  },

  markChanged: (path: string) => {
    const tab = get().tabs.find((t) => t.path === path);
    if (tab && !tab.dirty) {
      set({ tabs: get().tabs.map((t) => (t.path === path ? { ...t, dirty: true } : t)) });
    }
    touch(path);
  },

  markClean: (path: string) => {
    set({ tabs: get().tabs.map((t) => (t.path === path ? { ...t, dirty: false } : t)) });
    touch(path);
  },

  closeTab: (path: string): boolean => {
    const tab = get().tabs.find((t) => t.path === path);
    // Never silently close a dirty tab — the caller must save first.
    // This is the core guarantee of Phase 17: the app must never
    // silently lose user code.
    if (tab && tab.dirty) return false;
    const tabs = get().tabs.filter((t) => t.path !== path);
    contentCache.delete(path);
    contentOverrides.delete(path);
    set({
      tabs,
      activePath:
        get().activePath === path ? tabs[tabs.length - 1]?.path ?? null : get().activePath,
      largeFileWarning: get().largeFileWarning === path ? null : get().largeFileWarning,
    });
    return true;
  },

  closeAllTabs: () => {
    // Only close tabs that are safe to close (clean or untitled with no content).
    // Dirty tabs are intentionally left open so no code is lost.
    const tabs = get().tabs.filter((t) => !t.dirty);
    for (const t of get().tabs) {
      contentCache.delete(t.path);
      contentOverrides.delete(t.path);
    }
    set({ tabs, activePath: null, largeFileWarning: null });
    return;
  },

  saveActive: async (): Promise<boolean> => {
    const { activePath } = get();
    if (!activePath) return false;
    const content = getCachedContent(activePath);

    if (activePath.startsWith("untitled:")) {
      return get().saveAs(activePath);
    }

    const write = await window.closeCode.writeFile(activePath, content);
    if (write.error) {
      console.error("Save failed:", write.error);
      window.alert(`Failed to save: ${write.error}`);
      return false;
    }
    get().markClean(activePath);
    return true;
  },

  saveAs: async (targetPath?: string): Promise<boolean> => {
    const path = targetPath ?? get().activePath;
    if (!path) return false;
    const content = getCachedContent(path);
    const suggested = path.startsWith("untitled:") ? "Untitled.txt" : path.split(/[\\/]/).pop() ?? "Untitled.txt";
    const resp = await window.closeCode.saveAsDialog(suggested);
    if (!resp.path) return false;
    const newPath = resp.path;
    const write = await window.closeCode.writeFile(newPath, content);
    if (write.error) {
      console.error("Save As failed:", write.error);
      window.alert(`Failed to save: ${write.error}`);
      return false;
    }
    if (path.startsWith("untitled:")) {
      cacheContent(newPath, content);
      contentCache.delete(path);
      const name = newPath.split(/[\\/]/).pop() ?? newPath;
      set({
        tabs: get().tabs.map((t) =>
          t.path === path ? { ...t, path: newPath, name, dirty: false, size: content.length } : t
        ),
        activePath: newPath,
      });
      touch(newPath);
    } else {
      // Save As from existing file: keep original tab, also open new file
      cacheContent(newPath, content);
      const name = newPath.split(/[\\/]/).pop() ?? newPath;
      const exists = get().tabs.find((t) => t.path === newPath);
      if (!exists) {
        set({
          tabs: [...get().tabs, { path: newPath, name, dirty: false, size: content.length }],
          activePath: newPath,
        });
        touch(newPath);
      } else {
        set({ activePath: newPath });
        get().markClean(newPath);
      }
    }
    return true;
  },

  saveAll: async (): Promise<void> => {
    for (const tab of [...get().tabs]) {
      if (!tab.dirty) continue;
      if (tab.path.startsWith("untitled:")) continue;
      const content = getCachedContent(tab.path);
      const write = await window.closeCode.writeFile(tab.path, content);
      if (!write.error) {
        get().markClean(tab.path);
      } else {
        console.error(`Save All failed for ${tab.path}:`, write.error);
      }
    }
  },

  setLargeFileWarning: (path) => set({ largeFileWarning: path }),

  getContent: (path) => getCachedContent(path),

  /** Save a specific tab. Returns true if it was clean or saved
    // successfully; false if the write failed. */
  saveTab: async (path: string): Promise<boolean> => {
    if (!get().tabs.find((t) => t.path === path)) return true; // already gone
    const tab = get().tabs.find((t) => t.path === path);
    if (tab && !tab.dirty) { get().markClean(path); return true; }
    if (path.startsWith("untitled:")) return get().saveAs(path);
    const content = getCachedContent(path);
    const write = await window.closeCode.writeFile(path, content);
    if (!write.error) { get().markClean(path); return true; }
    console.error(`Save failed for ${path}:`, write.error);
    return false;
  },

  /** Safely close a tab: if it is dirty, save it first. Returns true
    // if the tab is now closed, false if the user could not save
    // and the tab remains open (so no code is lost). */
  closeTabSafely: async (path: string): Promise<boolean> => {
    const tab = get().tabs.find((t) => t.path === path);
    if (!tab) return true;
    if (tab.dirty) {
      const ok = await get().saveTab(path);
      if (!ok) return false; // still dirty — caller should not force-close
    }
    return get().closeTab(path);
  },
}));