// Close Code — Settings IPC (Phase 14)
// Legacy channels preserved: get-settings / save-settings (effective merge +
// user-scope writes). New channels expose categories, scopes, and resets.

import { BrowserWindow, ipcMain } from "electron";
import {
  getSettingCategories,
  getEffectiveSettings,
  getSettingsSnapshot,
  loadUserSettings,
  loadWorkspaceSettings,
  resetUserSettings,
  resetWorkspaceSettings,
  saveUserSettingsPatch,
  saveWorkspaceSettingsPatch,
  sanitizePatch,
} from "../services/settings";

export function notifySettingsChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("settings:changed");
  }
}

export function registerSettingsIpc(opts: { getWorkspaceRoot: () => string | null }): void {
  const root = (): string | null => opts.getWorkspaceRoot();

  // ---- Legacy contract (renderer + older phase tests) ----
  ipcMain.handle("get-settings", () => getEffectiveSettings(root()));

  ipcMain.handle("save-settings", (_event, patch: unknown) => {
    saveUserSettingsPatch(sanitizePatch(patch));
    notifySettingsChanged();
    return getEffectiveSettings(root());
  });

  // ---- New contract ----
  ipcMain.handle("settings:get-categories", () => getSettingCategories());

  ipcMain.handle("settings:get-all", () => ({
    ...getSettingsSnapshot(root()),
    hasWorkspace: root() !== null,
  }));

  ipcMain.handle("settings:save-user", (_event, patch: unknown) => {
    const clean = sanitizePatch(patch);
    saveUserSettingsPatch(clean);
    notifySettingsChanged();
    return { ok: true, result: loadUserSettings() };
  });

  ipcMain.handle("settings:save-workspace", (_event, patch: unknown) => {
    const r = root();
    if (!r) return { ok: false, error: "No workspace open — open a folder first to edit workspace settings." };
    const clean = sanitizePatch(patch);
    saveWorkspaceSettingsPatch(r, clean);
    notifySettingsChanged();
    return { ok: true, result: loadWorkspaceSettings(r) };
  });

  ipcMain.handle("settings:reset-user", () => {
    resetUserSettings();
    notifySettingsChanged();
    return { ok: true, result: loadUserSettings() };
  });

  ipcMain.handle("settings:reset-workspace", () => {
    const r = root();
    if (!r) return { ok: false, error: "No workspace open." };
    resetWorkspaceSettings(r);
    notifySettingsChanged();
    return { ok: true, result: {} };
  });
}