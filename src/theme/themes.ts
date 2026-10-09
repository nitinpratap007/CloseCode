// Close Code — Theme engine (Phase 15)
// Built-in editor (Monaco) themes + workbench palettes, custom theme.json
// loading (userData/themes + workspace .closecode/themes), registration,
// resolution (auto = follow workbench) and live CSS-variable application.

import * as monaco from "monaco-editor";

export interface WorkbenchPalette {
  bg: string;
  surface: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  accentHover: string;
  success?: string;
  warning?: string;
  error?: string;
  sidebar?: string;
  statusbar?: string;
}

export interface EditorThemeDef {
  name: string;
  kind: "dark" | "light";
  monaco: monaco.editor.IStandaloneThemeData;
  /** Hex colors. Used for the picker preview; custom themes also live-apply it. */
  workbench?: WorkbenchPalette;
}

const themeColors = (
  bg: string,
  fg: string,
  lineHighlight: string,
  cursor: string,
  selection: string,
  inactiveSelection: string,
  numbers: string,
  numbersActive: string,
  widget: string,
  border: string
): Record<string, string> => ({
  "editor.background": bg,
  "editor.foreground": fg,
  "editor.lineHighlightBackground": lineHighlight,
  "editorCursor.foreground": cursor,
  "editor.selectionBackground": selection,
  "editor.inactiveSelectionBackground": inactiveSelection,
  "editorIndentGuide.background1": border,
  "editor.lineNumbers.foreground": numbers,
  "editor.lineNumbers.activeForeground": numbersActive,
  "editorWidget.background": widget,
  "editorWidget.border": border,
  "editorSuggestWidget.background": widget,
  "editorSuggestWidget.selectedBackground": border,
  "editorSuggestWidget.border": border,
  "editorGutter.background": widget,
  "scrollbarSlider.background": "#45475a66",
  "scrollbarSlider.hoverBackground": "#585b7099",
  "scrollbarSlider.activeBackground": "#585b70",
});

// ---------------------------------------------------------------------------
// Built-in editor themes
// ---------------------------------------------------------------------------
export const BUILTIN_THEMES: EditorThemeDef[] = [
  {
    name: "cc-dark",
    kind: "dark",
    monaco: {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment", foreground: "6c7086", fontStyle: "italic" },
        { token: "keyword", foreground: "cba6f7" },
        { token: "string", foreground: "a6e3a1" },
        { token: "number", foreground: "fab387" },
        { token: "type", foreground: "89b4fa" },
        { token: "function", foreground: "74c7ec" },
        { token: "variable", foreground: "cdd6f4" },
      ],
      colors: themeColors(
        "#1e1e2e",
        "#cdd6f4",
        "#31324455",
        "#89b4fa",
        "#89b4fa33",
        "#89b4fa22",
        "#6c7086",
        "#cdd6f4",
        "#181825",
        "#313244"
      ),
    },
  },
  {
    name: "cc-light",
    kind: "light",
    monaco: {
      base: "vs",
      inherit: true,
      rules: [
        { token: "comment", foreground: "6c7086", fontStyle: "italic" },
        { token: "keyword", foreground: "8839ef" },
        { token: "string", foreground: "40a02b" },
        { token: "number", foreground: "fe640b" },
        { token: "type", foreground: "1e66f5" },
        { token: "function", foreground: "04a5e5" },
        { token: "variable", foreground: "1e1e2e" },
      ],
      colors: themeColors(
        "#ffffff",
        "#1e1e2e",
        "#dce0e866",
        "#1e66f5",
        "#1e66f533",
        "#1e66f522",
        "#9ca0b0",
        "#1e1e2e",
        "#f4f4f7",
        "#d0d4df"
      ),
    },
  },
  {
    name: "cc-catppuccin",
    kind: "dark",
    monaco: {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment", foreground: "6c708696", fontStyle: "italic" },
        { token: "keyword", foreground: "c6a0f6" },
        { token: "string", foreground: "a6da95" },
        { token: "number", foreground: "f5a97f" },
        { token: "type", foreground: "8aadf4" },
        { token: "function", foreground: "91d7e3" },
        { token: "variable", foreground: "cad3f5" },
      ],
      colors: themeColors(
        "#24273a",
        "#cad3f5",
        "#363a4f66",
        "#c6a0f6",
        "#c6a0f633",
        "#c6a0f622",
        "#5b6078",
        "#cad3f5",
        "#1e2030",
        "#363a4f"
      ),
    },
  },
  {
    name: "cc-aurora",
    kind: "dark",
    monaco: {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment", foreground: "64748b", fontStyle: "italic" },
        { token: "keyword", foreground: "c084fc" },
        { token: "string", foreground: "34d399" },
        { token: "number", foreground: "fbbf24" },
        { token: "type", foreground: "38bdf8" },
        { token: "function", foreground: "22d3ee" },
        { token: "variable", foreground: "e2e8f0" },
      ],
      colors: themeColors(
        "#0f172a",
        "#e2e8f0",
        "#1e293b66",
        "#38bdf8",
        "#38bdf833",
        "#38bdf822",
        "#475569",
        "#e2e8f0",
        "#1e293b",
        "#334155"
      ),
    },
  },
];

// ---------------------------------------------------------------------------
// Registration + lookup
// ---------------------------------------------------------------------------
const registered = new Map<string, EditorThemeDef>();

export function registerEditorTheme(def: EditorThemeDef): void {
  monaco.editor.defineTheme(def.name, def.monaco);
  registered.set(def.name, def);
}

export function registerBuiltinThemes(): void {
  for (const def of BUILTIN_THEMES) registerEditorTheme(def);
}

export function isThemeRegistered(name: string): boolean {
  return registered.has(name);
}

export function getRegisteredThemes(): EditorThemeDef[] {
  return [...registered.values()];
}

export function removeCustomTheme(name: string): void {
  // Monaco has no un-define API; builtins always win redefinition anyway. Only
  // forget the lookup entry so a broken custom theme can be re-registered.
  if (!BUILTIN_THEMES.some((b) => b.name === name)) registered.delete(name);
}

// ---------------------------------------------------------------------------
// Custom theme.json → EditorThemeDef (TextMate tokenColors → Monaco rules)
// ---------------------------------------------------------------------------
export interface CustomThemeJson {
  name?: string;
  type?: "dark" | "light";
  colors?: Record<string, string>;
  tokenColors?: Array<{
    scope?: string | string[];
    settings?: { foreground?: string; fontStyle?: string };
  }>;
  /** Direct Monaco theme payload used by the Close Code theme.json format. */
  monaco?: monaco.editor.IStandaloneThemeData;
  workbench?: Partial<Record<keyof WorkbenchPalette, string>>;
}

export function themeFromJson(name: string, json: CustomThemeJson): EditorThemeDef | null {
  if (!json || typeof json !== "object") return null;
  const kind: "dark" | "light" = json.type === "light" ? "light" : "dark";
  const monacoJson = json.monaco;
  const rules: monaco.editor.ITokenThemeRule[] = monacoJson?.rules ?? [];
  // Also accept the VS Code-style tokenColors/colors shape for interoperability.
  if (!monacoJson) {
    for (const entry of json.tokenColors ?? []) {
      const fg = entry.settings?.foreground;
      const fs = entry.settings?.fontStyle;
      if (!fg && !fs) continue;
      const scopes = Array.isArray(entry.scope) ? entry.scope : entry.scope ? [entry.scope] : [];
      for (const scope of scopes) {
        rules.push({
          token: scope,
          ...(fg ? { foreground: fg.replace(/^#/, "") } : {}),
          ...(fs ? { fontStyle: fs } : {}),
        });
      }
    }
  }
  const workbenchJson = json.workbench as Partial<Record<keyof WorkbenchPalette, string>> | undefined;
  return {
    name,
    kind,
    monaco: {
      base: monacoJson?.base ?? (kind === "light" ? "vs" : "vs-dark"),
      inherit: monacoJson?.inherit ?? true,
      rules,
      colors: monacoJson?.colors ?? json.colors ?? {},
    },
    workbench:
      workbenchJson && Object.keys(workbenchJson).length > 0
        ? ({
            bg: workbenchJson.bg ?? (kind === "light" ? "#eff1f5" : "#1e1e2e"),
            surface: workbenchJson.surface ?? (kind === "light" ? "#e6e9ef" : "#252536"),
            border: workbenchJson.border ?? (kind === "light" ? "#ccd0da" : "#313244"),
            text: workbenchJson.text ?? (kind === "light" ? "#4c4f69" : "#cdd6f4"),
            muted: workbenchJson.muted ?? (kind === "light" ? "#6c6f85" : "#6c7086"),
            accent: workbenchJson.accent ?? (kind === "light" ? "#1e66f5" : "#89b4fa"),
            accentHover: workbenchJson.accentHover ?? workbenchJson.accent ?? (kind === "light" ? "#04a5e5" : "#74c7ec"),
            ...(workbenchJson.success ? { success: workbenchJson.success } : {}),
            ...(workbenchJson.warning ? { warning: workbenchJson.warning } : {}),
            ...(workbenchJson.error ? { error: workbenchJson.error } : {}),
            ...(workbenchJson.sidebar ? { sidebar: workbenchJson.sidebar } : {}),
            ...(workbenchJson.statusbar ? { statusbar: workbenchJson.statusbar } : {}),
          } satisfies WorkbenchPalette)
        : undefined,
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------
export function resolveEditorTheme(
  effective: { editorTheme?: unknown; theme?: unknown }
): string {
  const pref = effective?.editorTheme;
  if (pref && pref !== "auto" && typeof pref === "string" && registered.has(pref)) {
    return pref;
  }
  const theme = effective?.theme;
  const isDark =
    theme === "system"
      ? typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
      : theme === "dark";
  return isDark ? "cc-dark" : "cc-light";
}

// ---------------------------------------------------------------------------
// CSS variable application (workbench restyling)
// ---------------------------------------------------------------------------
const VAR_MAP: Array<[keyof WorkbenchPalette, string]> = [
  ["bg", "--cc-bg"],
  ["surface", "--cc-surface"],
  ["border", "--cc-border"],
  ["text", "--cc-text"],
  ["muted", "--cc-muted"],
  ["accent", "--cc-accent"],
  ["accentHover", "--cc-accent-hover"],
  ["success", "--cc-success"],
  ["warning", "--cc-warning"],
  ["error", "--cc-error"],
  ["sidebar", "--cc-sidebar"],
  ["statusbar", "--cc-statusbar"],
];

/** "#rrggbb" / "#rgb" → "r g b", or null when unparseable. */
export function hexToRgbTriplet(hex: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((hex ?? "").trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

/** Apply a full palette to <html> CSS variables. Pass undefined to clear all. */
export function applyPalette(pal: WorkbenchPalette | undefined): void {
  const el = document.documentElement;
  for (const [key, cssVar] of VAR_MAP) {
    if (pal && pal[key]) {
      const triplet = hexToRgbTriplet(pal[key]);
      if (triplet) el.style.setProperty(cssVar, triplet);
      else el.style.removeProperty(cssVar);
    } else {
      el.style.removeProperty(cssVar);
    }
  }
}

/** Apply/clear the user accent override (on top of any theme palette). */
export function applyAccent(color: string): void {
  const el = document.documentElement;
  const triplet = color && hexToRgbTriplet(color);
  if (triplet) {
    el.style.setProperty("--cc-accent", triplet);
    // Slight desaturation for hover reads fine for most accents.
    el.style.setProperty("--cc-accent-hover", triplet);
  } else {
    el.style.removeProperty("--cc-accent");
    el.style.removeProperty("--cc-accent-hover");
  }
}