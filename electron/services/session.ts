// Phase 17: session persistence. The renderer writes its full open-state
// (workspace root + open tabs + active tab) to disk on every change so that
// a crash or unexpected quit can be recovered. This module is the main-
// process side: it reads/writes ~/.closecode/session.json and the
// recovery file.
import fs from "fs";
import path from "path";
import { app } from "electron";

export interface SessionTab {
  path: string;
  name: string;
  size: number;
  dirty: boolean;
}

export interface AppSession {
  root: string | null;
  name: string;
  tabs: SessionTab[];
  activePath: string | null;
  openedAt: number;
}

const SESSION_PATH = path.join(app.getPath("userData"), "session.json");
// Files that the renderer reported as dirty when it died. Kept so the
// restore flow can warn the user and pre-fill a recovery offer.
const RECOVERY_PATH = path.join(app.getPath("userData"), "recovery.json");

export function loadSession(): AppSession | null {
  try {
    const raw = fs.readFileSync(SESSION_PATH, "utf-8");
    return JSON.parse(raw) as AppSession;
  } catch {
    return null;
  }
}

export function saveSession(session: AppSession): void {
  fs.writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2), "utf-8");
}

export function clearSession(): void {
  fs.writeFileSync(SESSION_PATH, "null", "utf-8");
}

export function getRecoveryPath(): string {
  return RECOVERY_PATH;
}

export function loadRecovery(): AppSession | null {
  try {
    const raw = fs.readFileSync(RECOVERY_PATH, "utf-8");
    const s = JSON.parse(raw) as AppSession;
    // Only trust a recovery if it was written recently (last 5 minutes)
    // and has at least one dirty tab — a stale crash from days ago should
    // not interrupt a fresh start.
    if (Date.now() - s.openedAt < 5 * 60 * 1000 && s.tabs.some((t) => t.dirty)) {
      return s;
    }
  } catch {
    // no recovery file, or corrupt — nothing to recover
  }
  return null;
}

export function writeRecovery(session: AppSession): void {
  fs.writeFileSync(RECOVERY_PATH, JSON.stringify(session, null, 2), "utf-8");
}

export function clearRecovery(): void {
  fs.writeFileSync(RECOVERY_PATH, "null", "utf-8");
}

/** Build a session from the live renderer state. `tabs` must already be
  serialisable (path, name, size, dirty) and `activePath` the current tab. */
export function buildSession(
  root: string | null,
  name: string,
  tabs: SessionTab[],
  activePath: string | null
): AppSession {
  return { root, name, tabs, activePath, openedAt: Date.now() };
}
