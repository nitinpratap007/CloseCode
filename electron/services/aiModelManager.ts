// Close Code — AI Model Manager (Phase 36)
//
// This module is the control plane for AI providers and models. It sits between
// the UI (which wants to show available providers, let the user switch, fetch
// models) and the transport layer (which actually makes requests).
//
// Responsibilities:
//   * Maintain the active provider + model selection
//   * Fetch / cache available models from provider APIs (where supported)
//   * Provide configuration status for each provider
//   * Handle provider switching without leaking credentials
//   * Never automatically switch to a paid provider

import { app } from "electron";
import fs from "fs";
import path from "path";
import {
  getApiKey,
  setApiKey,
  clearApiKey,
  hasApiKey,
  loadAiConfig,
  saveAiConfig,
  type AiConfig,
} from "./aiSettings";
import {
  getProviderCatalogEntry,
  getAvailableProviders,
  getLocalProviders,
  getRemoteProviders,
  getFreeProviders,
  resolveCatalogEntry,
  PROVIDER_CATALOG,
  type ProviderCatalogEntry,
  type ProviderModelInfo,
  type ProviderApiType,
} from "./aiProviderCatalog";
import { getProviderRecords, saveProviderRecords, type ProviderRecord } from "./aiProviders";
import { resolveEndpoint, type ResolvedEndpoint } from "./agent/transport";

export interface ModelManagerConfig {
  activeProviderId: string;
  activeModelId: string;
  providers: ProviderRecord[];
}

export interface ProviderStatus {
  id: string;
  name: string;
  catalog: ProviderCatalogEntry;
  configured: boolean;
  hasApiKey: boolean;
  currentModel: string;
  availableModels: ProviderModelInfo[];
  configStatus: "not_configured" | "needs_key" | "needs_model" | "ready" | "error";
  error?: string;
}

export interface ModelManagerState {
  activeProviderId: string;
  activeModelId: string;
  providers: ProviderStatus[];
}

let modelManagerCache: ModelManagerState | null = null;
let modelFetchCache = new Map<string, { models: ProviderModelInfo[]; fetchedAt: number }>();
const MODEL_FETCH_TTL = 5 * 60 * 1000; // 5 minutes

function getProviderRecordsInternal(): ProviderRecord[] {
  return getProviderRecords();
}

function saveProviderRecordsInternal(records: ProviderRecord[]): void {
  saveProviderRecords(records);
}

function getModelManagerCache(): ModelManagerState {
  if (modelManagerCache) return modelManagerCache;
  const providers = getProviderRecordsInternal();
  const cfg = loadAiConfig();
  const activeProviderId = cfg.provider;
  const activeModelId = cfg.provider === "local" ? cfg.localModel : cfg.model;

  modelManagerCache = buildProviderStatuses(providers, activeProviderId, activeModelId);
  return modelManagerCache;
}

function invalidateCache(): void {
  modelManagerCache = null;
}

function buildProviderStatuses(providers: ProviderRecord[], activeProviderId: string, activeModelId: string): ModelManagerState {
  const statuses: ProviderStatus[] = providers.map((p) => {
    const catalog = resolveCatalogEntry(p.id);
    const hasKey = hasApiKey(p.id);
    const configured = catalog.isLocal
      ? !!p.baseUrl
      : !!p.baseUrl && hasApiKey(p.id);

    let configStatus: ProviderStatus["configStatus"] = "not_configured";
    if (!p.baseUrl) {
      configStatus = "not_configured";
    } else if (catalog.requiresApiKey && !hasKey) {
      configStatus = "needs_key";
    } else if (!p.model) {
      configStatus = "needs_model";
    } else if (!p.baseUrl) {
      configStatus = "error";
    } else {
      configStatus = "ready";
    }

    const currentModel = p.id === activeProviderId ? activeModelId : p.model;

    return {
      id: p.id,
      name: p.name,
      catalog,
      configured,
      hasApiKey: hasKey,
      currentModel,
      availableModels: catalog.knownModels,
      configStatus,
    };
  });

  return {
    activeProviderId,
    activeModelId,
    providers: statuses,
  };
}

async function fetchModelsFromProvider(catalog: ProviderCatalogEntry, baseUrl: string, apiKey: string | null): Promise<ProviderModelInfo[]> {
  // Check cache first
  const cacheKey = `${catalog.id}:${baseUrl}`;
  const cached = modelFetchCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < MODEL_FETCH_TTL) {
    return cached.models;
  }

  let models: ProviderModelInfo[] = [];

  try {
    switch (catalog.apiType) {
      case "openai-compatible": {
        const url = `${baseUrl.replace(/\/+$/, "")}/v1/models`;
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
        if (res.ok) {
          const data: { data: Array<any> } = (await res.json()) as any;
          if (data.data && Array.isArray(data.data)) {
            models = data.data
              .filter((m: any) => typeof m.id === "string")
              .map((m: any) => ({
                id: m.id,
                name: m.id,
                contextWindow: undefined,
                supportsTools: true,
                supportsVision: false,
                pricingTier: "unknown" as const,
              }));
          }
        }
        break;
      }
      case "anthropic": {
        // Anthropic doesn't have a models endpoint; use catalog
        models = catalog.knownModels;
        break;
      }
      case "google": {
        const url = `${baseUrl.replace(/\/+$/, "")}/models`;
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (apiKey) headers["x-goog-api-key"] = apiKey;
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
        if (res.ok) {
          const data: { models: Array<any> } = (await res.json()) as any;
          if (data.models && Array.isArray(data.models)) {
            models = data.models
              .filter((m: any) => typeof m.name === "string")
              .map((m: any) => ({
                id: m.name.replace("models/", ""),
                name: m.name.replace("models/", ""),
                contextWindow: m.inputTokenLimit,
                supportsTools: true,
                supportsVision: m.name?.includes("vision") ?? false,
                pricingTier: "freemium" as const,
              }));
          }
        }
        break;
      }
      case "local": {
        const url = `${baseUrl.replace(/\/+$/, "")}/api/tags`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (res.ok) {
          const data: { models: Array<any> } = (await res.json()) as any;
          if (data.models && Array.isArray(data.models)) {
            models = data.models
              .filter((m: any) => typeof m.name === "string")
              .map((m: any) => ({
                id: m.name,
                name: m.name,
                contextWindow: undefined,
                supportsTools: true,
                supportsVision: false,
                pricingTier: "free" as const,
              }));
          }
        }
        break;
      }
      default:
        models = catalog.knownModels;
    }
  } catch {
    // On fetch failure, fall back to catalog
    models = catalog.knownModels;
  }

  // Merge with catalog models (preserve catalog metadata like pricing)
  const merged = catalog.knownModels.map((catalogModel) => {
    const fetched = models.find((m) => m.id === catalogModel.id);
    return fetched ? { ...catalogModel, ...fetched } : catalogModel;
  });

  // Add any fetched models not in catalog
  for (const fetched of models) {
    if (!merged.some((m) => m.id === fetched.id)) {
      merged.push(fetched);
    }
  }

  modelFetchCache.set(catalog.id + ":" + baseUrl, { models: merged, fetchedAt: Date.now() });
  return merged;
}

export async function getModelManagerState(): Promise<ModelManagerState> {
  const cache = getModelManagerCache();
  // Refresh available models for each provider (async, non-blocking)
  await Promise.all(
    cache.providers.map(async (p) => {
      if (!p.catalog.transportImplemented || !p.configured) return;
      const key = hasApiKey(p.id) ? getApiKey(p.id) : null;
      try {
        const models = await fetchModelsFromProvider(p.catalog, p.catalog.defaultBaseUrl, key);
        p.availableModels = models;
      } catch {
        // Keep catalog models
      }
    })
  );
  return getModelManagerCache();
}

export function getActiveProvider(): ProviderStatus | null {
  const cache = getModelManagerCache();
  return cache.providers.find((p) => p.id === cache.activeProviderId) ?? null;
}

export function getActiveModel(): string {
  const active = getActiveProvider();
  return active?.currentModel ?? "";
}

export function getProviderById(id: string): ProviderStatus | null {
  const cache = getModelManagerCache();
  return cache.providers.find((p) => p.id === id) ?? null;
}

export function getAllProviders(): ProviderStatus[] {
  return getModelManagerCache().providers;
}

export function getConfiguredProviders(): ProviderStatus[] {
  return getModelManagerCache().providers.filter((p) => p.configured);
}

export async function setActiveProvider(providerId: string): Promise<{ ok: boolean; error?: string }> {
  const providers = getProviderRecordsInternal();
  const target = providers.find((p) => p.id === providerId);
  if (!target) return { ok: false, error: "Provider not found" };

  const catalog = resolveCatalogEntry(providerId);
  if (!catalog.transportImplemented) {
    return { ok: false, error: "This provider does not have a transport implementation" };
  }
  if (!target.baseUrl) {
    return { ok: false, error: "Provider has no base URL configured" };
  }
  if (catalog.requiresApiKey && !hasApiKey(providerId)) {
    return { ok: false, error: "Provider requires an API key" };
  }
  if (!target.model) {
    return { ok: false, error: "Provider has no model selected" };
  }

  const cfg = loadAiConfig();
  const patch: Partial<AiConfig> = {
    provider: providerId as AiConfig["provider"],
    model: target.model,
    localModel: target.model,
  };
  saveAiConfig(patch);
  invalidateCache();
  return { ok: true };
}

export async function setActiveModel(providerId: string, modelId: string): Promise<{ ok: boolean; error?: string }> {
  const providers = getProviderRecordsInternal();
  const target = providers.find((p) => p.id === providerId);
  if (!target) return { ok: false, error: "Provider not found" };

  const catalog = resolveCatalogEntry(providerId);
  const modelExists = catalog.knownModels.some((m) => m.id === modelId);
  if (!modelExists) {
    // Allow custom models not in catalog
    // But warn if it's not in the known list
  }

  const patch: Partial<AiConfig> = {};
  if (providerId === "local") {
    patch.localModel = modelId;
  } else {
    patch.model = modelId;
  }
  saveAiConfig(patch);
  invalidateCache();
  return { ok: true };
}

export async function addProvider(input: { id: string; name: string; baseUrl: string; apiType: ProviderApiType; model?: string }): Promise<{ ok: boolean; error?: string; provider?: ProviderRecord }> {
  const providers = getProviderRecordsInternal();
  if (providers.some((p) => p.id === input.id)) {
    return { ok: false, error: "A provider with this id already exists" };
  }
  if (providers.length >= 24) {
    return { ok: false, error: "Maximum number of providers reached (24)" };
  }

  const newProvider: ProviderRecord = {
    id: input.id,
    name: input.name,
    baseUrl: input.baseUrl,
    kind: input.apiType === "local" ? "local" : "remote",
    model: input.model || "",
    builtin: false,
  };

  providers.push(newProvider);
  saveProviderRecordsInternal(providers);
  invalidateCache();
  return { ok: true, provider: newProvider };
}

export async function updateProvider(id: string, patch: { name?: string; baseUrl?: string; model?: string }): Promise<{ ok: boolean; error?: string }> {
  const providers = getProviderRecordsInternal();
  const idx = providers.findIndex((p) => p.id === id);
  if (idx === -1) return { ok: false, error: "Provider not found" };
  if (providers[idx].builtin) return { ok: false, error: "Built-in providers cannot be fully modified" };

  if (patch.name !== undefined) providers[idx].name = patch.name.trim().slice(0, 60);
  if (patch.baseUrl !== undefined) providers[idx].baseUrl = patch.baseUrl.trim().replace(/\/+$/, "");
  if (patch.model !== undefined) providers[idx].model = patch.model.trim().slice(0, 200);

  saveProviderRecordsInternal(providers);
  invalidateCache();
  return { ok: true };
}

export async function deleteProvider(id: string): Promise<{ ok: boolean; error?: string }> {
  const providers = getProviderRecordsInternal();
  const idx = providers.findIndex((p) => p.id === id);
  if (idx === -1) return { ok: false, error: "Provider not found" };
  if (providers[idx].builtin) return { ok: false, error: "Built-in providers cannot be deleted" };

  providers.splice(idx, 1);
  saveProviderRecordsInternal(providers);
  clearApiKey(id);
  invalidateCache();
  return { ok: true };
}

export async function setApiKeyForProvider(providerId: string, key: string): Promise<{ ok: boolean; error?: string }> {
  const providers = getProviderRecordsInternal();
  const target = providers.find((p) => p.id === providerId);
  if (!target) return { ok: false, error: "Provider not found" };

  const catalog = resolveCatalogEntry(providerId);
  if (!catalog.requiresApiKey) {
    return { ok: false, error: "This provider does not require an API key" };
  }

  const ok = setApiKey(providerId, key);
  if (!ok) return { ok: false, error: "Failed to store API key" };
  invalidateCache();
  return { ok: true };
}

export async function clearApiKeyForProvider(providerId: string): Promise<{ ok: boolean; error?: string }> {
  clearApiKey(providerId);
  invalidateCache();
  return { ok: true };
}

export function hasProviderApiKey(providerId: string): boolean {
  return hasApiKey(providerId);
}

export function getResolvedEndpoint(): ResolvedEndpoint {
  const cfg = loadAiConfig();
  return resolveEndpoint(cfg);
}

export function getCatalog(): ProviderCatalogEntry[] {
  return [...getAvailableProviders()];
}

export function getCatalogEntry(id: string): ProviderCatalogEntry | undefined {
  return getProviderCatalogEntry(id);
}

export function getAllCatalogEntries(): ProviderCatalogEntry[] {
  return PROVIDER_CATALOG.slice();
}

export function getFreeProvidersList(): ProviderCatalogEntry[] {
  return getFreeProviders();
}

export function getLocalProvidersList(): ProviderCatalogEntry[] {
  return getLocalProviders();
}

export function getRemoteProvidersList(): ProviderCatalogEntry[] {
  return getRemoteProviders();
}

export type { ProviderCatalogEntry, ProviderModelInfo, ProviderApiType, ProviderQuotaInfo, ProviderPricingTier } from "./aiProviderCatalog";