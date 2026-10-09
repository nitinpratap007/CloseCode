import { ipcMain } from "electron";
import {
  searchWorkspace,
  replaceInFile,
  replaceAllInWorkspace,
  invalidateSearchCache,
  type SearchOptions,
} from "../services/search";

export function registerSearchIpc(): void {
  ipcMain.handle(
    "search:workspace",
    async (_e, root: string, query: string, opts: SearchOptions) => {
      try {
        if (!root) return { ok: false, error: "No workspace folder is open." };
        const res = await searchWorkspace(root, query, opts);
        return { ok: true, result: res };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  ipcMain.handle(
    "search:replace-file",
    async (_e, filePath: string, query: string, replacement: string, opts: SearchOptions) => {
      try {
        const count = await replaceInFile(filePath, query, replacement, opts);
        // Phase 16: the file just changed on disk, so cached results are now wrong.
        invalidateSearchCache();
        return { ok: true, result: { count } };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  ipcMain.handle(
    "search:replace-all",
    async (_e, root: string, query: string, replacement: string, opts: SearchOptions) => {
      try {
        if (!root) return { ok: false, error: "No workspace folder is open." };
        const res = await replaceAllInWorkspace(root, query, replacement, opts);
        // Phase 16: possibly many files changed on disk.
        invalidateSearchCache();
        return { ok: true, result: res };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );
}
