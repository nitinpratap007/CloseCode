// Close Code — Settings service (Phase 14)
// Schema-driven settings with three scopes:
//   defaults  -> compiled from SETTING_DEFINITIONS
//   user      -> userData/settings.json (global)
//   workspace -> <workspace>/.closecode/settings.json (per-project)
// Effective value = defaults < user < workspace.
// All existing keys (theme, fontSize, ...) are preserved so every consumer
// and previous integration test keeps working; new settings are flat ids too.

import { app } from "electron";
import fs from "fs";
import path from "path";

export type SettingValue = string | number | boolean | string[];
export type SettingType = "boolean" | "number" | "enum" | "string" | "stringArray";

export interface SettingChoice {
  value: string;
  label: string;
}

export interface SettingDefinition {
  id: string;
  category: string;
  label: string;
  description: string;
  type: SettingType;
  default?: SettingValue;
  options?: SettingChoice[];
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  external?: "ai";
  keywords?: string[];
}

export interface SettingsCategory {
  id: string;
  label: string;
  description: string;
}

export interface SettingsSnapshot {
  defaults: Record<string, SettingValue>;
  user: Record<string, SettingValue>;
  workspace: Record<string, SettingValue>;
  effective: Record<string, SettingValue>;
}

export interface AppSettings {
  // Editor
  fontSize: number;
  fontFamily: string;
  tabSize: number;
  wordWrap: "off" | "on" | "wordWrapColumn" | "bounded";
  minimap: boolean;
  lineNumbers: boolean;
  cursorBlinking: "blink" | "smooth" | "phase" | "expand" | "solid";
  bracketPairColorization: boolean;
  smoothScrolling: boolean;
  mouseWheelZoom: boolean;
  autoClosingBrackets: "always" | "languageDefined" | "beforeWhitespace" | "never";
  // Appearance
  theme: "dark" | "light" | "system";
  editorTheme: string;
  accentColor: string;
  fontLigatures: boolean;
  showStatusBar: boolean;
  // Files
  showHiddenFiles: boolean;
  fileExcludes: string[];
  autoSave: "off" | "afterDelay";
  autoSaveDelay: number;
  // Terminal
  terminalFontSize: number;
  terminalCursorBlink: boolean;
  terminalScrollback: number;
  shellPath: string;
  // Git
  gitEnabled: boolean;
  gitAutoRefresh: boolean;
  // Language
  languageAutoDetect: boolean;
  defaultLanguage: string;
  // Formatting
  defaultFormatter: string;
  formatOnSave: boolean;
  formatOnPaste: boolean;
  // Extensions
  extensionsDeveloperMode: boolean;
  workspaceExtensionDiscovery: boolean;
  // Privacy
  rememberRecentProjects: boolean;
  aiContextAutoInclude: boolean;
  // Performance
  largeFileThreshold: number; // MB
  contentCacheMax: number;
  searchDebounceMs: number;
}

export const SETTING_CATEGORIES: SettingsCategory[] = [
  { id: "editor", label: "Editor", description: "Typerwriter behavior, cursor, and editing options" },
  { id: "appearance", label: "Appearance", description: "Theme and chrome" },
  { id: "files", label: "Files", description: "Auto-save, hidden files, and explorer exclusions" },
  { id: "terminal", label: "Terminal", description: "Integrated terminal look and shell" },
  { id: "git", label: "Git", description: "Source control behavior" },
  { id: "language", label: "Language", description: "Language detection and default language" },
  { id: "formatting", label: "Formatting", description: "Formatters and format-on-save/paste" },
  { id: "ai", label: "AI", description: "AI assistant provider configuration (secured)" },
  { id: "extensions", label: "Extensions", description: "Extension system behavior" },
  { id: "privacy", label: "Privacy", description: "Data retention and privacy defaults" },
  { id: "performance", label: "Performance", description: "Editor performance thresholds" },
];

const CATEGORY = { editor: "editor", appearance: "appearance", files: "files", terminal: "terminal", git: "git", language: "language", formatting: "formatting", ai: "ai", extensions: "extensions", privacy: "privacy", performance: "performance" } as const;

export const DEFAULT_SETTINGS: AppSettings = {
  // Editor
  fontSize: 14,
  fontFamily: "Cascadia Code, Fira Code, Consolas, monospace",
  tabSize: 2,
  wordWrap: "off",
  minimap: true,
  lineNumbers: true,
  cursorBlinking: "blink",
  bracketPairColorization: true,
  smoothScrolling: false,
  mouseWheelZoom: false,
  autoClosingBrackets: "languageDefined",
  // Appearance
  theme: "dark",
  editorTheme: "auto",
  accentColor: "",
  fontLigatures: true,
  showStatusBar: true,
  // Files
  showHiddenFiles: true,
  fileExcludes: [],
  autoSave: "off",
  autoSaveDelay: 1000,
  // Terminal
  terminalFontSize: 13,
  terminalCursorBlink: true,
  terminalScrollback: 5000,
  shellPath: "",
  // Git
  gitEnabled: true,
  gitAutoRefresh: true,
  // Language
  languageAutoDetect: true,
  defaultLanguage: "plaintext",
  // Formatting
  defaultFormatter: "auto",
  formatOnSave: false,
  formatOnPaste: false,
  // Extensions
  extensionsDeveloperMode: true,
  workspaceExtensionDiscovery: true,
  // Privacy
  rememberRecentProjects: true,
  aiContextAutoInclude: false,
  // Performance
  largeFileThreshold: 5,
  contentCacheMax: 30,
  searchDebounceMs: 300,
};

export const SETTING_DEFINITIONS: SettingDefinition[] = [
  // ---- Editor ----
  { id: "fontSize", category: CATEGORY.editor, label: "Font Size", description: "Editor font size in pixels.", type: "number", default: DEFAULT_SETTINGS.fontSize, min: 8, max: 32, step: 1, keywords: ["font", "text", "size"] },
  { id: "fontFamily", category: CATEGORY.editor, label: "Font Family", description: "Monospace font stack used in the editor.", type: "string", default: DEFAULT_SETTINGS.fontFamily, keywords: ["font", "monospace", "font family"] },
  { id: "tabSize", category: CATEGORY.editor, label: "Tab Size", description: "Number of spaces per tab indentation.", type: "number", default: DEFAULT_SETTINGS.tabSize, min: 1, max: 8, step: 1, keywords: ["indent", "tab", "space"] },
  { id: "wordWrap", category: CATEGORY.editor, label: "Word Wrap", description: "Control when lines wrap.", type: "enum", default: DEFAULT_SETTINGS.wordWrap, options: [
    { value: "off", label: "Off" },
    { value: "on", label: "On" },
    { value: "wordWrapColumn", label: "At column" },
    { value: "bounded", label: "Bounded" },
  ], keywords: ["wrap", "line break"] },
  { id: "minimap", category: CATEGORY.editor, label: "Minimap", description: "Show the minimap code overview.", type: "boolean", default: DEFAULT_SETTINGS.minimap, keywords: ["overview", "map"] },
  { id: "lineNumbers", category: CATEGORY.editor, label: "Line Numbers", description: "Show line numbers in the gutter.", type: "boolean", default: DEFAULT_SETTINGS.lineNumbers, keywords: ["gutter", "line count"] },
  { id: "cursorBlinking", category: CATEGORY.editor, label: "Cursor Blinking", description: "Animation style of the text cursor.", type: "enum", default: DEFAULT_SETTINGS.cursorBlinking, options: [
    { value: "blink", label: "Blink" },
    { value: "smooth", label: "Smooth" },
    { value: "phase", label: "Phase" },
    { value: "expand", label: "Expand" },
    { value: "solid", label: "Solid" },
  ], keywords: ["cursor", "blink"] },
  { id: "bracketPairColorization", category: CATEGORY.editor, label: "Bracket Pair Colorization", description: "Colorize matching bracket pairs.", type: "boolean", default: DEFAULT_SETTINGS.bracketPairColorization, keywords: ["bracket", "color", "rainbow"] },
  { id: "smoothScrolling", category: CATEGORY.editor, label: "Smooth Scrolling", description: "Animate editor scrolling.", type: "boolean", default: DEFAULT_SETTINGS.smoothScrolling, keywords: ["scroll", "animation"] },
  { id: "mouseWheelZoom", category: CATEGORY.editor, label: "Mouse Wheel Zoom", description: "Zoom the editor with Ctrl + mouse wheel.", type: "boolean", default: DEFAULT_SETTINGS.mouseWheelZoom, keywords: ["zoom", "scroll ctrl"] },
  { id: "autoClosingBrackets", category: CATEGORY.editor, label: "Auto-Closing Brackets", description: "Automatically close brackets and quotes.", type: "enum", default: DEFAULT_SETTINGS.autoClosingBrackets, options: [
    { value: "always", label: "Always" },
    { value: "languageDefined", label: "Language defined" },
    { value: "beforeWhitespace", label: "Before whitespace" },
    { value: "never", label: "Never" },
  ], keywords: ["bracket", "autoclose", "quotes", "typing"] },
  // ---- Appearance ----
  { id: "theme", category: CATEGORY.appearance, label: "Theme", description: "Color theme of the whole editor.", type: "enum", default: DEFAULT_SETTINGS.theme, options: [
    { value: "dark", label: "Dark" },
    { value: "light", label: "Light" },
    { value: "system", label: "System" },
  ], keywords: ["color", "dark", "light", "appearance"] },
  { id: "fontLigatures", category: CATEGORY.appearance, label: "Font Ligatures", description: "Render programming ligatures where the font supports them.", type: "boolean", default: DEFAULT_SETTINGS.fontLigatures, keywords: ["font", "ligature", "fira"] },
  { id: "showStatusBar", category: CATEGORY.appearance, label: "Status Bar", description: "Show the status bar at the bottom.", type: "boolean", default: DEFAULT_SETTINGS.showStatusBar, keywords: ["status", "bottom bar"] },
  { id: "editorTheme", category: CATEGORY.appearance, label: "Editor Theme", description: "Syntax/editor color theme. \"Auto\" follows the workbench theme.", type: "enum", default: DEFAULT_SETTINGS.editorTheme, options: [
    { value: "auto", label: "Auto (follow workbench)" },
    { value: "cc-dark", label: "CloseCode Dark" },
    { value: "cc-light", label: "CloseCode Light" },
    { value: "cc-catppuccin", label: "Catppuccin Mocha" },
    { value: "cc-aurora", label: "Aurora" },
  ], keywords: ["theme", "syntax", "color", "monaco", "editor theme"] },
  { id: "accentColor", category: CATEGORY.appearance, label: "Accent Color", description: "Workbench accent (buttons, highlights, active items). Empty = theme default.", type: "string", default: DEFAULT_SETTINGS.accentColor, placeholder: "#89b4fa", keywords: ["accent", "color", "highlight", "brand"] },
  // ---- Files ----
  { id: "showHiddenFiles", category: CATEGORY.files, label: "Show Hidden Files", description: "Show dotfiles and hidden entries in the explorer and search.", type: "boolean", default: DEFAULT_SETTINGS.showHiddenFiles, keywords: ["dotfiles", "hidden", ".git"] },
  { id: "fileExcludes", category: CATEGORY.files, label: "Explorer Excludes", description: "Comma-separated globs hidden from the explorer (in addition to built-in defaults).", type: "stringArray", default: DEFAULT_SETTINGS.fileExcludes, keywords: ["exclude", "ignore", "filter"] },
  { id: "autoSave", category: CATEGORY.files, label: "Auto Save", description: "Save dirty files automatically.", type: "enum", default: DEFAULT_SETTINGS.autoSave, options: [
    { value: "off", label: "Off" },
    { value: "afterDelay", label: "After delay" },
  ], keywords: ["save", "autosave"] },
  { id: "autoSaveDelay", category: CATEGORY.files, label: "Auto Save Delay (ms)", description: "Delay before an auto-save kicks in.", type: "number", default: DEFAULT_SETTINGS.autoSaveDelay, min: 300, max: 10000, step: 100, keywords: ["save", "delay", "ms"] },
  // ---- Terminal ----
  { id: "terminalFontSize", category: CATEGORY.terminal, label: "Terminal Font Size", description: "Font size inside the integrated terminal.", type: "number", default: DEFAULT_SETTINGS.terminalFontSize, min: 8, max: 32, step: 1, keywords: ["font", "size", "xterm"] },
  { id: "terminalCursorBlink", category: CATEGORY.terminal, label: "Terminal Cursor Blink", description: "Blink the terminal cursor.", type: "boolean", default: DEFAULT_SETTINGS.terminalCursorBlink, keywords: ["cursor", "blink", "xterm"] },
  { id: "terminalScrollback", category: CATEGORY.terminal, label: "Terminal Scrollback", description: "Lines of terminal history kept in memory.", type: "number", default: DEFAULT_SETTINGS.terminalScrollback, min: 100, max: 100000, step: 100, keywords: ["scrollback", "history", "buffer"] },
  { id: "shellPath", category: CATEGORY.terminal, label: "Terminal Shell Path", description: "Explicit shell executable for new terminals (empty = auto-detect).", type: "string", default: DEFAULT_SETTINGS.shellPath, keywords: ["shell", "cmd", "powershell", "bash"] },
  // ---- Git ----
  { id: "gitEnabled", category: CATEGORY.git, label: "Git Integration", description: "Enable the source-control features.", type: "boolean", default: DEFAULT_SETTINGS.gitEnabled, keywords: ["git", "source control", "scm"] },
  { id: "gitAutoRefresh", category: CATEGORY.git, label: "Auto Refresh", description: "Periodically refresh the repository status while the Git panel is open.", type: "boolean", default: DEFAULT_SETTINGS.gitAutoRefresh, keywords: ["refresh", "status", "poll"] },
  // ---- Language ----
  { id: "languageAutoDetect", category: CATEGORY.language, label: "Auto-Detect Language", description: "Detect the language from the file extension.", type: "boolean", default: DEFAULT_SETTINGS.languageAutoDetect, keywords: ["detect", "language", "extension"] },
  { id: "defaultLanguage", category: CATEGORY.language, label: "Default Language", description: "Language used when auto-detection is off or the extension is unknown.", type: "enum", default: DEFAULT_SETTINGS.defaultLanguage, options: [
    { value: "plaintext", label: "Plain Text" },
    { value: "javascript", label: "JavaScript" },
    { value: "typescript", label: "TypeScript" },
    { value: "python", label: "Python" },
    { value: "json", label: "JSON" },
    { value: "html", label: "HTML" },
    { value: "css", label: "CSS" },
    { value: "markdown", label: "Markdown" },
    { value: "xml", label: "XML" },
    { value: "yaml", label: "YAML" },
  ], keywords: ["language", "fallback", "plain text"] },
  // ---- Formatting ----
  { id: "defaultFormatter", category: CATEGORY.formatting, label: "Default Formatter", description: "Formatter used by Format Document (auto prefers Prettier when installed).", type: "enum", default: DEFAULT_SETTINGS.defaultFormatter, options: [
    { value: "auto", label: "Auto" },
    { value: "monaco", label: "Monaco (built-in)" },
    { value: "prettier", label: "Prettier" },
    { value: "eslint", label: "ESLint" },
  ], keywords: ["format", "prettier", "eslint", "formatter"] },
  { id: "formatOnSave", category: CATEGORY.formatting, label: "Format on Save", description: "Run the default formatter whenever a file is saved.", type: "boolean", default: DEFAULT_SETTINGS.formatOnSave, keywords: ["format", "save"] },
  { id: "formatOnPaste", category: CATEGORY.formatting, label: "Format on Paste", description: "Run the editor formatter after pasting text.", type: "boolean", default: DEFAULT_SETTINGS.formatOnPaste, keywords: ["format", "paste"] },
  // ---- Extensions ----
  { id: "extensionsDeveloperMode", category: CATEGORY.extensions, label: "Developer Mode", description: "Show invalid/incompatible extensions and error details in the Extensions panel.", type: "boolean", default: DEFAULT_SETTINGS.extensionsDeveloperMode, keywords: ["extensions", "developer", "debug"] },
  { id: "workspaceExtensionDiscovery", category: CATEGORY.extensions, label: "Workspace Extensions", description: "Discover extensions from the workspace .closecode/extensions folder.", type: "boolean", default: DEFAULT_SETTINGS.workspaceExtensionDiscovery, keywords: ["workspace", "discovery", ".closecode"] },
  // ---- AI (external: values owned by the AI config service) ----
  { id: "ai.provider", category: CATEGORY.ai, label: "AI Provider", description: "Which AI backend the assistant uses.", type: "enum", external: "ai", default: "local", options: [
    { value: "local", label: "Local AI" },
    { value: "openai", label: "OpenAI-compatible" },
    { value: "custom", label: "Custom" },
  ], keywords: ["ai", "provider", "model"] },
  { id: "ai.model", category: CATEGORY.ai, label: "Model", description: "Model id used with the OpenAI-compatible provider.", type: "string", external: "ai", default: "", keywords: ["ai", "model", "openai"] },
  { id: "ai.baseUrl", category: CATEGORY.ai, label: "Base URL", description: "OpenAI-compatible endpoint (a /v1 is appended if missing).", type: "string", external: "ai", default: "https://api.openai.com/v1", keywords: ["ai", "url", "endpoint", "openai"] },
  { id: "ai.localBaseUrl", category: CATEGORY.ai, label: "Local Base URL", description: "Local runtime endpoint (Ollama / LM Studio / Jan).", type: "string", external: "ai", default: "http://127.0.0.1:11434", keywords: ["ai", "local", "ollama", "lm studio"] },
  { id: "ai.localModel", category: CATEGORY.ai, label: "Local Model", description: "Model id for the local runtime.", type: "string", external: "ai", default: "", keywords: ["ai", "local", "model"] },
  { id: "ai.stream", category: CATEGORY.ai, label: "Stream Responses", description: "Stream AI replies token-by-token.", type: "boolean", external: "ai", default: true, keywords: ["ai", "stream", "sse"] },
  { id: "ai.toolMode", category: CATEGORY.ai, label: "Tool Mode", description: "Chat ignores tools; Agent lets the assistant call workspace tools with your approval.", type: "enum", external: "ai", default: "chat", options: [
    { value: "chat", label: "Chat" },
    { value: "agent", label: "Agent" },
  ], keywords: ["ai", "agent", "tools"] },
  { id: "ai.temperature", category: CATEGORY.ai, label: "Temperature", description: "Sampling temperature (0 = deterministic).", type: "number", external: "ai", default: 0.2, min: 0, max: 2, step: 0.1, keywords: ["ai", "temperature", "creativity"] },
  // ---- Privacy ----
  { id: "rememberRecentProjects", category: CATEGORY.privacy, label: "Remember Recent Projects", description: "Persist and show recently opened folders.", type: "boolean", default: DEFAULT_SETTINGS.rememberRecentProjects, keywords: ["recent", "history", "projects"] },
  { id: "aiContextAutoInclude", category: CATEGORY.privacy, label: "AI: Auto-include context", description: "Default AI context bundles to ON (diagnostics + other open files). Nothing is ever sent without being visible in the AI panel.", type: "boolean", default: DEFAULT_SETTINGS.aiContextAutoInclude, keywords: ["ai", "context", "privacy", "telemetry"] },
  // ---- Performance ----
  { id: "largeFileThreshold", category: CATEGORY.performance, label: "Large File Threshold (MB)", description: "Files larger than this open read-only with a warning.", type: "number", default: DEFAULT_SETTINGS.largeFileThreshold, min: 1, max: 100, step: 1, keywords: ["large file", "read only", "mb"] },
  { id: "contentCacheMax", category: CATEGORY.performance, label: "Content Cache (files)", description: "Maximum file contents kept in memory (LRU).", type: "number", default: DEFAULT_SETTINGS.contentCacheMax, min: 2, max: 100, step: 1, keywords: ["cache", "memory", "lru"] },
  { id: "searchDebounceMs", category: CATEGORY.performance, label: "Search Debounce (ms)", description: "Delay before workspace search starts after typing.", type: "number", default: DEFAULT_SETTINGS.searchDebounceMs, min: 100, max: 2000, step: 50, keywords: ["search", "debounce", "delay"] },
];

const DEFINITION_BY_ID = new Map<string, SettingDefinition>(SETTING_DEFINITIONS.map((d) => [d.id, d]));

// ---------------------------------------------------------------
// Validation
// ---------------------------------------------------------------

function clampNumber(def: SettingDefinition, n: number): number {
  let v = n;
  if (typeof def.min === "number" && v < def.min) v = def.min;
  if (typeof def.max === "number" && v > def.max) v = def.max;
  if (typeof def.step === "number" && Number.isFinite(def.step) && def.step > 0) {
    // snap to step increments from min
    const base = typeof def.min === "number" ? def.min : 0;
    v = base + Math.round((v - base) / def.step) * def.step;
  }
  return Math.round(v * 100) / 100;
}

function coerceValue(def: SettingDefinition, raw: unknown): SettingValue | undefined {
  switch (def.type) {
    case "boolean":
      return typeof raw === "boolean" ? raw : undefined;
    case "number": {
      const n = Number(raw);
      if (typeof raw !== "number" && typeof raw !== "string") return undefined;
      if (!Number.isFinite(n)) return undefined;
      return clampNumber(def, n);
    }
    case "string":
      return typeof raw === "string" ? raw : undefined;
    case "enum": {
      if (typeof raw !== "string") return undefined;
      // Custom theme.json files are user/workspace supplied, so their names
      // cannot be enumerated in the static built-in options. Persist the name
      // and let the renderer resolve it against the live theme registry.
      if (def.id === "editorTheme" && raw.length > 0) return raw;
      if (!def.options) return raw;
      return def.options.some((o) => o.value === raw) ? raw : undefined;
    }
    case "stringArray":
      return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : undefined;
    default:
      return undefined;
  }
}

/** Filter/coerce an arbitrary patch to only known setting ids. `null` removes the key. */
export function sanitizePatch(raw: unknown): Record<string, SettingValue | null> {
  const out: Record<string, SettingValue | null> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const def = DEFINITION_BY_ID.get(id);
    if (!def || def.external) continue;
    if (value === null || value === undefined) {
      out[id] = null; // explicit delete
      continue;
    }
    const coerced = coerceValue(def, value);
    if (coerced !== undefined) out[id] = coerced;
  }
  return out;
}

// ---------------------------------------------------------------
// Storage
// ---------------------------------------------------------------

export function getSettingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

export function getWorkspaceSettingsPath(root: string): string {
  return path.join(root, ".closecode", "settings.json");
}

function readJsonFile(p: string): Record<string, unknown> | null {
  try {
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    }
  } catch {
    // corrupted settings file -> treated as empty
  }
  return null;
}

function writeJsonFile(p: string, data: unknown): void {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.error("Failed to write settings:", err);
  }
}

/** Load + sanitize the user-scope record (never contains unknown keys). */
export function loadUserSettings(): Record<string, SettingValue> {
  const raw = readJsonFile(getSettingsPath());
  if (!raw) return {};
  const out: Record<string, SettingValue> = {};
  for (const [id, value] of Object.entries(sanitizePatch(raw))) {
    if (value !== null) out[id] = value;
  }
  return out;
}

/** Apply a sanitized patch to the user scope (`null` deletes a key). */
export function saveUserSettingsPatch(patch: Record<string, SettingValue | null>): void {
  const current = loadUserSettings();
  const next: Record<string, SettingValue> = {};
  for (const [id, value] of Object.entries(current)) next[id] = value;
  for (const [id, value] of Object.entries(patch)) {
    if (value === null) delete next[id];
    else next[id] = value;
  }
  if (Object.keys(next).length === 0) {
    try { fs.rmSync(getSettingsPath(), { force: true }); } catch { /* ignore */ }
    return;
  }
  writeJsonFile(getSettingsPath(), next);
}

export function resetUserSettings(): void {
  try { fs.rmSync(getSettingsPath(), { force: true }); } catch { /* ignore */ }
}

export function loadWorkspaceSettings(root: string): Record<string, SettingValue> {
  const raw = readJsonFile(getWorkspaceSettingsPath(root));
  if (!raw) return {};
  const out: Record<string, SettingValue> = {};
  for (const [id, value] of Object.entries(sanitizePatch(raw))) {
    if (value !== null) out[id] = value;
  }
  return out;
}

export function saveWorkspaceSettingsPatch(root: string, patch: Record<string, SettingValue | null>): void {
  const current = loadWorkspaceSettings(root);
  const next: Record<string, SettingValue> = {};
  for (const [id, value] of Object.entries(current)) next[id] = value;
  for (const [id, value] of Object.entries(patch)) {
    if (value === null) delete next[id];
    else next[id] = value;
  }
  const file = getWorkspaceSettingsPath(root);
  if (Object.keys(next).length === 0) {
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    return;
  }
  writeJsonFile(file, next);
}

export function resetWorkspaceSettings(root: string): void {
  try { fs.rmSync(getWorkspaceSettingsPath(root), { force: true }); } catch { /* ignore */ }
}

function baseDefaults(): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {};
  for (const def of SETTING_DEFINITIONS) {
    if (def.external) continue;
    if (def.default !== undefined) out[def.id] = def.default;
  }
  return out;
}

/** Effective settings (defaults < user < workspace). Typed full object. */
export function getEffectiveSettings(root: string | null): AppSettings {
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS as unknown as Record<string, unknown> };
  for (const [id, value] of Object.entries(loadUserSettings())) merged[id] = value;
  if (root) {
    for (const [id, value] of Object.entries(loadWorkspaceSettings(root))) merged[id] = value;
  }
  const out = { ...merged } as unknown as AppSettings;
  for (const key of Object.keys(out)) {
    const def = DEFINITION_BY_ID.get(key);
    if (def) {
      const coerced = coerceValue(def, out[key as keyof AppSettings] as unknown);
      if (coerced !== undefined) (out as unknown as Record<string, SettingValue>)[key] = coerced;
    }
  }
  return out;
}

export function getSettingsSnapshot(root: string | null): SettingsSnapshot {
  const defaults = baseDefaults();
  const user = loadUserSettings();
  const workspace = root ? loadWorkspaceSettings(root) : {};
  const merged: Record<string, SettingValue> = { ...defaults };
  for (const [id, value] of Object.entries(user)) merged[id] = value;
  for (const [id, value] of Object.entries(workspace)) merged[id] = value;
  return { defaults, user, workspace, effective: merged };
}

/** List of setting definitions grouped by category (renderer renders dynamically + search). */
export function getSettingCategories(): { categories: SettingsCategory[]; definitions: SettingDefinition[] } {
  return { categories: SETTING_CATEGORIES, definitions: SETTING_DEFINITIONS };
}

// Legacy compat exports used before Phase 14 (keep working).
export function loadSettings(): AppSettings {
  return getEffectiveSettings(null);
}

export function saveSettings(settings: Partial<AppSettings>): void {
  saveUserSettingsPatch(sanitizePatch(settings));
}