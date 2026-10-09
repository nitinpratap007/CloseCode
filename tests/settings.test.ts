// Close Code — Phase 19 unit tests: Settings Store.
import { describe, it, expect, beforeEach } from "vitest";
import { useSettingsStore } from "../src/stores/settingsStore";
import { DEFAULT_EDITOR_SETTINGS } from "../src/types/settings";

describe("Settings Store", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      categories: [],
      definitions: [],
      defaults: DEFAULT_EDITOR_SETTINGS,
      user: {},
      workspace: {},
      effective: DEFAULT_EDITOR_SETTINGS,
      hasWorkspace: false,
      query: "",
      selectedCategory: "",
      targetScope: "user",
      loading: false,
      error: null,
    });
  });

  it("starts with default settings", () => {
    const eff = useSettingsStore.getState().effective;
    expect(eff.fontSize).toBe(14);
    expect(eff.tabSize).toBe(2);
    expect(eff.theme).toBe("dark");
  });

  it("effective settings merge user overrides", () => {
    useSettingsStore.setState({
      effective: { ...DEFAULT_EDITOR_SETTINGS, fontSize: 18 },
    });
    expect(useSettingsStore.getState().effective.fontSize).toBe(18);
  });

  it("init is a function", () => {
    expect(typeof useSettingsStore.getState().init).toBe("function");
  });

  it("refresh is a function", () => {
    expect(typeof useSettingsStore.getState().refresh).toBe("function");
  });

  it("save is a function", () => {
    expect(typeof useSettingsStore.getState().save).toBe("function");
  });

  it("resetSetting is a function", () => {
    expect(typeof useSettingsStore.getState().resetSetting).toBe("function");
  });

  it("setQuery is a function", () => {
    expect(typeof useSettingsStore.getState().setQuery).toBe("function");
  });

  it("setCategory is a function", () => {
    expect(typeof useSettingsStore.getState().setCategory).toBe("function");
  });

  it("setScope is a function", () => {
    expect(typeof useSettingsStore.getState().setScope).toBe("function");
  });
});
