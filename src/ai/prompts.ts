// Close Code — AI quick-action prompts (Phase 11)

import type { QuickActionKind } from "./types";

export const QUICK_ACTIONS: Array<{ kind: QuickActionKind; label: string; title: string }> = [
  { kind: "explain", label: "Explain", title: "Explain the selected code" },
  { kind: "generate", label: "Generate", title: "Generate code" },
  { kind: "fix", label: "Fix error", title: "Fix errors in the active file" },
  { kind: "refactor", label: "Refactor", title: "Refactor the active file" },
  { kind: "tests", label: "Tests", title: "Generate tests for the active file" },
  { kind: "docs", label: "Docs", title: "Generate documentation" },
];

export function quickActionPrompt(kind: QuickActionKind, userText: string, fileName: string | null): string {
  const file = fileName ? ` (${fileName})` : "";
  switch (kind) {
    case "explain":
      return userText.trim()
        ? `Explain the following in detail, referencing the provided context:\n\n${userText.trim()}`
        : `Explain the selected code and how it works, referencing the provided editor context.`;
    case "generate":
      return userText.trim()
        ? `Generate the requested code using the provided context:\n\n${userText.trim()}`
        : `Generate a helpful, complete implementation for the active file${file}. If this is a new file, respond with the complete file content in a fenced code block.`;
    case "fix":
      return `Fix all errors in the active file${file}. Keep the overall structure and behavior. ` +
        `Respond with the COMPLETE corrected file content in a single fenced code block labelled with its language. ` +
        `Do not show patches or partial snippets; the whole file is required.` +
        (userText.trim() ? `\n\nAdditional instructions: ${userText.trim()}` : "");
    case "refactor":
      return `Refactor the active file${file} to improve clarity, naming and structure without changing behavior. ` +
        `Respond with the COMPLETE refactored file content in a single fenced code block labelled with its language.` +
        (userText.trim() ? `\n\nAdditional instructions: ${userText.trim()}` : "");
    case "tests":
      return `Write unit tests for the code in the active file${file}. Use a mainstream test framework. ` +
        `Respond with the COMPLETE test file content in a single fenced code block labelled with its language.`;
    case "docs":
      return userText.trim()
        ? `Generate documentation for the following, using the provided context:\n\n${userText.trim()}`
        : `Generate clear documentation (comments and/or a doc file) for the active file${file}. ` +
          `If a doc file makes sense, respond with its COMPLETE content in a fenced code block.`;
    default:
      return userText.trim() ? userText.trim() : "";
  }
}