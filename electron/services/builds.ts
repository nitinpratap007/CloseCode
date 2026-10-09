// Close Code — Autonomous Project Builder (Phase 33)
//
// The builder turns a user's request ("build me a full MERN application") into a
// controlled, verifiable pipeline, and writes a *record* of it that survives the
// app restarting, exactly like the research store does:
//
//   1. understand intent        — the panel's request, stored verbatim
//   2. inspect the project      — the Plan-agent run (read-only by construction)
//   3. ask only necessary questions — one question, the one that is genuinely
//      necessary before anything is written: "may I modify your project per
//      this plan?" The user approves, denies, or replies with changes.
//   4. create a plan            — the Plan agent's real output
//   5. create tasks             — the Builder agent creates real plan tasks
//   6. select appropriate agents — this orchestrator picks plan → builder
//   7-13. create/edit files, install deps, run commands, detect errors, fix
//      errors, generate tests, run tests — all inside the Builder agent run,
//      which has real tools and passes through the real permission gate.
//   14. verify the result       — the *system* re-runs the specific build/test
//      /type-check commands the run actually exercised, plus a git read, and
//      records real exit codes. The record never trusts prose: its final
//      status is decided from those measured outcomes, not from the model's.
//   15. present changes         — an assembled summary: files changed, each
//      verification command and its real result, anything that was skipped and
//      why.
//
// HONESTY RULES (the phase's acceptance criterion):
//   * A builder run that finished but whose exercised verification command
//     failed is recorded as `failed`, whatever the model said.
//   * A run that exercised no verification command is recorded as completed
//     with an explicit "nothing was independently re-run" note.
//   * Verification commands that cannot run (terminal denied, no such script,
//     no tsconfig) are recorded as skipped with the reason, never as passing.
//   * Cancellation at any point lands the record in `cancelled` with the run id
//     that was stopped.

import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { AgentResult } from "./agent/types";

export type BuildStatus =
  | "queued"
  | "planning"
  | "awaiting_input"
  | "building"
  | "verifying"
  | "completed"
  | "failed"
  | "refused"
  | "cancelled";

export type BuildPhaseKind = "plan" | "question" | "implement" | "verify";

export type BuildPhaseStatus = "pending" | "running" | "done" | "failed" | "skipped" | "cancelled";

export type BuildFailureCode =
  | "aborted"
  | "plan_failed"
  | "run_failed"
  | "verification_failed"
  | "refused"
  | "not_a_git_repo"
  | "no_workspace";

export interface BuildError {
  code: BuildFailureCode;
  message: string;
}

/** One stage of the pipeline, each backed by a real event or run. */
export interface BuildPhase {
  kind: BuildPhaseKind;
  label: string;
  status: BuildPhaseStatus;
  at: number;
  endedAt?: number;
  /** What actually happened, in short. */
  detail: string;
  /** The real agent run that carried this phase, when there was one. */
  runId?: string;
}

/** One real command the system ran to verify (or why it could not). */
export interface BuildVerificationEntry {
  /** The exact thing that was verified — e.g. a package.json script name. */
  command: string;
  /** Real exit code, or null when the command did not run. */
  exitCode: number | null;
  /** True only when the command ran AND exited 0. */
  ok: boolean;
  /** First lines of the real output, bounded. */
  output: string;
  /** True when the command could not run; `output` then says why. */
  skipped: boolean;
  at: number;
}

/** The durable record of one builder pipeline. */
export interface BuildRecord {
  id: string;
  /** The user's request, verbatim. */
  request: string;
  /** The user's answer when they approved with changes. */
  note: string;
  workspace: string | null;
  status: BuildStatus;
  /** The Plan agent's real output. */
  plan: string;
  plannerRunId?: string;
  builderRunId?: string;
  phases: BuildPhase[];
  verification: BuildVerificationEntry[];
  /** Files changed while the builder worked, read from git. */
  changedFiles: string[];
  /** The assembled "here is what happened" summary. */
  summary: string;
  /** The builder run's own final text. */
  runText: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  error?: BuildError;
}

export const MAX_RECORDS = 25;
export const MAX_REQUEST = 2000;
export const MAX_NOTE = 1000;
export const MAX_VERIFY_OUTPUT = 2400;

// ---------------------------------------------------------------------------
// Durable store (mirrors the research store: atomic, quarantining, capped)
// ---------------------------------------------------------------------------

let buildUserDataDir: string | null = null;

/** Test and harness seam: point the store somewhere else. */
export function setBuildUserDataDir(dir: string | null): void {
  buildUserDataDir = dir;
}

function buildDir(): string {
  // `app` is imported lazily inside the function so unit tests that call
  // `setBuildUserDataDir` never touch Electron.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return buildUserDataDir ?? path.join(require("electron").app.getPath("userData"), "ai", "builds");
}

function ensure(): void {
  fs.mkdirSync(buildDir(), { recursive: true });
}

function recordPath(id: string): string {
  return path.join(buildDir(), `${id}.json`);
}

function coerceString(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function coercePhase(input: unknown): BuildPhase | null {
  if (!input || typeof input !== "object") return null;
  const p = input as Record<string, unknown>;
  const kind = p.kind === "plan" || p.kind === "question" || p.kind === "implement" || p.kind === "verify" ? p.kind : null;
  if (!kind) return null;
  const status =
    p.status === "running" || p.status === "done" || p.status === "failed" || p.status === "skipped" || p.status === "cancelled"
      ? p.status
      : "pending";
  return {
    kind,
    label: coerceString(p.label, 160) || kind,
    status,
    at: typeof p.at === "number" ? p.at : Date.now(),
    ...(typeof p.endedAt === "number" ? { endedAt: p.endedAt } : {}),
    detail: coerceString(p.detail, 600),
    ...(typeof p.runId === "string" && /^[a-z0-9-]{1,64}$/i.test(p.runId) ? { runId: p.runId } : {}),
  };
}

function coerceVerification(input: unknown): BuildVerificationEntry | null {
  if (!input || typeof input !== "object") return null;
  const v = input as Record<string, unknown>;
  const command = coerceString(v.command, 160);
  if (!command) return null;
  const exitCode = typeof v.exitCode === "number" && Number.isFinite(v.exitCode) ? v.exitCode : null;
  return {
    command,
    exitCode,
    ok: v.ok === true && exitCode === 0,
    output: coerceString(v.output, MAX_VERIFY_OUTPUT),
    skipped: v.skipped === true,
    at: typeof v.at === "number" ? v.at : Date.now(),
  };
}

/** A fresh record from ANY source is parsed defensively, like research. */
export function sanitizeRecord(input: unknown): BuildRecord | null {
  if (!input || typeof input !== "object") return null;
  const r = input as Record<string, unknown>;
  const id = coerceString(r.id, 64);
  if (!/^[a-z0-9-]{1,64}$/i.test(id)) return null;
  const createdAt = typeof r.createdAt === "number" && Number.isFinite(r.createdAt) ? r.createdAt : Date.now();
  const updatedAt = typeof r.updatedAt === "number" && Number.isFinite(r.updatedAt) ? r.updatedAt : createdAt;
  const phases = Array.isArray(r.phases)
    ? r.phases.map(coercePhase).filter((p): p is BuildPhase => p !== null).slice(0, 32)
    : [];
  const verification = Array.isArray(r.verification)
    ? r.verification.map(coerceVerification).filter((v): v is BuildVerificationEntry => v !== null).slice(0, 16)
    : [];
  const changedFiles = Array.isArray(r.changedFiles)
    ? r.changedFiles.filter((f): f is string => typeof f === "string" && f.length <= 400).slice(0, 500)
    : [];
  const statuses: readonly BuildStatus[] = [
    "queued", "planning", "awaiting_input", "building", "verifying", "completed", "failed", "refused", "cancelled",
  ];
  let status: BuildStatus = "queued";
  if (statuses.includes(r.status as BuildStatus)) status = r.status as BuildStatus;
  return {
    id,
    request: coerceString(r.request, MAX_REQUEST),
    note: coerceString(r.note, MAX_NOTE),
    workspace: typeof r.workspace === "string" ? r.workspace.slice(0, 2000) : null,
    status,
    plan: coerceString(r.plan, 20000),
    ...(typeof r.plannerRunId === "string" && /^[a-z0-9-]{1,64}$/i.test(r.plannerRunId) ? { plannerRunId: r.plannerRunId } : {}),
    ...(typeof r.builderRunId === "string" && /^[a-z0-9-]{1,64}$/i.test(r.builderRunId) ? { builderRunId: r.builderRunId } : {}),
    phases,
    verification,
    changedFiles,
    summary: coerceString(r.summary, 6000),
    runText: coerceString(r.runText, 20000),
    createdAt,
    updatedAt,
    ...(typeof r.completedAt === "number" && Number.isFinite(r.completedAt) ? { completedAt: r.completedAt } : {}),
    ...(r.error && typeof r.error === "object"
      ? {
          error: {
            code: coerceString((r.error as Record<string, unknown>).code, 60) as BuildFailureCode,
            message: coerceString((r.error as Record<string, unknown>).message, 600),
          },
        }
      : {}),
  };
}

export function createBuildRecord(input: {
  request: string;
  note: string;
  workspace: string | null;
  now: number;
}): BuildRecord {
  const now = input.now;
  return {
    id: `bld-${crypto.randomBytes(5).toString("hex")}`,
    request: input.request.trim().slice(0, MAX_REQUEST),
    note: input.note.trim().slice(0, MAX_NOTE),
    workspace: input.workspace,
    status: "queued",
    plan: "",
    phases: [],
    verification: [],
    changedFiles: [],
    summary: "",
    runText: "",
    createdAt: now,
    updatedAt: now,
  };
}

export function listBuildRecords(): BuildRecord[] {
  try {
    ensure();
    const out: BuildRecord[] = [];
    for (const name of fs.readdirSync(buildDir())) {
      if (!name.endsWith(".json")) continue;
      try {
        const rec = sanitizeRecord(JSON.parse(fs.readFileSync(path.join(buildDir(), name), "utf-8")));
        if (rec) out.push(rec);
      } catch {
        // a torn record does not take the whole list down
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_RECORDS);
  } catch {
    return [];
  }
}

export function getBuildRecord(id: string): BuildRecord | null {
  const clean = coerceString(id, 64);
  if (!/^[a-z0-9-]{1,64}$/i.test(clean)) return null;
  try {
    const p = recordPath(clean);
    if (!fs.existsSync(p)) return null;
    return sanitizeRecord(JSON.parse(fs.readFileSync(p, "utf-8")));
  } catch (err) {
    // Move the corrupt bytes aside — never delete them.
    try {
      const p = recordPath(clean);
      fs.renameSync(p, `${p}.corrupt`);
    } catch {
      // already gone
    }
    return null;
  }
}

export function saveBuildRecord(record: BuildRecord): boolean {
  try {
    ensure();
    const clean = sanitizeRecord(record);
    if (!clean) return false;
    const p = recordPath(clean.id);
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(clean, null, 2), "utf-8");
    // Small window where the old file still exists — rename is atomic on the
    // same volume, which is what makes a crash mid-write leave either the old
    // record or the new one, never a torn file.
    fs.renameSync(tmp, p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Orchestration pipeline
// ---------------------------------------------------------------------------

export interface BuildEvidence {
  /** The real tools the builder run used (granted), with their outcome's first line. */
  tools: Array<{ tool: string; outcome: string }>;
}

export interface BuildRunnerDeps {
  /**
   * Start one agent run and wait for it to finish, returning the real result
   * and the evidence of which tools it used. Production backs this with the
   * singleton runtime; tests inject fakes.
   */
  runAgent: (opts: {
    agentId: string;
    task: string;
    workspace: string | null;
    sessionId?: string | null;
  }) => Promise<{ runId: string; result: AgentResult; evidence: BuildEvidence }>;
  cancelRun: (runId: string) => boolean;
  /** Whether unattended shell commands may run for outer verification. */
  terminalAllowed: () => boolean;
  /** package.json scripts of the workspace, or null if unreadable. */
  readScripts: (workspace: string) => Record<string, string> | null;
  /** Run one of the workspace's own npm scripts and report the real result. */
  runScript: (workspace: string, script: string) => Promise<{ exitCode: number | null; output: string }>;
  /** Run `tsc --noEmit` against the workspace and report the real result. */
  runTsc: (workspace: string) => Promise<{ exitCode: number | null; output: string }>;
  /** Changed files from git, or null when there is no repo. */
  readGitChanges: (workspace: string) => string[] | null;
  now: () => number;
}

/** The wrapper the Builder agent gets for the build phase. */
export function buildTaskText(request: string, plan: string, note: string): string {
  const parts: string[] = [];
  parts.push(`The user asked for: ${request}`);
  if (plan.trim()) parts.push(`The approved plan is:\n\n${plan.trim()}`);
  if (note.trim()) parts.push(`The user added this note when approving the plan:\n\n${note.trim()}`);
  parts.push(
    `Autonomously build it now. Create one task per plan step with the task tools and complete each as ` +
      `you finish it. Implement the files, installing dependencies only where your permissions allow. Then ` +
      `run the project's REAL build and tests with run_build / run_tests / type_diagnostics and read the ` +
      `actual output — a step is done only when its real command passes. Fix what fails, never just claim ` +
      `it. Finish with a short summary: the files you created or edited, the commands you ran and their ` +
      `real results, and anything you could not do.`,
  );
  return parts.join("\n\n");
}

/** The wrapper the Plan agent gets for the planning phase. */
export function planTaskText(request: string): string {
  return (
    `Produce an implementation plan for the following request. Investigate the workspace with ` +
    `read-only tools first, then answer with: 1) the current situation, 2) a numbered list of concrete ` +
    `steps each naming the files to touch, 3) the risks or unknowns, and 4) how to verify each step. ` +
    `Do not write or run anything.\n\nRequest: ${request}`
  );
}

const BUILD_SCRIPT_ORDER = ["build", "build:prod", "compile", "dist"];
const TEST_SCRIPT_ORDER = ["test", "check", "unit", "test:unit", "typecheck"];

export interface VerificationPlan {
  entries: Array<
    | { kind: "script"; command: string }
    | { kind: "tsc"; command: string }
  >;
}

/**
 * Decide what to verify from what the builder run actually exercised. If the
 * run never called `run_build`, `run_tests` or `type_diagnostics`, the plan is
 * empty and the record will say so rather than inventing a command.
 */
export function planVerification(evidence: BuildEvidence, scripts: Record<string, string> | null): VerificationPlan {
  const used = new Set(evidence.tools.map((t) => t.tool));
  const entries: VerificationPlan["entries"] = [];
  if (used.has("run_build")) {
    const script = scripts ? BUILD_SCRIPT_ORDER.find((s) => s in scripts) : undefined;
    entries.push(script ? { kind: "script", command: script } : { kind: "script", command: "build" });
  }
  if (used.has("run_tests")) {
    const script = scripts ? TEST_SCRIPT_ORDER.find((s) => s in scripts) : undefined;
    entries.push(script ? { kind: "script", command: script } : { kind: "script", command: "test" });
  }
  if (used.has("type_diagnostics")) {
    entries.push({ kind: "tsc", command: "tsc" });
  }
  return { entries };
}

/** Quick human digest of one verification outcome. */
export function verifyOkName(entry: BuildVerificationEntry): string {
  if (entry.skipped) return "skipped";
  return entry.exitCode === 0 ? "passed" : `exit ${entry.exitCode ?? "?"}`;
}

function pushPhase(record: BuildRecord, phase: BuildPhase): void {
  record.phases.push(phase);
  if (record.phases.length > 32) record.phases = record.phases.slice(-32);
}

function addVerification(record: BuildRecord, entry: BuildVerificationEntry): void {
  record.verification.push(entry);
  if (record.verification.length > 16) record.verification = record.verification.slice(-16);
}

export type BuildPipelineOptions = {
  signal?: AbortSignal;
  onChange?: (r: BuildRecord) => void;
};

/**
 * Run a record through the whole pipeline. Assumes `record.status === "queued"`.
 * Mutates the record and calls `onChange` after every meaningful transition so
 * the IPC layer can persist and broadcast. Never claims success: the final
 * status is decided from measured verification results below.
 */
export async function runBuildPipeline(
  record: BuildRecord,
  deps: BuildRunnerDeps,
  opts: BuildPipelineOptions = {},
): Promise<BuildRecord> {
  const signal = opts.signal ?? new AbortController().signal;
  const now = deps.now;
  const touch = (): void => {
    record.updatedAt = now();
    opts.onChange?.(record);
  };
  const fail = (code: BuildFailureCode, message: string): void => {
    record.status = "failed";
    record.error = { code, message };
    record.completedAt = now();
    touch();
  };
  const cancelled = (): void => {
    record.status = "cancelled";
    record.error = { code: "aborted", message: "The build was stopped before it finished." };
    record.completedAt = now();
    touch();
  };

  // --- Phase 1+2+4: plan (a real Plan-agent run; read-only by construction) ---
  record.status = "planning";
  pushPhase(record, {
    kind: "plan",
    label: "Plan",
    status: "running",
    at: now(),
    detail: "Investigating the workspace and producing a plan…",
  });
  touch();

  const planRun = await deps.runAgent({
    agentId: "plan",
    task: planTaskText(record.request),
    workspace: record.workspace,
  });
  record.plannerRunId = planRun.runId;
  const planPhase = record.phases.find((p) => p.kind === "plan");
  if (planPhase) planPhase.runId = planRun.runId;

  if (signal.aborted || planRun.result.status === "cancelled") {
    if (planPhase) {
      planPhase.status = "cancelled";
      planPhase.endedAt = now();
      planPhase.detail = "Stopped during planning.";
    }
    cancelled();
    return record;
  }
  if (planRun.result.status === "failed") {
    if (planPhase) {
      planPhase.status = "failed";
      planPhase.endedAt = now();
      planPhase.detail = planRun.result.error?.message ?? "The plan run failed.";
    }
    fail("plan_failed", planRun.result.error?.message ?? "The plan run failed.");
    return record;
  }
  record.plan = planRun.result.text;
  if (planPhase) {
    planPhase.status = "done";
    planPhase.endedAt = now();
    planPhase.detail = record.plan.trim() ? "Plan produced." : "Plan produced with no text.";
  }

  // --- Phase 3: the one necessary question ---
  record.status = "awaiting_input";
  pushPhase(record, {
    kind: "question",
    label: "Approve plan",
    status: "pending",
    at: now(),
    detail: "Waiting for the user to approve the plan before anything is written.",
  });
  touch();
  return record;
}

export interface BuildApproveResult {
  record: BuildRecord;
}

/**
 * Resume a record that reached `awaiting_input`. `approved === false` refuses
 * the build; `note` becomes part of the builder run's task. When approved, the
 * Builder agent run starts, and on completion the system measures the outcome.
 */
export async function approveBuild(
  record: BuildRecord,
  approved: boolean,
  note: string,
  deps: BuildRunnerDeps,
  opts: BuildPipelineOptions = {},
): Promise<BuildRecord> {
  const signal = opts.signal ?? new AbortController().signal;
  const now = deps.now;
  const touch = (): void => {
    record.updatedAt = now();
    opts.onChange?.(record);
  };
  const questionPhase = record.phases.find((p) => p.kind === "question");
  const fail = (code: BuildFailureCode, message: string): void => {
    record.status = "failed";
    record.error = { code, message };
    record.completedAt = now();
    touch();
  };
  const cancelled = (): void => {
    record.status = "cancelled";
    record.error = { code: "aborted", message: "The build was stopped before it finished." };
    record.completedAt = now();
    touch();
  };

  record.note = note.trim().slice(0, MAX_NOTE);

  if (!approved) {
    record.status = "refused";
    record.error = { code: "refused", message: "The plan was not approved, so nothing was built." };
    record.completedAt = now();
    if (questionPhase) {
      questionPhase.status = "done";
      questionPhase.endedAt = now();
      questionPhase.detail = "Denied by the user.";
    }
    touch();
    return record;
  }

  if (record.status !== "awaiting_input") {
    return record;
  }

  if (questionPhase) {
    questionPhase.status = "done";
    questionPhase.endedAt = now();
    questionPhase.detail = note.trim() ? "Approved with changes." : "Approved.";
  }

  // --- Phase 5-13: implement (a real Builder-agent run) ---
  record.status = "building";
  pushPhase(record, {
    kind: "implement",
    label: "Build",
    status: "running",
    at: now(),
    detail: "Creating tasks, implementing files and running the project's commands…",
  });
  touch();

  const buildRun = await deps.runAgent({
    agentId: "builder",
    task: buildTaskText(record.request, record.plan, record.note),
    workspace: record.workspace,
  });
  record.builderRunId = buildRun.runId;
  const implementPhase = record.phases.find((p) => p.kind === "implement");
  if (implementPhase) implementPhase.runId = buildRun.runId;

  if (signal.aborted || buildRun.result.status === "cancelled") {
    if (implementPhase) {
      implementPhase.status = "cancelled";
      implementPhase.endedAt = now();
      implementPhase.detail = "Stopped while building.";
    }
    cancelled();
    return record;
  }
  if (buildRun.result.status === "failed") {
    if (implementPhase) {
      implementPhase.status = "failed";
      implementPhase.endedAt = now();
      implementPhase.detail = buildRun.result.error?.message ?? "The build run failed.";
    }
    fail("run_failed", buildRun.result.error?.message ?? "The build run failed.");
    return record;
  }

  record.runText = buildRun.result.text;
  if (implementPhase) {
    implementPhase.status = "done";
    implementPhase.endedAt = now();
    implementPhase.detail = "Builder finished; verifying the result now.";
  }

  // --- Phase 14: the system measures, the model does not get the last word ---
  record.status = "verifying";
  pushPhase(record, {
    kind: "verify",
    label: "Verify",
    status: "running",
    at: now(),
    detail: "Re-running the exact commands the build exercised and reading git…",
  });
  touch();

  let anythingFailed = false;
  let anythingSkipped = false;

  if (deps.terminalAllowed()) {
    const scripts = record.workspace ? deps.readScripts(record.workspace) : null;
    const plan = planVerification(buildRun.evidence, scripts);
    for (const entry of plan.entries) {
      if (signal.aborted) break;
      if (entry.kind === "tsc") {
        const tsc = await deps.runTsc(record.workspace!);
        const skipped = tsc.exitCode === null;
        addVerification(record, {
          command: "typecheck (tsc --noEmit)",
          exitCode: tsc.exitCode,
          ok: !skipped && tsc.exitCode === 0,
          output: skipped ? "tsc could not be started." : tsc.output,
          skipped,
          at: now(),
        });
        if (skipped) anythingSkipped = true;
        else if (tsc.exitCode !== 0) anythingFailed = true;
      } else {
        const script = entry.command;
        const exists = scripts ? script in scripts : false;
        if (!exists) {
          addVerification(record, {
            command: script,
            exitCode: null,
            ok: false,
            output: `package.json has no "${script}" script, so it could not be re-run.`,
            skipped: true,
            at: now(),
          });
          anythingSkipped = true;
          continue;
        }
        const res = await deps.runScript(record.workspace!, script);
        const skipped = res.exitCode === null;
        addVerification(record, {
          command: script,
          exitCode: res.exitCode,
          ok: !skipped && res.exitCode === 0,
          output: skipped ? "script could not be started." : res.output,
          skipped,
          at: now(),
        });
        if (skipped) anythingSkipped = true;
        else if (res.exitCode !== 0) anythingFailed = true;
      }
      touch();
    }
  } else {
    addVerification(record, {
      command: "terminal permission",
      exitCode: null,
      ok: false,
      output:
        "The terminal permission does not allow unattended command runs, so no verification " +
        "commands were re-run. The builder run itself still ran under the permission gate.",
      skipped: true,
      at: now(),
    });
    anythingSkipped = true;
  }

  // Changed files, read from git — never from the model's summary.
  if (record.workspace) {
    try {
      record.changedFiles = deps.readGitChanges(record.workspace) ?? [];
    } catch {
      record.changedFiles = [];
    }
  }

  if (signal.aborted) {
    cancelled();
    return record;
  }

  // --- Phase 15: present — assembled from measured facts, not prose ---
  const verifyPhase = record.phases.find((p) => p.kind === "verify");
  const fileLine = record.changedFiles.length
    ? `${record.changedFiles.length} file${record.changedFiles.length === 1 ? "" : "s"} changed (${record.changedFiles.slice(0, 8).join(", ")}${record.changedFiles.length > 8 ? ", …" : ""}).`
    : "No file changes were detected in git.";

  if (anythingFailed) {
    if (verifyPhase) {
      verifyPhase.status = "failed";
      verifyPhase.endedAt = now();
      verifyPhase.detail = "A verification command failed.";
    }
    const failing = record.verification.find((v) => !v.skipped && v.exitCode !== 0);
    record.summary =
      `The builder finished, but its exercised verification did not pass: ` +
      `"${failing?.command ?? "?"}" exited ${failing?.exitCode ?? "?"}. The result is NOT claimed to be verified. ${fileLine}`;
    fail("verification_failed", `Verification command "${failing?.command ?? "?"}" exited ${failing?.exitCode ?? "?"}.`);
    return record;
  }

  record.status = "completed";
  record.completedAt = now();
  if (verifyPhase) {
    verifyPhase.status = "done";
    verifyPhase.endedAt = now();
    verifyPhase.detail = anythingSkipped ? "Partial — some commands could not run." : "All exercised commands passed.";
  }

  if (record.verification.length === 0) {
    record.summary =
      `The builder finished, but did not exercise any build/test/type-check command, so nothing was ` +
      `independently re-run — its claims stand on their own. ${fileLine}`;
  } else if (anythingSkipped) {
    const skipped = record.verification.filter((v) => v.skipped).map((v) => `"${v.command}"`).join(", ");
    record.summary =
      `The builder finished and the verification commands that ran all passed. ${skipped} could not be re-run. ${fileLine}`;
  } else {
    record.summary =
      `The builder finished and every verification command it exercised passed. ${fileLine}`;
  }
  touch();
  return record;
}

/**
 * Stop a pipeline record wherever it is. When an agent run is in flight it is
 * cancelled first; when the record is waiting on input it is simply closed.
 */
export function cancelBuild(record: BuildRecord, deps: { cancelRun: (runId: string) => boolean }, now: number): BuildRecord {
  if (record.status === "planning" && record.plannerRunId) deps.cancelRun(record.plannerRunId);
  if ((record.status === "building" || record.status === "verifying") && record.builderRunId) deps.cancelRun(record.builderRunId);
  for (const p of record.phases) {
    if (p.status === "running") {
      p.status = "cancelled";
      p.endedAt = now;
      p.detail = "Stopped by the user.";
    }
  }
  record.status = "cancelled";
  record.error = { code: "aborted", message: "The build was stopped before it finished." };
  record.completedAt = now;
  record.updatedAt = now;
  return record;
}