import type { FormatterProvider } from "../types";

// Prettier provider — optional, not mandatory
// Checks via main's checkLSP for "prettier" command; no bundling of huge prettier

export const prettierProvider: FormatterProvider = {
  id: "prettier",
  displayName: "Prettier",
  filePatterns: ["*.js", "*.ts", "*.jsx", "*.tsx", "*.json", "*.css", "*.html", "*.md", "*.yaml", "*.yml"],
  isAvailable: async () => {
    try {
      if (typeof window !== "undefined" && (window as unknown as { closeCode?: { checkLSP?: (cmd: string) => Promise<{ found: boolean }> } }).closeCode?.checkLSP) {
        const r = await (window as unknown as { closeCode: { checkLSP: (cmd: string) => Promise<{ found: boolean }> } }).closeCode.checkLSP("prettier");
        return r.found;
      }
    } catch {}
    return false;
  },
  format: async () => {
    // Prettier formatting would be done via main process if prettier is installed globally
    // For now, we fallback to Monaco's built-in formatter (handled by manager)
    return null;
  },
};

// For testing: allow mocking
export function __setPrettierMock(_mock: unknown | null, _available: boolean): void {
  // No-op for now, kept for API compatibility
}
