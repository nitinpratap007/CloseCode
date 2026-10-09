import { registerCommand, unregisterCommand, type CommandId } from "./registry";
import { formatViaMonaco } from "../formatter/manager";

export interface AppCommandDeps {
  openFile: () => unknown;
  openFolder: () => unknown;
  closeFolder: () => unknown;
  save: () => unknown;
  saveAs: () => unknown;
  saveAll: () => unknown;
  closeTab: () => unknown;
  closeAllTabs: () => unknown;
  toggleExplorer: () => unknown;
  toggleSidebar: () => unknown;
  toggleSearch: () => unknown;
  toggleTerminal: () => unknown;
  viewProblems: () => unknown;
  showGit: () => unknown;
  openSettings: () => unknown;
  togglePalette: () => unknown;
  showDebug: () => unknown;
  debugContinue: () => unknown;
  debugStop: () => unknown;
  debugPause: () => unknown;
  debugStepOver: () => unknown;
  debugStepInto: () => unknown;
  debugStepOut: () => unknown;
  toggleBreakpoint: () => unknown;
  showDebugConsole: () => unknown;
  showAi: () => unknown;
  showExtensions: () => unknown;
  openThemePicker: () => unknown;
  cycleTheme: () => unknown;
}

function triggerMonaco(actionId: string): void {
  const ed = (window as unknown as Record<string, unknown>).__monacoEditor as import("monaco-editor").editor.IStandaloneCodeEditor | undefined;
  if (!ed) return;
  ed.focus();
  const action = ed.getAction(actionId);
  if (action) void action.run();
  else ed.trigger("keyboard", actionId, {});
}

export function registerAppCommands(deps: AppCommandDeps): () => void {
  const ids: CommandId[] = [];

  const reg = (id: CommandId, title: string, shortcut: string, description: string, execute: () => unknown): void => {
    registerCommand({ id, title, shortcut, description, execute });
    ids.push(id);
  };

  reg("open-file", "Open File", "Ctrl+O", "Open a file (Ctrl+O)", () => deps.openFile());
  reg("open-folder", "Open Folder", "Ctrl+Shift+O", "Open a folder (Ctrl+Shift+O)", () => deps.openFolder());
  reg("close-folder", "Close Folder", "Ctrl+K W", "Close the current folder and clear the restored session", () => deps.closeFolder());
  reg("save", "Save", "Ctrl+S", "Save the active file (Ctrl+S)", () => deps.save());
  reg("save-as", "Save As", "Ctrl+Shift+S", "Save As… (Ctrl+Shift+S)", () => deps.saveAs());
  reg("save-all", "Save All", "Ctrl+K S", "Save all dirty files (Ctrl+K S)", () => deps.saveAll());
  reg("close-tab", "Close Tab", "Ctrl+W", "Close the active tab (Ctrl+W)", () => deps.closeTab());
  reg("close-all-tabs", "Close All Tabs", "Ctrl+Shift+W", "Close all tabs (Ctrl+Shift+W)", () => deps.closeAllTabs());
  reg("toggle-sidebar", "Toggle Sidebar", "Ctrl+B", "Toggle the sidebar (Ctrl+B)", () => deps.toggleSidebar());
  reg("toggle-explorer", "Toggle Explorer", "Ctrl+Shift+E", "Toggle the explorer (Ctrl+Shift+E)", () => deps.toggleExplorer());
  reg("toggle-terminal", "Toggle Terminal", "Ctrl+`", "Toggle the integrated terminal (Ctrl+`)", () => deps.toggleTerminal());
  reg("find", "Find", "Ctrl+F", "Find in file (Ctrl+F)", () => triggerMonaco("actions.find"));
  reg("replace", "Replace", "Ctrl+H", "Replace in file (Ctrl+H)", () => triggerMonaco("editor.action.startFindReplaceAction"));
  reg("search-workspace", "Search: Find in Files", "Ctrl+Shift+F", "Search across workspace (Ctrl+Shift+F)", () => deps.toggleSearch());
  reg("replace-workspace", "Search: Replace in Files", "Ctrl+Shift+H", "Replace across workspace (Ctrl+Shift+H)", () => deps.toggleSearch());
  reg("go-to-line", "Go to Line", "Ctrl+G", "Go to line (Ctrl+G)", () => triggerMonaco("editor.action.gotoLine"));
  reg("go-to-symbol", "Go to Symbol", "Ctrl+T", "Go to symbol (Ctrl+T)", () => triggerMonaco("editor.action.quickOutline"));
  reg("go-to-definition", "Go to Definition", "F12", "Go to definition (F12)", () => triggerMonaco("editor.action.revealDefinition"));
  reg("find-references", "Find References", "Shift+F12", "Find references (Shift+F12)", () => triggerMonaco("editor.action.referenceSearch.trigger"));
  reg("rename-symbol", "Rename Symbol", "F2", "Rename symbol (F2)", () => triggerMonaco("editor.action.rename"));
  reg("show-hover", "Show Hover", "Ctrl+K Ctrl+I", "Show hover information (Ctrl+K Ctrl+I)", () => triggerMonaco("editor.action.showHover"));
  reg("trigger-completion", "Trigger Completion", "Ctrl+Space", "Trigger completion (Ctrl+Space)", () => triggerMonaco("editor.action.triggerSuggest"));
  reg("trigger-signature-help", "Trigger Signature Help", "Ctrl+Shift+Space", "Trigger signature help (Ctrl+Shift+Space)", () => triggerMonaco("editor.action.triggerParameterHints"));
  reg("view-problems", "View: Problems", "Ctrl+Shift+M", "View problems (Ctrl+Shift+M)", () => deps.viewProblems());
  reg("format-document", "Format Document", "Shift+Alt+F", "Format the document (Shift+Alt+F)", async () => {
    // Try formatter manager first (prettier/monaco), fallback to Monaco action
    const ok = await formatViaMonaco();
    if (!ok) triggerMonaco("editor.action.formatDocument");
  });
  reg("git-status", "Git Status", "Ctrl+Shift+G", "Show Git status", () => deps.showGit());
  reg("settings", "Settings", "Ctrl+,", "Open settings (Ctrl+,)", () => deps.openSettings());

  // --- Debug (Phase 10) ---
  reg("debug-continue", "Debug: Continue / Start", "F5", "Start or continue debugging (F5)", () => deps.debugContinue());
  reg("debug-stop", "Debug: Stop", "Shift+F5", "Stop debugging (Shift+F5)", () => deps.debugStop());
  reg("debug-pause", "Debug: Pause", "", "Pause the debuggee", () => deps.debugPause());
  reg("debug-step-over", "Debug: Step Over", "F10", "Step over (F10)", () => deps.debugStepOver());
  reg("debug-step-into", "Debug: Step Into", "F11", "Step into (F11)", () => deps.debugStepInto());
  reg("debug-step-out", "Debug: Step Out", "Shift+F11", "Step out (Shift+F11)", () => deps.debugStepOut());
  reg("toggle-breakpoint", "Debug: Toggle Breakpoint", "F9", "Toggle a breakpoint at the cursor (F9)", () => deps.toggleBreakpoint());
  reg("debug-console", "Debug: Debug Console", "Ctrl+Shift+Y", "Show the debug console (Ctrl+Shift+Y)", () => deps.showDebugConsole());
  reg("debug-view", "Debug: Run and Debug", "Ctrl+Shift+D", "Show the Run and Debug view (Ctrl+Shift+D)", () => deps.showDebug());

  // --- AI (Phase 11) ---
  reg("ai-view", "AI: Toggle Assistant", "Ctrl+Shift+A", "Open or close the AI assistant panel (Ctrl+Shift+A)", () => deps.showAi());

  // --- Extensions (Phase 13) ---
  reg("extensions-view", "Extensions: Show", "", "Open the Extensions view", () => deps.showExtensions());

  // --- Themes (Phase 15) ---
  reg("theme-picker", "Themes: Browse", "", "Open the theme picker (workbench + editor + accent)", () => deps.openThemePicker());
  reg("theme-cycle", "Themes: Cycle Workbench Theme", "Ctrl+Shift+T", "Cycle the workbench theme: Dark → Light → System (Ctrl+Shift+T)", () => deps.cycleTheme());

  // Quick open via palette is Ctrl+P — palette itself handles it, but we also expose open-file there
  // Palette open is Ctrl+Shift+P / F1 / Ctrl+P — handled by App's palette state, not a registered command execute

  return () => {
    for (const id of ids) {
      try { unregisterCommand(id); } catch {}
    }
  };
}

// Helper for TitleBar / tests to discover commands
export function triggerFind(): void { triggerMonaco("actions.find"); }
export function triggerReplace(): void { triggerMonaco("editor.action.startFindReplaceAction"); }
