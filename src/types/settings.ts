export interface EditorSettings {
  theme: "dark" | "light" | "system";
  fontSize: number;
  fontFamily: string;
  tabSize: number;
  wordWrap: "off" | "on" | "wordWrapColumn" | "bounded";
  minimap: boolean;
  lineNumbers: boolean;
  showHiddenFiles: boolean;
  fileExcludes: string[];
  autoSave: "off" | "afterDelay";
  autoSaveDelay: number;
  formatOnSave: boolean;
  defaultFormatter: string; // "auto" | "monaco" | "prettier" | ...
  // Phase 14 additions (mirror electron Settings so getSettings() is assignable)
  cursorBlinking: "blink" | "smooth" | "phase" | "expand" | "solid";
  bracketPairColorization: boolean;
  smoothScrolling: boolean;
  mouseWheelZoom: boolean;
  autoClosingBrackets: "always" | "languageDefined" | "beforeWhitespace" | "never";
  fontLigatures: boolean;
  showStatusBar: boolean;
  // Phase 15 additions
  editorTheme: string;
  accentColor: string;
  terminalFontSize: number;
  terminalCursorBlink: boolean;
  terminalScrollback: number;
  shellPath: string;
  gitEnabled: boolean;
  gitAutoRefresh: boolean;
  languageAutoDetect: boolean;
  defaultLanguage: string;
  formatOnPaste: boolean;
  extensionsDeveloperMode: boolean;
  workspaceExtensionDiscovery: boolean;
  rememberRecentProjects: boolean;
  aiContextAutoInclude: boolean;
  largeFileThreshold: number;
  contentCacheMax: number;
  searchDebounceMs: number;
}

export interface AppInfo {
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
}

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface Tab {
  path: string;
  name: string;
  dirty: boolean;
  size: number;
}

export interface RecentProject {
  path: string;
  name: string;
  lastOpened: number;
}

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  theme: "dark",
  fontSize: 14,
  fontFamily: "Cascadia Code, Fira Code, Consolas, monospace",
  tabSize: 2,
  wordWrap: "off",
  minimap: true,
  lineNumbers: true,
  showHiddenFiles: true,
  fileExcludes: [],
  autoSave: "off",
  autoSaveDelay: 1000,
  formatOnSave: false,
  defaultFormatter: "auto",
  cursorBlinking: "blink",
  bracketPairColorization: true,
  smoothScrolling: false,
  mouseWheelZoom: false,
  autoClosingBrackets: "languageDefined",
  fontLigatures: true,
  showStatusBar: true,
  editorTheme: "auto",
  accentColor: "",
  terminalFontSize: 13,
  terminalCursorBlink: true,
  terminalScrollback: 5000,
  shellPath: "",
  gitEnabled: true,
  gitAutoRefresh: true,
  languageAutoDetect: true,
  defaultLanguage: "plaintext",
  formatOnPaste: false,
  extensionsDeveloperMode: true,
  workspaceExtensionDiscovery: true,
  rememberRecentProjects: true,
  aiContextAutoInclude: false,
  largeFileThreshold: 5,
  contentCacheMax: 30,
  searchDebounceMs: 300,
};