// Close Code — AI Provider Catalog (Phase 36)
//
// This module defines the *known* provider types and their metadata. It does not
// make network calls; it is a static registry the UI and the model manager can
// consult to show availability, pricing hints, and configuration status.
//
// The exact supported providers depend on *actually implemented* transport
// adapters. If a transport for a provider doesn't exist, the catalog entry
// reflects that (e.g., `transportImplemented: false`).

export type ProviderApiType =
  | "openai-compatible"
  | "anthropic"
  | "google"
  | "local"
  | "custom";

export type ProviderPricingTier = "free" | "freemium" | "paid" | "unknown";

export interface ProviderQuotaInfo {
  /** Requests per minute (if known/applicable). */
  rpm?: number;
  /** Tokens per minute (if known/applicable). */
  tpm?: number;
  /** Requests per day (if known/applicable). */
  rpd?: number;
  /** Human-readable summary for the UI. */
  summary?: string;
}

export interface ProviderModelInfo {
  /** Model identifier as the provider expects it. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Context window in tokens (if known). */
  contextWindow?: number;
  /** Whether the model supports tool calling / function calling. */
  supportsTools?: boolean;
  /** Whether the model supports vision/multimodal input. */
  supportsVision?: boolean;
  /** Pricing tier for this specific model (if different from provider default). */
  pricingTier?: ProviderPricingTier;
  /** Cost per 1M input tokens (USD, if known). */
  inputCostPer1M?: number;
  /** Cost per 1M output tokens (USD, if known). */
  outputCostPer1M?: number;
}

export interface ProviderCatalogEntry {
  /** Unique identifier, used as the key-store slot and config id. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Provider API type determines the transport adapter used. */
  apiType: ProviderApiType;
  /** Default base URL for the provider's API. */
  defaultBaseUrl: string;
  /** Whether a transport implementation exists for this provider. */
  transportImplemented: boolean;
  /** Whether the provider requires an API key. */
  requiresApiKey: boolean;
  /** Pricing tier for the provider (default, models may override). */
  pricingTier: ProviderPricingTier;
  /** Quota/rate limit information (if publicly documented). */
  quota?: ProviderQuotaInfo;
  /** Known models for this provider. */
  knownModels: ProviderModelInfo[];
  /** Default model id if the user doesn't specify one. */
  defaultModel?: string;
  /** Whether this is a local/on-device provider. */
  isLocal: boolean;
  /** Human-readable description for the UI. */
  description?: string;
  /** Documentation URL for the provider's API/docs. */
  docsUrl?: string;
  /** Whether the provider is currently available (API reachable, not deprecated). */
  available: boolean;
}

/**
 * The catalog of known providers. This is the source of truth for the UI.
 * Only providers with `transportImplemented: true` can actually be used.
 */
export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = Object.freeze([
  {
    id: "openai",
    name: "OpenAI",
    apiType: "openai-compatible",
    defaultBaseUrl: "https://api.openai.com/v1",
    transportImplemented: true,
    requiresApiKey: true,
    pricingTier: "paid",
    quota: {
      rpm: 3500,
      tpm: 90000,
      summary: "Rate limits vary by tier. Tier 1: 3,500 RPM / 90,000 TPM",
    },
    knownModels: [
      { id: "gpt-4o", name: "GPT-4o", contextWindow: 128000, supportsTools: true, supportsVision: true, pricingTier: "paid", inputCostPer1M: 2.50, outputCostPer1M: 10.00 },
      { id: "gpt-4o-mini", name: "GPT-4o mini", contextWindow: 128000, supportsTools: true, supportsVision: true, pricingTier: "paid", inputCostPer1M: 0.15, outputCostPer1M: 0.60 },
      { id: "gpt-4-turbo", name: "GPT-4 Turbo", contextWindow: 128000, supportsTools: true, supportsVision: true, pricingTier: "paid", inputCostPer1M: 10.00, outputCostPer1M: 30.00 },
      { id: "gpt-4", name: "GPT-4", contextWindow: 8192, supportsTools: true, pricingTier: "paid", inputCostPer1M: 30.00, outputCostPer1M: 60.00 },
      { id: "gpt-3.5-turbo", name: "GPT-3.5 Turbo", contextWindow: 16385, supportsTools: true, pricingTier: "paid", inputCostPer1M: 0.50, outputCostPer1M: 1.50 },
      { id: "o1-preview", name: "o1 Preview", contextWindow: 128000, supportsTools: true, pricingTier: "paid", inputCostPer1M: 15.00, outputCostPer1M: 60.00 },
      { id: "o1-mini", name: "o1 Mini", contextWindow: 128000, supportsTools: true, pricingTier: "paid", inputCostPer1M: 3.00, outputCostPer1M: 12.00 },
    ],
    defaultModel: "gpt-4o-mini",
    isLocal: false,
    available: true,
    description: "OpenAI's flagship models including GPT-4o, o1 series, and GPT-3.5 Turbo.",
    docsUrl: "https://platform.openai.com/docs/api-reference",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    apiType: "anthropic",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    transportImplemented: false,
    requiresApiKey: true,
    pricingTier: "paid",
    quota: {
      rpm: 1000,
      tpm: 40000,
      summary: "Rate limits vary by tier. Standard: 1,000 RPM / 40,000 TPM",
    },
    knownModels: [
      { id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet", contextWindow: 200000, supportsTools: true, supportsVision: true, pricingTier: "paid", inputCostPer1M: 3.00, outputCostPer1M: 15.00 },
      { id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku", contextWindow: 200000, supportsTools: true, supportsVision: true, pricingTier: "paid", inputCostPer1M: 0.80, outputCostPer1M: 4.00 },
      { id: "claude-3-opus-20240229", name: "Claude 3 Opus", contextWindow: 200000, supportsTools: true, supportsVision: true, pricingTier: "paid", inputCostPer1M: 15.00, outputCostPer1M: 75.00 },
      { id: "claude-3-sonnet-20240229", name: "Claude 3 Sonnet", contextWindow: 200000, supportsTools: true, supportsVision: true, pricingTier: "paid", inputCostPer1M: 3.00, outputCostPer1M: 15.00 },
      { id: "claude-3-haiku-20240307", name: "Claude 3 Haiku", contextWindow: 200000, supportsTools: true, supportsVision: true, pricingTier: "paid", inputCostPer1M: 0.25, outputCostPer1M: 1.25 },
    ],
    defaultModel: "claude-3-5-sonnet-20241022",
    isLocal: false,
    available: true,
    description: "Anthropic's Claude 3.5 and 3 series models.",
    docsUrl: "https://docs.anthropic.com/claude/reference/getting-started",
  },
  {
    id: "google",
    name: "Google (Gemini)",
    apiType: "google",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    transportImplemented: false,
    requiresApiKey: true,
    pricingTier: "freemium",
    quota: {
      rpm: 1500,
      tpm: 1000000,
      summary: "Free tier: 1,500 RPM / 1M TPM. Paid tier higher.",
    },
    knownModels: [
      { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro", contextWindow: 2000000, supportsTools: true, supportsVision: true, pricingTier: "freemium", inputCostPer1M: 1.25, outputCostPer1M: 5.00 },
      { id: "gemini-1.5-flash", name: "Gemini 1.5 Flash", contextWindow: 1000000, supportsTools: true, supportsVision: true, pricingTier: "freemium", inputCostPer1M: 0.075, outputCostPer1M: 0.30 },
      { id: "gemini-1.0-pro", name: "Gemini 1.0 Pro", contextWindow: 32768, supportsTools: true, pricingTier: "freemium", inputCostPer1M: 0.50, outputCostPer1M: 1.50 },
    ],
    defaultModel: "gemini-1.5-flash",
    isLocal: false,
    available: true,
    description: "Google's Gemini 1.5 models with large context windows.",
    docsUrl: "https://ai.google.dev/gemini-api/docs",
  },
  {
    id: "local",
    name: "Local AI (Ollama / LM Studio / Jan)",
    apiType: "local",
    defaultBaseUrl: "http://127.0.0.1:11434",
    transportImplemented: true,
    requiresApiKey: false,
    pricingTier: "free",
    quota: {
      summary: "No rate limits — runs on your hardware.",
    },
    knownModels: [
      { id: "llama3.1", name: "Llama 3.1", contextWindow: 128000, supportsTools: true, pricingTier: "free" },
      { id: "llama3.2", name: "Llama 3.2", contextWindow: 128000, supportsTools: true, pricingTier: "free" },
      { id: "mistral-nemo", name: "Mistral Nemo", contextWindow: 128000, supportsTools: true, pricingTier: "free" },
      { id: "qwen2.5", name: "Qwen 2.5", contextWindow: 128000, supportsTools: true, pricingTier: "free" },
      { id: "phi3.5", name: "Phi 3.5", contextWindow: 128000, supportsTools: true, pricingTier: "free" },
      { id: "codellama", name: "Code Llama", contextWindow: 16384, supportsTools: true, pricingTier: "free" },
      { id: "deepseek-coder", name: "DeepSeek Coder", contextWindow: 16384, supportsTools: true, pricingTier: "free" },
    ],
    defaultModel: "llama3.1",
    isLocal: true,
    available: true,
    description: "Local models via Ollama, LM Studio, Jan, or any OpenAI-compatible local server.",
    docsUrl: "https://ollama.com",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    apiType: "openai-compatible",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    transportImplemented: true,
    requiresApiKey: true,
    pricingTier: "freemium",
    quota: {
      summary: "Rate limits vary by model. Free models available.",
    },
    knownModels: [
      { id: "meta-llama/llama-3.1-405b-instruct", name: "Llama 3.1 405B", contextWindow: 128000, supportsTools: true, pricingTier: "paid", inputCostPer1M: 3.00, outputCostPer1M: 3.00 },
      { id: "meta-llama/llama-3.1-70b-instruct", name: "Llama 3.1 70B", contextWindow: 128000, supportsTools: true, pricingTier: "paid", inputCostPer1M: 0.90, outputCostPer1M: 0.90 },
      { id: "meta-llama/llama-3.1-8b-instruct", name: "Llama 3.1 8B", contextWindow: 128000, supportsTools: true, pricingTier: "free", inputCostPer1M: 0.05, outputCostPer1M: 0.05 },
      { id: "mistralai/mistral-large", name: "Mistral Large", contextWindow: 128000, supportsTools: true, pricingTier: "paid", inputCostPer1M: 2.00, outputCostPer1M: 6.00 },
      { id: "google/gemini-flash-1.5", name: "Gemini Flash 1.5", contextWindow: 1000000, supportsTools: true, supportsVision: true, pricingTier: "freemium" },
      { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet", contextWindow: 200000, supportsTools: true, supportsVision: true, pricingTier: "paid", inputCostPer1M: 3.00, outputCostPer1M: 15.00 },
    ],
    defaultModel: "meta-llama/llama-3.1-8b-instruct",
    isLocal: false,
    available: true,
    description: "Access 100+ models from multiple providers through a single OpenAI-compatible API.",
    docsUrl: "https://openrouter.ai/docs",
  },
  {
    id: "custom",
    name: "Custom / Other OpenAI-Compatible",
    apiType: "openai-compatible",
    defaultBaseUrl: "",
    transportImplemented: true,
    requiresApiKey: true,
    pricingTier: "unknown",
    quota: { summary: "Depends on the provider you configure." },
    knownModels: [
      { id: "custom", name: "Custom Model", contextWindow: 4096, supportsTools: true, pricingTier: "unknown" },
    ],
    defaultModel: "custom",
    isLocal: false,
    available: true,
    description: "Any OpenAI-compatible endpoint (vLLM, TGI, LocalAI, private gateway, etc.).",
    docsUrl: "",
  },
]);

/**
 * Look up a catalog entry by id.
 */
export function getProviderCatalogEntry(id: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find((p) => p.id === id);
}

/**
 * Get all catalog entries that have a working transport.
 */
export function getAvailableProviders(): ProviderCatalogEntry[] {
  return PROVIDER_CATALOG.filter((p) => p.transportImplemented && p.available);
}

/**
 * Get all local providers.
 */
export function getLocalProviders(): ProviderCatalogEntry[] {
  return PROVIDER_CATALOG.filter((p) => p.isLocal && p.available);
}

/**
 * Get all remote providers.
 */
export function getRemoteProviders(): ProviderCatalogEntry[] {
  return PROVIDER_CATALOG.filter((p) => !p.isLocal && p.available);
}

/**
 * Get providers that are free or have a free tier.
 */
export function getFreeProviders(): ProviderCatalogEntry[] {
  return PROVIDER_CATALOG.filter((p) => p.available && (p.pricingTier === "free" || p.pricingTier === "freemium"));
}

/**
 * Format pricing tier for display.
 */
export function formatPricingTier(tier: ProviderPricingTier): { label: string; color: string } {
  switch (tier) {
    case "free":
      return { label: "Free", color: "text-green-400" };
    case "freemium":
      return { label: "Freemium", color: "text-blue-400" };
    case "paid":
      return { label: "Paid", color: "text-amber-400" };
    default:
      return { label: "Unknown", color: "text-cc-muted" };
  }
}

/**
 * Get the catalog entry for a provider id, falling back to a generic entry
 * for unknown/custom providers.
 */
export function resolveCatalogEntry(id: string): ProviderCatalogEntry {
  const found = getProviderCatalogEntry(id);
  if (found) return found;
  // Fallback for unknown/custom providers
  return {
    id,
    name: id,
    apiType: "openai-compatible",
    defaultBaseUrl: "",
    transportImplemented: true,
    requiresApiKey: true,
    pricingTier: "unknown",
    quota: { summary: "Custom provider — limits unknown." },
    knownModels: [{ id: "custom", name: "Custom Model", contextWindow: 4096, supportsTools: true, pricingTier: "unknown" }],
    defaultModel: "custom",
    isLocal: false,
    available: true,
    description: "Custom OpenAI-compatible provider.",
  };
}