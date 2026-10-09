// Close Code — web research store (Phase 32)
//
// Renderer projection of the research store. The disk is the truth and the
// main process is the authority: every row arrives over `research:list`, every
// write goes through `research:start` / `research:respond`, and the push
// channel (`research:event`) keeps the panel live during a running pipeline —
// steps, sources and status change under the user's cursor without a poll.

import { create } from "zustand";
import type { ResearchRecordView } from "../types/electron";

export interface WebResearchStoreState {
  records: ResearchRecordView[];
  busy: boolean;
  question: string;
  focusUrls: string;
  error: string | null;

  setQuestion: (q: string) => void;
  setFocusUrls: (u: string) => void;
  refresh: () => Promise<void>;
  start: () => Promise<void>;
  respond: (id: string, approved: boolean) => Promise<void>;
  clearError: () => void;
}

function msg(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : typeof err === "string" ? err : fallback;
}

/** Parse the optional "documentation URLs" field: comma/space separated http(s) URLs, max 5. */
function splitUrls(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s))
    .slice(0, 5);
}

export const useWebResearchStore = create<WebResearchStoreState>((set, get) => ({
  records: [],
  busy: false,
  question: "",
  focusUrls: "",
  error: null,

  setQuestion: (q) => set({ question: q }),
  setFocusUrls: (u) => set({ focusUrls: u }),
  clearError: () => set({ error: null }),

  refresh: async () => {
    try {
      const res = await window.closeCode.researchList();
      if (res.ok && res.records) set({ records: res.records });
      else set({ error: res.error ?? "The research list could not be read." });
    } catch (err) {
      set({ error: msg(err, "The research list could not be read.") });
    }
  },

  start: async () => {
    const question = get().question.trim();
    if (!question) {
      set({ error: "Enter a research question first." });
      return;
    }
    set({ busy: true, error: null });
    try {
      const focusUrls = splitUrls(get().focusUrls);
      const res = await window.closeCode.researchStart({ question, focusUrls });
      if (!res.ok) {
        set({ busy: false, error: res.error ?? "The research could not start." });
        return;
      }
      set({ busy: false, question: "", focusUrls: "" });
      await get().refresh();
    } catch (err) {
      set({ busy: false, error: msg(err, "The research could not start.") });
    }
  },

  respond: async (id, approved) => {
    try {
      const res = await window.closeCode.researchRespond(id, approved);
      if (!res.ok) set({ error: res.error ?? "The approval could not be sent." });
      await get().refresh();
    } catch (err) {
      set({ error: msg(err, "The approval could not be sent.") });
    }
  },
}));