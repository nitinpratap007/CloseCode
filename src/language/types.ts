export type LanguageId = string; // "html" | "css" | "javascript" | "typescript" | "json" | "markdown" | ...

export interface LSPConfig {
  /** Command to launch the server, e.g. "pylsp" or "typescript-language-server --stdio" */
  command: string;
  args?: string[];
  /** Whether this server should be auto-started if found */
  enabled: boolean;
  /** Glob for files this server handles, e.g. "**\/*.py" */
  filePattern?: string;
  /** Optional explicit path, if not in PATH */
  path?: string;
}

export interface LanguageProvider {
  id: LanguageId;
  extensions: string[]; // e.g. [".js", ".ts"]
  displayName: string;
  /** Optional LSP config for external server (for Python, Java, etc.) */
  lsp?: LSPConfig;
  /** Optional Monaco configuration hook */
  configureMonaco?: () => void;
  /** Whether this language is built-in via Monaco workers (no external server needed) */
  isBuiltIn?: boolean;
}

export interface Diagnostic {
  file: string; // absolute path or uri
  line: number; // 1-indexed
  column: number; // 1-indexed
  endLine?: number;
  endColumn?: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source?: string;
  code?: string | number;
}

// For hover, definition, etc. - we delegate to Monaco, so types are minimal
export interface HoverInfo {
  contents: string[];
  range?: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
}

export interface Location {
  file: string;
  line: number;
  column: number;
}
