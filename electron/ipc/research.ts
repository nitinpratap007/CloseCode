// Close Code — web research IPC (Phase 32)
//
// The panel's window onto the research store and its one write path (starting
// a research run). Everything the pipeline does is real network and real model
// work; the only decision this layer makes that the pipeline does not is the
// `web` permission gate, and it makes it HERE in main where it can be enforced
// rather than displayed. A `deny` mode refuses before a single request is
// made; an `ask` mode queues the record and expects a `research:respond`; an
// `allow` mode starts the pipeline immediately. The record that matters is
// always the one on disk — the response to `research:start` is a receipt, not
// the authority.

import { BrowserWindow, ipcMain } from "electron";
import { getApiKey, loadAiConfig, WEB_SEARCH_KEY_ID } from "../services/aiSettings";
import {
  createResearchRecord,
  getResearchRecord,
  listResearchRecords,
  MAX_FOCUS_URLS,
  MAX_QUESTION,
  normalizeResearchUrl,
  researchPermissionDecision,
  saveResearchRecord,
  type ResearchRecord,
} from "../services/webResearch";
import { runResearchRecord } from "../services/agent/instance";

/** Records awaiting a user yes/no because `web` is in `ask` mode. */
const pendingApprovals = new Map<string, number>();

function fail(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

function broadcast(record: ResearchRecord): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send("research:event", { type: "record", record });
    } catch {
      // the window went away mid-broadcast
    }
  }
}

export function registerResearchIpc(): void {
  ipcMain.handle("research:start", (_e, payload: unknown) => {
    try {
      const p = (payload ?? {}) as Record<string, unknown>;
      const question = typeof p.question === "string" ? p.question.trim() : "";
      if (!question) return fail("Enter a research question first.");
      if (question.length > MAX_QUESTION) return fail(`The question is too long (max ${MAX_QUESTION} characters).`);
      const focusUrls = Array.isArray(p.focusUrls)
        ? p.focusUrls.filter((u): u is string => typeof u === "string" && normalizeResearchUrl(u) !== null).slice(0, MAX_FOCUS_URLS)
        : [];

      // The gate, decided in main: an `ask` mode can be raised here, but it can
      // never be skipped by the renderer, because the renderer never sees this
      // branch — it sees the receipt it asked for.
      const decision = researchPermissionDecision(loadAiConfig().permissions?.web ?? "ask");
      const record = createResearchRecord(
        question,
        focusUrls,
        decision.action === "ask" ? "ask" : decision.action === "refuse" ? "deny" : "allow",
        Date.now(),
      );

      if (decision.action === "refuse") {
        record.status = "refused";
        record.error = { code: "refused", message: "Web access is set to deny, so this research was not started." };
        record.completedAt = Date.now();
        saveResearchRecord(record);
        broadcast(record);
        return { ok: true, record, refused: true };
      }

      if (decision.action === "ask") {
        record.awaitingApproval = true;
        saveResearchRecord(record);
        broadcast(record);
        pendingApprovals.set(record.id, Date.now());
        return { ok: true, record, awaitingApproval: true };
      }

      saveResearchRecord(record);
      broadcast(record);
      void runResearchRecord(record, new AbortController().signal);
      return { ok: true, record };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("research:respond", (_e, payload: unknown) => {
    try {
      const p = (payload ?? {}) as Record<string, unknown>;
      const id = typeof p.id === "string" ? p.id : "";
      if (!id || !pendingApprovals.has(id)) return fail("There is no pending approval for that research request.");
      pendingApprovals.delete(id);
      const record = getResearchRecord(id);
      if (!record) return fail("That research request is no longer stored.");
      record.awaitingApproval = false;
      if (p.approved === true) {
        saveResearchRecord(record);
        broadcast(record);
        void runResearchRecord(record, new AbortController().signal);
        return { ok: true, record };
      }
      record.status = "refused";
      record.error = { code: "refused", message: "The research request was declined." };
      record.completedAt = Date.now();
      saveResearchRecord(record);
      broadcast(record);
      return { ok: true, record };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("research:list", () => {
    try {
      return { ok: true, records: listResearchRecords() };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("research:get", (_e, payload: unknown) => {
    try {
      const id = typeof (payload as Record<string, unknown>)?.id === "string" ? ((payload as Record<string, unknown>).id as string) : "";
      const record = getResearchRecord(id);
      return record ? { ok: true, record } : fail("No such research record.");
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });
}