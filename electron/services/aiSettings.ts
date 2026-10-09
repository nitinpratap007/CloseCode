// Close Code — AI settings & secure key storage (Phase 11/12)
// API keys live ONLY in the main process, encrypted with Electron safeStorage.
// Never send keys to the renderer. The renderer only learns whether a key exists.

import { app, safeStorage } from "electron";
import fs from "fs";
import path from "path";

export type AiProviderType = "local" | "openai" | "custom";

export type AiPermissionMode = "ask" | "allow" | "deny";

export interface AiConfig {
  /** Which provider is active. */
  provider: AiProviderType;
  /** Remote OpenAI-compatible endpoint base URL (openai / custom). */
  baseUrl: string;
  /** Local runtime endpoint (Ollama / LM Studio / Jan …). */
  localBaseUrl: string;
  /** Model id for remote providers. */
  model: string;
  /** Model id for the local runtime. */
  localModel: string;
  temperature: number;
  timeoutMs: number;
  /** Stream tokens to the UI when the endpoint supports SSE. */
  stream: boolean;
  /** "chat" = plain Q&A. "agent" = tool-calling loop (files/terminal/search/git). */
  toolMode: "chat" | "agent";
  /** Tool category -> permission mode. See `ALLOWED_AI_PERMISSIONS`. */
  permissions: Record<string, AiPermissionMode>;
}

export const AI_PROVIDER_LABELS: Record<AiProviderType, string> = {
  local: "Local AI",
  openai: "OpenAI Compatible",
  custom: "Custom / Other",
};

/**
 * Phase 22 added `web` and `browser`.
 *
 * They are separate categories, and both default to `ask`, because they are the
 * only tools that put anything on the wire. Folding them into `search` would
 * mean a user who had allowed in-workspace search had silently also allowed an
 * agent to send workspace content to any URL it chose — which is a different
 * decision from the one they were making.
 *
 * Phase 29 added `tasks`: the persistent task list. It also defaults to `ask`,
 * because like the file tools it changes stored state the user reads back.
 *
 * Phase 30 added `mcp`: calling configured MCP servers. The capability beneath
 * it (`mcp.invoke`) defaults to `deny`, so even a user who never opens this
 * panel cannot have an MCP call made on their behalf without opting in — a
 * category at `ask` cannot lift a capability's stricter default on its own.
 *
 * Phase 31 added `skills`: invoking skill workflows. It defaults to `ask`,
 * because a cloned repository can carry a skill file the user has never read.
 */
export const ALLOWED_AI_PERMISSIONS = ["files", "terminal", "search", "git", "agent", "web", "browser", "tasks", "mcp", "skills"];

export const AI_PERMISSION_LABELS: Record<string, string> = {
  files: "Read & write files",
  terminal: "Run terminal commands",
  search: "Search the workspace",
  git: "Git operations",
  agent: "Delegate to sub-agents",
  web: "Send requests to the internet",
  browser: "Open & control a browser",
  tasks: "Maintain the task list",
  mcp: "Call MCP servers",
  skills: "Invoke skills",
};

export const DEFAULT_AI_PERMISSIONS: Record<string, AiPermissionMode> = {
  files: "ask",
  terminal: "ask",
  search: "ask",
  git: "ask",
  // Phase 21: "agent" gates sub-agent delegation. Defaults to ask, because
  // starting another agent is a decision the user should be able to see.
  agent: "ask",
  // Phase 22: both of these leave the machine, so they start at `ask` rather
  // than inheriting anything a user set for the five Phase 21 categories.
  web: "ask",
  browser: "ask",
  // Phase 29: the task list is stored app state the user reads back, so changes
  // default to asking, exactly like `files`. Reading the list is part of the
  // same single capability — coarse on purpose (see permissions.ts).
  tasks: "ask",
  // Phase 30: the *category* asks, but `mcp.invoke` itself defaults to `deny`
  // and a category can only widen, never narrow (see `categoryCanWiden`) — so
  // this row is how a user opts MCP in one switch, not how it sneaks in.
  mcp: "ask",
  // Phase 31: a skill is workspace-authored text loaded on the model's request;
  // asking is the default for the same reason `agent` asks.
  skills: "ask",
};

/**
 * The key-store slot used by the `web_search` tool. It lives in the same
 * encrypted store as the provider keys (`safeStorage`), so a search API key is
 * never written in plain text and never sent to the renderer — the renderer only
 * ever learns *whether* one exists.
 */
export const WEB_SEARCH_KEY_ID = "web-search";

export const DEFAULT_AI_CONFIG: AiConfig = {
  provider: "local",
  baseUrl: "https://api.openai.com/v1",
  localBaseUrl: "http://127.0.0.1:11434",
  model: "",
  localModel: "",
  temperature: 0.2,
  timeoutMs: 120000,
  stream: true,
  toolMode: "chat",
  permissions: { ...DEFAULT_AI_PERMISSIONS },
};

function aiDir(): string {
  return path.join(app.getPath("userData"), "ai");
}

function configPath(): string {
  return path.join(aiDir(), "config.json");
}

function keysPath(): string {
  return path.join(aiDir(), "keys.bin");
}

export function ensureDir(): void {
  fs.mkdirSync(aiDir(), { recursive: true });
}

/** Validate a permission object: only allow-list categories, only ask/allow/deny. */
function sanitizePermissions(input: unknown): Record<string, AiPermissionMode> {
  const out: Record<string, AiPermissionMode> = { ...DEFAULT_AI_PERMISSIONS };
  if (input && typeof input === "object") {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (ALLOWED_AI_PERMISSIONS.includes(k) && (v === "ask" || v === "allow" || v === "deny")) {
        out[k] = v;
      }
    }
  }
  return out;
}

export function sanitizeAiConfig(patch: Partial<AiConfig>): Partial<AiConfig> {
  const out: Partial<AiConfig> = {};
  if (patch.provider && ["local", "openai", "custom"].includes(patch.provider)) out.provider = patch.provider;
  if (typeof patch.baseUrl === "string") out.baseUrl = patch.baseUrl.trim() || DEFAULT_AI_CONFIG.baseUrl;
  if (typeof patch.localBaseUrl === "string") out.localBaseUrl = patch.localBaseUrl.trim() || DEFAULT_AI_CONFIG.localBaseUrl;
  if (typeof patch.model === "string") out.model = patch.model.trim();
  if (typeof patch.localModel === "string") out.localModel = patch.localModel.trim();
  if (typeof patch.temperature === "number") out.temperature = Math.min(2, Math.max(0, patch.temperature));
  if (typeof patch.timeoutMs === "number") out.timeoutMs = Math.min(600000, Math.max(1000, Math.round(patch.timeoutMs)));
  if (typeof patch.stream === "boolean") out.stream = patch.stream;
  if (patch.toolMode === "chat" || patch.toolMode === "agent") out.toolMode = patch.toolMode;
  if (patch.permissions) out.permissions = sanitizePermissions(patch.permissions);
  return out;
}

export function loadAiConfig(): AiConfig {
  try {
    const p = configPath();
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf-8");
      const parsed = JSON.parse(raw) as Partial<AiConfig>;
      const merged: AiConfig = {
        ...DEFAULT_AI_CONFIG,
        ...parsed,
        permissions: sanitizePermissions(parsed.permissions),
      };
      return merged;
    }
  } catch {
    // corrupted or missing -> defaults
  }
  return { ...DEFAULT_AI_CONFIG, permissions: { ...DEFAULT_AI_PERMISSIONS } };
}

export function saveAiConfig(patch: Partial<AiConfig>): AiConfig {
  try {
    ensureDir();
    const current = loadAiConfig();
    const clean = sanitizeAiConfig(patch);
    const next: AiConfig = { ...current, ...clean, permissions: sanitizePermissions(clean.permissions ?? current.permissions) };
    fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), "utf-8");
    return next;
  } catch (err) {
    console.error("Failed to save AI config:", err);
    return loadAiConfig();
  }
}

export function setAiConfigForTest(cfg: AiConfig): void {
  try {
    ensureDir();
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), "utf-8");
  } catch (err) {
    console.error("Failed to write AI config (test):", err);
  }
}

interface StoredKeys {
  version: 1;
  keys: Record<string, { data: string; plain?: boolean }>;
}

function readKeys(): StoredKeys {
  try {
    const p = keysPath();
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p);
      if (safeStorage.isEncryptionAvailable()) {
        const dec = safeStorage.decryptString(raw);
        const parsed = JSON.parse(dec) as StoredKeys;
        if (parsed && parsed.keys) return parsed;
      } else {
        // Plain-text fallback (e.g. Linux without keyring): decode envelope, mark plain.
        const parsed = JSON.parse(raw.toString("utf8")) as StoredKeys;
        if (parsed && parsed.keys) return parsed;
      }
    }
  } catch (err) {
    console.error("Failed to read AI keys:", err);
  }
  return { version: 1, keys: {} };
}

function writeKeys(keys: StoredKeys): void {
  try {
    ensureDir();
    if (safeStorage.isEncryptionAvailable()) {
      const enc = safeStorage.encryptString(JSON.stringify(keys));
      fs.writeFileSync(keysPath(), enc);
    } else {
      fs.writeFileSync(keysPath(), Buffer.from(JSON.stringify(keys), "utf8"));
    }
  } catch (err) {
    console.error("Failed to store AI key:", err);
  }
}

export function hasApiKey(provider: string): boolean {
  return !!readKeys().keys[provider];
}

export function setApiKey(provider: string, key: string): boolean {
  const keys = readKeys();
  const trimmed = (key || "").trim();
  if (!trimmed) {
    delete keys.keys[provider];
    writeKeys(keys);
    return false;
  }
  keys.keys[provider] = { data: trimmed };
  writeKeys(keys);
  return true;
}

export function clearApiKey(provider: string): void {
  const keys = readKeys();
  delete keys.keys[provider];
  writeKeys(keys);
}

export function getApiKey(provider: string): string | null {
  try {
    const entry = readKeys().keys[provider];
    if (!entry) return null;
    return entry.data || null;
  } catch {
    return null;
  }
}