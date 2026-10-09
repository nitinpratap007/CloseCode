// Close Code — AI Model Manager IPC (Phase 36)
//
// Handles provider/model management: listing, switching, adding, updating,
// deleting providers, fetching models, and managing API keys.

import { ipcMain } from "electron";
import {
  getModelManagerState,
  getActiveProvider,
  getActiveModel,
  getProviderById,
  getAllProviders,
  getConfiguredProviders,
  setActiveProvider,
  setActiveModel,
  addProvider,
  updateProvider,
  deleteProvider,
  setApiKeyForProvider,
  clearApiKeyForProvider,
  hasProviderApiKey,
  getResolvedEndpoint,
  getCatalog,
  getCatalogEntry,
  getAllCatalogEntries,
  getFreeProvidersList,
  getLocalProvidersList,
  getRemoteProvidersList,
  type ProviderStatus,
  type ProviderCatalogEntry,
  type ProviderApiType,
} from "../services/aiModelManager";
import { loadAiConfig, hasApiKey, getApiKey } from "../services/aiSettings";
import { getProviderRecords } from "../services/aiProviders";

function fail(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

export function registerModelManagerIpc(): void {
  // --- Provider catalog ---
  ipcMain.handle("modelManager:catalog", () => {
    try {
      return { ok: true, result: getCatalog() };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("modelManager:catalogAll", () => {
    try {
      return { ok: true, result: getAllCatalogEntries() };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("modelManager:catalogEntry", (_e, id: string) => {
    try {
      const entry = getCatalogEntry(id);
      return { ok: true, result: entry };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("modelManager:catalogFree", () => {
    try {
      return { ok: true, result: getFreeProvidersList() };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("modelManager:catalogLocal", () => {
    try {
      return { ok: true, result: getLocalProvidersList() };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("modelManager:catalogRemote", () => {
    try {
      return { ok: true, result: getRemoteProvidersList() };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  // --- Provider status ---
  ipcMain.handle("modelManager:state", async () => {
    try {
      const state = await getModelManagerState();
      return { ok: true, result: state };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("modelManager:activeProvider", () => {
    try {
      return { ok: true, result: getActiveProvider() };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("modelManager:activeModel", () => {
    try {
      return { ok: true, result: getActiveModel() };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("modelManager:provider", (_e, id: string) => {
    try {
      return { ok: true, result: getProviderById(id) };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("modelManager:allProviders", () => {
    try {
      return { ok: true, result: getAllProviders() };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("modelManager:configuredProviders", () => {
    try {
      return { ok: true, result: getConfiguredProviders() };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  // --- Provider actions ---
  ipcMain.handle("modelManager:setActiveProvider", async (_e, providerId: string) => {
    try {
      return await setActiveProvider(providerId);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("modelManager:setActiveModel", async (_e, providerId: string, modelId: string) => {
    try {
      return await setActiveModel(providerId, modelId);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("modelManager:addProvider", async (_e, input: { id: string; name: string; baseUrl: string; apiType: ProviderApiType; model?: string }) => {
    try {
      return await addProvider(input);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("modelManager:updateProvider", async (_e, id: string, patch: { name?: string; baseUrl?: string; model?: string }) => {
    try {
      return await updateProvider(id, patch);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("modelManager:deleteProvider", async (_e, id: string) => {
    try {
      return await deleteProvider(id);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  // --- API Key management ---
  ipcMain.handle("modelManager:setApiKey", async (_e, providerId: string, key: string) => {
    try {
      return await setApiKeyForProvider(providerId, key);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("modelManager:clearApiKey", async (_e, providerId: string) => {
    try {
      return await clearApiKeyForProvider(providerId);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("modelManager:hasApiKey", (_e, providerId: string) => {
    try {
      return { ok: true, result: hasProviderApiKey(providerId) };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  // --- Resolved endpoint (for debugging/verification) ---
  ipcMain.handle("modelManager:resolvedEndpoint", () => {
    try {
      const endpoint = getResolvedEndpoint();
      return { ok: true, result: endpoint };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  // --- Legacy compatibility: provider records (for settings migration) ---
  ipcMain.handle("modelManager:providerRecords", () => {
    try {
      const records = getProviderRecords();
      const keys = records.map((p) => ({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        kind: p.kind,
        model: p.model,
        builtin: p.builtin,
        hasKey: hasApiKey(p.id),
      }));
      return { ok: true, result: keys };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  // --- Legacy compatibility: active provider + model ---
  ipcMain.handle("modelManager:activeProviderLegacy", () => {
    try {
      const cfg = loadAiConfig();
      const active = getActiveProvider();
      return { ok: true, result: { provider: cfg.provider, model: active?.currentModel ?? "" } };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  // --- API key existence (legacy compatibility) ---
  ipcMain.handle("modelManager:hasApiKeyLegacy", (_e, provider: string) => {
    try {
      return { ok: true, result: hasApiKey(provider) };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });
}

export type { ProviderStatus, ProviderCatalogEntry };