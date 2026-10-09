export type FormatterId = string; // "monaco" | "prettier" | "eslint" | ...

export interface FormatOptions {
  tabSize?: number;
  insertSpaces?: boolean;
  // Future: prettier options
  semi?: boolean;
  singleQuote?: boolean;
  trailingComma?: "none" | "es5" | "all";
}

export interface FormatterProvider {
  id: FormatterId;
  displayName: string;
  /** Glob patterns this formatter handles, e.g. ["*.js", "*.ts", "*.json"] . If empty, handles all */
  filePatterns?: string[];
  /** Whether this formatter is available (prettier installed, etc.) */
  isAvailable: () => boolean | Promise<boolean>;
  /** Format content, return new content or null if not applicable / no change */
  format: (content: string, filePath: string, options?: FormatOptions) => string | Promise<string | null>;
  /** Optional: provide diagnostics (for linters like ESLint) */
  getDiagnostics?: (content: string, filePath: string) => Array<{
    line: number;
    column: number;
    endLine?: number;
    endColumn?: number;
    severity: "error" | "warning" | "info";
    message: string;
    source?: string;
  }> | Promise<Array<{
    line: number;
    column: number;
    endLine?: number;
    endColumn?: number;
    severity: "error" | "warning" | "info";
    message: string;
    source?: string;
  }>>;
}

export interface FormatterConfig {
  /** Default formatter id, "auto" means pick best available for file */
  defaultFormatter: FormatterId; // "auto" | "monaco" | "prettier" | ...
  formatOnSave: boolean;
  /** Per-language override, e.g. { "javascript": "prettier", "json": "monaco" } */
  perLanguage?: Record<string, FormatterId>;
}

export const DEFAULT_FORMATTER_CONFIG: FormatterConfig = {
  defaultFormatter: "auto",
  formatOnSave: false,
  perLanguage: {},
};
