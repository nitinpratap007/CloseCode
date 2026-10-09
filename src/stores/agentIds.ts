// CloseCode — renderer-side agent id helpers (Phase 24)
//
// The canonical agent list and the `default` → `build` alias live in the main
// process (`electron/services/agent/definitions.ts`). The renderer cannot import
// from there — `contextIsolation` is on and that is not going to change for the
// sake of a two-entry map — so it carries its own copy of the alias.
//
// That duplication is deliberate but it must not drift, and the Phase 24 E2E
// suite asserts the two agree by reading both sources. The main process remains
// authoritative: `agent:start` canonicalises again on the way in, so a stale
// alias here costs the user a mislabelled selector, never a wrong agent running.

/** Ids that used to be real and now resolve to a renamed agent. */
const AGENT_ALIASES: Readonly<Record<string, string>> = Object.freeze({ default: "build" });

/** Shown while the real list is loading. Matches `DEFAULT_AGENT_ID` in main. */
export const DEFAULT_AGENT = "build";

export function canonicalAgentId(id: string): string {
  const clean = id.trim();
  if (!clean) return DEFAULT_AGENT;
  return Object.prototype.hasOwnProperty.call(AGENT_ALIASES, clean) ? AGENT_ALIASES[clean] : clean;
}