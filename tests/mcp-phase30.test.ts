// Phase 30 — the MCP manager.
//
// Every test here speaks real MCP: the fixture servers are genuine SDK
// `McpServer` instances and the client is the app's own manager, connected over
// an in-memory transport pair — the only part of the connect flow swapped out.
// The handshake, capability negotiation, tools/list, tools/call, resources/read
// and prompts/get are the protocol itself, not a mock of it. The real stdio and
// HTTP transports are covered by the E2E.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "cc-mcp-userdata-"));
vi.mock("electron", () => ({
  app: { getPath: () => userData },
  safeStorage: {
    isEncryptionAvailable: () => true,
    // Faithful to the contract, not the crypto: the file holds no plaintext,
    // and the process that wrote it can read it back.
    encryptString: (s: string) => Buffer.from(`enc:${Buffer.from(s, "utf8").toString("base64")}`, "utf8"),
    decryptString: (b: Buffer) => {
      const s = b.toString("utf8");
      if (!s.startsWith("enc:")) throw new Error("bad envelope");
      return Buffer.from(s.slice(4), "base64").toString("utf8");
    },
  },
}));

type Mod = typeof import("../electron/services/mcp");

let dir: string;
let m: Mod;
let servers: McpServer[];

async function load(reuseDir?: string): Promise<Mod> {
  vi.resetModules();
  const mod = await import("../electron/services/mcp");
  dir = reuseDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "cc-mcp-"));
  mod.setMcpDir(dir);
  return mod;
}

/** A real MCP server with two tools, one resource and one prompt. */
async function startFixture(): Promise<{ clientTransport: InMemoryTransport; close: () => Promise<void> }> {
  const server = new McpServer({ name: "fixture", version: "1.2.3" });
  server.registerTool(
    "echo",
    { description: "Echo text back", inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
    async ({ text }) => ({ content: [{ type: "text" as const, text: `echo:${text}` }] }),
  );
  server.registerTool(
    "explode",
    { description: "Always fails", inputSchema: {}, annotations: { destructiveHint: true } },
    async () => ({ content: [{ type: "text" as const, text: "kaboom" }], isError: true }),
  );
  server.registerResource("notes", "memo://notes", { description: "Some notes" }, async (uri) => ({
    contents: [{ uri: uri.href, text: "resource body", mimeType: "text/plain" }],
  }));
  server.registerPrompt("review", { description: "Review code", argsSchema: { file: z.string() } }, async ({ file }) => ({
    messages: [{ role: "user" as const, content: { type: "text" as const, text: `Review ${file}` } }],
  }));
  servers.push(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return { clientTransport, close: () => server.close() };
}

/** Wire the manager's test factory so every `stdio` config lands on a fixture. */
function useFixtures(mod: Mod, fixtures: Map<string, InMemoryTransport>): void {
  mod.setMcpTransportFactoryForTests((config) => {
    const t = fixtures.get(config.name);
    if (!t) throw new Error(`fixture "${config.name}" was closed`);
    return { transport: t, kind: "stdio" };
  });
}

const fixtures = new Map<string, InMemoryTransport>();

beforeEach(async () => {
  m = await load();
  servers = [];
  fixtures.clear();
});

afterEach(async () => {
  m.setMcpTransportFactoryForTests(null);
  await m.shutdownMcpServers();
  for (const s of servers) {
    try {
      await s.close();
    } catch {
      // already closed
    }
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // disposable temp dir
  }
});

async function addFixtureServer(name = "fixture", over: Record<string, unknown> = {}) {
  const fx = await startFixture();
  fixtures.set(name, fx.clientTransport);
  useFixtures(m, fixtures);
  const res = await m.addMcpServer({ name, transport: "stdio", command: "fixture", ...over });
  return { res, fx };
}

// ---------------------------------------------------------------------------

describe("1. servers are configured, persisted and removed", () => {
  it("an added server is validated, connected, and listed with its real identity", async () => {
    const { res } = await addFixtureServer();
    if (!res.ok) throw new Error(res.error);
    expect(res.server.state).toBe("connected");
    expect(res.server.server).toEqual({ name: "fixture", version: "1.2.3" });
    expect(res.server.counts).toEqual({ tools: 2, resources: 1, prompts: 1 });
    const list = m.listMcpServers();
    expect(list.servers).toHaveLength(1);
    expect(list.servers[0].name).toBe("fixture");
  });

  it("a fresh module over the same directory reads the config back", async () => {
    const { res } = await addFixtureServer();
    if (!res.ok) throw new Error(res.error);
    const restarted = await load(dir);
    const list = restarted.listMcpServers();
    expect(list.servers).toHaveLength(1);
    expect(list.servers[0].id).toBe(res.server.id);
    // Not connected yet — connections are lazy, config is durable.
    expect(list.servers[0].state).toBe("disconnected");
  });

  it("remove closes the connection, deletes the config and drops the secrets", async () => {
    const { res } = await addFixtureServer("fixture", { env: { TOKEN: "secret-value" } });
    if (!res.ok) throw new Error(res.error);
    const secrets = path.join(dir, "mcp", "secrets.bin");
    expect(fs.existsSync(secrets)).toBe(true);
    expect(fs.readFileSync(secrets, "utf8")).not.toContain("secret-value"); // envelope, not plain
    const removed = await m.removeMcpServer(res.server.id);
    expect(removed.ok).toBe(true);
    expect(m.listMcpServers().servers).toHaveLength(0);
    expect(fs.readFileSync(secrets, "utf8")).not.toContain("TOKEN");
  });

  it("duplicate names and bad configs are refused with reasons", async () => {
    await addFixtureServer();
    const dup = await m.addMcpServer({ name: "Fixture", transport: "stdio", command: "x" });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error).toContain("already exists");
    const noCmd = await m.addMcpServer({ name: "nocmd", transport: "stdio", command: "  " });
    expect(noCmd.ok).toBe(false);
    const badUrl = await m.addMcpServer({ name: "badurl", transport: "http", url: "not-a-url" });
    expect(badUrl.ok).toBe(false);
    const ftp = await m.addMcpServer({ name: "ftp", transport: "http", url: "ftp://x/mcp" });
    expect(ftp.ok).toBe(false);
  });

  it("a corrupt servers.json is moved aside, not deleted, and the manager starts empty", async () => {
    await addFixtureServer();
    const file = path.join(dir, "mcp", "servers.json");
    fs.writeFileSync(file, "{ nope", "utf8");
    const list = m.listMcpServers();
    expect(list.servers).toHaveLength(0);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readdirSync(path.join(dir, "mcp")).some((f) => f.includes(".corrupt-"))).toBe(true);
  });
});

describe("2. tools are discovered and invoked through the real protocol", () => {
  it("discovery lists the server's tools with their annotations and schemas", async () => {
    const { res } = await addFixtureServer();
    if (!res.ok) throw new Error(res.error);
    const tools = m.listMcpTools(res.server.id);
    if (!tools.ok) throw new Error(tools.error);
    const echo = tools.tools.find((t) => t.name === "echo");
    const boom = tools.tools.find((t) => t.name === "explode");
    expect(echo?.readOnlyHint).toBe(true);
    expect(echo?.destructiveHint).toBe(false);
    expect(boom?.destructiveHint).toBe(true);
    expect((echo?.inputSchema as { properties?: Record<string, unknown> }).properties).toHaveProperty("text");
  });

  it("callMcpTool returns the server's real result text", async () => {
    const { res } = await addFixtureServer();
    if (!res.ok) throw new Error(res.error);
    const out = await m.callMcpTool(res.server.id, "echo", { text: "hello" }, new AbortController().signal, 10_000);
    expect(out).toEqual({ ok: true, text: "echo:hello" });
  });

  it("an MCP-level error result is an error, not a success", async () => {
    const { res } = await addFixtureServer();
    if (!res.ok) throw new Error(res.error);
    const out = await m.callMcpTool(res.server.id, "explode", {}, new AbortController().signal, 10_000);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("kaboom");
  });

  it("a call to an unknown tool or server is an error string, never a throw", async () => {
    const { res } = await addFixtureServer();
    if (!res.ok) throw new Error(res.error);
    const missingTool = await m.callMcpTool(res.server.id, "nope", {}, new AbortController().signal, 10_000);
    expect(missingTool.ok).toBe(false);
    const missingServer = await m.callMcpTool("mcp-nothere", "echo", {}, new AbortController().signal, 10_000);
    expect(missingServer.ok).toBe(false);
  });

  it("results are bounded, with the truncation stated", async () => {
    const { res } = await addFixtureServer();
    if (!res.ok) throw new Error(res.error);
    const out = await m.callMcpTool(res.server.id, "echo", { text: "x".repeat(50_000) }, new AbortController().signal, 2_000);
    if (!out.ok) throw new Error(out.error);
    expect(out.text.length).toBeLessThan(3_000);
    expect(out.text).toContain("truncated");
  });
});

describe("3. resources and prompts", () => {
  it("resources are listed and read through the manager", async () => {
    const { res } = await addFixtureServer();
    if (!res.ok) throw new Error(res.error);
    const resources = m.listMcpResources(res.server.id);
    if (!resources.ok) throw new Error(resources.error);
    expect(resources.resources).toEqual([{ uri: "memo://notes", name: "notes", description: "Some notes", mimeType: "" }]);
    const read = await m.readMcpResource(res.server.id, "memo://notes", new AbortController().signal, 10_000);
    expect(read).toEqual({ ok: true, text: "resource body" });
  });

  it("prompts are listed with their arguments and fetched with them filled", async () => {
    const { res } = await addFixtureServer();
    if (!res.ok) throw new Error(res.error);
    const prompts = m.listMcpPrompts(res.server.id);
    if (!prompts.ok) throw new Error(prompts.error);
    expect(prompts.prompts[0].name).toBe("review");
    expect(prompts.prompts[0].arguments).toEqual([{ name: "file", description: "", required: true }]);
    const got = await m.getMcpPrompt(res.server.id, "review", { file: "a.ts" });
    if (!got.ok) throw new Error(got.error);
    expect(got.messages).toEqual([{ role: "user", text: "Review a.ts" }]);
  });
});

describe("4. lifecycle: failure is a state, never a crash", () => {
  it("a server that throws on connect lands in failed with the error, and the app keeps working", async () => {
    useFixtures(m, fixtures);
    m.setMcpTransportFactoryForTests((config) => {
      if (config.name === "broken") throw new Error("spawn fixture ENOENT");
      const t = fixtures.get(config.name);
      if (!t) throw new Error(`fixture "${config.name}" was closed`);
      return { transport: t, kind: "stdio" };
    });
    const res = await m.addMcpServer({ name: "broken", transport: "stdio", command: "does-not-exist" });
    if (!res.ok) throw new Error(res.error);
    expect(res.server.state).toBe("failed");
    expect(res.server.lastError).toContain("spawn fixture ENOENT");
    // The manager still works for other servers.
    const good = await addFixtureServer();
    if (!good.res.ok) throw new Error(good.res.error);
    expect(good.res.server.state).toBe("connected");
    // And a call against the failed server is an error string, not a throw.
    const call = await m.callMcpTool(res.server.id, "echo", { text: "x" }, new AbortController().signal, 10_000);
    expect(call.ok).toBe(false);
  });

  it("disable closes the connection; enable reconnects on next call", async () => {
    const { res } = await addFixtureServer();
    if (!res.ok) throw new Error(res.error);
    await m.updateMcpServer(res.server.id, { enabled: false });
    expect(m.listMcpServers().servers[0].state).toBe("disabled");
    const disabled = await m.callMcpTool(res.server.id, "echo", { text: "x" }, new AbortController().signal, 10_000);
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) expect(disabled.error).toContain("disabled");
    await m.updateMcpServer(res.server.id, { enabled: true });
    expect(m.listMcpServers().servers[0].state).toBe("disconnected");
    // A reconnect spawns a fresh connection — a new process for a real stdio
    // server, a fresh paired transport here.
    fixtures.set("fixture", (await startFixture()).clientTransport);
    // The next call reconnects inline — one attempt, no background loop.
    const out = await m.callMcpTool(res.server.id, "echo", { text: "back" }, new AbortController().signal, 10_000);
    expect(out).toEqual({ ok: true, text: "echo:back" });
  });

  it("a mid-call transport failure marks the server failed and the next call reconnects", async () => {
    const { res, fx } = await addFixtureServer();
    if (!res.ok) throw new Error(res.error);
    // Kill the server side of the pair: the connection is now a dead pipe.
    await fx.close();
    const failed = await m.callMcpTool(res.server.id, "echo", { text: "x" }, new AbortController().signal, 10_000);
    expect(failed.ok).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    const state = m.listMcpServers().servers[0].state;
    expect(state === "failed" || state === "disconnected").toBe(true);
    // A fresh fixture answers the reconnect.
    const fx2 = await startFixture();
    fixtures.set("fixture", fx2.clientTransport);
    const out = await m.callMcpTool(res.server.id, "echo", { text: "again" }, new AbortController().signal, 10_000);
    expect(out).toEqual({ ok: true, text: "echo:again" });
  });

  it("shutdown closes every connection without throwing", async () => {
    await addFixtureServer("a");
    await addFixtureServer("b");
    await expect(m.shutdownMcpServers()).resolves.toBeUndefined();
  });

  it("secrets are written through the envelope and env values reach the server config path only", async () => {
    const { res } = await addFixtureServer("fixture", { env: { API_TOKEN: "tok_123" }, headers: undefined });
    if (!res.ok) throw new Error(res.error);
    // The renderer-facing view knows names, never values.
    expect(res.server.envKeys).toEqual(["API_TOKEN"]);
    expect(JSON.stringify(res.server)).not.toContain("tok_123");
    // The file on disk holds the envelope, not the plaintext.
    const raw = fs.readFileSync(path.join(dir, "mcp", "secrets.bin"), "utf8");
    expect(raw.startsWith("enc:")).toBe(true);
    expect(raw).not.toContain("tok_123");
  });
});

describe("5. the registry sync makes discovered tools first-class agent tools", () => {
  it("connected servers' tools appear in an attached registry, and disappear on remove", async () => {
    const { createBuiltinRegistry } = await import("../electron/services/agent/tools");
    const registry = createBuiltinRegistry(false);
    m.attachMcpRegistry(registry);
    expect(registry.names().some((n) => n.startsWith("mcp__"))).toBe(false);

    const { res } = await addFixtureServer();
    if (!res.ok) throw new Error(res.error);
    const names = registry.names().filter((n) => n.startsWith("mcp__"));
    expect(names).toContain("mcp__fixture__echo");
    expect(names).toContain("mcp__fixture__explode");
    expect(names).toContain("mcp__fixture__read_resource");
    const echo = registry.get("mcp__fixture__echo");
    expect(echo?.category).toBe("mcp");
    expect(echo?.readOnly).toBe(true);
    expect(registry.get("mcp__fixture__explode")?.readOnly).toBe(false);

    await m.removeMcpServer(res.server.id);
    expect(registry.names().some((n) => n.startsWith("mcp__"))).toBe(false);
  });

  it("a disabled server's tools leave the registry until re-enabled", async () => {
    const { createBuiltinRegistry } = await import("../electron/services/agent/tools");
    const registry = createBuiltinRegistry(false);
    m.attachMcpRegistry(registry);
    const { res } = await addFixtureServer();
    if (!res.ok) throw new Error(res.error);
    await m.updateMcpServer(res.server.id, { enabled: false });
    expect(registry.names().some((n) => n.startsWith("mcp__"))).toBe(false);
    await m.updateMcpServer(res.server.id, { enabled: true });
    fixtures.set("fixture", (await startFixture()).clientTransport);
    const out = await m.callMcpTool(res.server.id, "echo", { text: "y" }, new AbortController().signal, 10_000);
    expect(out.ok).toBe(true);
    expect(registry.names()).toContain("mcp__fixture__echo");
  });
});
