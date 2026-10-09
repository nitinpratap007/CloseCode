// Close Code — MCP tools for the agent registry (Phase 30)
//
// A configured MCP server's discovered tools become first-class agent tools
// named `mcp__<server>__<tool>`, which is what makes every Phase 21-30 property
// apply to them unchanged: they are resolved per run by the same registry,
// validated against their own (real, server-provided) JSON Schema by the same
// `invoke`, gated by the same permission model, traced on the same run record,
// and hidden from read-only agents when the server itself says a tool writes
// (`annotations.readOnlyHint === false`).
//
// This module only *builds* AgentTool objects. It owns no connection state and
// no config: the manager (`electron/services/mcp.ts`) owns both, and passes the
// one function these closures need — "call this tool on this server" — in as an
// argument, so the tools are constructible in a unit test with a fake caller
// and no MCP anything on the machine.

import type { AgentTool, AgentToolContext, AgentToolOutcome } from "./types";

/** What the manager reports about one discovered MCP tool. */
export interface McpDiscoveredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** From MCP `annotations`. Absent means the server did not say. */
  readOnlyHint: boolean;
  destructiveHint: boolean;
}

/** The one call the tools need. Implemented by the manager, faked by tests. */
export type McpToolCaller = (
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  maxChars: number,
) => Promise<{ ok: true; text: string } | { ok: false; error: string }>;

export type McpResourceReader = (
  serverId: string,
  uri: string,
  signal: AbortSignal,
  maxChars: number,
) => Promise<{ ok: true; text: string } | { ok: false; error: string }>;

const DENIED: AgentToolOutcome = { granted: false, text: "Permission denied by policy or user." };

/**
 * The tool-name prefix for a server. OpenAI-compatible function names must be
 * `^[a-zA-Z0-9_-]{1,64}$`; a server named "My Git Server" becomes `my-git-server`.
 * Falls back to the id when the name sanitises to nothing.
 */
export function serverPrefix(serverName: string, serverId: string): string {
  const san = serverName
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return `mcp__${san || serverId}`;
}

/** Sanitise an MCP tool name into the function-name charset. */
function toolPart(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "tool";
}

/** OpenAI's 64-character function-name ceiling, kept collision-free by the caller. */
export function agentToolName(prefix: string, toolName: string, suffix = ""): string {
  const base = `${prefix}__${toolPart(toolName)}`;
  return (base + suffix).slice(0, 64);
}

/**
 * The schema handed to the registry's validator is the server's own
 * `inputSchema`. MCP declares it as a JSON Schema object; when a server ships
 * something that is not an object schema, the honest fallback is an open object
 * schema — the registry's validator treats missing properties as unconstrained,
 * and the server remains the authority on its own arguments.
 */
function asObjectSchema(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const s = input as Record<string, unknown>;
    if (s.type === undefined || s.type === "object") return s;
  }
  return { type: "object", properties: {} };
}

/** Build one agent tool per discovered MCP tool, in discovery order. */
export function buildMcpAgentTools(
  serverId: string,
  serverName: string,
  tools: readonly McpDiscoveredTool[],
  call: McpToolCaller,
  readResource: McpResourceReader | null,
  resourceCount: number,
): AgentTool[] {
  const prefix = serverPrefix(serverName, serverId);
  const out: AgentTool[] = [];
  const used = new Set<string>();

  for (const tool of tools) {
    let name = agentToolName(prefix, tool.name);
    for (let n = 2; used.has(name); n += 1) name = agentToolName(prefix, tool.name, `_${n}`);
    used.add(name);
    const description =
      (tool.description || "").trim() ||
      `MCP tool "${tool.name}" provided by the "${serverName}" server.`;
    const destructive = tool.destructiveHint === true;
    out.push({
      name,
      description: `[MCP ${serverName}] ${description}`,
      parameters: asObjectSchema(tool.inputSchema),
      category: "mcp",
      readOnly: tool.readOnlyHint === true,
      destructive,
      async execute(ctx: AgentToolContext, args: Record<string, unknown>): Promise<AgentToolOutcome> {
        if (!(await ctx.authorize("mcp", args))) return DENIED;
        const res = await call(serverId, tool.name, args, ctx.signal, ctx.maxOutputChars);
        if (!res.ok) {
          return { granted: true, status: "error", text: `Error: ${res.error}` };
        }
        return { granted: true, text: res.text };
      },
    });
  }

  // Resources are read-only content, so they surface as one read-only tool per
  // server — and only when the server actually has some to read.
  if (readResource && resourceCount > 0) {
    let name = agentToolName(prefix, "read_resource");
    for (let n = 2; used.has(name); n += 1) name = agentToolName(prefix, "read_resource", `_${n}`);
    used.add(name);
    out.push({
      name,
      description:
        `[MCP ${serverName}] Read one of this server's resources by URI. ` +
        `Use the resource list (in the MCP panel) to find the URI; the resource's text comes back as the result.`,
      parameters: {
        type: "object",
        properties: {
          uri: { type: "string", description: "The resource URI, exactly as the server listed it." },
        },
        required: ["uri"],
      },
      category: "mcp",
      readOnly: true,
      destructive: false,
      async execute(ctx: AgentToolContext, args: Record<string, unknown>): Promise<AgentToolOutcome> {
        if (!(await ctx.authorize("mcp", args))) return DENIED;
        const uri = typeof args.uri === "string" ? args.uri.trim() : "";
        if (!uri) return { granted: true, status: "error", text: "Error: read_resource needs a uri." };
        const res = await readResource(serverId, uri, ctx.signal, ctx.maxOutputChars);
        if (!res.ok) {
          return { granted: true, status: "error", text: `Error: ${res.error}` };
        }
        return { granted: true, text: res.text };
      },
    });
  }

  return out;
}
