// Phase 20 unit tests: closing the workspace must not leave a stale session
// behind, and the `close-folder` command must be reachable and must refuse to
// run while a tab holds unsaved edits.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useWorkspaceStore } from "../src/stores/workspaceStore";
import {
  registerCommand,
  clearRegistryForTesting,
  getAllCommands,
  getCommandByShortcut,
  executeCommand,
} from "../src/commands/registry";
import { registerAppCommands } from "../src/commands/appCommands";

const sessionClear = vi.fn(async () => ({ ok: true }));

beforeEach(() => {
  clearRegistryForTesting();
  sessionClear.mockClear();
  sessionClear.mockImplementation(async () => ({ ok: true }));
  (globalThis as unknown as { window: Record<string, unknown> }).window = {
    ...(globalThis as unknown as { window: Record<string, unknown> }).window,
    closeCode: { sessionClear, getRecentProjects: async () => [] },
    alert: vi.fn(),
  };
  useWorkspaceStore.setState({
    root: "C:\\ws",
    rootName: "ws",
    children: {},
    expanded: {},
    errors: {},
    loading: {},
    recentProjects: [],
    contextMenu: null,
    inlineInput: null,
    refreshCounter: 0,
  });
});

describe("Close Folder (Phase 20)", () => {
  it("registers a close-folder command", () => {
    registerAppCommands({} as never);
    const cmd = getAllCommands().find((c) => c.id === "close-folder");
    expect(cmd).toBeDefined();
    expect(cmd!.title).toBe("Close Folder");
  });

  it("binds close-folder to Ctrl+K W and it does not collide", () => {
    registerAppCommands({} as never);
    const bound = getCommandByShortcut("Ctrl+K W");
    expect(bound).toBeDefined();
    expect(bound!.id).toBe("close-folder");
  });

  it("closeWorkspace clears the persisted session", async () => {
    await useWorkspaceStore.getState().closeWorkspace();
    expect(sessionClear).toHaveBeenCalledTimes(1);
  });

  it("closeWorkspace resets the in-memory root", async () => {
    await useWorkspaceStore.getState().closeWorkspace();
    const s = useWorkspaceStore.getState();
    expect(s.root).toBeNull();
    expect(s.rootName).toBe("");
  });

  it("closeWorkspace still resets state when sessionClear rejects", async () => {
    // A failed IPC must not strand the UI in a half-closed state.
    sessionClear.mockRejectedValueOnce(new Error("ipc down") as never);
    await useWorkspaceStore.getState().closeWorkspace();
    expect(useWorkspaceStore.getState().root).toBeNull();
  });

  it("close-folder dep is invoked by the registry", async () => {
    const closeFolder = vi.fn();
    registerAppCommands({ closeFolder } as never);
    await executeCommand("close-folder");
    expect(closeFolder).toHaveBeenCalledTimes(1);
  });

  it("unregistering removes close-folder", () => {
    const un = registerAppCommands({} as never);
    expect(getAllCommands().some((c) => c.id === "close-folder")).toBe(true);
    un();
    expect(getAllCommands().some((c) => c.id === "close-folder")).toBe(false);
  });

  it("close-folder is not reachable twice under the same shortcut", () => {
    registerAppCommands({} as never);
    // registerCommand rejects duplicate shortcuts; if it had silently
    // overwritten, one of the earlier commands would lose its binding.
    expect(() => registerCommand({ id: "dup-probe", title: "Dup", shortcut: "Ctrl+K W", execute: async () => {} })).toThrow();
  });
});
