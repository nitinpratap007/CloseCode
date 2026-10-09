// Close Code — Cloud Sync IPC (Phase 58)
// 
// Handles renderer access to cloud synchronization features.
// All cloud features are optional and user-controlled.
// Source-code synchronization is explicitly opt-in — never automatic.
// Cloud failures never break the desktop IDE.

import { ipcMain } from "electron";
import {
  getSyncState,
  setSyncState,
  isSynced,
  enableSync,
  disableSync,
} from "../../services/cloudSync";

function fail(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

// --- Sync state ---

ipcMain.handle("cloudSync:get-state", async (_e) => {
  try {
    return { ok: true, result: getSyncState() };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("cloudSync:enable", async (_e, type: string) => {
  try {
    const validTypes = ["account", "session", "settings", "projectMetadata", "aiMemory", "preferences", "sourceCode"];
    if (!validTypes.includes(type)) {
      return { ok: false, error: `Invalid sync type: ${type}` };
    }
    enableSync(type as keyof typeof defaultSyncState);
    return { ok: true, result: { enabled: true, type } };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("cloudSync:disable", async (_e, type: string) => {
  try {
    const validTypes = ["account", "session", "settings", "projectMetadata", "aiMemory", "preferences", "sourceCode"];
    if (!validTypes.includes(type)) {
      return { ok: false, error: `Invalid sync type: ${type}` };
    }
    disableSync(type as keyof typeof defaultSyncState);
    return { ok: true, result: { enabled: false, type } };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

// --- Data sync operations ---

ipcMain.handle("cloudSync:sync:settings", async (_e) => {
  try {
    return {
      ok: true,
      result: { 
        synced: "settings",
        message: "Settings sync prepared (user-approved only)",
        sourceCodeSynced: false
      }
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("cloudSync:sync:project-metadata", async (_e) => {
  try {
    const metadata = {
      appName: "Close Code",
      version: process.env.npm_package_version || "0.0.0",
      timestamp: Date.now(),
    };
    
    return {
      ok: true,
      result: { 
        synced: "projectMetadata",
        message: "Project metadata sync prepared",
        metadata: metadata
      }
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("cloudSync:sync:ai-memory", async (_e) => {
  try {
    const aiMemory = {
      lastActive: Date.now(),
      sessionCount: 0,
    };
    
    return {
      ok: true,
      result: { 
        synced: "aiMemory",
        message: "AI memory sync prepared (metadata only)",
        aiMemory: aiMemory
      }
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("cloudSync:sync:preferences", async (_e) => {
  try {
    return {
      ok: true,
      result: { 
        synced: "preferences",
        message: "Preferences sync prepared",
        sourceCodeSynced: false // explicitly false
      }
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

// --- Data management ---

ipcMain.handle("cloudSync:list-data", async (_e) => {
  try {
    const data: any = {};
    
    const settingsPath = path.join(app.getPath("userData"), ".closecode", "cloud", "settings.json");
    if (fs.existsSync(settingsPath)) {
      try {
        data.settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      } catch {}
    }
    
    const syncStatePath = path.join(app.getPath("userData"), ".closecode", "cloud", "sync-state.json");
    if (fs.existsSync(syncStatePath)) {
      try {
        data.syncState = JSON.parse(fs.readFileSync(syncStatePath, "utf-8"));
      } catch {}
    }
    
    const cloudDir = path.join(app.getPath("userData"), ".closecode", "cloud");
    const cloudFiles = fs.readdirSync(cloudDir).filter(f => !["settings.json", "sync-state.json"].includes(f));
    data.cloudFiles = cloudFiles;
    
    return { ok: true, result: data };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("cloudSync:delete-data", async (_e, type: string) => {
  try {
    let deleted = false;
    let message = "";
    
    switch (type) {
      case "settings": {
        const settingsPath = path.join(app.getPath("userData"), ".closecode", "cloud", "settings.json");
        if (fs.existsSync(settingsPath)) {
          fs.removeFileSync(settingsPath);
          deleted = true;
          message = "Settings data deleted";
        } else {
          message = "No settings data to delete";
        }
        break;
      }
      case "sync-state": {
        const syncStatePath = path.join(app.getPath("userData"), ".closecode", "cloud", "sync-state.json");
        if (fs.existsSync(syncStatePath)) {
          fs.removeFileSync(syncStatePath);
          deleted = true;
          message = "Sync state deleted";
        } else {
          message = "No sync state to delete";
        }
        break;
      }
      case "all": {
        if (fs.existsSync(path.join(app.getPath("userData"), ".closecode", "cloud", "settings.json"))) {
          fs.removeFileSync(path.join(app.getPath("userData"), ".closecode", "cloud", "settings.json"));
          deleted = true;
        }
        if (fs.existsSync(path.join(app.getPath("userData"), ".closecode", "cloud", "sync-state.json"))) {
          fs.removeFileSync(path.join(app.getPath("userData"), ".closecode", "cloud", "sync-state.json"));
          deleted = true;
        }
        message = deleted ? "All cloud data deleted (source code preserved)" : "No cloud data to delete";
        break;
      }
      default:
        message = `Unknown data type: ${type}`;
    }
    
    return { ok: true, result: { deleted, message } };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});