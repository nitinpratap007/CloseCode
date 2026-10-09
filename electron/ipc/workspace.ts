import { app, BrowserWindow, dialog, ipcMain } from "electron";
import path from "path";
import fs from "fs";
import { getEffectiveSettings } from "../services/settings";
import { WorkspaceService, type ListOptions } from "../services/workspace";
import { pushRecent, loadRecent, removeRecent, clearRecent } from "../services/recent";
import { invalidateSearchCache } from "../services/search";

const service = new WorkspaceService();

function getOpts(): ListOptions {
  const s = getEffectiveSettings(service.getRoot());
  return {
    showHiddenFiles: s.showHiddenFiles,
    fileExcludes: s.fileExcludes,
  };
}

function recentsEnabled(): boolean {
  return getEffectiveSettings(service.getRoot()).rememberRecentProjects;
}

function getMainWindow(): BrowserWindow {
  const [win] = BrowserWindow.getAllWindows();
  if (!win) throw new Error("No window available");
  return win;
}

function getRootName(): string {
  const root = service.getRoot();
  return root ? path.basename(root) : "";
}

export function getWorkspaceRoot(): string | null {
  return service.getRoot();
}

async function tryOk(
  fn: () => unknown
): Promise<{ ok: true; result?: unknown } | { ok: false; error: string }> {
  try {
    return { ok: true, result: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function openWorkspaceFromDialog(): { root: string; name: string } | null {
  const result = dialog.showOpenDialogSync(getMainWindow(), {
    properties: ["openDirectory"],
  });
  if (!result || result.length === 0) return null;
  const root = result[0];
  service.setRoot(root);
  if (recentsEnabled()) pushRecent(root);
  const name = path.basename(root);
  getMainWindow().webContents.send("workspace:opened", { root, name });
  return { root, name };
}

export function openWorkspaceByPath(rootPath: string): { root: string; name: string } | null {
  try {
    service.setRoot(rootPath);
  } catch {
    return null;
  }
  if (recentsEnabled()) pushRecent(rootPath);
  const name = path.basename(rootPath);
  getMainWindow().webContents.send("workspace:opened", { root: rootPath, name });
  return { root: rootPath, name };
}

export function registerWorkspaceIpc(): void {
  if (process.env.CC_USER_DATA) {
    try {
      app.setPath("userData", process.env.CC_USER_DATA);
    } catch {
      // ignore
    }
  }

  ipcMain.handle("workspace:open-folders", (_e, rootPaths?: string | string[]) => {
    if (rootPaths && typeof rootPaths === "string") {
      const stat = fs.statSync(rootPaths, { throwIfNoEntry: false });
      if (stat?.isDirectory()) {
        return tryOk(() => openWorkspaceByPath(rootPaths));
      }
      return { ok: false, error: "Path is not a directory" };
    }
    return tryOk(() => openWorkspaceFromDialog());
  });

  ipcMain.handle("workspace:get-state", () => {
    return {
      root: service.getRoot(),
      name: getRootName(),
    };
  });

  ipcMain.handle("workspace:get-recent", () => (recentsEnabled() ? loadRecent() : []));
  ipcMain.handle("workspace:remove-recent", (_e, p: string) => {
    removeRecent(p);
  });
  ipcMain.handle("workspace:clear-recent", () => {
    clearRecent();
  });

  ipcMain.handle("fs:list-dir", (_e, dirPath: string) => {
    return tryOk(() => service.listDir(dirPath, getOpts()));
  });

  // Phase 16: every mutation below drops the memoised workspace-search results, so a
  // change made through Close Code can never be answered from the search cache.
  ipcMain.handle("fs:create-file", (_e, dirPath: string, name: string) => {
    return tryOk(() => {
      const out = service.createFile(dirPath, name);
      invalidateSearchCache();
      return out;
    });
  });

  ipcMain.handle("fs:create-folder", (_e, dirPath: string, name: string) => {
    return tryOk(() => {
      const out = service.createFolder(dirPath, name);
      invalidateSearchCache();
      return out;
    });
  });

  ipcMain.handle("fs:rename-item", (_e, oldPath: string, newName: string) => {
    return tryOk(() => {
      const out = service.renameItem(oldPath, newName);
      invalidateSearchCache();
      return out;
    });
  });

  ipcMain.handle("fs:delete-item", (_e, itemPath: string) => {
    return tryOk(() => {
      service.deleteItem(itemPath);
      invalidateSearchCache();
    });
  });

  ipcMain.handle("fs:move-item", (_e, src: string, destDir: string) => {
    return tryOk(async () => {
      const out = await service.moveItem(src, destDir);
      invalidateSearchCache();
      return out;
    });
  });

  ipcMain.handle("fs:move-dialog", async (_e, src: string) => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ["openDirectory"],
      title: "Choose destination folder",
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: true, result: null };
    }
    return tryOk(async () => {
      return await service.moveItem(src, result.filePaths[0]);
    });
  });

  ipcMain.handle("fs:read-file", (_e, filePath: string) => {
    return tryOk(() => service.readTextFile(filePath));
  });
}