import { selectFormatter, getAllFormatters } from "./registry";
import type { FormatterConfig } from "./types";
import { DEFAULT_FORMATTER_CONFIG } from "./types";

let currentConfig: FormatterConfig = { ...DEFAULT_FORMATTER_CONFIG };

export function setFormatterConfig(config: Partial<FormatterConfig>): void {
  currentConfig = { ...currentConfig, ...config };
  // Persist to settings? Handled by App's updateSettings
  const w = window as unknown as Record<string, unknown>;
  w.__formatterConfig = currentConfig;
}

export function getFormatterConfig(): FormatterConfig {
  return currentConfig;
}

export async function formatDocumentContent(filePath: string, content: string): Promise<string | null> {
  const provider = await selectFormatter(filePath, currentConfig);
  if (!provider) return null;

  // Try provider's format first
  const viaProvider = await provider.format(content, filePath, { tabSize: 2, insertSpaces: true });
  if (viaProvider && viaProvider !== content) return viaProvider;

  // Fallback: try Monaco's built-in via editor action if we have an editor
  // This is for when prettier is not available but monaco's formatter can handle
  // We can't directly call Monaco's formatter without an editor instance, so we return null
  // The UI will then try editor.action.formatDocument
  return null;
}

export async function formatViaMonaco(): Promise<boolean> {
  const ed = (window as unknown as Record<string, unknown>).__monacoEditor as import("monaco-editor").editor.IStandaloneCodeEditor | undefined;
  if (!ed) return false;
  try {
    await ed.getAction("editor.action.formatDocument")?.run();
    return true;
  } catch {
    return false;
  }
}

// For format on save: called from App's save logic
export async function formatOnSaveIfNeeded(filePath: string): Promise<boolean> {
  if (!currentConfig.formatOnSave) return false;
  const ed = (window as unknown as Record<string, unknown>).__monacoEditor as import("monaco-editor").editor.IStandaloneCodeEditor | undefined;
  if (!ed) return false;
  // Only format if the active file is the one being saved
  const activePath = (window as unknown as { __editorStore?: { getState: () => { activePath: string | null } } }).__editorStore?.getState().activePath;
  if (activePath !== filePath) return false;
  // Trigger format
  try {
    await ed.getAction("editor.action.formatDocument")?.run();
    return true;
  } catch {
    return false;
  }
}

export function getAvailableFormatters(): ReturnType<typeof getAllFormatters> {
  return getAllFormatters();
}

// Expose for tests
if (typeof window !== "undefined") {
  const w = window as unknown as Record<string, unknown>;
  w.__formatterConfig = currentConfig;
  w.__formatDocumentContent = formatDocumentContent;
}
