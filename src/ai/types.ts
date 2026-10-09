// Close Code — Renderer AI module (Phase 11/12)
// Provider-independent abstractions. Transport lives in the main process;
// the renderer only holds configuration UI state and chat state.

import type {
  AiConfigData,
  AiPermissionMode,
  AiProviderType,
  AiLocalRuntime,
  AiApprovalRequest,
  AiChatEvent,
} from "../types/electron";

export interface AiProviderMeta {
  id: AiProviderType;
  name: string;
  kind: "local" | "remote";
  description: string;
  /** If kind is local we can auto-detect a runtime. */
  local: boolean;
}

export interface AiContextPart {
  label: string;
  text: string;
}

export interface AiContextBundle {
  parts: AiContextPart[];
  totalChars: number;
}

export type QuickActionKind = "explain" | "generate" | "fix" | "refactor" | "tests" | "docs";

export interface AiMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
}

export interface AiToolLog {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  result: string;
  granted: boolean;
  /**
   * Phase 22. The structured outcome, so the panel can colour a call by what
   * happened rather than by re-reading the result string. Optional because the
   * `tool` event is also produced by the Phase 11 path in `AiService`, which has
   * no structured result to report.
   */
  status?: "ok" | "error" | "denied";
  /** Phase 22. True when this call changed files, the repo or the machine. */
  destructive?: boolean;
}

export interface SuggestedChange {
  id: string;
  file: string;
  original: string;
  suggested: string;
  diff: string;
  applied: boolean;
}

export type { AiConfigData, AiPermissionMode, AiProviderType, AiLocalRuntime, AiApprovalRequest, AiChatEvent };

let msgCounter = 0;
export function nextId(prefix = "msg"): string {
  msgCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${msgCounter}-${Math.random().toString(36).slice(2, 7)}`;
}