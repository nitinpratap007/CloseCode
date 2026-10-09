import { ipcMain, BrowserWindow } from "electron";
import { ExtensionHost } from "../services/extensions/host";
import { getEffectiveSettings } from "../services/settings";

let host: ExtensionHost | null = null;

interface Options {
  getWorkspaceRoot: () => string | null;
  userDataDir: () => string;
}

export function getExtensionHost(): ExtensionHost | null {
  return host;
}

export function registerExtensionIpc(opts: Options): void {
  host = new ExtensionHost({
    emit: (channel, payload) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(channel, payload);
      }
    },
    getWorkspaceRoot: opts.getWorkspaceRoot,
    userDataDir: opts.userDataDir,
    getWorkspaceExtensionsEnabled: () => getEffectiveSettings(opts.getWorkspaceRoot()).workspaceExtensionDiscovery,
  });

  // Activate everything that is enabled.
  for (const info of host.list()) {
    if (info.enabled && !info.incompatible && !info.loadError) {
      host.setEnabled(info.id, true);
    }
  }

  ipcMain.handle("extension:list", () => host?.list() ?? []);

  ipcMain.handle("extension:set-enabled", (_e, id: string, enabled: boolean) => {
    try {
      if (!host) throw new Error("Extension host not ready");
      return host.setEnabled(String(id), !!enabled);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("extension:exec-command", (_e, commandId: string) => {
    try {
      if (!host) throw new Error("Extension host not ready");
      return host.executeCommand(String(commandId));
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("extension:reload", () => {
    try {
      if (!host) throw new Error("Extension host not ready");
      return { ok: true, result: host.reload() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

/** Re-broadcast states to a freshly loaded window (called after window created). */
export function rebroadcastExtensionState(): void {
  if (!host) return;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("extension:changed", { extensions: host.list() });
    }
  }
}