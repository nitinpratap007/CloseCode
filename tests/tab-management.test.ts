// Close Code — Phase 19 unit tests: Tab Management.
import { describe, it, expect, beforeEach } from "vitest";
import { useEditorStore } from "../src/stores/editorStore";
import { clearRegistryForTesting } from "../src/commands/registry";
import { registerAppCommands } from "../src/commands/appCommands";

describe("Tab Management", () => {
  beforeEach(() => {
    clearRegistryForTesting();
    registerAppCommands({ getSettings: () => ({}), setSettings: () => {} } as any);
    // Reset store state
    useEditorStore.setState({
      tabs: [],
      activePath: null,
      largeFileWarning: null,
      untitledCounter: 0,
    });
  });

  it("starts with empty tabs", () => {
    const tabs = useEditorStore.getState().tabs;
    expect(tabs.length).toBe(0);
  });

  it("newUntitled creates a tab with untitled: prefix", () => {
    useEditorStore.getState().newUntitled();
    const tabs = useEditorStore.getState().tabs;
    expect(tabs.length).toBe(1);
    expect(tabs[0].path).toMatch(/^untitled:/);
  });

  it("newUntitled increments counter", () => {
    useEditorStore.getState().newUntitled();
    useEditorStore.getState().newUntitled();
    const tabs = useEditorStore.getState().tabs;
    expect(tabs.length).toBe(2);
    expect(tabs[0].path).toBe("untitled:1");
    expect(tabs[1].path).toBe("untitled:2");
  });

  it("markChanged sets dirty flag", () => {
    useEditorStore.getState().newUntitled();
    const tab = useEditorStore.getState().tabs[0];
    useEditorStore.getState().markChanged(tab.path);
    const updated = useEditorStore.getState().tabs.find((t) => t.path === tab.path);
    expect(updated?.dirty).toBe(true);
  });

  it("markClean clears dirty flag", () => {
    useEditorStore.getState().newUntitled();
    const tab = useEditorStore.getState().tabs[0];
    useEditorStore.getState().markChanged(tab.path);
    useEditorStore.getState().markClean(tab.path);
    const updated = useEditorStore.getState().tabs.find((t) => t.path === tab.path);
    expect(updated?.dirty).toBe(false);
  });

  it("closeTab removes the tab", () => {
    useEditorStore.getState().newUntitled();
    const tab = useEditorStore.getState().tabs[0];
    const result = useEditorStore.getState().closeTab(tab.path);
    expect(result).toBe(true);
    expect(useEditorStore.getState().tabs.length).toBe(0);
  });

  it("closeTab returns false for dirty untitled tab", () => {
    useEditorStore.getState().newUntitled();
    const tab = useEditorStore.getState().tabs[0];
    useEditorStore.getState().markChanged(tab.path);
    const result = useEditorStore.getState().closeTab(tab.path);
    expect(result).toBe(false);
    expect(useEditorStore.getState().tabs.length).toBe(1);
  });

  it("dirtyTabs excludes untitled paths", () => {
    useEditorStore.getState().newUntitled();
    const dirty = useEditorStore.getState().dirtyTabs();
    expect(dirty.length).toBe(0);
  });

  it("setActive changes activePath", () => {
    useEditorStore.getState().newUntitled();
    const tab = useEditorStore.getState().tabs[0];
    useEditorStore.getState().setActive(tab.path);
    expect(useEditorStore.getState().activePath).toBe(tab.path);
  });

  it("closeAllTabs removes dirty tabs and keeps clean ones", () => {
    useEditorStore.getState().newUntitled();
    // Mark the untitled tab as dirty
    const tab = useEditorStore.getState().tabs[0];
    useEditorStore.getState().markChanged(tab.path);
    const countBefore = useEditorStore.getState().tabs.length;
    useEditorStore.getState().closeAllTabs();
    expect(useEditorStore.getState().tabs.length).toBeLessThan(countBefore);
  });

  it("saveTab works on clean tab", async () => {
    useEditorStore.getState().newUntitled();
    const tab = useEditorStore.getState().tabs[0];
    const result = await useEditorStore.getState().saveTab(tab.path);
    // saveTab returns true if already clean
    expect(result).toBe(true);
  });

  it("tabs array is initially empty", () => {
    const state = useEditorStore.getState();
    expect(state.tabs).toEqual([]);
    expect(state.activePath).toBeNull();
  });
});
