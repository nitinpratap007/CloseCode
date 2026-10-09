import type { LanguageProvider, LanguageId } from "./types";
import { detectLanguage } from "../lib/language";

const providers = new Map<LanguageId, LanguageProvider>();

export function registerLanguage(provider: LanguageProvider): void {
  if (providers.has(provider.id)) {
    throw new Error(`Language already registered: ${provider.id}`);
  }
  providers.set(provider.id, provider);
  // Run Monaco config if provided
  if (provider.configureMonaco) {
    try {
      provider.configureMonaco();
    } catch (err) {
      console.error(`Failed to configure Monaco for ${provider.id}:`, err);
    }
  }
}

export function unregisterLanguage(id: LanguageId): void {
  providers.delete(id);
}

export function getLanguage(id: LanguageId): LanguageProvider | undefined {
  return providers.get(id);
}

export function getAllLanguages(): LanguageProvider[] {
  return [...providers.values()];
}

export function getLanguageForFile(filePath: string): LanguageProvider | undefined {
  const langId = detectLanguage(filePath);
  return providers.get(langId);
}

export function clearLanguagesForTesting(): void {
  providers.clear();
}

// Helper to check if a language is supported
export function isLanguageSupported(langId: string): boolean {
  return providers.has(langId);
}
