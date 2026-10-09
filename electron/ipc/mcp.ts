// Close Code — MCP IPC (Phase 30)
//
// The panel's window onto the MCP manager. Ten channels, all `{ ok, … }`
// envelopes, plus one push (`mcp:changed`) registered on the manager's change
// hook so *any* mutation — panel, lifecycle, a server dropping mid-run —
// reaches the renderer in the same instant. Secret values (env, headers) cross
// this boundary in exactly one direction: renderer → main, at add/update time.
// They are never returned.

import { BrowserWindow, ipcMain } from "electron";
import {
  addMcpServer,
  getMcpPrompt,
  listMcpPrompts,
  listMcpResources,
  listMcpServers,
  listMcpTools,
  readMcpResource,
  reconnectMcpServer,
  removeMcpServer,
  setMcpChangedListener,
  updateMcpServer,
  type McpAddInput,
  type McpTransport,
  type McpUpdateInput,
} from "../services/mcp";

function sendToAllWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch {
      // the window went away mid-broadcast
    }
  }
}

function fail(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

function broadcastMcpChanged(): void {
  const list = listMcpServers();
  sendToAllWindows("mcp:changed", { servers: list.servers });
}

function str(v: unknown, max = 4000): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((a): a is string => typeof a === "string") : [];
}

function strRecord(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

export function registerMcpIpc(): void {
  setMcpChangedListener(broadcastMcpChanged);

  ipcMain.handle("mcp:list", () => {
    try {
      return listMcpServers();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("mcp:add", async (_e, payload: Record<string, unknown>) => {
    try {
      const transport: McpTransport = payload?.transport === "http" ? "http" : "stdio";
      const input: McpAddInput = {
        name: str(payload?.name, 200),
        transport,
        command: str(payload?.command, 1000),
        args: strArray(payload?.args),
        env: strRecord(payload?.env),
        url: str(payload?.url, 2000),
        headers: strRecord(payload?.headers),
        enabled: payload?.enabled !== false,
      };
      return await addMcpServer(input);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("mcp:update", async (_e, payload: Record<string, unknown>) => {
    try {
      const id = str(payload?.id, 100);
      if (!id) return fail("Which server?");
      const patch: McpUpdateInput = {};
      if (payload?.name !== undefined) patch.name = str(payload.name, 200);
      if (payload?.enabled !== undefined) patch.enabled = payload.enabled === true;
      if (payload?.command !== undefined) patch.command = str(payload.command, 1000);
      if (payload?.args !== undefined) patch.args = strArray(payload.args);
      if (payload?.url !== undefined) patch.url = str(payload.url, 2000);
      if (payload?.env !== undefined) patch.env = strRecord(payload.env);
      if (payload?.headers !== undefined) patch.headers = strRecord(payload.headers);
      return await updateMcpServer(id, patch);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("mcp:remove", async (_e, payload: Record<string, unknown>) => {
    try {
      const id = str(payload?.id, 100);
      if (!id) return fail("Which server?");
      return await removeMcpServer(id);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("mcp:reconnect", async (_e, payload: Record<string, unknown>) => {
    try {
      const id = str(payload?.id, 100);
      if (!id) return fail("Which server?");
      return await reconnectMcpServer(id);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("mcp:tools", (_e, payload: Record<string, unknown>) => {
    try {
      return listMcpTools(str(payload?.id, 100));
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("mcp:resources", (_e, payload: Record<string, unknown>) => {
    try {
      return listMcpResources(str(payload?.id, 100));
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("mcp:prompts", (_e, payload: Record<string, unknown>) => {
    try {
      return listMcpPrompts(str(payload?.id, 100));
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("mcp:read-resource", async (_e, payload: Record<string, unknown>) => {
    try {
      const id = str(payload?.id, 100);
      const uri = str(payload?.uri, 2000);
      if (!id || !uri) return fail("Which server and resource?");
      // Panel reads go through the same manager path the agent's read_resource
      // tool uses, with a fresh signal — there is no run to abort this one.
      return await readMcpResource(id, uri, new AbortController().signal, 24_000);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("mcp:get-prompt", async (_e, payload: Record<string, unknown>) => {
    try {
      const id = str(payload?.id, 100);
      const name = str(payload?.name, 200);
      if (!id || !name) return fail("Which server and prompt?");
      return await getMcpPrompt(id, name, strRecord(payload?.args));
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });
}
