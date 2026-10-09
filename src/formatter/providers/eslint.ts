import type { FormatterProvider } from "../types";

// ESLint provider — for diagnostics, not formatting
// Optional, not mandatory. Checks via main's checkLSP for "eslint"

export const eslintProvider: FormatterProvider = {
  id: "eslint",
  displayName: "ESLint",
  filePatterns: ["*.js", "*.ts", "*.jsx", "*.tsx"],
  isAvailable: async () => {
    try {
      if (typeof window !== "undefined" && (window as unknown as { closeCode?: { checkLSP?: (cmd: string) => Promise<{ found: boolean }> } }).closeCode?.checkLSP) {
        const r = await (window as unknown as { closeCode: { checkLSP: (cmd: string) => Promise<{ found: boolean }> } }).closeCode.checkLSP("eslint");
        return r.found;
      }
    } catch {}
    return false;
  },
  format: async () => null,
  getDiagnostics: async () => [],
};
