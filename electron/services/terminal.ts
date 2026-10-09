import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { spawn as cpSpawn, type ChildProcess } from "child_process";

// Try to load node-pty, fallback to child_process if not available or fails to load for Electron
let pty: typeof import("node-pty") | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  pty = require("node-pty") as typeof import("node-pty");
} catch {
  pty = null;
}

export interface TerminalSession {
  id: string;
  shell: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  // pty or child process
  pty?: import("node-pty").IPty;
  proc?: ChildProcess;
  isPty: boolean;
}

const sessions = new Map<string, TerminalSession>();
let idCounter = 0;

function getDefaultShell(): { shell: string; args: string[] } {
  const platform = process.platform;
  if (platform === "win32") {
    // Prefer pwsh, then powershell, then cmd
    const progFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const pwshPath = path.join(progFiles, "PowerShell", "7", "pwsh.exe");
    if (fs.existsSync(pwshPath)) return { shell: pwshPath, args: [] };
    // Check for pwsh in PATH via where
    // For now, try powershell.exe which is always present on Windows
    const systemRoot = process.env["SystemRoot"] ?? "C:\\Windows";
    const psPath = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (fs.existsSync(psPath)) return { shell: psPath, args: ["-NoLogo"] };
    return { shell: process.env["COMSPEC"] ?? "cmd.exe", args: [] };
  } else {
    const shell = process.env["SHELL"] ?? "/bin/bash";
    // Use login shell? Just use shell
    return { shell, args: ["-l"] };
  }
}

function getDefaultCwd(explicitCwd?: string): string {
  if (explicitCwd && fs.existsSync(explicitCwd) && fs.statSync(explicitCwd).isDirectory()) {
    return explicitCwd;
  }
  // Try workspace root via env? Renderer will pass workspace root
  // Fallback to homedir
  return os.homedir();
}

export function createTerminal(opts: { cwd?: string; shell?: string; args?: string[]; cols?: number; rows?: number }): TerminalSession {
  const id = `term-${++idCounter}-${Date.now()}`;
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;
  const cwd = getDefaultCwd(opts.cwd);
  let shell = opts.shell ?? "";
  let args: string[] = opts.args ?? [];
  if (!shell) {
    const def = getDefaultShell();
    shell = def.shell;
    args = def.args;
  }

  const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<string, string>;

  let session: TerminalSession;

  if (pty) {
    try {
      const p = pty.spawn(shell, args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env,
      });
      session = { id, shell, args, cwd, cols, rows, pty: p, isPty: true };
    } catch (err) {
      console.error("pty.spawn failed, falling back to child_process:", err);
      // Fallback
      const proc = cpSpawn(shell, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      session = { id, shell, args, cwd, cols, rows, proc, isPty: false };
    }
  } else {
    const proc = cpSpawn(shell, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    session = { id, shell, args, cwd, cols, rows, proc, isPty: false };
  }

  sessions.set(id, session);
  return session;
}

export function getSession(id: string): TerminalSession | undefined {
  return sessions.get(id);
}

export function listSessions(): Array<{ id: string; shell: string; cwd: string; cols: number; rows: number; isPty: boolean }> {
  return [...sessions.values()].map((s) => ({ id: s.id, shell: s.shell, cwd: s.cwd, cols: s.cols, rows: s.rows, isPty: s.isPty }));
}

export function writeToTerminal(id: string, data: string): void {
  const s = sessions.get(id);
  if (!s) throw new Error(`Terminal ${id} not found`);
  if (s.isPty && s.pty) {
    s.pty.write(data);
  } else if (s.proc?.stdin?.writable) {
    s.proc.stdin.write(data);
  } else {
    throw new Error(`Terminal ${id} stdin not writable`);
  }
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  const s = sessions.get(id);
  if (!s) throw new Error(`Terminal ${id} not found`);
  s.cols = cols;
  s.rows = rows;
  if (s.isPty && s.pty) {
    s.pty.resize(cols, rows);
  }
  // For child_process, no real resize, just store
}

export function killTerminal(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  if (s.isPty && s.pty) {
    s.pty.kill();
  } else if (s.proc) {
    try { s.proc.kill(); } catch {}
  }
  sessions.delete(id);
}

export function killAllTerminals(): void {
  for (const id of [...sessions.keys()]) killTerminal(id);
}

export function restartTerminal(id: string): TerminalSession | null {
  const old = sessions.get(id);
  if (!old) return null;
  const { cwd, shell, args, cols, rows } = old;
  killTerminal(id);
  // Create new with same id? Use new id for simplicity, but keep old id for UI consistency? Generate new id
  const next = createTerminal({ cwd, shell, args, cols, rows });
  // Keep old id mapping for UI? We'll return new session and let caller handle id change
  // For now, create new and delete old mapping already, return new
  return next;
}

export function clearTerminal(id: string): void {
  // Clear is handled in renderer (xterm clear), not pty
  // No-op in main, just for completeness
}

export function onTerminalData(callback: (id: string, data: string) => void): void {
  // This is called once to set up listeners for all sessions
  // We need to attach to each new session when created
  // Instead, we attach per-session when created via helper
}

export function attachDataListeners(session: TerminalSession, onData: (id: string, data: string) => void, onExit: (id: string, code: number) => void): void {
  if (session.isPty && session.pty) {
    session.pty.onData((data: string) => onData(session.id, data));
    session.pty.onExit(({ exitCode }) => {
      onExit(session.id, exitCode);
      sessions.delete(session.id);
    });
  } else if (session.proc) {
    session.proc.stdout?.on("data", (d: Buffer) => onData(session.id, d.toString()));
    session.proc.stderr?.on("data", (d: Buffer) => onData(session.id, d.toString()));
    session.proc.on("exit", (code) => {
      onExit(session.id, code ?? 0);
      sessions.delete(session.id);
    });
    session.proc.on("error", (err) => {
      onData(session.id, `\r\n[Terminal error: ${String(err)}]\r\n`);
    });
  }
}

// Cleanup on app quit
export function disposeAll(): void {
  killAllTerminals();
}
