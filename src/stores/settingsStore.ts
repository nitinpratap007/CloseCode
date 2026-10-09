// Close Code — Settings store (Phase 14)
// Single renderer source of truth for the settings system:
//   - categories + definitions (schema from main, drives dynamic UI + search)
//   - three scopes: defaults / user / workspace + merged effective values
//   - search + category filtering (renderer-side for immediate UX)
//   - mutations write to the chosen target scope, then refresh the snapshot

import { create } from "zustand";
import type { SettingDefinition, SettingsCategoryInfo, SettingValue } from "../types/electron";

interface SettingsState {
  categories: SettingsCategoryInfo[];
  definitions: SettingDefinition[];
  defaults: Record<string, SettingValue>;
  user: Record<string, SettingValue>;
  workspace: Record<string, SettingValue>;
  effective: Record<string, SettingValue>;
  hasWorkspace: boolean;
  query: string;
  selectedCategory: string | null; // null = All
  targetScope: "user" | "workspace";
  loading: boolean;
  error: string | null;

  init: () => Promise<void>;
  refresh: () => Promise<void>;
  setQuery: (q: string) => void;
  setCategory: (c: string | null) => void;
  setScope: (s: "user" | "workspace") => void;
  save: (patch: Record<string, unknown>) => Promise<boolean>;
  resetSetting: (id: string) => Promise<void>;
  resetScope: () => Promise<void>;
}

function applySnapshot(data: {
  defaults: Record<string, SettingValue>;
  user: Record<string, SettingValue>;
  workspace: Record<string, SettingValue>;
  effective: Record<string, SettingValue>;
  hasWorkspace?: boolean;
  categories?: SettingsCategoryInfo[];
  definitions?: SettingDefinition[];
}): Partial<SettingsState> {
  return {
    defaults: data.defaults ?? {},
    user: data.user ?? {},
    workspace: data.workspace ?? {},
    effective: data.effective ?? {},
    ...(data.hasWorkspace !== undefined ? { hasWorkspace: data.hasWorkspace } : {}),
    ...(data.categories ? { categories: data.categories } : {}),
    ...(data.definitions ? { definitions: data.definitions } : {}),
  };
}

function matchesQuery(def: SettingDefinition, query: string, categories: SettingsCategoryInfo[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const cat = categories.find((c) => c.id === def.category);
  const hay = [
    def.id,
    def.label,
    def.description,
    cat?.label ?? "",
    ...(def.keywords ?? []),
  ]
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  categories: [],
  definitions: [],
  defaults: {},
  user: {},
  workspace: {},
  effective: {},
  hasWorkspace: false,
  query: "",
  selectedCategory: null,
  targetScope: "user",
  loading: false,
  error: null,

  init: async () => {
    if (get().loading) return;
    set({ loading: true, error: null });
    try {
      const [catRes, allRes] = await Promise.all([
        window.closeCode.getSettingCategories(),
        window.closeCode.getAllSettings(),
      ]);
      const unsub = window.closeCode.onSettingsChanged(() => {
        void get().refresh();
      });
      set({
        categories: catRes.categories ?? [],
        definitions: catRes.definitions ?? [],
        ...applySnapshot(allRes),
        loading: false,
      });
      // Keep a live handler across the store's lifetime.
      if (!(window as unknown as Record<string, unknown>).__settingsUnsub) {
        (window as unknown as Record<string, unknown>).__settingsUnsub = unsub;
      } else {
        unsub();
      }
      // Push perf-relevant limits into the editor cache layer.
      void import("./editorStore").then((ed) => {
        ed.setPerfLimits({
          largeFileThreshold: Number(allRes.effective?.largeFileThreshold) || 5,
          contentCacheMax: Number(allRes.effective?.contentCacheMax) || 30,
        });
      });
    } catch (err) {
      set({ error: String(err), loading: false });
    }
  },

  refresh: async () => {
    try {
      const all = await window.closeCode.getAllSettings();
      set(applySnapshot(all));
      void import("./editorStore").then((ed) => {
        ed.setPerfLimits({
          largeFileThreshold: Number(all.effective?.largeFileThreshold) || 5,
          contentCacheMax: Number(all.effective?.contentCacheMax) || 30,
        });
      });
    } catch (err) {
      set({ error: String(err) });
    }
  },

  setQuery: (q) => set({ query: q }),
  setCategory: (c) => set({ selectedCategory: c }),
  setScope: (s) => set({ targetScope: s }),

  save: async (patch) => {
    const { targetScope, hasWorkspace } = get();
    if (targetScope === "workspace" && !hasWorkspace) {
      set({ error: "No workspace open — open a folder first." });
      return false;
    }
    const res =
      targetScope === "workspace"
        ? await window.closeCode.saveWorkspaceSetting(patch)
        : await window.closeCode.saveUserSetting(patch);
    if (!res.ok) {
      set({ error: res.error ?? "Failed to save setting" });
      return false;
    }
    await get().refresh();
    return true;
  },

  resetSetting: async (id) => {
    const patch: Record<string, unknown> = { [id]: null };
    await get().save(patch);
  },

  resetScope: async () => {
    const { targetScope, hasWorkspace } = get();
    if (targetScope === "workspace" && !hasWorkspace) {
      set({ error: "No workspace open." });
      return;
    }
    const res =
      targetScope === "workspace"
        ? await window.closeCode.resetWorkspaceSettings()
        : await window.closeCode.resetUserSettings();
    if (!res.ok) {
      set({ error: res.error ?? "Failed to reset settings" });
      return;
    }
    await get().refresh();
  },
}));

// ---- Selectors / helpers (component-friendly) ----

export function selectVisibleDefinitions(
  state: SettingsState
): { category: SettingsCategoryInfo; definitions: SettingDefinition[] }[] {
  const q = state.query.trim();
  const out: { category: SettingsCategoryInfo; definitions: SettingDefinition[] }[] = [];
  for (const cat of state.categories) {
    if (state.selectedCategory && state.selectedCategory !== cat.id && !q) continue;
    const defs = state.definitions.filter(
      (d) => d.category === cat.id && matchesQuery(d, q, state.categories)
    );
    if (defs.length > 0 || (q && (cat.label.toLowerCase().includes(q.toLowerCase()) || cat.id.includes(q.toLowerCase())))) {
      out.push({ category: cat, definitions: defs });
    }
  }
  return out;
}

export function settingOwner(
  state: { user: Record<string, SettingValue>; workspace: Record<string, SettingValue> },
  id: string
): "user" | "workspace" | "default" {
  if (state.workspace[id] !== undefined) return "workspace";
  if (state.user[id] !== undefined) return "user";
  return "default";
}

/** Count of settings visible for the current query/category filter. */
export function selectVisibleCount(state: SettingsState): number {
  return selectVisibleDefinitions(state).reduce((n, g) => n + g.definitions.length, 0);
}

// Expose for CDP / tests
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__settingsStore = useSettingsStore;
}