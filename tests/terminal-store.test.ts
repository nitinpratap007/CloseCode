// Close Code — Phase 19 unit tests: Terminal Store.
import { describe, it, expect, beforeEach } from "vitest";
import { useTerminalStore } from "../src/stores/terminalStore";

describe("Terminal Store", () => {
  beforeEach(() => {
    useTerminalStore.setState({ terminals: [], activeId: null });
  });

  it("starts with empty terminals", () => {
    expect(useTerminalStore.getState().terminals).toEqual([]);
    expect(useTerminalStore.getState().activeId).toBeNull();
  });

  it("setActive changes activeId", () => {
    useTerminalStore.getState().setActive("test-id-1");
    expect(useTerminalStore.getState().activeId).toBe("test-id-1");
  });

  it("killTerminal removes terminal", () => {
    useTerminalStore.setState({
      terminals: [{ id: "t1", title: "Test", kind: "terminal", cwd: "/tmp", pid: 0 }],
      activeId: "t1",
    });
    useTerminalStore.getState().killTerminal("t1");
    expect(useTerminalStore.getState().terminals.length).toBe(0);
  });

  it("killAll removes all terminals", () => {
    useTerminalStore.setState({
      terminals: [
        { id: "t1", title: "Test1", kind: "terminal", cwd: "/tmp", pid: 0 },
        { id: "t2", title: "Test2", kind: "terminal", cwd: "/tmp", pid: 0 },
      ],
      activeId: "t1",
    });
    useTerminalStore.getState().killAll();
    expect(useTerminalStore.getState().terminals.length).toBe(0);
  });

  it("restartTerminal is a function", () => {
    expect(typeof useTerminalStore.getState().restartTerminal).toBe("function");
  });

  it("clearTerminal is a function", () => {
    expect(typeof useTerminalStore.getState().clearTerminal).toBe("function");
  });

  it("resizeTerminal is a function", () => {
    expect(typeof useTerminalStore.getState().resizeTerminal).toBe("function");
  });

  it("writeToTerminal is a function", () => {
    expect(typeof useTerminalStore.getState().writeToTerminal).toBe("function");
  });

  it("setActive with no args does not crash", () => {
    expect(() => useTerminalStore.getState().setActive("nonexistent")).not.toThrow();
  });
});
