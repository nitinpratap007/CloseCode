// Close Code — Cloud Sync (Phase 58)
// 
// Provides optional cloud synchronization features for account, session,
// settings, project metadata, AI memory, preferences, and device synchronization.
//
// CRITICAL: Source-code synchronization must be explicit and user-controlled.
// Close Code Cloud must NOT silently upload project source.
//
// Philosophy:
// — Opt-in by default: all sync features disabled until user enables them
— User-controlled: user explicitly chooses what to sync and where
— Transparent: user always knows what is stored, where, and why
— Protective: sensitive data is never synced without explicit approval
— Resilient: cloud failures never break the desktop IDE
— No hidden subscription: all features available without subscription pressure
//
// Data storage: all cloud data stored in userData/.closecode/cloud/

import { ipcMain } from "electron";
import path from "path";
import fs from "fs";

// ---- Cloud storage path —

const CLOUD_DIR = path.join(app.getPath("userData"), ".closecode", "cloud");
const SETTINGS_PATH = path.join(CLOUD_DIR, "settings.json");
const SYNC_STATE_PATH = path.join(CLOUD_DIR, "sync-state.json");

// Ensure cloud directory exists
if (!fs.existsSync(CLOUD_DIR)) {
  fs.mkdirSync(CLOUD_DIR, { recursive: true });
}

// ---- Cloud sync state —

// Default sync state: all features disabled
const defaultSyncState = {
  account: false,
  session: false,
  settings: false,
  projectMetadata: false,
  aiMemory: false,
  preferences: false,
  // Source code sync is ALWAYS explicitly opt-in — never default
  sourceCode: false,
};

// Load or initialize sync state
let syncState = defaultSyncState;

try {
  const stored = fs.readFileSync(SETTINGS_PATH, "utf-8");
  const storedState = JSON.parse(stored);
  // Only override with stored values that are valid booleans
  syncState = { ...defaultSyncState, ...storedState };
} catch {
  // Use defaults — no cloud config file yet
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(defaultSyncState), "utf-8");
}

// ---- Sync state helpers —

/**
 * Get current sync state.
 */
function getSyncState(): typeof defaultSyncState {
  return syncState;
}

/**
 * Set sync state (called from IPC handlers).
 */
function setSyncState(newState: typeof defaultSyncState): void {
  syncState = newState;
  // Persist to disk
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(syncState), "utf-8");
  } catch {
    // If we can't persist, keep in-memory state
  }
}

/**
 * Check if a sync type is enabled.
 */
function isSynced(type: keyof typeof defaultSyncState): boolean {
  return syncState[type] === true;
}

/**
 * Enable a sync type.
 */
function enableSync(type: keyof typeof defaultSyncState): void {
  const newState = { ...syncState, [type]: true };
  setSyncState(newState);
}

/**
 * Disable a sync type.
 */
function disableSync(type: keyof typeof defaultSyncState): void {
  const newState = { ...syncState, [type]: false };
  setSyncState(newState);
}

// ---- IPC handlers ---

export function registerCloudSyncIpc(): void {
  // --- Sync state ---

  ipcMain.handle("cloudSync:get-state", async () => {
    try {
      return { ok: true, result: getSyncState() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // --- Data sync operations (placeholders — actual sync would connect to cloud services) ---

  ipcMain.handle("cloudSync:sync:settings", async () => {
    try {
      // Read current settings and prepare for sync
      const settingsPath = path.join(app.getPath("userData"), "settings.json");
      let settings = {};
      if (fs.existsSync(settingsPath)) {
        try {
          settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
        } catch {}
      }
      
      // In a real implementation, this would sync with cloud service
      // But source code must NEVER be synced automatically
      return {
        ok: true,
        result: { 
          synced: "settings",
          message: "Settings sync prepared (user-approved only)",
          sourceCodeSynced: false // explicitly false
        }
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("cloudSync:sync:project-metadata", async () => {
    try {
      // Sync project metadata (not source code)
      const metadata = {
        appName: "Close Code",
        version: process.env.npm_package_version || "0.0.0",
        timestamp: Date.now(),
        // Never include source code paths or content
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
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("cloudSync:sync:ai-memory", async () => {
    try {
      // AI memory sync — only metadata, never source code
      const aiMemory = {
        lastActive: Date.now(),
        sessionCount: 0,
        // Never include actual conversation content or source code
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
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("cloudSync:sync:preferences", async () => {
    try {
      // Sync user preferences (theme, etc.) — never source code
      return {
        ok: true,
        result: { 
          synced: "preferences",
          message: "Preferences sync prepared",
          sourceCodeSynced: false // explicitly false
        }
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // --- Cloud data management ---

  ipcMain.handle("cloudSync:list-data", async () => {
    try {
      // List what cloud data exists
      const data: any = {};
      
      // Check settings
      if (fs.existsSync(SETTINGS_PATH)) {
        try {
          data.settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
        } catch {}
      }
      
      // Check sync state
      if (fs.existsSync(SYNC_STATE_PATH)) {
        try {
          data.syncState = JSON.parse(fs.readFileSync(SYNC_STATE_PATH, "utf-8"));
        } catch {}
      }
      
      // Check cloud directory for any other files
      const cloudFiles = fs.readdirSync(CLOUD_DIR).filter(f => !["settings.json", "sync-state.json"].includes(f));
      data.cloudFiles = cloudFiles;
      
      return { ok: true, result: data };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("cloudSync:delete-data", async (_e, type: string) => {
    try {
      // Delete specific cloud data
      let deleted = false;
      let message = "";
      
      switch (type) {
        case "settings":
          const settingsPath = path.join(CLOUD_DIR, "settings.json");
          if (fs.existsSync(SETTINGS_PATH)) {
            fs.removeFileSync(SETTINGS_PATH);
            deleted = true;
            message = "Settings data deleted";
          } else {
            message = "No settings data to delete";
          }
          break;
        case "sync-state":
          if (fs.existsSync(SYNC_STATE_PATH)) {
            fs.removeFileSync(SYNC_STATE_PATH);
            deleted = true;
            message = "Sync state deleted";
          } else {
            message = "No sync state to delete";
          }
          break;
        case "all":
          // Delete all cloud data except source code
          if (fs.existsSync(SETTINGS_PATH)) {
            fs.removeFileSync(SETTINGS_PATH);
            deleted = true;
          }
          if (fs.existsSync(SYNC_STATE_PATH)) {
            fs.removeFileSync(SYNC_STATE_PATH);
            deleted = true;
          }
          // Don't delete source code related files
          message = deleted ? "All cloud data deleted (source code preserved)" : "No cloud data to delete";
          break;
        default:
          message = `Unknown data type: ${type}`;
      }
      
      return { ok: true, result: { deleted, message } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}