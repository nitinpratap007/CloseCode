// Close Code — AI store (Phase 11/12)
// Chat message state, streaming event handling, suggested-change diff previews,
// tool-approval flow, and provider configuration — the renderer half of the
// provider-independent AI architecture.

import { create } from "zustand";
import monaco from "../monaco";
import type {
  AiApprovalRequest,
  AiChatEvent,
  AiConfigData,
  AiLocalRuntime,
} from "../types/electron";
import { formatCompactionNotice } from "../lib/compaction";
import type { AiMessage, AiToolLog, QuickActionKind, SuggestedChange } from "../ai/types";
import { buildAiContext, serializeAiContext, DEFAULT_CONTEXT_SELECTION, type AiContextSelection } from "../ai/context";
import { makeUnifiedDiff, extractCodeBlocks, langMatchesFile } from "../ai/diff";
import { quickActionPrompt } from "../ai/prompts";
import { useEditorStore, cacheContent } from "./editorStore";
import { useWorkspaceStore } from "./workspaceStore";
import { useSessionStore } from "./sessionStore";
import { nextId } from "../ai/types";

interface AiState {
  config: AiConfigData | null;
  apiKeys: Record<string, boolean>;
  localDetected: AiLocalRuntime[] | null;
  models: string[];
  messages: AiMessage[];
  toolLog: AiToolLog[];
  suggestedChanges: SuggestedChange[];
  approvalRequests: AiApprovalRequest[];
  contextSel: AiContextSelection;
  contextChars: number;
  busy: boolean;
  error: string | null;
  input: string;
  /**
   * Phase 28. Set when the plain (non-agent) chat path had to compress the
   * payload before sending it, so the user can see that a long conversation did
   * not lose anything silently. Cleared when the next message is sent.
   */
  compactionNote: string | null;
  configOpen: boolean;
  started: boolean;

  startListening: () => void;
  loadConfig: () => Promise<void>;
  saveConfig: (patch: Partial<AiConfigData>) => Promise<void>;
  setApiKey: (provider: string, key: string) => Promise<void>;
  clearApiKey: (provider: string) => Promise<void>;
  detectLocal: () => Promise<void>;
  refreshModels: () => Promise<void>;
  setContextSel: (patch: Partial<AiContextSelection>) => void;
  refreshContext: () => void;
  setInput: (text: string) => void;
  toggleConfig: () => void;
  send: (textOverride?: string) => Promise<void>;
  quickAction: (kind: QuickActionKind) => Promise<void>;
  respondApproval: (id: string, approved: boolean) => void;
  applyChange: (id: string) => Promise<void>;
  discardChange: (id: string) => void;
  clearChat: () => void;
  clearError: () => void;
  maybeSuggestChange: (assistantId: string, text: string) => Promise<void>;
}

function historyMessages(messages: AiMessage[]): Array<{ role: string; content: string }> {
  return messages
    .filter((m) => m.role === "user" || (m.role === "assistant" && m.text.length > 0 && !m.streaming))
    .map((m) => ({ role: m.role, content: m.text }));
}

let activeRequestId: string | null = null;

export const useAiStore = create<AiState>((set, get) => {
  const handleEvent = (ev: AiChatEvent): void => {
    switch (ev.type) {
      case "stream": {
        const { id, delta } = ev.payload;
        if (id !== activeRequestId) return;
        set((s) => ({
          messages: s.messages.map((m) => (m.id === id ? { ...m, text: m.text + delta } : m)),
        }));
        break;
      }
      case "tool": {
        const { id, tool, args, result, granted, status, destructive } = ev.payload;
        if (id !== activeRequestId) return;
        set((s) => ({
          toolLog: [...s.toolLog, { id: nextId("tool"), tool, args, result, granted, status, destructive }].slice(-50),
        }));
        break;
      }
      case "agent": {
        if (ev.payload.id !== activeRequestId) return;
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === ev.payload.id
              ? { ...m, text: m.text ? m.text : `[agent mode] ${ev.payload.note}\n` }
              : m
          ),
        }));
        break;
      }
      case "compaction": {
        // Phase 28. The plain chat path compressed the payload it is about to
        // send (the agent path reports the same fact through the agent panel).
        // A note beats silent re-sending: the user can see the conversation was
        // over budget and that nothing was deleted — only compressed.
        if (ev.payload.id !== activeRequestId) return;
        set({ compactionNote: formatCompactionNotice(ev.payload.record) });
        break;
      }
      case "approval": {
        set((s) => ({ approvalRequests: [...s.approvalRequests, ev.payload] }));
        break;
      }
      case "done": {
        const { id, text } = ev.payload;
        if (id !== activeRequestId) return;
        activeRequestId = null;
        set((s) => ({
          messages: s.messages.map((m) => (m.id === id ? { ...m, text, streaming: false } : m)),
          busy: false,
        }));
        void get().maybeSuggestChange(id, text);
        // Phase 27. The answer, now that it is complete rather than streaming.
        // An empty answer is not worth a turn — `done` can fire with no text when
        // the model returned nothing usable, and a session full of blank turns
        // would make `resumeHistory` replay noise.
        if (text.trim()) void useSessionStore.getState().recordTurn("assistant", text, id);
        break;
      }
      case "error": {
        const { id, message } = ev.payload;
        activeRequestId = null;
        set((s) => ({
          busy: false,
          error: message,
          messages: s.messages.map((m) => (m.id === id ? { ...m, streaming: false, text: m.text || "(error)" } : m)),
        }));
        break;
      }
      default:
        break;
    }
  };

  return {
    config: null,
    apiKeys: {},
    localDetected: null,
    models: [],
    messages: [],
    toolLog: [],
    suggestedChanges: [],
    approvalRequests: [],
    contextSel: { ...DEFAULT_CONTEXT_SELECTION },
    contextChars: 0,
    busy: false,
    error: null,
    input: "",
    compactionNote: null,
    configOpen: false,
    started: false,

    startListening: () => {
      if (get().started) return;
      set({ started: true });
      window.closeCode.onAiEvent(handleEvent);
      void get().loadConfig();
      void get().detectLocal();
      // Phase 14: privacy.aiContextAutoInclude — default extra context bundles ON
      void window.closeCode.getSettings().then((s) => {
        if (s.aiContextAutoInclude) {
          set((st) => ({
            contextSel: { ...st.contextSel, diagnostics: true, moreFiles: true },
          }));
        }
      });
    },

    loadConfig: async () => {
      try {
        const res = await window.closeCode.aiGetConfig();
        if (res.ok && res.result) {
          set({ config: res.result.config, apiKeys: res.result.apiKeys });
        } else {
          set({ error: res.error ?? "Failed to load AI config" });
        }
      } catch (err) {
        set({ error: String(err) });
      }
    },

    saveConfig: async (patch) => {
      try {
        const res = await window.closeCode.aiSaveConfig(patch);
        if (res.ok && res.result) set({ config: res.result.config, apiKeys: res.result.apiKeys });
        else set({ error: res.error ?? "Failed to save AI config" });
      } catch (err) {
        set({ error: String(err) });
      }
    },

    setApiKey: async (provider, key) => {
      try {
        const res = await window.closeCode.aiSetApiKey(provider, key);
        if (res.ok && res.result) {
          set((s) => ({ apiKeys: { ...s.apiKeys, [provider]: res.result!.has } }));
        } else {
          set({ error: res.error ?? "Failed to store API key" });
        }
      } catch (err) {
        set({ error: String(err) });
      }
    },

    clearApiKey: async (provider) => {
      try {
        await window.closeCode.aiClearApiKey(provider);
        set((s) => ({ apiKeys: { ...s.apiKeys, [provider]: false } }));
      } catch (err) {
        set({ error: String(err) });
      }
    },

    detectLocal: async () => {
      try {
        const res = await window.closeCode.aiDetectLocal();
        if (res.ok && res.result) {
          set({ localDetected: res.result.runtimes });
          return;
        }
        set({ localDetected: [] });
      } catch {
        set({ localDetected: [] });
      }
    },

    refreshModels: async () => {
      try {
        const res = await window.closeCode.aiModels();
        if (res.ok && res.result) set({ models: res.result.models });
        else set({ error: res.error ?? "Failed to fetch models" });
      } catch (err) {
        set({ error: String(err) });
      }
    },

    setContextSel: (patch) => {
      set((s) => {
        const next = { ...s.contextSel, ...patch };
        const bundle = buildAiContext(next);
        return { contextSel: next, contextChars: bundle.totalChars };
      });
    },

    refreshContext: () => {
      const bundle = buildAiContext(get().contextSel);
      set({ contextChars: bundle.totalChars });
    },

    setInput: (text) => set({ input: text }),
    toggleConfig: () => set((s) => ({ configOpen: !s.configOpen })),

    send: async (textOverride) => {
      const { busy, input } = get();
      if (busy) return;
      const text = (textOverride ?? input).trim();
      if (!text) {
        set({ error: "Type a message first." });
        return;
      }
      get().refreshContext();
      const bundle = buildAiContext(get().contextSel);
      const context = serializeAiContext(bundle);
      const history = historyMessages(get().messages);
      const userMsg: AiMessage = { id: nextId("user"), role: "user", text };
      const assistantMsg: AiMessage = { id: nextId("assistant"), role: "assistant", text: "", streaming: true };
      set((s) => ({
        messages: [...s.messages, userMsg, assistantMsg],
        busy: true,
        error: null,
        input: textOverride == null ? "" : s.input,
        // Phase 28. A fresh send starts with a clean slate: the previous
        // compaction notice belonged to the previous turn.
        compactionNote: null,
      }));
      activeRequestId = assistantMsg.id;
      // Phase 27. The question is filed before the request is even sent, so a
      // crash mid-answer still leaves the user's own words on disk. Filing it
      // after the response would lose exactly the message that matters most.
      void useSessionStore.getState().recordTurn("user", text, userMsg.id);
      try {
        const res = await window.closeCode.aiChat({
          id: assistantMsg.id,
          messages: [...historyMsgWith(history, userMsg)],
          context,
          workspace: useWorkspaceStore.getState().root,
        });
        if (!res.ok) {
          activeRequestId = null;
          set((s) => ({
            busy: false,
            error: res.error ?? "AI request failed",
            messages: s.messages.map((m) => (m.id === assistantMsg.id ? { ...m, streaming: false } : m)),
          }));
        }
        // On success the stream/done events finish the message.
      } catch (err) {
        activeRequestId = null;
        set((s) => ({
          busy: false,
          error: String(err),
          messages: s.messages.map((m) => (m.id === assistantMsg.id ? { ...m, streaming: false } : m)),
        }));
      }
    },

    quickAction: async (kind) => {
      const active = useEditorStore.getState().activePath;
      const fileName = active ? active.split(/[\\/]/).pop() ?? null : null;
      const prompt = quickActionPrompt(kind, get().input, fileName);
      await get().send(prompt);
    },

    respondApproval: (id, approved) => {
      void window.closeCode.aiRespondApproval(id, approved);
      set((s) => ({ approvalRequests: s.approvalRequests.filter((a) => a.id !== id) }));
    },

    applyChange: async (id) => {
      const change = get().suggestedChanges.find((c) => c.id === id);
      if (!change || change.applied) return;
      if (change.file.startsWith("untitled:")) {
        set({ error: "Cannot apply to an unsaved file. Save it first." });
        return;
      }
      const write = await window.closeCode.writeFile(change.file, change.suggested);
      if (write.error) {
        set({ error: `Apply failed: ${write.error}` });
        return;
      }
      cacheContent(change.file, change.suggested);
      try {
        const model = monaco.editor.getModel(monaco.Uri.file(change.file));
        if (model) model.setValue(change.suggested);
      } catch {
        // no open model — file was written to disk anyway
      }
      const tab = useEditorStore.getState().tabs.find((t) => t.path === change.file);
      if (tab) useEditorStore.getState().markClean(change.file);
      set((s) => ({
        suggestedChanges: s.suggestedChanges.map((c) => (c.id === id ? { ...c, applied: true } : c)),
      }));
    },

    discardChange: (id) => {
      set((s) => ({ suggestedChanges: s.suggestedChanges.filter((c) => c.id !== id) }));
    },

    clearChat: () => set({ messages: [], toolLog: [], suggestedChanges: [], error: null }),

    clearError: () => set({ error: null }),

    maybeSuggestChange: async (_assistantId: string, text: string) => {
      const blocks = extractCodeBlocks(text);
      if (blocks.length === 0) return;
      const activePath = useEditorStore.getState().activePath;
      const target = activePath && !activePath.startsWith("untitled:") ? activePath : null;
      if (!target) return;
      const block = blocks.find((b) => langMatchesFile(b.lang, target)) ?? blocks[0];
      const original = getCachedContent(target);
      if (block.content === original) return;
      // Skip suggestions where the assistant merely echoed context back.
      if (!langMatchesFile(block.lang, target) && blocks.length > 1) return;
      const diff = makeUnifiedDiff(original, block.content, target);
      const change: SuggestedChange = {
        id: nextId("change"),
        file: target,
        original,
        suggested: block.content,
        diff,
        applied: false,
      };
      set((s) => ({ suggestedChanges: [...s.suggestedChanges, change].slice(-10) }));
    },
  };
});

function historyMsgWith(
  history: Array<{ role: string; content: string }>,
  userMsg: AiMessage
): Array<{ role: string; content: string }> {
  return [...history, { role: "user", content: userMsg.text }];
}

function getCachedContent(path: string): string {
  return useEditorStore.getState().getContent(path);
}

// Expose for CDP / unit tests
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__aiStore = useAiStore;
}