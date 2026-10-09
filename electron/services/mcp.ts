// Close Code — MCP (Model Context Protocol) support (Phase 30)
//
// Before this phase the app could not speak to an MCP server at all: the
// `mcp.invoke` capability existed (declared ahead in Phase 23, default `deny`)
// with nothing behind it. This module is the whole MCP story in the main
// process:
//
//   * configuration — servers the user adds, stored per-install in
//     `userData/mcp/servers.json` with the same atomic write and quarantine the
//     sessions and task stores use;
//   * secrets — env values and HTTP header values are stored encrypted
//     (safeStorage, same envelope as the AI provider keys) and never sent to
//     the renderer: the panel learns names, never values;
//   * lifecycle — one connection per enabled server, lazy connect with a
//     timeout, a single inline reconnect attempt on the next call after a
//     failure, no background retry loops, `closeAll` on quit;
//   * discovery — tools, resources and prompts listed once per connection and
//     cached, because the registry reads them synchronously per run;
//   * invocation — `tools/call`, `resources/read`, `prompts/get` with per-call
//     timeouts, the run's abort signal honoured, and every failure contained
//     into `{ ok: false, error }`: a failed server must never crash the app,
//     and a crashing server must never take the agent run down with it.
//
// WHY LAZY, NOT EAGER:
//
//   A server the user configured months ago and never uses should not spawn a
//   child process on every launch. Connections open on first use (or on an
//   explicit `warmup` at startup for *enabled* servers), fail into a `failed`
//   state with the server's own stderr as the error, and recover on the next
//   call — one attempt per call, so a wedged server costs one timeout, not the
//   whole session.
//
// SECURITY, stated plainly:
//
//   * Every MCP tool call goes through the `mcp` category / `mcp.invoke`
//     capability gate, which defaults to `deny`. Adding a server does not grant
//     anything; the user opts in separately.
//   * Env/header values never leave the main process after being written.
//   * A server is code: `stdio` spawns it, `http` talks to it. Neither path is
//     sandboxed — that is what the permission gate and the disabled-by-default
//     posture are for, and it is said here rather than implied away.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { app, safeStorage } from "electron";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { ToolRegistry } from "./agent/tools";
import { buildMcpAgentTools, agentToolName, serverPrefix, type McpDiscoveredTool } from "./agent/tools-mcp";
import type { AgentTool } from "./agent/types";

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

export type McpTransport = "stdio" | "http";

export type McpServerState = "disabled" | "disconnected" | "connecting" | "connected" | "failed";

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransport;
  enabled: boolean;
  // stdio
  command: string;
  args: string[];
  // http
  url: string;
  /** Names only — values live in the encrypted secrets file, never here. */
  envKeys: string[];
  headerKeys: string[];
  createdAt: number;
  updatedAt: number;
}

export interface McpServerView {
  id: string;
  name: string;
  transport: McpTransport;
  enabled: boolean;
  state: McpServerState;
  lastError: string | null;
  /** The server's own self-reported identity, once connected. */
  server: { name: string; version: string } | null;
  command: string;
  args: string[];
  url: string;
  envKeys: string[];
  headerKeys: string[];
  counts: { tools: number; resources: number; prompts: number };
  createdAt: number;
  updatedAt: number;
}

export interface McpResourceInfo {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface McpPromptInfo {
  name: string;
  description: string;
  arguments: Array<{ name: string; description: string; required: boolean }>;
}

export interface McpPromptMessage {
  role: string;
  text: string;
}

export type McpResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

// Bounds
export const MAX_MCP_SERVERS = 16;
export const MAX_MCP_NAME = 60;
export const MAX_MCP_ARGS = 32;
export const MAX_MCP_ARG_CHARS = 512;
export const MAX_MCP_ENV_KEYS = 32;
export const MAX_MCP_VALUE_CHARS = 2000;
export const MAX_MCP_TOOLS = 256;
export const MAX_MCP_RESOURCES = 256;
export const MAX_MCP_PROMPTS = 128;
const MAX_LIST_PAGES = 20;
const CONNECT_TIMEOUT_MS = 15_000;
const LIST_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 60_000;
const MAX_STDERR_CHARS = 4000;
const MAX_RESULT_CHARS = 24_000;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

let mcpDirOverride: string | null = null;

/** Tests point the whole module at a temp directory, like the other stores. */
export function setMcpDir(dir: string): void {
  mcpDirOverride = dir;
}

function mcpDir(): string {
  const base = mcpDirOverride ?? app.getPath("userData");
  return path.join(base, "mcp");
}

function serversFile(): string {
  return path.join(mcpDir(), "servers.json");
}

function secretsFile(): string {
  return path.join(mcpDir(), "secrets.bin");
}

function ensureDir(): void {
  fs.mkdirSync(mcpDir(), { recursive: true });
}

// ---------------------------------------------------------------------------
// Secrets — env and header values, encrypted exactly like AI provider keys
// ---------------------------------------------------------------------------

interface McpSecretsFile {
  version: 1;
  /** serverId -> { "env.NAME": value, "header.NAME": value } */
  servers: Record<string, Record<string, string>>;
}

function readSecrets(): McpSecretsFile {
  try {
    const p = secretsFile();
    if (!fs.existsSync(p)) return { version: 1, servers: {} };
    const raw = fs.readFileSync(p);
    if (safeStorage.isEncryptionAvailable()) {
      const parsed = JSON.parse(safeStorage.decryptString(raw)) as McpSecretsFile;
      if (parsed && parsed.servers) return parsed;
      return { version: 1, servers: {} };
    }
    // The plaintext fallback only reads files the plaintext writer made. Bytes
    // written encrypted are not JSON; parsing them as if they were produces a
    // misleading syntax error, so say what actually happened instead.
    try {
      const parsed = JSON.parse(raw.toString("utf8")) as McpSecretsFile;
      if (parsed && parsed.servers) return parsed;
    } catch {
      console.error(
        "Failed to read MCP secrets: the file was written encrypted and this instance has no encryption backend to read it with.",
      );
    }
  } catch (err) {
    console.error("Failed to read MCP secrets:", err);
  }
  return { version: 1, servers: {} };
}

function writeSecrets(secrets: McpSecretsFile): void {
  try {
    ensureDir();
    if (safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(secretsFile(), safeStorage.encryptString(JSON.stringify(secrets)));
    } else {
      fs.writeFileSync(secretsFile(), Buffer.from(JSON.stringify(secrets), "utf8"));
    }
  } catch (err) {
    console.error("Failed to store MCP secrets:", err);
  }
}

function secretsFor(serverId: string, kind: "env" | "header"): Record<string, string> {
  const all = readSecrets().servers[serverId] ?? {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(`${kind}.`)) out[k.slice(kind.length + 1)] = v;
  }
  return out;
}

/** Replace the whole secret set for one server of one kind. */
function setSecrets(serverId: string, kind: "env" | "header", values: Record<string, string>): void {
  const all = readSecrets();
  const mine = { ...(all.servers[serverId] ?? {}) };
  for (const k of Object.keys(mine)) if (k.startsWith(`${kind}.`)) delete mine[k];
  for (const [k, v] of Object.entries(values)) mine[`${kind}.${k}`] = v;
  all.servers[serverId] = mine;
  writeSecrets(all);
}

function dropSecrets(serverId: string): void {
  const all = readSecrets();
  if (serverId in all.servers) {
    delete all.servers[serverId];
    writeSecrets(all);
  }
}

// ---------------------------------------------------------------------------
// Config persistence — atomic write, quarantine on corruption
// ---------------------------------------------------------------------------

interface McpConfigFile {
  version: 1;
  servers: McpServerConfig[];
}

function writeFileAtomic(file: string, text: string): void {
  ensureDir();
  const tmp = `${file}.tmp`;
  try {
    if (fs.existsSync(file)) {
      const bakTmp = `${file}.bak.tmp`;
      fs.writeFileSync(bakTmp, fs.readFileSync(file));
      fs.renameSync(bakTmp, `${file}.bak`);
    }
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, file);
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
    } catch {
      // last-resort cleanup; the next write overwrites it anyway
    }
  }
}

function sanitizeConfig(raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" && r.id.length > 0 && r.id.length <= 64 ? r.id : null;
  const name = typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, MAX_MCP_NAME) : null;
  const transport: McpTransport | null = r.transport === "stdio" || r.transport === "http" ? r.transport : null;
  if (!id || !name || !transport) return null;
  const keys = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((k): k is string => typeof k === "string" && k.length > 0).slice(0, MAX_MCP_ENV_KEYS) : [];
  const args = Array.isArray(r.args)
    ? r.args.filter((a): a is string => typeof a === "string").map((a) => a.slice(0, MAX_MCP_ARG_CHARS)).slice(0, MAX_MCP_ARGS)
    : [];
  return {
    id,
    name,
    transport,
    enabled: r.enabled !== false,
    command: typeof r.command === "string" ? r.command : "",
    args,
    url: typeof r.url === "string" ? r.url : "",
    envKeys: keys(r.envKeys),
    headerKeys: keys(r.headerKeys),
    createdAt: typeof r.createdAt === "number" ? r.createdAt : Date.now(),
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : Date.now(),
  };
}

function loadConfig(): { servers: McpServerConfig[]; corruptFile: string | null } {
  const file = serversFile();
  if (!fs.existsSync(file)) return { servers: [], corruptFile: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<McpConfigFile>;
    const servers = (Array.isArray(parsed.servers) ? parsed.servers : [])
      .map(sanitizeConfig)
      .filter((s): s is McpServerConfig => s !== null);
    return { servers, corruptFile: null };
  } catch {
    // Unreadable bytes are moved aside, never deleted — the user may be able to
    // rescue a server definition by hand, and silent deletion is how trust dies.
    const aside = `${file}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(file, aside);
    } catch {
      return { servers: [], corruptFile: file };
    }
    return { servers: [], corruptFile: aside };
  }
}

function persistConfig(servers: McpServerConfig[]): void {
  writeFileAtomic(serversFile(), JSON.stringify({ version: 1, servers } satisfies McpConfigFile, null, 2));
}

// ---------------------------------------------------------------------------
// Change notification — same one-hook pattern as the task store
// ---------------------------------------------------------------------------

type McpChangedListener = () => void;

let changedListener: McpChangedListener | null = null;

export function setMcpChangedListener(cb: McpChangedListener | null): void {
  changedListener = cb;
}

function notifyChanged(): void {
  try {
    changedListener?.();
  } catch {
    // a broken listener must not break the manager it listens to
  }
}

// ---------------------------------------------------------------------------
// The manager
// ---------------------------------------------------------------------------

interface Discovered {
  tools: McpDiscoveredTool[];
  resources: McpResourceInfo[];
  prompts: McpPromptInfo[];
}

interface Live {
  config: McpServerConfig;
  state: McpServerState;
  client: Client | null;
  connecting: Promise<McpResult> | null;
  lastError: string | null;
  serverInfo: { name: string; version: string } | null;
  discovered: Discovered | null;
}

const live = new Map<string, Live>();
const attachedRegistries = new Set<ToolRegistry>();

function liveFor(config: McpServerConfig): Live {
  const existing = live.get(config.id);
  if (existing) {
    existing.config = config;
    return existing;
  }
  const created: Live = {
    config,
    state: config.enabled ? "disconnected" : "disabled",
    client: null,
    connecting: null,
    lastError: null,
    serverInfo: null,
    discovered: null,
  };
  live.set(config.id, created);
  return created;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s.`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** A discovery list may be paginated; read every page, bounded. */
async function listAll<T>(
  fetchPage: (cursor?: string) => Promise<Record<string, unknown> & { nextCursor?: string }>,
  key: string,
  cap: number,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES && out.length < cap; page += 1) {
    const res = await fetchPage(cursor);
    const items = Array.isArray(res[key]) ? (res[key] as T[]) : [];
    out.push(...items);
    cursor = typeof res.nextCursor === "string" && res.nextCursor ? res.nextCursor : undefined;
    if (!cursor) break;
  }
  return out.slice(0, cap);
}

async function discover(client: Client): Promise<Discovered> {
  const capabilities = client.getServerCapabilities() ?? {};
  const [tools, resources, prompts] = await Promise.all([
    capabilities.tools
      ? withTimeout(
          listAll<{ name: string; description?: string; inputSchema?: unknown; annotations?: Record<string, unknown> }>(
            (cursor) => client.listTools(cursor ? { cursor } : undefined) as Promise<never>,
            "tools",
            MAX_MCP_TOOLS,
          ),
          LIST_TIMEOUT_MS,
          "Listing MCP tools",
        )
      : Promise.resolve([]),
    capabilities.resources
      ? withTimeout(
          listAll<{ uri: string; name?: string; description?: string; mimeType?: string }>(
            (cursor) => client.listResources(cursor ? { cursor } : undefined) as Promise<never>,
            "resources",
            MAX_MCP_RESOURCES,
          ),
          LIST_TIMEOUT_MS,
          "Listing MCP resources",
        )
      : Promise.resolve([]),
    capabilities.prompts
      ? withTimeout(
          listAll<{ name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }>(
            (cursor) => client.listPrompts(cursor ? { cursor } : undefined) as Promise<never>,
            "prompts",
            MAX_MCP_PROMPTS,
          ),
          LIST_TIMEOUT_MS,
          "Listing MCP prompts",
        )
      : Promise.resolve([]),
  ]);
  return {
    tools: tools.map((t) => ({
      name: t.name,
      description: typeof t.description === "string" ? t.description : "",
      inputSchema:
        t.inputSchema && typeof t.inputSchema === "object" && !Array.isArray(t.inputSchema)
          ? (t.inputSchema as Record<string, unknown>)
          : { type: "object", properties: {} },
      readOnlyHint: t.annotations?.readOnlyHint === true,
      destructiveHint: t.annotations?.destructiveHint === true,
    })),
    resources: resources.map((r) => ({
      uri: r.uri,
      name: typeof r.name === "string" ? r.name : r.uri,
      description: typeof r.description === "string" ? r.description : "",
      mimeType: typeof r.mimeType === "string" ? r.mimeType : "",
    })),
    prompts: prompts.map((p) => ({
      name: p.name,
      description: typeof p.description === "string" ? p.description : "",
      arguments: (Array.isArray(p.arguments) ? p.arguments : []).map((a) => ({
        name: a.name,
        description: typeof a.description === "string" ? a.description : "",
        required: a.required === true,
      })),
    })),
  };
}

/**
 * Test seam: unit tests run the whole protocol against a real SDK server over
 * an in-memory pair, without spawning processes on the test machine. The E2E
 * covers the real stdio and HTTP paths; this hook is the only part of the
 * connect flow that is swapped, and it is unset outside tests.
 */
let transportFactory: ((config: McpServerConfig) => { transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport | unknown; kind: string }) | null = null;

export function setMcpTransportFactoryForTests(factory: typeof transportFactory): void {
  transportFactory = factory;
}

/** Build the transport for a config. Throws synchronously on a bad URL. */
function makeTransport(config: McpServerConfig): { transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport; kind: string } {
  if (transportFactory) {
    return transportFactory(config) as { transport: StdioClientTransport; kind: string };
  }
  if (config.transport === "stdio") {
    const env = { ...getDefaultEnvironment(), ...secretsFor(config.id, "env") };
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env,
      stderr: "pipe",
    });
    return { transport, kind: "stdio" };
  }
  const url = new URL(config.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`MCP url must be http(s), got "${url.protocol}".`);
  }
  const headers = secretsFor(config.id, "header");
  // Streamable HTTP first; a legacy SSE-only server gets the SSE transport as
  // the documented fallback, and the record says which one actually worked.
  return {
    transport: new StreamableHTTPClientTransport(url, { requestInit: { headers } }),
    kind: "streamable-http",
  };
}

async function closeLive(entry: Live): Promise<void> {
  const client = entry.client;
  entry.client = null;
  entry.connecting = null;
  if (client) {
    try {
      await client.close();
    } catch {
      // closing a broken connection must not throw into the caller
    }
  }
}

/**
 * Connect one server. Concurrent callers share the in-flight attempt; a
 * failure leaves the server in `failed` with the server's own error text —
 * including the last of its stderr for stdio servers, which is where "the
 * server printed why it could not start" actually lives.
 */
function connect(entry: Live): Promise<McpResult> {
  if (entry.state === "connected" && entry.client) {
    return Promise.resolve({ ok: true, text: "already connected" });
  }
  if (entry.connecting) return entry.connecting;

  entry.state = "connecting";
  notifyChanged();

  entry.connecting = (async (): Promise<McpResult> => {
    const stderrChunks: string[] = [];
    let stderrLen = 0;
    let client: Client | null = null;
    try {
      const { transport, kind } = makeTransport(entry.config);
      if (transport instanceof StdioClientTransport && transport.stderr) {
        transport.stderr.on("data", (chunk: Buffer | string) => {
          const text = chunk.toString();
          stderrChunks.push(text);
          stderrLen += text.length;
          while (stderrLen > MAX_STDERR_CHARS && stderrChunks.length > 0) {
            const first = stderrChunks[0];
            stderrLen -= first.length;
            stderrChunks.shift();
          }
        });
      }
      client = new Client(
        { name: "closecode", version: "0.1.0" },
        { capabilities: {} },
      );
      const connectOnce = async (): Promise<void> => {
        try {
          await client!.connect(transport);
        } catch (firstErr) {
          // The Streamable HTTP transport speaks to post-2025 servers. A server
          // that only speaks the deprecated HTTP+SSE transport fails here, and
          // the honest thing is to try the transport it does speak rather than
          // declare the server broken.
          if (kind === "streamable-http" && entry.config.transport === "http") {
            const url = new URL(entry.config.url);
            const headers = secretsFor(entry.config.id, "header");
            const sse = new SSEClientTransport(url, { requestInit: { headers } });
            await client!.connect(sse);
            return;
          }
          throw firstErr;
        }
      };
      await withTimeout(connectOnce(), CONNECT_TIMEOUT_MS, `Connecting to MCP server "${entry.config.name}"`);
      const info = client.getServerVersion();
      entry.serverInfo = info ? { name: info.name ?? entry.config.name, version: info.version ?? "" } : null;
      entry.discovered = await discover(client);
      entry.client = client;
      entry.state = "connected";
      entry.lastError = null;
      syncRegistries();
      notifyChanged();
      return { ok: true, text: "connected" };
    } catch (err) {
      const stderr = stderrChunks.join("").trim();
      const base = errorText(err);
      entry.state = "failed";
      entry.lastError = stderr ? `${base} — server said: ${stderr.slice(-800)}` : base;
      entry.discovered = null;
      if (client) {
        try {
          await client.close();
        } catch {
          // already broken
        }
      }
      syncRegistries();
      notifyChanged();
      return { ok: false, error: entry.lastError };
    } finally {
      entry.connecting = null;
    }
  })();

  return entry.connecting;
}

/** The client for a call: connected, or one inline reconnect attempt. */
async function ensureClient(serverId: string): Promise<{ ok: true; entry: Live; client: Client } | { ok: false; error: string }> {
  const entry = live.get(serverId);
  if (!entry) return { ok: false, error: `No MCP server "${serverId}".` };
  if (!entry.config.enabled) return { ok: false, error: `MCP server "${entry.config.name}" is disabled.` };
  if (entry.state === "connected" && entry.client) return { ok: true, entry, client: entry.client };
  const res = await connect(entry);
  if (!res.ok || !entry.client) return { ok: false, error: res.ok ? "connect failed" : res.error };
  return { ok: true, entry, client: entry.client };
}

// ---------------------------------------------------------------------------
// Registry sync — MCP tools flow into the shared registry, per-run resolution
// does the rest
// ---------------------------------------------------------------------------

function currentAgentTools(): AgentTool[] {
  const out: AgentTool[] = [];
  for (const entry of live.values()) {
    if (entry.state !== "connected" || !entry.discovered) continue;
    out.push(
      ...buildMcpAgentTools(
        entry.config.id,
        entry.config.name,
        entry.discovered.tools,
        callMcpTool,
        entry.discovered.resources.length > 0 ? readMcpResource : null,
        entry.discovered.resources.length,
      ),
    );
  }
  return out;
}

function syncRegistries(): void {
  const tools = currentAgentTools();
  const byName = new Map(tools.map((t) => [t.name, t]));
  for (const registry of attachedRegistries) {
    for (const name of registry.names()) {
      if (name.startsWith("mcp__") && !byName.has(name)) registry.unregister(name);
    }
    for (const tool of tools) {
      if (!registry.has(tool.name)) registry.register(tool);
    }
  }
}

/** The agent runtime's registry attaches once; discovery changes keep it current. */
export function attachMcpRegistry(registry: ToolRegistry): void {
  attachedRegistries.add(registry);
  syncRegistries();
}

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

function clampResult(text: string, maxChars: number): string {
  const cap = Math.max(1000, Math.min(maxChars, MAX_RESULT_CHARS));
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n… (truncated, ${text.length - cap} more characters)`;
}

/** Serialise MCP content into plain text. Tool results carry `content[]`;
 * prompt messages carry one block per message — both shapes land here. */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  const blocks: unknown[] = Array.isArray(content) ? content : content ? [content] : [];
  const parts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b.type === "image") parts.push("[image content omitted — the model cannot see it]");
    else if (b.type === "audio") parts.push("[audio content omitted]");
    else if (b.type === "resource") {
      const res = b.resource as Record<string, unknown> | undefined;
      if (res && typeof res.text === "string") parts.push(res.text);
      else parts.push(`[resource ${typeof res?.uri === "string" ? res.uri : ""} omitted]`);
    } else parts.push(JSON.stringify(block));
  }
  return parts.join("\n");
}

export async function callMcpTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  maxChars: number,
): Promise<McpResult> {
  const got = await ensureClient(serverId);
  if (!got.ok) return { ok: false, error: got.error };
  if (signal.aborted) return { ok: false, error: "The run was stopped." };
  try {
    const result = (await withTimeout(
      got.client.callTool({ name: toolName, arguments: args }, undefined, { signal }),
      CALL_TIMEOUT_MS,
      `MCP tool "${toolName}"`,
    )) as { content?: unknown; isError?: boolean; structuredContent?: unknown };
    const text = clampResult(
      typeof result.structuredContent !== "undefined" && result.structuredContent !== null
        ? JSON.stringify(result.structuredContent, null, 2)
        : contentToText(result.content),
      maxChars,
    );
    if (result.isError === true) {
      return { ok: false, error: `MCP tool "${toolName}" on "${got.entry.config.name}" reported an error: ${text}` };
    }
    return { ok: true, text: text || "(no output)" };
  } catch (err) {
    // A transport failure mid-call means the connection cannot be trusted —
    // drop it so the next call reconnects instead of writing into a dead pipe,
    // and leave the server in `failed` so the panel shows what happened.
    if (!signal.aborted) {
      got.entry.state = "failed";
      got.entry.lastError = errorText(err);
      void closeLive(got.entry).then(() => notifyChanged());
      notifyChanged();
    }
    return { ok: false, error: `MCP tool "${toolName}" failed: ${errorText(err)}` };
  }
}

export async function readMcpResource(
  serverId: string,
  uri: string,
  signal: AbortSignal,
  maxChars: number,
): Promise<McpResult> {
  const got = await ensureClient(serverId);
  if (!got.ok) return { ok: false, error: got.error };
  try {
    const result = (await withTimeout(
      got.client.readResource({ uri }, { signal }),
      CALL_TIMEOUT_MS,
      `MCP resource "${uri}"`,
    )) as { contents?: Array<{ uri?: string; mimeType?: string; text?: string; blob?: string }> };
    const parts = (result.contents ?? []).map((c) => {
      if (typeof c.text === "string") return c.text;
      if (typeof c.blob === "string") return `[binary resource ${c.uri ?? uri} (${c.mimeType ?? "unknown"}), ${c.blob.length} base64 characters, not shown]`;
      return "";
    });
    return { ok: true, text: clampResult(parts.filter(Boolean).join("\n") || "(empty resource)", maxChars) };
  } catch (err) {
    return { ok: false, error: `MCP resource "${uri}" failed: ${errorText(err)}` };
  }
}

export async function getMcpPrompt(
  serverId: string,
  name: string,
  args: Record<string, string>,
): Promise<{ ok: true; messages: McpPromptMessage[] } | { ok: false; error: string }> {
  const got = await ensureClient(serverId);
  if (!got.ok) return { ok: false, error: got.error };
  try {
    const result = (await withTimeout(
      got.client.getPrompt({ name, arguments: args }),
      CALL_TIMEOUT_MS,
      `MCP prompt "${name}"`,
    )) as { messages?: Array<{ role?: string; content?: unknown }> };
    const messages = (result.messages ?? []).map((m) => ({
      role: typeof m.role === "string" ? m.role : "user",
      text: contentToText(m.content),
    }));
    return { ok: true, messages };
  } catch (err) {
    return { ok: false, error: `MCP prompt "${name}" failed: ${errorText(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Views & CRUD
// ---------------------------------------------------------------------------

function viewOf(entry: Live): McpServerView {
  return {
    id: entry.config.id,
    name: entry.config.name,
    transport: entry.config.transport,
    enabled: entry.config.enabled,
    state: entry.state,
    lastError: entry.lastError,
    server: entry.serverInfo,
    command: entry.config.command,
    args: entry.config.args,
    url: entry.config.url,
    envKeys: entry.config.envKeys,
    headerKeys: entry.config.headerKeys,
    counts: {
      tools: entry.discovered?.tools.length ?? 0,
      resources: entry.discovered?.resources.length ?? 0,
      prompts: entry.discovered?.prompts.length ?? 0,
    },
    createdAt: entry.config.createdAt,
    updatedAt: entry.config.updatedAt,
  };
}

export function listMcpServers(): { ok: true; servers: McpServerView[] } {
  const { servers } = loadConfig();
  return { ok: true, servers: servers.map((c) => viewOf(liveFor(c))) };
}

export interface McpAddInput {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

function cleanName(v: unknown): string {
  return typeof v === "string" ? v.trim().slice(0, MAX_MCP_NAME) : "";
}

function cleanKv(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const key = k.trim();
    if (!key || key.length > 64 || typeof v !== "string") continue;
    out[key] = v.slice(0, MAX_MCP_VALUE_CHARS);
    if (Object.keys(out).length >= MAX_MCP_ENV_KEYS) break;
  }
  return out;
}

function validateAdd(input: McpAddInput): string | null {
  if (input.transport === "stdio") {
    if (!input.command || !input.command.trim()) return "A stdio server needs a command (for example: node, npx, uvx).";
  } else if (input.transport === "http") {
    try {
      const url = new URL(input.url ?? "");
      if (url.protocol !== "http:" && url.protocol !== "https:") return "The URL must be http or https.";
    } catch {
      return "A remote server needs a valid URL.";
    }
  } else {
    return `Unknown transport "${String(input.transport)}".`;
  }
  return null;
}

export async function addMcpServer(input: McpAddInput): Promise<{ ok: true; server: McpServerView } | { ok: false; error: string }> {
  const name = cleanName(input.name);
  if (!name) return { ok: false, error: "A server needs a name." };
  const invalid = validateAdd(input);
  if (invalid) return { ok: false, error: invalid };
  const { servers } = loadConfig();
  if (servers.length >= MAX_MCP_SERVERS) {
    return { ok: false, error: `At most ${MAX_MCP_SERVERS} MCP servers can be configured.` };
  }
  if (servers.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
    return { ok: false, error: `A server named "${name}" already exists.` };
  }
  const now = Date.now();
  const config: McpServerConfig = {
    id: `mcp-${crypto.randomBytes(6).toString("hex")}`,
    name,
    transport: input.transport,
    enabled: input.enabled !== false,
    command: (input.command ?? "").trim(),
    args: (input.args ?? []).filter((a) => typeof a === "string").map((a) => a.slice(0, MAX_MCP_ARG_CHARS)).slice(0, MAX_MCP_ARGS),
    url: (input.url ?? "").trim(),
    envKeys: Object.keys(cleanKv(input.env)),
    headerKeys: Object.keys(cleanKv(input.headers)),
    createdAt: now,
    updatedAt: now,
  };
  setSecrets(config.id, "env", cleanKv(input.env));
  setSecrets(config.id, "header", cleanKv(input.headers));
  servers.push(config);
  persistConfig(servers);
  const entry = liveFor(config);
  notifyChanged();
  if (config.enabled) {
    // Adding a server the user cannot tell works is how silent brokenness
    // ships; connect now so the panel shows the truth immediately.
    await connect(entry);
  }
  return { ok: true, server: viewOf(entry) };
}

export interface McpUpdateInput {
  name?: string;
  enabled?: boolean;
  command?: string;
  args?: string[];
  url?: string;
  /** Present = replace that whole secret set. Absent = leave it alone. */
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export async function updateMcpServer(id: string, patch: McpUpdateInput): Promise<{ ok: true; server: McpServerView } | { ok: false; error: string }> {
  const { servers } = loadConfig();
  const idx = servers.findIndex((s) => s.id === id);
  if (idx < 0) return { ok: false, error: `No MCP server "${id}".` };
  const config = { ...servers[idx] };
  if (patch.name !== undefined) {
    const name = cleanName(patch.name);
    if (!name) return { ok: false, error: "A server needs a name." };
    config.name = name;
  }
  if (patch.command !== undefined) config.command = patch.command.trim();
  if (patch.args !== undefined) {
    config.args = patch.args.filter((a) => typeof a === "string").map((a) => a.slice(0, MAX_MCP_ARG_CHARS)).slice(0, MAX_MCP_ARGS);
  }
  if (patch.url !== undefined) config.url = patch.url.trim();
  if (patch.env !== undefined) {
    config.envKeys = Object.keys(cleanKv(patch.env));
    setSecrets(id, "env", cleanKv(patch.env));
  }
  if (patch.headers !== undefined) {
    config.headerKeys = Object.keys(cleanKv(patch.headers));
    setSecrets(id, "header", cleanKv(patch.headers));
  }
  const wasEnabled = config.enabled;
  if (patch.enabled !== undefined) config.enabled = patch.enabled === true;
  const invalid = validateAdd({ name: config.name, transport: config.transport, command: config.command, url: config.url });
  if (invalid) return { ok: false, error: invalid };
  config.updatedAt = Date.now();
  servers[idx] = config;
  persistConfig(servers);
  const entry = liveFor(config);

  if (!config.enabled && wasEnabled) {
    await closeLive(entry);
    entry.state = "disabled";
    entry.discovered = null;
  } else if (config.enabled && !wasEnabled) {
    entry.state = "disconnected";
  } else if (config.enabled && entry.state === "connected") {
    // Connection-affecting fields may have changed; reconnect on next call.
    await closeLive(entry);
    entry.state = "disconnected";
    entry.discovered = null;
  }
  syncRegistries();
  notifyChanged();
  return { ok: true, server: viewOf(entry) };
}

export async function removeMcpServer(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { servers } = loadConfig();
  const idx = servers.findIndex((s) => s.id === id);
  if (idx < 0) return { ok: false, error: `No MCP server "${id}".` };
  servers.splice(idx, 1);
  persistConfig(servers);
  const entry = live.get(id);
  if (entry) {
    await closeLive(entry);
    live.delete(id);
  }
  dropSecrets(id);
  syncRegistries();
  notifyChanged();
  return { ok: true };
}

export async function reconnectMcpServer(id: string): Promise<{ ok: true; server: McpServerView } | { ok: false; error: string }> {
  const { servers } = loadConfig();
  const config = servers.find((s) => s.id === id);
  if (!config) return { ok: false, error: `No MCP server "${id}".` };
  const entry = liveFor(config);
  await closeLive(entry);
  entry.state = "disconnected";
  entry.discovered = null;
  const res = await connect(entry);
  syncRegistries();
  notifyChanged();
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, server: viewOf(entry) };
}

// ---------------------------------------------------------------------------
// Discovery views for the panel
// ---------------------------------------------------------------------------

export function listMcpTools(id: string): { ok: true; tools: McpDiscoveredTool[] } | { ok: false; error: string } {
  const entry = live.get(id);
  if (!entry) return { ok: false, error: `No MCP server "${id}".` };
  return { ok: true, tools: entry.discovered?.tools ?? [] };
}

export function listMcpResources(id: string): { ok: true; resources: McpResourceInfo[] } | { ok: false; error: string } {
  const entry = live.get(id);
  if (!entry) return { ok: false, error: `No MCP server "${id}".` };
  return { ok: true, resources: entry.discovered?.resources ?? [] };
}

export function listMcpPrompts(id: string): { ok: true; prompts: McpPromptInfo[] } | { ok: false; error: string } {
  const entry = live.get(id);
  if (!entry) return { ok: false, error: `No MCP server "${id}".` };
  return { ok: true, prompts: entry.discovered?.prompts ?? [] };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Connect every enabled server at startup. Failures are states, not crashes. */
export async function warmupMcpServers(): Promise<void> {
  const { servers } = loadConfig();
  for (const config of servers) {
    if (!config.enabled) continue;
    const entry = liveFor(config);
    if (entry.state === "connected" || entry.state === "connecting") continue;
    // Sequential on purpose: a cold app launching 16 servers at once pays all
    // the spawn costs together; one at a time they each get their own timeout.
    await connect(entry);
  }
}

/** Quit path: close every connection. Never throws — the app is leaving. */
export async function shutdownMcpServers(): Promise<void> {
  const entries = [...live.values()];
  await Promise.all(entries.map((entry) => closeLive(entry)));
}

/** The name an MCP tool gets in the registry — exposed for tests and the panel. */
export function mcpToolNameFor(serverName: string, serverId: string, toolName: string): string {
  return agentToolName(serverPrefix(serverName, serverId), toolName);
}
