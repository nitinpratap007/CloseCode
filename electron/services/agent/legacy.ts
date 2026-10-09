// Close Code — AI Agent Runtime — Phase 11 chat-contract projection (Phase 21)
//
// The AI chat surface (renderer `aiStore`, AI panel) speaks the Phase 11
// `ai:event` contract. Phase 21 replaced the loop underneath it, so the old
// events are now *derived* from the runtime's event stream.
//
// Kept in its own module, free of `electron` imports, so the projection itself
// is unit-testable rather than only observable end-to-end.

import type { AgentEvent, AgentStatusKind, ToolStatus } from "./types";

export type LegacyAiEvent =
  | { type: "stream"; payload: { id: string; delta: string } }
  | { type: "done"; payload: { id: string; text: string; toolSteps: number } }
  | { type: "agent"; payload: { id: string; note: string } }
  | {
      type: "tool";
      payload: {
        id: string;
        tool: string;
        args: Record<string, unknown>;
        result: string;
        granted: boolean;
        /** Phase 22. Lets the UI label a failed call without reading the text. */
        status: ToolStatus;
        /** Phase 22. True when this call changed files, the repo or the machine. */
        destructive: boolean;
      };
    }
  | {
      type: "approval";
      // Phase 23. The capability fields ride along on the legacy projection too.
      // The AI panel renders approvals from this stream, and a legacy payload
      // that dropped them would leave the one place the user approves a call
      // unable to say which permission is being exercised.
      payload: {
        id: string;
        tool: string;
        args: Record<string, unknown>;
        destructive: boolean;
        capabilities: readonly string[];
        capabilityLabels: readonly string[];
        escalation?: { capability: string; mode: "ask" | "deny"; reason: string };
      };
    }
  | { type: "error"; payload: { id: string; message: string } };

/**
 * Project one runtime event onto the legacy chat contract, or `null` when the
 * event has no legacy equivalent.
 *
 * `error` events are deliberately not mapped. The runtime always follows an
 * error with a terminal `result` event, and mapping both would show the user
 * two failure banners for a single failure.
 */
export function toLegacyAiEvent(ev: AgentEvent): LegacyAiEvent | null {
  switch (ev.type) {
    case "delta":
      return { type: "stream", payload: { id: ev.runId, delta: ev.delta } };
    case "tool":
      return {
        type: "tool",
        payload: {
          id: ev.runId,
          tool: ev.tool,
          args: ev.args,
          result: ev.result,
          granted: ev.granted,
          status: ev.status,
          destructive: ev.destructive,
        },
      };
    case "approval":
      return {
        type: "approval",
        payload: {
          id: ev.id,
          tool: ev.tool,
          args: ev.args,
          destructive: ev.destructive,
          capabilities: ev.capabilities,
          capabilityLabels: ev.capabilityLabels,
          ...(ev.escalation ? { escalation: ev.escalation } : {}),
        },
      };
    case "status":
      // Only the opening note was ever surfaced by the chat UI.
      return (ev.level as AgentStatusKind) === "starting"
        ? { type: "agent", payload: { id: ev.runId, note: ev.text } }
        : null;
    case "result":
      return ev.result.status === "completed"
        ? { type: "done", payload: { id: ev.runId, text: ev.result.text, toolSteps: ev.result.toolCalls } }
        : {
            type: "error",
            payload: {
              id: ev.runId,
              message: ev.result.error?.message ?? "The agent run did not complete.",
            },
          };
    default:
      return null;
  }
}
