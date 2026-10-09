import { ipcMain, BrowserWindow } from "electron";
import { AiService, type AiChatRequest } from "../services/ai";
import {
  WEB_SEARCH_KEY_ID,
  clearApiKey,
  hasApiKey,
  loadAiConfig,
  saveAiConfig,
  setApiKey,
} from "../services/aiSettings";

const aiService = new AiService((channel, payload) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
});

/**
 * Which key-store slots the renderer may write.
 *
 * Phase 22 added the `web-search` slot for the `web_search` tool. It is not an AI
 * model provider, so it is deliberately absent from the provider dropdown; it
 * gets its own field in the AI panel's configuration section and is stored in
 * the same encrypted store as everything else.
 */
const WRITABLE_KEY_IDS = ["local", "openai", "custom", WEB_SEARCH_KEY_ID];

function maskedConfig() {
  const config = loadAiConfig();
  return {
    config,
    apiKeys: {
      local: hasApiKey("local"),
      openai: hasApiKey("openai"),
      custom: hasApiKey("custom"),
      // The renderer learns only *whether* a key exists. The value never leaves
      // the main process.
      [WEB_SEARCH_KEY_ID]: hasApiKey(WEB_SEARCH_KEY_ID),
    },
  };
}

export function registerAiIpc(): void {
  ipcMain.handle("ai:get-config", () => {
    try {
      return { ok: true, result: maskedConfig() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("ai:save-config", (_e, patch: unknown) => {
    try {
      const valid = patch && typeof patch === "object" ? (patch as Record<string, unknown>) : {};
      saveAiConfig(valid as Parameters<typeof saveAiConfig>[0]);
      return { ok: true, result: maskedConfig() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("ai:set-api-key", (_e, provider: string, key: string) => {
    try {
      if (!WRITABLE_KEY_IDS.includes(provider)) {
        throw new Error("Unknown provider");
      }
      const has = setApiKey(provider, key);
      return { ok: true, result: { has } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("ai:clear-api-key", (_e, provider: string) => {
    try {
      clearApiKey(provider);
      return { ok: true, result: { has: false } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("ai:models", async () => {
    try {
      const r = await aiService.listModels(loadAiConfig());
      return r.ok
        ? { ok: true, result: { models: r.models ?? [] } }
        : { ok: false, error: r.error };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("ai:detect-local", async (_e, specificUrl?: string) => {
    try {
      const result = await aiService.detectLocal(typeof specificUrl === "string" && specificUrl ? specificUrl : undefined);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("ai:chat", async (event, req: AiChatRequest) => {
    const sender = event.sender;
    try {
      if (!req || typeof req.id !== "string") throw new Error("Missing request id");
      const workspace = (req.workspace as string | null) ?? null;
      const outcome = await aiService.chat({ ...req, workspace }, loadAiConfig());
      return { ok: outcome.ok, result: outcome.ok ? { text: outcome.text, toolSteps: outcome.toolSteps } : undefined, error: outcome.error };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sender.send("ai:event", { type: "error", payload: { id: req?.id, message } });
      return { ok: false, error: message };
    }
  });

  ipcMain.handle("ai:approval-response", (_e, id: string, approved: boolean) => {
    aiService.resolveApproval(id, !!approved);
    return { ok: true };
  });
}