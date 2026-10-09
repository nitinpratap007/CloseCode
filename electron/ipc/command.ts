// Close Code — Command Center & Autonomous Builder IPC (Phase 33)
//
// The panel's window onto the command catalog, the command runner, and the
// build-record store. Nothing here executes commands by hand: `command:run`
// dispatches to the command center, which starts a *real agent run* through the
// same runtime and gates as the agent panel. `build:start` is the receipt for a
// record whose pipeline (plan → approve → build → measure) runs in main and is
// broadcast over `build:event` on every transition, so the panel never polls.
//
// The verification commands the pipeline runs are the real project commands
// (`npm run <script>`, the project's own `tsc --noEmit`) executed here in main
// with real exit codes and bounded output — the record's final status is
// decided from those, never from the model's prose.

import { ipcMain, BrowserWindow } from "electron";
import { execFile } from "child_process";
import path from "path";
import fs from "fs";
import { app } from "electron";
import { getAgentRuntime, buildRunSpec, setPermissionPolicyDir } from "../services/agent/instance";
import { loadPermissionPolicy } from "../services/permissionStore";
import { resolveCapabilityDetailed, type Capability } from "../services/agent/permissions";
import { loadAiConfig } from "../services/aiSettings";
import { getStatus } from "../services/git";
import { createCommandCenter, applyTarget, type CommandCatalogEntry } from "../services/commandCenter";
import {
  approveBuild,
  cancelBuild,
  createBuildRecord,
  getBuildRecord,
  listBuildRecords,
  MAX_NOTE,
  MAX_REQUEST,
  runBuildPipeline,
  saveBuildRecord,
  setBuildUserDataDir,
  type BuildRecord,
  type BuildRunnerDeps,
  type BuildEvidence,
} from "../services/builds";
import type { AgentResult } from "../services/agent/types";

function fail(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

function broadcast(record: BuildRecord): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send("build:event", { type: "record", record });
    } catch {
      // the window went away mid-broadcast
    }
  }
}

function userDataDir(): string {
  const dir = app.getPath("userData");
  setPermissionPolicyDir(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Outer-verification command runner (real commands, real exit codes)
// ---------------------------------------------------------------------------

const NPM_EXECUTABLE = process.platform === "win32" ? "npm.cmd" : "npm";
const NPM_NEEDS_SHELL = process.platform === "win32";
const VERIFY_TOOLS = new Set(["run_build", "run_tests", "type_diagnostics"]);
const MAX_NPM_OUTPUT = 8 * 1024 * 1024;

function clip(output: string): string {
  return output.slice(0, 4000);
}

function runNpmScript(workspace: string, script: string): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve) => {
    try {
      execFile(
        NPM_EXECUTABLE,
        ["run", script],
        {
          cwd: workspace,
          timeout: 10 * 60_000,
          maxBuffer: MAX_NPM_OUTPUT,
          windowsHide: true,
          shell: NPM_NEEDS_SHELL,
        },
        (err, stdout, stderr) => {
          const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : null) : 0;
          resolve({ exitCode: code, output: clip((stdout + (stderr ? `\n${stderr}` : "")).trim()) });
        },
      );
    } catch {
      resolve({ exitCode: null, output: "npm could not be started." });
    }
  });
}

function runTsc(workspace: string): Promise<{ exitCode: number | null; output: string }> {
  const tsc = path.join(workspace, "node_modules", "typescript", "bin", "tsc");
  if (!fs.existsSync(tsc)) {
    return Promise.resolve({ exitCode: null, output: "No local TypeScript compiler in node_modules." });
  }
  return new Promise((resolve) => {
    try {
      execFile(
        process.execPath,
        [tsc, "--noEmit", "--pretty", "false"],
        { cwd: workspace, timeout: 5 * 60_000, maxBuffer: MAX_NPM_OUTPUT, windowsHide: true },
        (err, stdout, stderr) => {
          const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : null) : 0;
          resolve({ exitCode: code, output: clip((stdout + (stderr ? `\n${stderr}` : "")).trim()) });
        },
      );
    } catch {
      resolve({ exitCode: null, output: "tsc could not be started." });
    }
  });
}

function readScripts(workspace: string): Record<string, string> | null {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(workspace, "package.json"), "utf-8"));
    return manifest && typeof manifest === "object" && typeof (manifest as Record<string, unknown>).scripts === "object"
      ? (manifest as { scripts: Record<string, string> }).scripts
      : {};
  } catch {
    return null;
  }
}

function readGitChanges(workspace: string): string[] | null {
  try {
    const st = getStatus(workspace);
    if (!st) return null;
    return st.files.map((f) => f.path).sort();
  } catch {
    return null;
  }
}

function collectEvidence(runId: string): BuildEvidence {
  const run = getAgentRuntime().getRun(runId);
  const tools: BuildEvidence["tools"] = [];
  for (const t of run?.trace ?? []) {
    if (t.kind !== "tool" || !t.granted || !t.tool || !t.text) continue;
    if (!VERIFY_TOOLS.has(t.tool)) continue;
    const firstLine = t.text.split("\n")[0].trim().slice(0, 200);
    if (!firstLine) continue;
    tools.push({ tool: t.tool, outcome: firstLine });
  }
  return { tools };
}

/** The shared runner: real agent runs over the singleton runtime. */
async function startAndAwaitRun(opts: {
  agentId: string;
  task: string;
  workspace: string | null;
  sessionId?: string | null;
}): Promise<{ runId: string; result: AgentResult; evidence: BuildEvidence }> {
  const spec = buildRunSpec({
    agentId: opts.agentId,
    task: opts.task,
    workspace: opts.workspace,
    sessionId: opts.sessionId ?? null,
  });
  const { runId, done } = getAgentRuntime().start(spec);
  const result = await done;
  return { runId, result, evidence: collectEvidence(runId) };
}

function terminalAllowed(workspace: string | null): boolean {
  const cfg = loadAiConfig();
  const floor = cfg.permissions?.terminal;
  if (floor === "deny") return false;
  const policy = loadPermissionPolicy(userDataDir());
  const resolved = resolveCapabilityDetailed(policy, "shell.exec" as Capability, {
    workspace: workspace ?? null,
    agentId: "builder",
  });
  // `ask` too: an unattended verification command may not silently await
  // approval — the record must know the command was not run, not stall forever.
  return resolved.mode === "allow";
}

function buildDeps(): BuildRunnerDeps {
  return {
    runAgent: startAndAwaitRun,
    cancelRun: (runId: string) => getAgentRuntime().cancel(runId),
    terminalAllowed: () => terminalAllowed(null),
    readScripts,
    runScript: runNpmScript,
    runTsc,
    readGitChanges,
    now: () => Date.now(),
  };
}

const runningControllers = new Map<string, AbortController>();

export function registerCommandIpc(): void {
  const commandCenter = createCommandCenter({ startRun: startAndAwaitRun });

  ipcMain.handle("command:catalog", () => {
    try {
      return { ok: true, result: commandCenter.catalog() };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("command:run", (_e, payload: unknown) => {
    try {
      const p = (payload ?? {}) as Record<string, unknown>;
      const request = typeof p.request === "string" ? p.request : "";
      const workspace = typeof p.workspace === "string" ? p.workspace : null;
      const sessionId = typeof p.sessionId === "string" ? p.sessionId : undefined;
      return commandCenter.run(request, { workspace, sessionId }).then(
        (result) => ({ ok: true, result }),
        (err) => fail(err instanceof Error ? err.message : String(err)),
      );
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("build:list", () => {
    try {
      return { ok: true, result: listBuildRecords() };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("build:get", (_e, payload: unknown) => {
    try {
      const p = (payload ?? {}) as Record<string, unknown>;
      const id = typeof p.id === "string" ? p.id : "";
      return { ok: true, result: getBuildRecord(id) };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("build:start", (_e, payload: unknown) => {
    try {
      const p = (payload ?? {}) as Record<string, unknown>;
      const request = typeof p.request === "string" ? p.request.trim() : "";
      if (!request) return fail("Describe what you want built first.");
      if (request.length > MAX_REQUEST) return fail(`The request is too long (max ${MAX_REQUEST} characters).`);
      const note = typeof p.note === "string" ? p.note : "";
      const workspace = typeof p.workspace === "string" ? p.workspace : null;
      const sessionId = typeof p.sessionId === "string" ? p.sessionId : undefined;

      const record = createBuildRecord({ request, note, workspace, now: Date.now() });
      saveBuildRecord(record);
      broadcast(record);

      const controller = new AbortController();
      runningControllers.set(record.id, controller);
      const onChange = (r: BuildRecord): void => {
        saveBuildRecord(r);
        broadcast(r);
      };
      void runBuildPipeline(record, buildDeps(), { signal: controller.signal, onChange }).then(
        (finished) => {
          runningControllers.delete(record.id);
          saveBuildRecord(finished);
          broadcast(finished);
        },
        (err) => {
          runningControllers.delete(record.id);
          record.status = "failed";
          record.error = { code: "plan_failed", message: err instanceof Error ? err.message : String(err) };
          record.completedAt = Date.now();
          saveBuildRecord(record);
          broadcast(record);
        },
      );

      return { ok: true, result: { id: record.id, status: record.status } };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("build:respond", (_e, payload: unknown) => {
    try {
      const p = (payload ?? {}) as Record<string, unknown>;
      const id = typeof p.id === "string" ? p.id : "";
      const approved = p.approved === true;
      const note = typeof p.note === "string" ? p.note.slice(0, MAX_NOTE) : "";
      const record = getBuildRecord(id);
      if (!record) return fail("Build record not found.");
      if (record.status !== "awaiting_input") return fail("This build is not waiting for input.");
      const controller = runningControllers.get(id) ?? new AbortController();
      runningControllers.set(id, controller);
      const onChange = (r: BuildRecord): void => {
        saveBuildRecord(r);
        broadcast(r);
      };
      void approveBuild(record, approved, note, buildDeps(), { signal: controller.signal, onChange }).then(
        (finished) => {
          runningControllers.delete(id);
          saveBuildRecord(finished);
          broadcast(finished);
        },
        (err) => {
          runningControllers.delete(id);
          record.status = "failed";
          record.error = { code: "run_failed", message: err instanceof Error ? err.message : String(err) };
          record.completedAt = Date.now();
          saveBuildRecord(record);
          broadcast(record);
        },
      );
      return { ok: true, result: { id, status: record.status } };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("build:cancel", (_e, payload: unknown) => {
    try {
      const p = (payload ?? {}) as Record<string, unknown>;
      const id = typeof p.id === "string" ? p.id : "";
      const record = getBuildRecord(id);
      if (!record) return fail("Build record not found.");
      if (record.status === "completed" || record.status === "failed" || record.status === "refused" || record.status === "cancelled") {
        return { ok: true, result: { id, status: record.status } };
      }
      const controller = runningControllers.get(id);
      if (controller) controller.abort();
      runningControllers.delete(id);
      cancelBuild(record, { cancelRun: (runId) => getAgentRuntime().cancel(runId) }, Date.now());
      saveBuildRecord(record);
      broadcast(record);
      return { ok: true, result: { id, status: record.status } };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });
}

export type { CommandCatalogEntry };
export { applyTarget };