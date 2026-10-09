// Close Code — Themes IPC (Phase 15): custom theme discovery/read.

import { ipcMain } from "electron";
import { listCustomThemes, readCustomTheme } from "../services/themes";

export function registerThemesIpc(getWorkspaceRoot: () => string | null): void {
  ipcMain.handle("themes:list-custom", () => listCustomThemes(getWorkspaceRoot()));

  ipcMain.handle("themes:read", (_e, file: unknown) => {
    if (typeof file !== "string" || file.length === 0) {
      return { ok: false, error: "Invalid theme file path" };
    }
    return { ok: true, theme: readCustomTheme(file) };
  });
}