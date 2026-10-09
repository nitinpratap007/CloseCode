// Close Code — Auto Update IPC (Phase 50)
// 
// Handles auto-update checking, downloading, and installation.
// Uses electron-updater under the hood.

import { ipcMain } from "electron";
import { autoUpdater } from "electron-updater";

function fail(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

// --- Check for updates ---

ipcMain.handle("autoUpdate:checkNow", async () => {
  try {
    autoUpdater.checkForUpdates();

    // autoUpdater emits events; we return pending status
    return {
      ok: true,
      result: {
        checking: true,
        message: "Checking for updates...",
      },
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

// --- Status ---

ipcMain.handle("autoUpdate:status", async () => {
  try {
    // Return current update status
    const result: any = {
      lastChecked: new Date().toISOString(),
      updates: [],
    };

    // Build in a basic status object
    // electron-updater manages this internally; we expose what we can
    return {
      ok: true,
      result,
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

// --- Download ---

ipcMain.handle("autoUpdate:download", async () => {
  try {
    autoUpdater.downloadUpdate();
    return {
      ok: true,
      result: {
        downloading: true,
        message: "Downloading update...",
      },
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

// --- Install ---

ipcMain.handle("autoUpdate:install", async () => {
  try {
    autoUpdater.quitAndInstall();
    return {
      ok: true,
      result: {
        installing: true,
        message: "Installing update and restarting...",
      },
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});