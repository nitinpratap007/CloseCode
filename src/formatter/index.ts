import { registerFormatter } from "./registry";
import { monacoProvider } from "./providers/builtin";
import { prettierProvider } from "./providers/prettier";
import { eslintProvider } from "./providers/eslint";
import { setFormatterConfig } from "./manager";
import type { FormatterConfig } from "./types";

export function setupFormatters(initialConfig?: Partial<FormatterConfig>): void {
  // Register providers (only once)
  try {
    registerFormatter(monacoProvider);
  } catch {}
  try {
    registerFormatter(prettierProvider);
  } catch {}
  try {
    registerFormatter(eslintProvider);
  } catch {}

  if (initialConfig) {
    setFormatterConfig(initialConfig);
  }

  console.info(`[Formatter] Registered ${["monaco", "prettier", "eslint"].join(", ")} (prettier/eslint optional)`);

  // Expose for tests
  const w = window as unknown as Record<string, unknown>;
  w.__formatterSetupDone = true;
}

export { getFormatterConfig, setFormatterConfig } from "./manager";
export { getAllFormatters, selectFormatter } from "./registry";
