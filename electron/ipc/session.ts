// Phase 17: session + recovery + error logging IPC.
//   session:save       — renderer writes full open state
//   session:load       — renderer reads last saved state
//   session:clear      — wipe saved state (new project)
//   session:recovery   — check for a crash-recovery offer
//   session:accept-recovery — restore the crashed session
//   session:dismiss-recovery — discard the recovery offer
//   error:log          — append an error entry
//   error:load         — read recent error entries
import { BrowserWindow, ipcMain } from "electron";
import {
  loadSession,
  saveSession,
  clearSession,
  loadRecovery,
  clearRecovery,
  writeRecovery,
} from "../services/session";
import { logError, loadErrors } from "../services/errorLog";
import {
  appendTurn,
  createSession,
  deleteSession,
  forkSession,
  getActiveSessionId,
  listSessions,
  loadSessionById,
  renameSession,
  resumeHistory,
  setActiveSessionId,
  setSessionStatus,
  type SessionSummary,
} from "../services/aiSessions";

/** Best-effort fan-out. A window that closed mid-send is not an error worth raising. */
function sendToAllWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch {
      // the window went away mid-broadcast
    }
  }
}

export function registerSessionIpc(): void {
  ipcMain.handle("session:save", async (_e, session: unknown) => {
    try {
      saveSession(session as ReturnType<typeof import("../services/session").buildSession>);
      return { ok: true };
    } catch (err) {
      logError({ timestamp: Date.now(), process: "main", type: "save",
        message: "session:save failed",
        stack: err instanceof Error ? err.message : String(err) });
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("session:load", () => loadSession());

  ipcMain.handle("session:clear", () => { clearSession(); return { ok: true }; });

  ipcMain.handle("session:recovery", () => {
    const r = loadRecovery();
    return r
      ? { hasRecovery: true, root: r.root, tabs: r.tabs.length, activePath: r.activePath }
      : { hasRecovery: false };
  });

  ipcMain.handle("session:accept-recovery", () => {
    const r = loadRecovery();
    clearRecovery();
    return r ? { ok: true, session: r } : { ok: true, session: null };
  });

  ipcMain.handle("session:dismiss-recovery", () => {
    clearRecovery();
    return { ok: true };
  });

  ipcMain.handle("error:log", (_e, entry: { process: "main" | "renderer"; type: string; message: string; stack?: string; context?: Record<string, unknown> }) => {
    logError({ timestamp: Date.now(), process: entry.process as "main" | "renderer", type: entry.type as any, message: entry.message, stack: entry.stack, context: entry.context });
    return { ok: true };
  });

  ipcMain.handle("error:load", (_e, since?: number) => loadErrors(since));

  registerAiSessionIpc();
}

// ---------------------------------------------------------------------------
// Phase 27 — persistent AI sessions
// ---------------------------------------------------------------------------

/**
 * The AI-session half of session IPC.
 *
 * Separate from the workspace-session handlers above on purpose: those store open
 * tabs and are written every 15 seconds by a heartbeat, these store conversations
 * and are written on real events. Merging them would have meant one file with two
 * lifecycles, two retention policies and two corruption stories.
 *
 * Note what `resume` is *not*: it does not restart a run or replay tool calls. It
 * returns the conversation in the shape `AgentRunSpec.history` already declared and
 * nothing ever populated, so the next run continues from it. A session is a record
 * of what was said and done, not a replay of side effects — replaying a
 * `write_file` because someone reopened a conversation would be a genuinely
 * destructive thing to build.
 */
function registerAiSessionIpc(): void {
  ipcMain.handle("session:ai:list", () => ({ ok: true, sessions: listSessions() }));

  ipcMain.handle(
    "session:ai:create",
    (_e, opts?: { name?: string; workspace?: string | null }) => {
      const created = createSession({
        ...(typeof opts?.name === "string" ? { name: opts.name } : {}),
        ...(typeof opts?.workspace === "string" ? { workspace: opts.workspace } : {}),
      });
      if (!created.ok) return { ok: false, error: created.error };
      broadcastAiSessionChanged(created.session.id);
      return { ok: true, session: created.session, history: [] as Array<{ role: "user" | "assistant"; content: string }> };
    },
  );

  ipcMain.handle(
    "session:ai:open",
    (_e, opts?: { id?: string; activate?: boolean }) => {
      // No id means "the session I was last in", which is what a launch wants.
      const id = typeof opts?.id === "string" && opts.id ? opts.id : getActiveSessionId();
      if (!id) return { ok: false, error: "There is no session to open." };
      const read = loadSessionById(id);
      if (!read.ok) {
        // A session that cannot be read is worth reporting as such rather than as
        // "no sessions" — the difference is the difference between an empty app
        // and a lost conversation.
        if (read.summary) broadcastAiSessionChanged(undefined);
        return { ok: false, error: read.error, summary: read.summary };
      }
      if (opts?.activate !== false) setActiveSessionId(id);
      broadcastAiSessionChanged(id);
      return { ok: true, session: read.session, history: resumeHistory(read.session) };
    },
  );

  ipcMain.handle(
    "session:ai:update",
    (_e, opts: { id?: string; name?: string; status?: "open" | "closed" }) => {
      if (typeof opts?.id !== "string") return { ok: false, error: "Which session?" };
      if (typeof opts.name === "string") {
        const renamed = renameSession(opts.id, opts.name);
        if (!renamed.ok) return { ok: false, error: renamed.error };
      }
      if (opts.status === "open" || opts.status === "closed") {
        const closed = setSessionStatus(opts.id, opts.status);
        if (!closed.ok) return { ok: false, error: closed.error };
      }
      broadcastAiSessionChanged(opts.id);
      return { ok: true, sessions: listSessions() };
    },
  );

  ipcMain.handle("session:ai:delete", (_e, opts: { id?: string }) => {
    if (typeof opts?.id !== "string") return { ok: false, error: "Which session?" };
    const removed = deleteSession(opts.id);
    if (!removed.ok) return { ok: false, error: removed.error };
    broadcastAiSessionChanged(undefined);
    return { ok: true, sessions: listSessions() };
  });

  ipcMain.handle("session:ai:fork", (_e, opts: { id?: string; name?: string }) => {
    if (typeof opts?.id !== "string") return { ok: false, error: "Which session?" };
    const forked = forkSession(opts.id, opts.name);
    if (!forked.ok) return { ok: false, error: forked.error };
    setActiveSessionId(forked.session.id);
    broadcastAiSessionChanged(forked.session.id);
    return { ok: true, session: forked.session, history: resumeHistory(forked.session) };
  });

  ipcMain.handle(
    "session:ai:turn",
    (_e, opts: { id?: string; role?: string; text?: string; turnId?: string }) => {
      if (typeof opts?.id !== "string") return { ok: false, error: "Which session?" };
      if (typeof opts.text !== "string" || !opts.text.trim()) {
        return { ok: false, error: "An empty turn is not worth storing." };
      }
      const written = appendTurn(opts.id, {
        id: opts.turnId ?? "",
        role: opts.role === "assistant" ? "assistant" : "user",
        text: opts.text,
        at: Date.now(),
      });
      if (!written.ok) return { ok: false, error: written.error };
      // A turn changes the session's turn count, its size and its position in the
      // list, so the push every other session operation sends is sent here too.
      // Without it a user's own conversation grows while the bar beside it claims
      // otherwise — and the count in that bar is the number they would trust.
      broadcastAiSessionChanged();
      return { ok: true, name: written.name };
    },
  );
}

/**
 * Tell every window the session list changed.
 *
 * A push rather than a poll because the two windows of a real app can both edit
 * sessions, and a list that only refreshes when its own window changed is a list
 * that lies to one of them.
 */
export function broadcastAiSessionChanged(activeId?: string): void {
  let sessions: SessionSummary[] = [];
  try {
    sessions = listSessions();
  } catch {
    sessions = [];
  }
  sendToAllWindows("session:ai:changed", {
    activeId: activeId === undefined ? getActiveSessionId() : activeId,
    sessions,
  });
}
