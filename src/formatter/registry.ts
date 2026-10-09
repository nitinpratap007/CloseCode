import type { FormatterProvider, FormatterId, FormatOptions } from "./types";
import { detectLanguage } from "../lib/language";

const providers = new Map<FormatterId, FormatterProvider>();

export function registerFormatter(provider: FormatterProvider): void {
  if (providers.has(provider.id)) {
    throw new Error(`Formatter already registered: ${provider.id}`);
  }
  providers.set(provider.id, provider);
}

export function unregisterFormatter(id: FormatterId): void {
  providers.delete(id);
}

export function getFormatter(id: FormatterId): FormatterProvider | undefined {
  return providers.get(id);
}

export function getAllFormatters(): FormatterProvider[] {
  return [...providers.values()];
}

export function clearFormattersForTesting(): void {
  providers.clear();
}

// Select best formatter for a file based on config and availability
export async function selectFormatter(filePath: string, config: { defaultFormatter: string; perLanguage?: Record<string, string> }): Promise<FormatterProvider | null> {
  const lang = detectLanguage(filePath);
  const perLang = config.perLanguage?.[lang];
  const desiredId = perLang ?? config.defaultFormatter;

  if (desiredId !== "auto") {
    const provider = providers.get(desiredId);
    if (provider) {
      const available = await provider.isAvailable();
      if (available) return provider;
    }
    // Fallback to auto if desired not available
  }

  // Auto: pick first available that matches file, prefer prettier for js/ts/json, monaco for others
  const candidates: FormatterId[] = ["prettier", "monaco", "eslint"];
  for (const candId of candidates) {
    const p = providers.get(candId);
    if (!p) continue;
    // Check file pattern if specified
    if (p.filePatterns && p.filePatterns.length > 0) {
      const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
      const matches = p.filePatterns.some((pat) => {
        // Simple glob: * and **
        const reStr = pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
        return new RegExp(`^${reStr}$`, "i").test(fileName) || new RegExp(`^${reStr}$`, "i").test(filePath);
      });
      if (!matches) continue;
    }
    const avail = await p.isAvailable();
    if (avail) return p;
  }

  // Fallback to monaco if available
  const monaco = providers.get("monaco");
  if (monaco && (await monaco.isAvailable())) return monaco;

  return null;
}

export async function formatWithProvider(
  provider: FormatterProvider,
  content: string,
  filePath: string,
  options?: FormatOptions
): Promise<string | null> {
  try {
    const result = await provider.format(content, filePath, options);
    return result;
  } catch (err) {
    console.error(`[Formatter ${provider.id}] format failed:`, err);
    return null;
  }
}
