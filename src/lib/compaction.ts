// Close Code — renderer wording for context compaction (Phase 28).
//
// The main process decides *that* a payload was compacted and ships the numbers
// in `CompactionRecord`; the *wording* of "what happened" is a UI concern, so it
// lives here, in the renderer, where both surfaces that say it can share it. The
// agent panel says it in a metric chip and a trace line; the chat panel says it
// in a note. Two places, one sentence, no drift.

import type { CompactionRecord } from "../types/electron";

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/** The sentence the UI shows when a payload was compacted. */
export function formatCompactionNotice(record: CompactionRecord): string {
  const passes = record.passes > 1 ? ` (${record.passes} passes)` : "";
  return (
    `Context compacted${passes}: ${fmt(record.beforeChars)} → ${fmt(record.afterChars)} chars, ` +
    `${record.beforeMessages} → ${record.afterMessages} messages.` +
    (record.overflow ? " The system prompt and active task alone still exceed the budget." : "")
  );
}