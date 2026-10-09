// Close Code — Theme store (Phase 15)
// Owns custom-theme discovery/registration, the theme picker modal state, and
// live workbench restyling (custom theme palettes + accent color overrides).

import { create } from "zustand";
import {
  registerEditorTheme,
  themeFromJson,
  getRegisteredThemes,
  applyPalette,
  applyAccent,
  BUILTIN_THEMES,
  type CustomThemeJson,
} from "../theme/themes";
import type { CustomThemeMeta } from "../types/electron";
import { useSettingsStore } from "./settingsStore";

interface ThemeStoreState {
  initialized: boolean;
  customThemes: CustomThemeMeta[];
  pickerOpen: boolean;
  applying: string | null;

  init: () => Promise<void>;
  refreshCustom: () => Promise<void>;
  openPicker: () => void;
  closePicker: () => void;
  /** Apply an editor theme by name (built-in or custom). */
  apply: (name: string) => Promise<void>;
  applyEditorTheme: (name: string) => Promise<void>;
  applyWorkbench: (theme: "dark" | "light" | "system") => Promise<void>;
  /** Set the accent color (hex like "#f38ba8"); "" clears back to the palette default. */
  applyAccent: (hex: string) => Promise<void>;
  cycle: () => Promise<void>;
}

export const useThemeStore = create<ThemeStoreState>((set, get) => ({
  initialized: false,
  customThemes: [],
  pickerOpen: false,
  applying: null,

  async init() {
    const already = get().initialized;
    await get().refreshCustom();
    if (!already) set({ initialized: true });
  },

  async refreshCustom() {
    let metas: CustomThemeMeta[] = [];
    try {
      metas = await window.closeCode.listCustomThemes();
      const seen = new Set<string>();
      for (const meta of metas) {
        if (seen.has(meta.name)) continue; // workspace shadows user
        seen.add(meta.name);
        const res = await window.closeCode.readCustomTheme(meta.file);
        if (!res?.ok || !res.theme || typeof res.theme !== "object") continue;
        const def = themeFromJson(meta.name, res.theme as CustomThemeJson);
        if (!def) continue;
        registerEditorTheme(def);
      }
    } catch {
      metas = [];
    }
    set({ customThemes: metas });
  },

  openPicker: () => set({ pickerOpen: true }),
  closePicker: () => set({ pickerOpen: false }),

  async apply(name) {
    await get().applyEditorTheme(name);
  },

  async applyAccent(hex) {
    await window.closeCode.saveUserSetting({ accentColor: hex });
    applyAccent(hex);
    set({ applying: `accent:${hex}` });
  },

  /** Apply an editor theme (built-in or custom) and restyle the workbench if it's a full custom theme. */
  async applyEditorTheme(name) {
    await window.closeCode.saveUserSetting({ editorTheme: name });
    const def = getRegisteredThemes().find((d) => d.name === name);
    const isBuiltin = BUILTIN_THEMES.some((b) => b.name === name);
    if (!isBuiltin) {
      // Full custom theme -> its workbench palette restyles the UI.
      applyPalette(def?.workbench);
    } else {
      applyPalette(undefined);
    }
    applyAccent((useSettingsStore.getState().effective.accentColor as string | undefined) ?? "");
    set({ applying: name });
  },

  async applyWorkbench(theme) {
    await window.closeCode.saveUserSetting({ theme });
  },

  async cycle() {
    const cur = useSettingsStore.getState().effective.theme;
    const seq = ["dark", "light", "system"] as const;
    const current = cur as (typeof seq)[number];
    const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const resolved = (value: (typeof seq)[number]): "dark" | "light" =>
      value === "system" ? (systemDark ? "dark" : "light") : value;
    const currentResolved = resolved(current);
    const idx = seq.indexOf(current);
    let next: (typeof seq)[number] = current;
    // Avoid a no-op visible cycle (e.g. System on a dark OS would otherwise
    // select explicit Dark and leave the workbench looking unchanged).
    for (let step = 1; step <= seq.length; step++) {
      const candidate = seq[(idx + step) % seq.length];
      if (resolved(candidate) !== currentResolved) {
        next = candidate;
        break;
      }
    }
    await get().applyWorkbench(next);
  },
}));

// Expose for CDP integration tests.
(window as unknown as Record<string, unknown>).__themeStore = useThemeStore;
