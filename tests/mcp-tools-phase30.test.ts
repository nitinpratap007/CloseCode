// Phase 30 — MCP tools in the agent surface.
//
// Two layers:
//
//   1. The tool builder as a unit: naming, sanitisation, schema passthrough,
//      the permission gate, annotation mapping, and the read_resource rule. The
//      caller is fake, so the test is about the tool's own behaviour.
//
//   2. One real runtime run: a model scripted to call `mcp__fixture__echo`
//      goes through the real registry, the real gate, the real manager and a
//      real SDK server over an in-memory pair — the whole chain, no mock of
//      the protocol.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import {
  agentToolName,
  buildMcpAgentTools,
  serverPrefix,
  type McpDiscoveredTool,
  type McpToolCaller,
} from "../electron/services/agent/tools-mcp";
import { type AgentToolContext, type AgentPermissionRequest } from "../electron/services/agent/types";
import { AgentRuntime, type AgentRuntimeOptions } from "../electron/services/agent/runtime";
import { createBuiltinRegistry } from "../electron/services/agent/tools";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "cc-mcptools-"));
vi.mock("electron", () => ({
  app: { getPath: () => userData },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${Buffer.from(s, "utf8").toString("base64")}`, "utf8"),
    decryptString: (b: Buffer) => Buffer.from(b.toString("utf8").slice(4), "base64").toString("utf8"),
  },
}));

// ---------------------------------------------------------------------------
// Unit layer
// ---------------------------------------------------------------------------

const ECHO: McpDiscoveredTool = {
  name: "echo",
  description: "Echo text back",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  readOnlyHint: true,
  destructiveHint: false,
};

const WRITE: McpDiscoveredTool = {
  name: "create issue",
  description: "",
  inputSchema: { type: "object", properties: { title: { type: "string" } } },
  readOnlyHint: false,
  destructiveHint: false,
};

function fakeCaller(over: Partial<Record<"echo" | "create issue" | "resource", { ok: boolean; text?: string; error?: string }>> = {}) {
  const calls: Array<{ serverId: string; name: string; args: Record<string, unknown> }> = [];
  const caller: McpToolCaller = async (serverId, toolName, args) => {
    calls.push({ serverId, name: toolName, args });
    const key = toolName as "echo";
    const out = over[key];
    if (out && out.ok === false) return { ok: false, error: out.error ?? "nope" };
    return { ok: true, text: out?.text ?? `result:${toolName}` };
  };
  return { calls, caller };
}

function makeCtx(over: { authorize?: (category: string, args: Record<string, unknown>, request?: AgentPermissionRequest) => Promise<boolean> } = {}): AgentToolContext {
  return {
    runId: "run_test",
    agentId: "build",
    workspace: "C:\\proj",
    signal: new AbortController().signal,
    deadline: Date.now() + 60_000,
    maxOutputChars: 10_000,
    authorize: over.authorize ?? (async () => true),
    log: () => undefined,
  } as unknown as AgentToolContext;
}

describe("MCP tool builder — naming and shape", () => {
  it("names tools mcp__<server>__<tool>, sanitising both halves", () => {
    expect(serverPrefix("My Git Server", "mcp-abc")).toBe("mcp__my-git-server");
    expect(serverPrefix("!!!", "mcp-abc")).toBe("mcp__mcp-abc");
    expect(agentToolName("mcp__fixture", "create issue")).toBe("mcp__fixture__create-issue");
    expect(agentToolName("mcp__fixture", "x".repeat(100)).length).toBeLessThanOrEqual(64);
  });

  it("passes the server's own schema through and maps the annotations", () => {
    const { caller } = fakeCaller();
    const tools = buildMcpAgentTools("mcp-1", "fixture", [ECHO, WRITE], caller, null, 0);
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe("mcp__fixture__echo");
    expect(tools[0].category).toBe("mcp");
    expect(tools[0].readOnly).toBe(true);
    expect(tools[0].parameters).toEqual(ECHO.inputSchema);
    expect(tools[1].name).toBe("mcp__fixture__create-issue");
    expect(tools[1].readOnly).toBe(false);
    // An empty description is synthesised — a tool the model cannot read about
    // is a tool it will misuse.
    expect(tools[1].description.length).toBeGreaterThan(0);
  });

  it("read_resource is registered only when the server has resources", () => {
    const { caller } = fakeCaller();
    const none = buildMcpAgentTools("mcp-1", "fixture", [ECHO], caller, async () => ({ ok: true, text: "" }), 0);
    expect(none.map((t) => t.name)).not.toContain("mcp__fixture__read_resource");
    const some = buildMcpAgentTools("mcp-1", "fixture", [ECHO], caller, async () => ({ ok: true, text: "body" }), 3);
    const rr = some.find((t) => t.name === "mcp__fixture__read_resource");
    expect(rr?.readOnly).toBe(true);
    expect(rr?.destructive).toBe(false);
  });

  it("a schema that is not an object schema becomes an open object schema", () => {
    const { caller } = fakeCaller();
    const weird: McpDiscoveredTool = { name: "w", description: "w", inputSchema: ["not", "a", "schema"] as never, readOnlyHint: false, destructiveHint: false };
    const tools = buildMcpAgentTools("mcp-1", "fixture", [weird], caller, null, 0);
    expect(tools[0].parameters).toEqual({ type: "object", properties: {} });
  });
});

describe("MCP tool builder — the gate and the outcome", () => {
  it("every call goes through the mcp category, and a denial stops the call", async () => {
    const { calls, caller } = fakeCaller();
    const tools = buildMcpAgentTools("mcp-1", "fixture", [ECHO], caller, null, 0);
    let seen: string | null = null;
    const ctx = makeCtx({
      authorize: async (category) => {
        seen = category;
        return false;
      },
    });
    const outcome = await tools[0].execute(ctx, { text: "hi" });
    expect(outcome.granted).toBe(false);
    expect(seen).toBe("mcp");
    expect(calls).toHaveLength(0); // the server was never touched
  });

  it("a successful call returns the server's text; a failure is a readable error", async () => {
    const { calls, caller } = fakeCaller({ echo: { ok: true, text: "echo:hi" } });
    const tools = buildMcpAgentTools("mcp-1", "fixture", [ECHO], caller, null, 0);
    const good = await tools[0].execute(makeCtx(), { text: "hi" });
    expect(good.granted).toBe(true);
    expect(good.text).toBe("echo:hi");
    expect(calls[0]).toEqual({ serverId: "mcp-1", name: "echo", args: { text: "hi" } });

    const failing = buildMcpAgentTools("mcp-1", "fixture", [ECHO], async () => ({ ok: false, error: "server gone" }), null, 0);
    const bad = await failing[0].execute(makeCtx(), { text: "hi" });
    expect(bad.granted).toBe(true);
    expect(bad.status).toBe("error");
    expect(bad.text).toContain("server gone");
  });
});

// ---------------------------------------------------------------------------
// The real chain: runtime → registry → gate → manager → real MCP server
// ---------------------------------------------------------------------------

type Mod = typeof import("../electron/services/mcp");

let dir: string;
let m: Mod;
let servers: McpServer[];

async function load(): Promise<Mod> {
  vi.resetModules();
  const mod = await import("../electron/services/mcp");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-mcpt-real-"));
  mod.setMcpDir(dir);
  return mod;
}

async function startFixture(): Promise<InMemoryTransport> {
  const server = new McpServer({ name: "fixture", version: "2.0.0" });
  server.registerTool(
    "echo",
    { description: "Echo text back", inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
    async ({ text }) => ({ content: [{ type: "text" as const, text: `echo:${text}` }] }),
  );
  servers.push(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return clientTransport;
}

function scriptedTransport(script: Array<{ content?: string; toolCalls?: Array<{ name: string; args: unknown }> }>): {
  transport: NonNullable<AgentRuntimeOptions["createTransport"]>;
} {
  let i = 0;
  const transport = async () => {
    const turn = script[Math.min(i, script.length - 1)];
    i += 1;
    return {
      content: turn.content ?? "",
      toolCalls: (turn.toolCalls ?? []).map((tc, n) => ({
        id: `call-${i}-${n}`,
        name: tc.name,
        arguments: JSON.stringify(tc.args),
      })),
      streamed: false,
    };
  };
  return { transport };
}

beforeEach(async () => {
  m = await load();
  servers = [];
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
    // disposable
  }
});

describe("MCP tools — one real run through the whole chain (Phase 30 integration)", () => {
  async function wireServer(): Promise<{ serverId: string; registry: ReturnType<typeof createBuiltinRegistry> }> {
    const transport = await startFixture();
    m.setMcpTransportFactoryForTests(() => ({ transport, kind: "stdio" }));
    const added = await m.addMcpServer({ name: "fixture", transport: "stdio", command: "fixture" });
    if (!added.ok) throw new Error(added.error);
    const registry = createBuiltinRegistry(true);
    m.attachMcpRegistry(registry);
    return { serverId: added.server.id, registry };
  }

  it("a model calling an MCP tool gets the server's real answer, gated by mcp", async () => {
    const { registry } = await wireServer();
    expect(registry.has("mcp__fixture__echo")).toBe(true);

    const { transport } = scriptedTransport([
      { toolCalls: [{ name: "mcp__fixture__echo", args: { text: "over the wire" } }] },
      { content: "The server said it back." },
    ]);
    const runtime = new AgentRuntime({
      registry,
      createTransport: () => transport,
      onEvent: () => undefined,
    });
    const result = await runtime.run({
      agentId: "build",
      task: "Call the MCP echo tool once.",
      workspace: "C:\\proj",
      endpoint: { url: "http://127.0.0.1:11434", model: "t", key: null },
      temperature: 0,
      timeoutMs: 5000,
      stream: true,
      permissions: { mcp: "allow" },
    });

    expect(result.status).toBe("completed");
    expect(result.toolCalls).toBe(1);
    const trace = runtime.getRun(result.runId)?.trace ?? [];
    const entry = trace.find((t) => t.kind === "tool" && (t as { tool?: string }).tool === "mcp__fixture__echo") as { granted?: boolean; text?: string } | undefined;
    expect(entry?.granted).toBe(true);
    expect(entry?.text).toContain("echo:over the wire");
  });

  it("a denied MCP call never reaches the server, and the run records the denial", async () => {
    const { registry } = await wireServer();
    const { transport } = scriptedTransport([
      { toolCalls: [{ name: "mcp__fixture__echo", args: { text: "should not arrive" } }] },
      { content: "Understood." },
    ]);
    const runtime = new AgentRuntime({
      registry,
      createTransport: () => transport,
      onEvent: () => undefined,
    });
    const result = await runtime.run({
      agentId: "build",
      task: "Call the MCP echo tool once.",
      workspace: "C:\\proj",
      endpoint: { url: "http://127.0.0.1:11434", model: "t", key: null },
      temperature: 0,
      timeoutMs: 5000,
      stream: true,
      permissions: { mcp: "deny" },
    });

    expect(result.status).toBe("completed");
    const trace = runtime.getRun(result.runId)?.trace ?? [];
    const entry = trace.find((t) => t.kind === "tool" && (t as { tool?: string }).tool === "mcp__fixture__echo") as { granted?: boolean } | undefined;
    expect(entry?.granted).toBe(false);
  });
});
