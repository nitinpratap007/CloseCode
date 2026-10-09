import { create } from "zustand";
import type { DirEntry, RecentProject } from "../types/settings";

export function dirname(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx > 0 ? p.slice(0, idx) : p;
}

export interface WorkspaceState {
  root: string | null;
  rootName: string;
  recentProjects: RecentProject[];
  children: Record<string, DirEntry[]>;
  expanded: Record<string, boolean>;
  loading: Record<string, boolean>;
  errors: Record<string, string>;
  contextMenu: { visible: boolean; x: number; y: number; targetPath: string; targetName: string; isDir: boolean } | null;
  inlineInput: { mode: "create-file" | "create-folder" | "rename"; targetPath: string } | null;
  refreshCounter: number;
  openWorkspace: (root: string, name: string) => void;
  closeWorkspace: () => Promise<void>;
  loadChildren: (dirPath: string) => Promise<void>;
  toggleDir: (dirPath: string) => void;
  collapseAll: () => void;
  refreshDir: (dirPath: string) => Promise<void>;
  refreshAll: () => Promise<void>;
  createFile: (dirPath: string, name: string) => Promise<void>;
  createFolder: (dirPath: string, name: string) => Promise<void>;
  rename: (oldPath: string, newName: string) => Promise<boolean>;
  removeTarget: (itemPath: string) => Promise<void>;
  move: (src: string, destDir: string) => Promise<void>;
  setContextMenu: (menu: WorkspaceState["contextMenu"]) => void;
  setInlineInput: (input: WorkspaceState["inlineInput"]) => void;
  loadRecent: () => Promise<void>;
  removeRecent: (p: string) => Promise<void>;
  clearRecent: () => Promise<void>;
  bumpRefresh: () => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  root: null,
  rootName: "",
  recentProjects: [],
  children: {},
  expanded: {},
  loading: {},
  errors: {},
  contextMenu: null,
  inlineInput: null,
  refreshCounter: 0,

  openWorkspace: async (root: string, name: string) => {
    set({ root, rootName: name, children: {}, expanded: {}, errors: {}, loading: {} });
    await get().loadChildren(root);
    const recent = await window.closeCode.getRecentProjects();
    set({ recentProjects: recent });
  },

  closeWorkspace: async () => {
    // Phase 20: closing the folder must also wipe the persisted session.
    // Without this the next launch restores the tabs of a folder the user just
    // closed, and they get "file not found" tabs instead of an empty editor.
    try {
      await window.closeCode.sessionClear();
    } catch (e) {
      // A failure here is cosmetic (the in-memory state still resets below and
      // the stale session is overwritten by the next heartbeat), so it must not
      // block the close.
      console.error("sessionClear failed:", e);
    }
    set({ root: null, rootName: "", children: {}, expanded: {}, errors: {}, loading: {} });
  },

  loadChildren: async (dirPath: string) => {
    const s = get();
    if (s.loading[dirPath]) return;
    set({ loading: { ...get().loading, [dirPath]: true }, errors: { ...get().errors, [dirPath]: "" } });
    const resp = await window.closeCode.listDir(dirPath);
    if (resp.ok && resp.result) {
      set({
        children: { ...get().children, [dirPath]: resp.result },
        loading: { ...get().loading, [dirPath]: false },
      });
    } else {
      set({
        errors: { ...get().errors, [dirPath]: resp.error ?? "Failed" },
        loading: { ...get().loading, [dirPath]: false },
      });
    }
  },

  toggleDir: async (dirPath: string) => {
    const s = get();
    const nextExpanded = !s.expanded[dirPath];
    set({ expanded: { ...s.expanded, [dirPath]: nextExpanded } });
    if (nextExpanded && !s.children[dirPath]) {
      await get().loadChildren(dirPath);
    }
  },

  collapseAll: () => set({ expanded: {} }),

  refreshDir: async (dirPath: string) => {
    set({ children: { ...get().children, [dirPath]: undefined! }, loading: { ...get().loading, [dirPath]: false } });
    await get().loadChildren(dirPath);
  },

  refreshAll: async () => {
    const expandedPaths = Object.keys(get().expanded).filter((p) => get().expanded[p]);
    set({ children: {}, loading: {}, errors: {} });
    await get().loadChildren(get().root!);
    for (const p of expandedPaths) {
      if (p !== get().root) {
        await get().loadChildren(p);
      }
    }
  },

  createFile: async (dirPath: string, name: string) => {
    const resp = await window.closeCode.createFile(dirPath, name);
    if (resp.ok) {
      await get().refreshDir(dirPath);
    } else {
      console.error("createFile failed:", resp.error);
    }
  },

  createFolder: async (dirPath: string, name: string) => {
    const resp = await window.closeCode.createFolder(dirPath, name);
    if (resp.ok) {
      await get().refreshDir(dirPath);
    } else {
      console.error("createFolder failed:", resp.error);
    }
  },

  rename: async (oldPath: string, newName: string): Promise<boolean> => {
    const resp = await window.closeCode.renameItem(oldPath, newName);
    if (resp.ok) {
      const newPath = resp.result!;
      const parent = dirname(oldPath);
      const wasExpanded = !!get().expanded[oldPath];
      const nextExpanded = { ...get().expanded };
      delete nextExpanded[oldPath];
      const nextChildren = { ...get().children };
      delete nextChildren[oldPath];
      set({ expanded: nextExpanded, children: nextChildren });
      await get().refreshDir(parent);
      if (wasExpanded) {
        await get().toggleDir(newPath);
      }
      return true;
    }
    console.error("rename failed:", resp.error);
    return false;
  },

  removeTarget: async (itemPath: string) => {
    const resp = await window.closeCode.deleteItem(itemPath);
    if (resp.ok) {
      const parent = itemPath.replace(/[\\/][^\\/]+$/, "");
      if (get().expanded[itemPath]) {
        const next = { ...get().expanded };
        delete next[itemPath];
        set({ expanded: next });
      }
      await get().refreshDir(parent);
    } else {
      console.error("delete failed:", resp.error);
    }
  },

  move: async (src: string, destDir: string) => {
    const resp = await window.closeCode.moveItem(src, destDir);
    if (resp.ok) {
      const srcParent = src.replace(/[\\/][^\\/]+$/, "");
      const destExpanded = get().expanded[destDir];
      await get().refreshDir(srcParent);
      if (destExpanded) await get().refreshDir(destDir);
    } else {
      console.error("move failed:", resp.error);
    }
  },

  setContextMenu: (menu) => set({ contextMenu: menu }),
  setInlineInput: (input) => set({ inlineInput: input }),

  loadRecent: async () => {
    const recent = await window.closeCode.getRecentProjects();
    set({ recentProjects: recent });
  },

  removeRecent: async (p: string) => {
    await window.closeCode.removeRecentProject(p);
    const recent = await window.closeCode.getRecentProjects();
    set({ recentProjects: recent });
  },

  clearRecent: async () => {
    await window.closeCode.clearRecentProjects();
    set({ recentProjects: [] });
  },

  bumpRefresh: () => set({ refreshCounter: get().refreshCounter + 1 }),
}));