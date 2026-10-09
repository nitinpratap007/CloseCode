// @vitest-environment jsdom
//
// Phase 30 — the renderer half of MCP.
//
// The manager owns config, secrets, connections and discovery in the main
// process; `mcpStore` is a projection served by `window.closeCode`, and
// `McpSection` renders that projection: the add form, per-server state chips
// and errors, enable/disable/reconnect/remove, and the details view. Everything
// is exercised against a fake `window.closeCode`, so every store decision and
// every rendered element is testable without Electron — the protocol and the
// lifecycle live in the main-process suites.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";
vi.mock("../src/monaco", () => ({
  default: {
    editor: { getModel: () => null, setTheme: () => {}, getTheme: () => "cc-dark" },
    Uri: { file: () => ({}) },
  },
}));
vi.mock("../src/language/diagnostics", () => ({
  useDiagnosticsStore: {
    getState: () => ({ diagnostics: [] }),
    setState: () => {},
    subscribe: () => () => {},
  },
}));
import { useMcpStore, type McpStoreState } from "../src/stores/mcpStore";
import McpSection from "../src/components/ai/McpSection";
import type { McpServerView } from "../src/types/electron";

let seq = 0;
function server(over: Partial<McpServerView> = {}): McpServerView {
  seq += 1;
  return {
    id: `mcp-${seq}`,
    name: `server${seq}`,
    transport: "stdio",
    enabled: true,
    state: "connected",
    lastError: null,
    server: { name: `server${seq}`, version: "1.0" },
    command: "npx",
    args: ["-y", "fixture"],
    url: "",
    envKeys: [],
    headerKeys: [],
    counts: { tools: 2, resources: 1, prompts: 1 },
    createdAt: seq,
    updatedAt: seq,
    ...over,
  };
}

interface McpApi {
  onMcpChanged: ReturnType<typeof vi.fn>;
  mcpList: ReturnType<typeof vi.fn>;
  mcpAdd: ReturnType<typeof vi.fn>;
  mcpUpdate: ReturnType<typeof vi.fn>;
  mcpRemove: ReturnType<typeof vi.fn>;
  mcpReconnect: ReturnType<typeof vi.fn>;
  mcpTools: ReturnType<typeof vi.fn>;
  mcpResources: ReturnType<typeof vi.fn>;
  mcpPrompts: ReturnType<typeof vi.fn>;
  mcpReadResource: ReturnType<typeof vi.fn>;
  mcpGetPrompt: ReturnType<typeof vi.fn>;
  push: (payload: { servers: McpServerView[] }) => void;
  listeners: Array<(payload: { servers: McpServerView[] }) => void>;
}

let api: McpApi;

function install(over: Partial<McpApi> = {}): McpApi {
  const listeners: Array<(payload: { servers: McpServerView[] }) => void> = [];
  const base: McpApi = {
    onMcpChanged: vi.fn((cb: (payload: { servers: McpServerView[] }) => void) => {
      listeners.push(cb);
      return () => {};
    }),
    mcpList: vi.fn(async () => ({ ok: true, servers: [] })),
    mcpAdd: vi.fn(async () => ({ ok: true, server: null })),
    mcpUpdate: vi.fn(async () => ({ ok: true, server: null })),
    mcpRemove: vi.fn(async () => ({ ok: true })),
    mcpReconnect: vi.fn(async () => ({ ok: true, server: null })),
    mcpTools: vi.fn(async () => ({ ok: true, tools: [] })),
    mcpResources: vi.fn(async () => ({ ok: true, resources: [] })),
    mcpPrompts: vi.fn(async () => ({ ok: true, prompts: [] })),
    mcpReadResource: vi.fn(async () => ({ ok: true, text: "" })),
    mcpGetPrompt: vi.fn(async () => ({ ok: true, messages: [] })),
    push: (payload) => listeners.forEach((cb) => cb(payload)),
    listeners,
    ...over,
  };
  (window as unknown as { closeCode: unknown }).closeCode = base;
  return base;
}

beforeEach(() => {
  api = install();
  useMcpStore.setState({
    servers: [],
    tools: {},
    resources: {},
    prompts: {},
    error: null,
    notice: null,
    busy: false,
    listening: false,
  } as Partial<McpStoreState>);
});

afterEach(() => {
  cleanup();
  api.listeners.length = 0;
});

describe("mcpStore — projection of the manager", () => {
  it("refresh reads the server list; a push replaces it", async () => {
    useMcpStore.getState().startListening();
    const s = server({ name: "alpha" });
    await act(async () => {
      api.mcpList.mockResolvedValue({ ok: true, servers: [s] });
      await useMcpStore.getState().refresh();
    });
    expect(useMcpStore.getState().servers.map((x) => x.name)).toEqual(["alpha"]);
    act(() => {
      api.push({ servers: [server({ name: "beta" })] });
    });
    expect(useMcpStore.getState().servers.map((x) => x.name)).toEqual(["beta"]);
  });

  it("a failed add surfaces the manager's reason, verbatim", async () => {
    api.mcpAdd.mockResolvedValue({ ok: false, error: "A server named \"x\" already exists." });
    await act(async () => {
      await useMcpStore.getState().add({ name: "x", transport: "stdio", command: "npx" });
    });
    expect(useMcpStore.getState().error).toBe('A server named "x" already exists.');
  });

  it("a saved-but-failed server is an error with the server's own message, not a success", async () => {
    api.mcpAdd.mockResolvedValue({
      ok: true,
      server: server({ name: "broken", state: "failed", lastError: "spawn npx ENOENT" }),
    });
    await act(async () => {
      await useMcpStore.getState().add({ name: "broken", transport: "stdio", command: "npx" });
    });
    expect(useMcpStore.getState().error).toContain("spawn npx ENOENT");
  });

  it("a connected add says what was discovered", async () => {
    api.mcpAdd.mockResolvedValue({ ok: true, server: server({ name: "good", counts: { tools: 4, resources: 1, prompts: 0 } }) });
    await act(async () => {
      await useMcpStore.getState().add({ name: "good", transport: "stdio", command: "npx" });
    });
    expect(useMcpStore.getState().notice).toContain("4 tools");
  });

  it("remove drops the server's cached details too", async () => {
    const s = server({ id: "mcp-x" });
    useMcpStore.setState({ servers: [s], tools: { "mcp-x": [] }, resources: { "mcp-x": [] }, prompts: { "mcp-x": [] } });
    api.mcpRemove.mockResolvedValue({ ok: true });
    await act(async () => {
      await useMcpStore.getState().remove("mcp-x");
    });
    expect(api.mcpRemove).toHaveBeenCalledWith("mcp-x");
    expect(useMcpStore.getState().tools["mcp-x"]).toBeUndefined();
  });
});

describe("McpSection — what the user sees and presses", () => {
  it("renders the empty state when no servers are configured", async () => {
    const { container } = render(<McpSection />);
    expect(container.querySelector("[data-mcp-empty]")).not.toBeNull();
    expect(container.querySelector("[data-ai-mcp]")).not.toBeNull();
  });

  it("renders each server with its state and its failure reason", async () => {
    api.mcpList.mockResolvedValue({
      ok: true,
      servers: [
        server({ id: "mcp-1", name: "good", state: "connected" }),
        server({ id: "mcp-2", name: "bad", state: "failed", lastError: "spawn npx ENOENT" }),
      ],
    });
    let view: ReturnType<typeof render> | null = null;
    await act(async () => {
      view = render(<McpSection />);
    });
    const root = view!.container.querySelector("[data-ai-mcp]") as HTMLElement;
    expect(root.querySelector("[data-mcp-server='mcp-1']")).not.toBeNull();
    expect(root.querySelector("[data-mcp-state='mcp-1']")?.textContent).toBe("connected");
    expect(root.querySelector("[data-mcp-state='mcp-2']")?.textContent).toBe("failed");
    expect(root.querySelector("[data-mcp-error='mcp-2']")?.textContent).toContain("spawn npx ENOENT");
    expect(root.querySelector("[data-mcp-tool-count='mcp-1']")?.textContent).toContain("2");
  });

  it("the add form sends exactly what the user typed (stdio)", async () => {
    api.mcpAdd.mockResolvedValue({ ok: true, server: server({ name: "fs" }) });
    let view: ReturnType<typeof render> | null = null;
    await act(async () => {
      view = render(<McpSection />);
    });
    const root = view!.container.querySelector("[data-ai-mcp]") as HTMLElement;
    fireEvent.click(root.querySelector("[data-mcp-add-open]") as HTMLElement);
    fireEvent.change(root.querySelector("[data-mcp-add-name]") as HTMLInputElement, { target: { value: "fs" } });
    fireEvent.change(root.querySelector("[data-mcp-add-command]") as HTMLInputElement, { target: { value: "npx" } });
    fireEvent.change(root.querySelector("[data-mcp-add-args]") as HTMLInputElement, { target: { value: "-y @modelcontextprotocol/server-filesystem C:\\" } });
    fireEvent.change(root.querySelector("[data-mcp-add-env]") as HTMLInputElement, { target: { value: "TOKEN=abc\nDEBUG=1" } });
    await act(async () => {
      fireEvent.click(root.querySelector("[data-mcp-add-submit]") as HTMLElement);
    });
    expect(api.mcpAdd).toHaveBeenCalledWith({
      name: "fs",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "C:\\"],
      env: { TOKEN: "abc", DEBUG: "1" },
    });
  });

  it("the http form sends the url and parsed headers, not a command", async () => {
    api.mcpAdd.mockResolvedValue({ ok: true, server: server({ name: "remote", transport: "http" }) });
    let view: ReturnType<typeof render> | null = null;
    await act(async () => {
      view = render(<McpSection />);
    });
    const root = view!.container.querySelector("[data-ai-mcp]") as HTMLElement;
    fireEvent.click(root.querySelector("[data-mcp-add-open]") as HTMLElement);
    fireEvent.change(root.querySelector("[data-mcp-add-transport]") as HTMLSelectElement, { target: { value: "http" } });
    fireEvent.change(root.querySelector("[data-mcp-add-name]") as HTMLInputElement, { target: { value: "remote" } });
    fireEvent.change(root.querySelector("[data-mcp-add-url]") as HTMLInputElement, { target: { value: "http://127.0.0.1:3001/mcp" } });
    fireEvent.change(root.querySelector("[data-mcp-add-headers]") as HTMLInputElement, { target: { value: "Authorization=Bearer x" } });
    await act(async () => {
      fireEvent.click(root.querySelector("[data-mcp-add-submit]") as HTMLElement);
    });
    expect(api.mcpAdd).toHaveBeenCalledWith({
      name: "remote",
      transport: "http",
      url: "http://127.0.0.1:3001/mcp",
      headers: { Authorization: "Bearer x" },
    });
  });

  it("disable, reconnect and remove map to their store actions", async () => {
    const s = server({ id: "mcp-1", name: "good", state: "connected" });
    api.mcpList.mockResolvedValue({ ok: true, servers: [s] });
    let view: ReturnType<typeof render> | null = null;
    await act(async () => {
      view = render(<McpSection />);
    });
    const root = view!.container.querySelector("[data-ai-mcp]") as HTMLElement;
    await act(async () => {
      fireEvent.click(root.querySelector("[data-mcp-toggle='mcp-1']") as HTMLElement);
    });
    expect(api.mcpUpdate).toHaveBeenCalledWith({ id: "mcp-1", enabled: false });
    await act(async () => {
      fireEvent.click(root.querySelector("[data-mcp-remove='mcp-1']") as HTMLElement);
    });
    expect(api.mcpRemove).toHaveBeenCalledWith("mcp-1");

    // A failed server offers reconnect.
    act(() => {
      api.push({ servers: [server({ id: "mcp-1", name: "good", state: "failed", lastError: "x" })] });
    });
    await act(async () => {
      fireEvent.click(root.querySelector("[data-mcp-reconnect='mcp-1']") as HTMLElement);
    });
    expect(api.mcpReconnect).toHaveBeenCalledWith("mcp-1");
  });

  it("details load the discovered tools, resources and prompts for that server", async () => {
    const s = server({ id: "mcp-1", name: "good", state: "connected" });
    api.mcpList.mockResolvedValue({ ok: true, servers: [s] });
    api.mcpTools.mockResolvedValue({ ok: true, tools: [{ name: "echo", description: "Echo", inputSchema: {}, readOnlyHint: true, destructiveHint: false }] });
    api.mcpResources.mockResolvedValue({ ok: true, resources: [{ uri: "memo://notes", name: "notes", description: "", mimeType: "text/plain" }] });
    api.mcpPrompts.mockResolvedValue({ ok: true, prompts: [{ name: "review", description: "", arguments: [] }] });
    let view: ReturnType<typeof render> | null = null;
    await act(async () => {
      view = render(<McpSection />);
    });
    const root = view!.container.querySelector("[data-ai-mcp]") as HTMLElement;
    await act(async () => {
      fireEvent.click(root.querySelector("[data-mcp-details='mcp-1']") as HTMLElement);
    });
    expect(root.querySelector("[data-mcp-tool='mcp-1:echo']")).not.toBeNull();
    expect(root.querySelector("[data-mcp-resource='mcp-1:memo://notes']")).not.toBeNull();
    expect(root.querySelector("[data-mcp-prompt='review']")).not.toBeNull();
  });
});
