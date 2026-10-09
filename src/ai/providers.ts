// Close Code — AI provider registry (Phase 11/12)
// Future providers (MCP, Anthropic, Gemini, …) register here; the transport
// seam is the OpenAI-compatible HTTP endpoint in the main process.

import type { AiProviderMeta, AiProviderType } from "./types";

const providers = new Map<AiProviderType, AiProviderMeta>();

export function registerProvider(meta: AiProviderMeta): void {
  if (providers.has(meta.id)) {
    throw new Error(`AI provider already registered: ${meta.id}`);
  }
  providers.set(meta.id, meta);
}

export function getProviders(): AiProviderMeta[] {
  return [...providers.values()];
}

export function getProvider(id: string): AiProviderMeta | undefined {
  return providers.get(id as AiProviderType);
}

// Built-ins. "local" is the Local AI runtime (Phase 12); "openai" is the
// OpenAI-compatible remote; "custom" is any other OpenAI-compatible service.
registerProvider({
  id: "local",
  name: "Local AI",
  kind: "local",
  local: true,
  description: "Models running on this machine (Ollama, LM Studio, Jan). Private — nothing leaves your computer.",
});
registerProvider({
  id: "openai",
  name: "OpenAI Compatible",
  kind: "remote",
  local: false,
  description: "Any service that speaks the OpenAI chat-completions API (OpenAI, Azure, Groq, …).",
});
registerProvider({
  id: "custom",
  name: "Custom / Other",
  kind: "remote",
  local: false,
  description: "A self-hosted or alternative OpenAI-compatible endpoint of your choosing.",
});