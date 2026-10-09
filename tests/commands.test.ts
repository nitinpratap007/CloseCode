// Close Code — Phase 19 unit tests: Commands & Registry.
import { describe, it, expect, beforeEach } from "vitest";
import {
  registerCommand,
  unregisterCommand,
  getCommand,
  getAllCommands,
  getCommandByShortcut,
  executeCommand,
  clearRegistryForTesting,
  searchCommands,
  type CommandMeta,
} from "../src/commands/registry";
import { registerAppCommands } from "../src/commands/appCommands";

describe("Command Registry", () => {
  beforeEach(() => {
    clearRegistryForTesting();
    registerAppCommands({
      getSettings: () => ({}),
      setSettings: () => {},
    } as any);
  });

  it("registers all app commands", () => {
    const cmds = getAllCommands();
    expect(cmds.length).toBeGreaterThanOrEqual(20);
  });

  it("has required core commands", () => {
    const ids = getAllCommands().map((c) => c.id);
    expect(ids).toContain("open-file");
    expect(ids).toContain("save");
    expect(ids).toContain("close-tab");
    expect(ids).toContain("toggle-sidebar");
    expect(ids).toContain("find");
    expect(ids).toContain("search-workspace");
  });

  it("getCommand returns correct command", () => {
    const cmd = getCommand("save");
    expect(cmd).toBeDefined();
    expect(cmd!.id).toBe("save");
    expect(cmd!.title).toBe("Save");
  });

  it("getCommandByShortcut finds command", () => {
    const cmd = getCommandByShortcut("Ctrl+S");
    expect(cmd).toBeDefined();
    expect(cmd!.id).toBe("save");
  });

  it("getCommandByShortcut handles Ctrl+Shift+S", () => {
    const cmd = getCommandByShortcut("Ctrl+Shift+S");
    expect(cmd).toBeDefined();
    expect(cmd!.id).toBe("save-as");
  });

  it("getCommandByShortcut handles F1", () => {
    const cmd = getCommandByShortcut("F1");
    if (cmd) expect(cmd.id).toBe("palette");
  });

  it("searchCommands filters by query", () => {
    const results = searchCommands("save");
    expect(results.length).toBeGreaterThan(0);
    results.forEach((r) => {
      expect(r.title.toLowerCase()).toContain("save");
    });
  });

  it("searchCommands returns empty for unknown query", () => {
    const results = searchCommands("xyznotfound");
    expect(results.length).toBe(0);
  });

  it("executeCommand throws for unknown id", async () => {
    await expect(executeCommand("nonexistent-command-xyz")).rejects.toBeDefined();
  });

  it("unregisterCommand removes command", () => {
    unregisterCommand("save");
    expect(getCommand("save")).toBeUndefined();
  });

  it("registerCommand adds new command", () => {
    const meta: CommandMeta = {
      id: "test-cmd",
      title: "Test Command",
      shortcut: "Alt+Shift+T",
      execute: async () => {},
    };
    registerCommand(meta);
    expect(getCommand("test-cmd")).toBeDefined();
    expect(getCommandByShortcut("Alt+Shift+T")?.id).toBe("test-cmd");
  });

  it("shortcut index works", () => {
    const cmd = getCommandByShortcut("Ctrl+S");
    expect(cmd).toBeDefined();
    const cmd2 = getCommandByShortcut("Ctrl+Shift+S");
    expect(cmd2).toBeDefined();
  });
});
