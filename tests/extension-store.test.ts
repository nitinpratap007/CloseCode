// Close Code — Phase 19 unit tests: Extension Store.
import { describe, it, expect, beforeEach } from "vitest";
import { useExtensionStore } from "../src/stores/extensionStore";

describe("Extension Store", () => {
  beforeEach(() => {
    useExtensionStore.setState({
      extensions: [],
      registeredCommandIds: [],
      error: null,
      started: false,
    });
  });

  it("starts with empty extensions", () => {
    expect(useExtensionStore.getState().extensions).toEqual([]);
  });

  it("has required methods", () => {
    const methods = ["load", "setEnabled", "reload", "syncCommands"];
    const s = useExtensionStore.getState();
    methods.forEach((m) => { expect(typeof (s as Record<string, unknown>)[m]).toBe("function"); });
  });

  it("setEnabled is a function and does not throw", () => {
    useExtensionStore.setState({
      extensions: [{ id: "test-ext", enabled: true }],
    });
    expect(() => useExtensionStore.getState().setEnabled("test-ext", false)).not.toThrow();
  });

  it("reload is a function", () => {
    expect(typeof useExtensionStore.getState().reload).toBe("function");
  });

  it("syncCommands is a function", () => {
    expect(typeof useExtensionStore.getState().syncCommands).toBe("function");
  });
});
