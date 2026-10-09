import type { FormatterProvider } from "../types";

// Monaco built-in formatter — uses editor.action.formatDocument via Monaco
// This provider is always available, but actual formatting is done via Monaco's action, not here
// For file content formatting without editor, we provide a simple fallback

export const monacoProvider: FormatterProvider = {
  id: "monaco",
  displayName: "Monaco (Built-in)",
  isAvailable: () => true,
  format: async (content, _filePath, options) => {
    // For JS/TS/JSON, we could do a simple prettify via Monaco's worker, but for now we just
    // do minimal formatting: trim trailing whitespace, ensure final newline
    // Real formatting is done via editor.action.formatDocument in the UI
    // This provider just normalizes whitespace as a fallback
    let formatted = content;
    // Example: ensure consistent tabSize
    if (options?.tabSize) {
      // Not actually reformatting, just return content for now
      // The real formatting will be via Monaco's action
    }
    // Simple: trim trailing whitespace per line
    formatted = formatted
      .split("\n")
      .map((line) => line.replace(/[ \t]+$/g, ""))
      .join("\n");
    // Ensure final newline
    if (formatted.length > 0 && !formatted.endsWith("\n")) formatted += "\n";
    // If no change, return null to indicate no edit
    if (formatted === content) return null;
    return formatted;
  },
};
