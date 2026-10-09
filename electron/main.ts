import { app, BrowserWindow, ipcMain, Menu, dialog } from "electron";
import path from "path";
import fs from "fs";
import { registerSettingsIpc } from "./ipc/settings";
import { registerThemesIpc } from "./ipc/themes";
import { registerWorkspaceIpc, openWorkspaceFromDialog, openWorkspaceByPath, getWorkspaceRoot } from "./ipc/workspace";
import { registerSearchIpc } from "./ipc/search";
import { invalidateSearchCache } from "./services/search";
import { registerTerminalIpc } from "./ipc/terminal";
import { registerLspIpc } from "./ipc/lsp";
import { registerGitIpc } from "./ipc/git";
import { registerDebugIpc, stopDebugger } from "./ipc/debug";
import { registerAiIpc } from "./ipc/ai";
import { registerAgentIpc } from "./ipc/agent";
import { registerPermissionIpc } from "./ipc/permissions";
import { registerTaskIpc } from "./ipc/task";
import { registerMcpIpc } from "./ipc/mcp";
import { registerResearchIpc } from "./ipc/research";
import { registerCommandIpc } from "./ipc/command";
import { registerModelManagerIpc } from "./ipc/modelManager";
import { registerProjectBrainIpc } from "./ipc/projectBrain";
import { registerProjectMapIpc } from "./ipc/projectMap";
import { registerProjectHealthIpc } from "./ipc/projectHealth";
import { registerDependencyDoctorIpc } from "./ipc/dependencyDoctor";
import { registerBrowserAgentIpc } from "./ipc/browserAgent";
import { registerUiDebuggerIpc } from "./ipc/uiDebugger";
import { registerSecurityGuardianIpc } from "./ipc/securityGuardian";
import { registerTestGeneratorIpc } from "./ipc/testGenerator";
import { registerAutoUpdateIpc } from "./ipc/autoUpdate";
import { registerMultiAgentIpc } from "./ipc/multiAgentWorkspace";
import { registerVerificationIpc } from "./ipc/verificationWorkflow";
import { registerSkillsIpc } from "./ipc/skills";
import { registerCompanionIpc } from "./services/companion";
import { shutdownMcpServers, warmupMcpServers } from "./services/mcp";
import { registerExtensionIpc, rebroadcastExtensionState } from "./ipc/extensions";
import { registerSessionIpc } from "./ipc/session";
import { logError } from "./services/errorLog";
import { loadSession } from "./services/session";


const isDev = !app.isPackaged;

/**
 * Display name for the window title, the Help-menu entry and the About dialog.
 * Single source of truth: `app.getName()`, which Electron resolves from
 * `productName` in package.json ("CloseCode"). Deriving it instead of hardcoding
 * keeps the UI from drifting away from the packaged executable name, the
 * Start Menu shortcut and the installer — all four are Phase 20 deliverables.
 */
const APP_NAME = app.getName();

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: APP_NAME,
    backgroundColor: "#1e1e2e",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  mainWindow.webContents.once("did-finish-load", () => {
    rebroadcastExtensionState();
  });

  // Phase 17: bind crash handlers to this window.
  registerCrashHandlers(mainWindow);

  buildMenu();
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "File",
      submenu: [
        {
          label: "New File",
          accelerator: "CmdOrCtrl+N",
          click: () => mainWindow?.webContents.send("menu:new-file"),
        },
        {
          label: "Open File...",
          accelerator: "CmdOrCtrl+O",
          click: () => {
            const r = mainWindow
              ? dialog.showOpenDialogSync(mainWindow, {
                  properties: ["openFile"],
                  filters: [
                    { name: "All Files", extensions: ["*"] },
                  ],
                })
              : null;
            if (r && r.length > 0) {
              try {
                const content = fs.readFileSync(r[0], "utf-8");
                mainWindow?.webContents.send("file:opened", {
                  filePath: r[0],
                  content,
                });
              } catch {
                // ignore
              }
            }
          },
        },
        {
          label: "Open Folder...",
          accelerator: "CmdOrCtrl+K CmdOrCtrl+O",
          click: () => openWorkspaceFromDialog(),
        },
        { type: "separator" },
        {
          label: "Save",
          accelerator: "CmdOrCtrl+S",
          click: () => mainWindow?.webContents.send("menu:save"),
        },
        {
          label: "Save As...",
          accelerator: "CmdOrCtrl+Shift+S",
          click: () => mainWindow?.webContents.send("menu:save-as"),
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen", accelerator: "Ctrl+Alt+F" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { role: "close" },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: `About ${APP_NAME}`,
          click: () => {
            if (!mainWindow) return;
            dialog.showMessageBox(mainWindow, {
              type: "info",
              title: `About ${APP_NAME}`,
              message: APP_NAME,
              detail: `Version: ${app.getVersion()}\nElectron: ${process.versions.electron}\nNode: ${process.versions.node}\nChrome: ${process.versions.chrome}`,
            });
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

registerWorkspaceIpc();
registerSearchIpc();
registerTerminalIpc();
registerLspIpc();
registerGitIpc();
registerDebugIpc();
registerAiIpc();
registerAgentIpc();
registerPermissionIpc();
registerExtensionIpc({
  getWorkspaceRoot,
  userDataDir: () => app.getPath("userData"),
});

registerSettingsIpc({ getWorkspaceRoot });
registerThemesIpc(getWorkspaceRoot);

ipcMain.handle("get-app-info", () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  node: process.versions.node,
  chrome: process.versions.chrome,
  platform: process.platform,
}));

ipcMain.handle("get-platform", () => process.platform);

ipcMain.handle("save-as-dialog", async (_event, suggestedName?: string) => {
  const win = mainWindow;
  if (!win) return { path: null, error: "No window" };
  try {
    const result = await dialog.showSaveDialog(win, {
      title: "Save As",
      defaultPath: suggestedName || "Untitled.txt",
      filters: [{ name: "All Files", extensions: ["*"] }],
    });
    if (result.canceled || !result.filePath) {
      return { path: null, error: null };
    }
    return { path: result.filePath, error: null };
  } catch (err) {
    return { path: null, error: String(err) };
  }
});

ipcMain.handle("open-file-dialog", async () => {
  const win = mainWindow;
  if (!win) return null;
  try {
    const result = await dialog.showOpenDialog(win, {
      title: "Open File",
      properties: ["openFile"],
      filters: [{ name: "All Files", extensions: ["*"] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    const buf = fs.readFileSync(filePath);
    const content = buf.includes(0) ? "" : buf.toString("utf8");
    return { filePath, content };
  } catch {
    return null;
  }
});

ipcMain.handle("write-file", (_event, filePath: string, content: string) => {
  try {
    fs.writeFileSync(filePath, content, "utf8");
    // Phase 16: a saved file changes what a workspace search would find, so the
    // memoised search results are dropped on every write.
    invalidateSearchCache();
    return { error: null };
  } catch (err) {
    return { error: String(err) };
  }
});

app.whenReady().then(() => {
  createWindow();
  const args = process.argv.slice();
  for (const arg of args) {
    if (arg.startsWith("--") || arg.endsWith(".exe")) continue;
    if (fs.existsSync(arg) && fs.statSync(arg).isDirectory()) {
      setTimeout(() => openWorkspaceByPath(arg), 1000);
      break;
    }
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Phase 17: crash recovery — if the renderer dies while there is a
// saved session with dirty tabs, offer to restore it on next launch.
function maybeSaveRecovery(): void {
  try {
    const session = loadSession();
    if (session && session.tabs.some((t) => t.dirty)) {
      const recoveryPath = path.join(app.getPath("userData"), "recovery.json");
      fs.writeFileSync(recoveryPath, JSON.stringify(session), "utf-8");
    }
  } catch {}
}

// --- Renderer crash handling (Phase 17) ---
function registerCrashHandlers(win: BrowserWindow): void {
  const wc = win.webContents as NodeJS.EventEmitter;
  wc.on("render-process-gone", (_e, details: Electron.RenderProcessGoneDetails) => {
    logError({
      timestamp: Date.now(), process: "main",
      type: "render-process-gone",
      message: `Renderer process gone: ${details.reason}`,
      stack: JSON.stringify(details),
    });
    maybeSaveRecovery();
    const w = BrowserWindow.fromWebContents(win.webContents);
    if (w) w.webContents.loadURL(`data:text/html,<h1>Something went wrong.</h1><p>The editor crashed. <button id="r">Reload</button><p><button id="d">Dismiss</button>`);
  });
  wc.on("child-process-gone", (_e, details: { reason: string; type?: string; exitCode?: number; killed?: boolean } | null) => {
    logError({
      timestamp: Date.now(), process: "main",
      type: "child-process-gone",
      message: `Child process gone: ${details?.reason ?? "unknown"}`,
      stack: JSON.stringify(details),
    });
  });
  wc.on("crashed", () => {
    logError({ timestamp: Date.now(), process: "main", type: "crash",
      message: "Renderer process crashed" });
    maybeSaveRecovery();
  });
}

// --- Process-level error capture (Phase 17) ---
function registerErrorCapture(): void {
  process.on("uncaughtException", (err) => {
    logError({ timestamp: Date.now(), process: "main", type: "uncaught",
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined });
  });
  process.on("unhandledRejection", (reason) => {
    logError({ timestamp: Date.now(), process: "main", type: "unhandled",
      message: reason instanceof Error ? reason.message : String(reason) });
  });
}

app.on("before-quit", async () => {
  // Save the full session so a restart can restore it.
  try {
    const session = loadSession();
    if (session) {
      const recoveryPath = path.join(app.getPath("userData"), "recovery.json");
      fs.writeFileSync(recoveryPath, JSON.stringify(session), "utf-8");
    }
  } catch {}
  try {
    const { killAllTerminals } = require("./services/terminal");
    killAllTerminals();
  } catch {}
  try { void stopDebugger(); } catch {}
  // Phase 30. MCP children are processes too; they do not outlive the app.
  try { void shutdownMcpServers(); } catch {}
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Register after window creation so the handlers have a window to bind.
registerSessionIpc();
registerTaskIpc();
registerMcpIpc();
registerSkillsIpc();
registerCollaborationIpc();
registerCloudIpc();
registerCompanionIpc();
registerAppPreviewIpc();
registerCrashReporterIpc();
registerVerificationIpc();
registerProjectHealthDataEngineIpc();
registerMultiAgentIpc();
registerTestGeneratorIpc();
registerSecurityGuardianIpc();
registerUiDebuggerIpc();
registerBrowserAgentIpc();
registerDependencyDoctorIpc();
registerProjectMapIpc();
registerProjectHealthIpc();
registerProjectBrainIpc();
registerResearchIpc();
registerCommandIpc();
registerModelManagerIpc();
registerErrorCapture();

// Phase 30. Connect enabled MCP servers in the background. Each gets its own
// timeout; a failure lands in the server's `failed` state, never in the app's
// startup path — a broken server must not keep the editor from opening.
void warmupMcpServers();