// Phase 17: central error logging. Every error that surfaces anywhere in
// the app is appended here so it is never silently lost. Format is one JSON
// line per entry, written with fs.appendFile (safe for concurrent calls
// from different IPC handlers).
import fs from "fs";
import path from "path";
import { app } from "electron";

export type ErrorEntry = {
  timestamp: number;
  process: "main" | "renderer";
  type: "uncaught" | "unhandled" | "crash" | "render-process-gone"
    | "child-process-gone" | "ipc" | "save" | "other";
  message: string;
  stack?: string;
  /** Extra diagnostic context, e.g. { path, tabCount } */
  context?: Record<string, unknown>;
};

const LOG_PATH = path.join(app.getPath("userData"), "errors.log");
const MAX_LINES = 2000; // rotate: keep last N entries

function rotateIfNeeded(): void {
  try {
    const raw = fs.readFileSync(LOG_PATH, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    if (lines.length > MAX_LINES) {
      fs.writeFileSync(LOG_PATH, lines.slice(-MAX_LINES).join("\n") + "\n", "utf-8");
    }
  } catch {}
}

export function logError(entry: ErrorEntry): void {
  try {
    rotateIfNeeded();
    fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // logging must never itself throw — best effort
  }
}

export function loadErrors(since?: number): ErrorEntry[] {
  try {
    const raw = fs.readFileSync(LOG_PATH, "utf-8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as ErrorEntry)
      .filter((e) => !since || e.timestamp >= since);
  } catch {
    return [];
  }
}
