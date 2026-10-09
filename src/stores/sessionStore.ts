// Close Code — session store (Phase 27)
//
// Renderer half of persistent AI sessions. It owns which session is open, the
// list, and the one piece of state that has to be consumed rather than read: the
// replay history a resume produced.
//
// It deliberately does not mirror the session into its own copy of the
// conversation. `aiStore.messages` is the live chat; the session is the durable
// record of it. Two copies of a conversation in one process is how they drift, so
// this store sends turns to the main process and reads the session back when it
// needs to.

import { create } from "zustand";
import { useWorkspaceStore } from "./workspaceStore";
import type { AiSession, AiSessionHistoryTurn, AiSessionSummary } from "../types/electron";

export interface SessionStoreState {
  sessions: AiSessionSummary[];
  activeId: string | null;
  /** The open session, or `null` when none is open. */
  current: AiSession | null;
  /**
   * The conversation a resumed session should replay into the next run.
   *
   * Consumed, not read: `takeResumeHistory()` hands it over once and clears it,
   * because once a run has been started with it the history is *in* that run and
   * sending it again would duplicate the whole conversation in the prompt.
   */
  resumeHistory: AiSessionHistoryTurn[];
  /** A session that could not be read, and where its bytes were moved to. */
  corrupted: AiSessionSummary | null;
  error: string | null;
  notice: string | null;
  busy: boolean;
  listening: boolean;

  startListening: () => void;
  /**
   * Re-read the list, and open whatever was last open.
   *
   * `createIfEmpty` exists because of a recursion this signature was written to kill.
   * `refresh` used to create a session when the store was empty, and `create` ended by
   * calling `refresh`. If a create succeeded but the list still came back empty, that
   * is `refresh → create → refresh → create`, unbounded — and because every iteration
   * mints and writes a *new* session file, it filled the user's profile with junk
   * before anything noticed. The store is now bounded, so it stopped at 200 files
   * instead of running forever, which is not a fix, it is a smaller symptom.
   *
   * Anything that already has a session therefore refreshes with the flag off.
   */
  refresh: (opts?: { createIfEmpty?: boolean }) => Promise<void>;
  create: (name?: string) => Promise<void>;
  open: (id: string) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
  setStatus: (id: string, status: "open" | "closed") => Promise<void>;
  remove: (id: string) => Promise<void>;
  fork: (id: string) => Promise<void>;
  /** Called by the chat store for each finished message. */
  recordTurn: (role: "user" | "assistant", text: string, turnId?: string) => Promise<void>;
  /** Called by the agent store when a run files itself against a session. */
  noteRunFiled: (sessionId: string | null | undefined) => Promise<void>;
  takeResumeHistory: () => AiSessionHistoryTurn[];
  clearError: () => void;
  dismissCorrupted: () => void;
}

function msg(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : typeof err === "string" ? err : fallback;
}

export const useSessionStore = create<SessionStoreState>((set, get) => ({
  sessions: [],
  activeId: null,
  current: null,
  resumeHistory: [],
  corrupted: null,
  error: null,
  notice: null,
  busy: false,
  listening: false,

  startListening: () => {
    if (get().listening) return;
    set({ listening: true });
    window.closeCode.onAiSessionChanged((payload) => {
      set({ sessions: payload.sessions, activeId: payload.activeId });
    });
    void get().refresh();
  },

  refresh: async (opts) => {
    const createIfEmpty = opts?.createIfEmpty ?? true;
    try {
      const res = await window.closeCode.aiSessionsList();
      if (!res.ok) {
        set({ error: res.error ?? "The session list could not be read." });
        return;
      }
      const sessions = res.sessions ?? [];
      set({ sessions });

      // Landing back where the user left off is the acceptance criterion, so the
      // last-active session is opened automatically. With *nothing* stored yet,
      // one is created — a first launch should not open onto an empty bar and
      // leave the user to discover that sessions exist by reading the docs.
      const res2 = await window.closeCode.aiSessionOpen();
      if (res2.ok && res2.session) {
        set({
          current: res2.session,
          activeId: res2.session.id,
          resumeHistory: [],
          notice: `Resumed “${res2.session.name}”.`,
        });
        return;
      }
      if (res2.summary?.corrupted) {
        set({ corrupted: res2.summary, current: null, activeId: null });
        return;
      }
      if (sessions.length === 0) {
        if (!createIfEmpty) {
          // Asked not to create one, and there is nothing to open. Say so rather than
          // looping, and rather than inventing a session nobody asked for.
          set({ current: null, activeId: null, resumeHistory: [] });
          return;
        }
        await get().create();
        return;
      }
      set({ current: null, activeId: null, resumeHistory: [] });
    } catch (err) {
      set({ error: msg(err, "The session list could not be read.") });
    }
  },

  create: async (name) => {
    set({ busy: true, error: null });
    try {
      const root = readWorkspaceRoot();
      const res = await window.closeCode.aiSessionCreate(
        name === undefined ? { workspace: root } : { name, workspace: root },
      );
      set({ busy: false });
      if (!res.ok || !res.session) {
        set({ error: res.error ?? "The session could not be created." });
        return;
      }
      set({
        current: res.session,
        activeId: res.session.id,
        resumeHistory: [],
        corrupted: null,
        notice: `Started “${res.session.name}”.`,
      });
      // No `refresh()` here, and its absence was a bug once. Every mutating handler in
      // the main process broadcasts `session:ai:changed` with the rebuilt list, so the
      // list was already up to date by the time this returned — the refresh was a
      // second round trip for nothing. It was worse than useless: a refresh that found
      // no active session cleared `current`, so a session the user had just created
      // could disappear from under them. And because `refresh` creates a session when
      // the store is empty, the pair could also recurse without end, writing a new
      // session file every iteration. See the note on `refresh`.
    } catch (err) {
      set({ busy: false, error: msg(err, "The session could not be created.") });
    }
  },

  open: async (id) => {
    set({ busy: true, error: null });
    try {
      const res = await window.closeCode.aiSessionOpen({ id });
      set({ busy: false });
      if (!res.ok || !res.session) {
        if (res.summary?.corrupted) {
          set({ corrupted: res.summary, current: null, activeId: null });
        }
        set({ error: res.error ?? "That session could not be opened." });
        // A failed open must not quietly invent a session to stand in for the one the
        // user asked for.
        await get().refresh({ createIfEmpty: false });
        return;
      }
      set({
        current: res.session,
        activeId: res.session.id,
        resumeHistory: res.history ?? [],
        corrupted: null,
        notice: `Opened “${res.session.name}” — ${res.session.runs.length} run(s), ${res.session.turns.length} turn(s) restored.`,
      });
    } catch (err) {
      set({ busy: false, error: msg(err, "That session could not be opened.") });
    }
  },

  rename: async (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) {
      set({ error: "A session name cannot be empty." });
      return;
    }
    try {
      const res = await window.closeCode.aiSessionUpdate({ id, name: trimmed });
      if (!res.ok) {
        set({ error: res.error ?? "The session could not be renamed." });
        return;
      }
      set((s) => ({
        sessions: res.sessions ?? s.sessions,
        current: s.current && s.current.id === id ? { ...s.current, name: trimmed } : s.current,
        notice: `Renamed to “${trimmed}”.`,
      }));
    } catch (err) {
      set({ error: msg(err, "The session could not be renamed.") });
    }
  },

  setStatus: async (id, status) => {
    try {
      const res = await window.closeCode.aiSessionUpdate({ id, status });
      if (!res.ok) {
        set({ error: res.error ?? "The session could not be closed." });
        return;
      }
      set((s) => ({
        sessions: res.sessions ?? s.sessions,
        current: s.current && s.current.id === id ? { ...s.current, status } : s.current,
        notice: status === "closed" ? "Session closed. It is kept, not deleted." : "Session reopened.",
      }));
    } catch (err) {
      set({ error: msg(err, "The session could not be closed.") });
    }
  },

  remove: async (id) => {
    try {
      const res = await window.closeCode.aiSessionDelete({ id });
      if (!res.ok) {
        set({ error: res.error ?? "The session could not be deleted." });
        await get().refresh({ createIfEmpty: false });
        return;
      }
      set((s) => ({
        sessions: res.sessions ?? [],
        ...(s.activeId === id ? { current: null, activeId: null, resumeHistory: [] } : {}),
        notice: "Session deleted.",
      }));
      if (get().activeId === null) await get().refresh({ createIfEmpty: false });
    } catch (err) {
      set({ error: msg(err, "The session could not be deleted.") });
    }
  },

  fork: async (id) => {
    set({ busy: true, error: null });
    try {
      const res = await window.closeCode.aiSessionFork({ id });
      set({ busy: false });
      if (!res.ok || !res.session) {
        set({ error: res.error ?? "The session could not be forked." });
        return;
      }
      set({
        current: res.session,
        activeId: res.session.id,
        resumeHistory: res.history ?? [],
        notice: `Forked to “${res.session.name}”. The original is untouched.`,
      });
      // The list arrives by push, as it does for every other operation. See `create`.
    } catch (err) {
      set({ busy: false, error: msg(err, "The session could not be forked.") });
    }
  },

  recordTurn: async (role, text, turnId) => {
    const id = get().activeId;
    if (!id) return;
    // A closed session is not a write target: "close" means done, and quietly
    // appending to it anyway would make the word mean nothing.
    if (get().current && get().current?.id === id && get().current?.status === "closed") return;
    try {
      await window.closeCode.aiSessionTurn({ id, role, text, ...(turnId ? { turnId } : {}) });
    } catch {
      // Losing one chat turn is not worth interrupting a conversation with an
      // error banner; the run and the session file are unaffected.
    }
  },

  noteRunFiled: async (sessionId) => {
    const id = sessionId ?? get().activeId;
    if (!id) return;
    try {
      const res = await window.closeCode.aiSessionOpen({ id, activate: false });
      if (!res.ok) return;
      set((s) => ({
        current: res.session ?? s.current,
        // The replay history has been spent by the run that consumed it.
        resumeHistory: s.current?.id === id ? [] : s.resumeHistory,
      }));
      // `sessions` arrived by push when the run was filed, so this re-read is only
      // here for `current` — which the `aiSessionOpen` above has just refreshed.
    } catch {
      // same reasoning as recordTurn
    }
  },

  takeResumeHistory: () => {
    const history = get().resumeHistory;
    if (history.length > 0) set({ resumeHistory: [] });
    return history;
  },

  clearError: () => set({ error: null }),
  dismissCorrupted: () => set({ corrupted: null }),
}));

/**
 * The workspace root, read from the workspace store.
 *
 * A session records *which project* a conversation belongs to. It never copies a
 * file out of it — only the path is stored, so opening a session on another
 * machine cannot leak source, and a session cannot go stale because a file
 * changed underneath it.
 *
 * Imported directly rather than threaded through as a parameter because
 * `workspaceStore` imports nothing but zustand, so this is not a cycle.
 */
function readWorkspaceRoot(): string | null {
  try {
    return useWorkspaceStore.getState().root ?? null;
  } catch {
    // The store may not be constructed yet on a cold launch. A session without a
    // workspace is still a valid session; it just does not claim to be about one.
    return null;
  }
}