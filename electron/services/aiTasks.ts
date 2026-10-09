// Close Code — persistent AI tasks (Phase 29)
//
// Before this module, the AI had exactly one way to remember work: conversation
// text. A run that said "I'll fix X, then Y, then Z" produced a paragraph, not a
// list; nothing could be checked off, re-ordered, cancelled, retried or handed
// to a sub-agent, and a resumed session had to re-read prose to know what was
// still open.
//
// This module is the durable half of the Phase 29 task engine: a structured task
// list — creation, subtasks, dependencies, progress, status, priority,
// cancellation, retry, completion and assignment — persisted keyed by workspace,
// and reachable both by the AI (through the `task_*` tools) and by the user
// (through the same IPC the panel uses).
//
// WHY ONE FILE PER WORKSPACE, mirroring the sessions story:
//
//   Tasks are workspace-scoped (an agent in `C:\proj` maintains a different
//   list from the agent in `D:\app`, and a task never secretly follows a
//   session across folders). One file per workspace means a torn write can only
//   ever damage that workspace's list, and deleting one workspace's tasks is one
//   rename. The file name is derived from the workspace path, never joined from
//   renderer input — there is no id that can smuggle a traversal.
//
// WHY THIS RUNS IN THE MAIN PROCESS:
//
//   The renderer's copy is a projection for display; the disk is the truth. Both
//   the agent tools and the IPC layer call these functions, so a task updated by
//   a run is visible to the user in the same instant.
//
// SECURITY AND HONESTY, stated plainly:
//
//   * Task text is redacted like session text (the same secret-shaped patterns,
//     counted and surfaced) before anything is written.
//   * A file that cannot be read is moved aside, never deleted — the bytes stay
//     recoverable and the UI is told where they went.
//   * Bounds are enforced at the edge (creation refuses past the cap), and a
//     file that would still overflow drops the oldest tasks and says so with the
//     `truncated` flag. Dropping silently is not a design.
//   * No task state is ever fabricated. The dependency engine recomputes
//     `blocked`/`pending` from facts, and every transition is logged with who
//     did it and when.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { app } from "electron";
import { redactSecrets, REDACTION_PLACEHOLDER } from "./aiSessions";
import type { TaskToolService, TaskCreateInput, TaskUpdateInput } from "./agent/tools-tasks";

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

export type TaskStatus =
  | "pending"
  | "in_progress"
  | "blocked"
  | "completed"
  | "cancelled"
  | "failed";

export type TaskPriority = "low" | "medium" | "high" | "urgent";

export interface AiTask {
  id: string;
  title: string;
  description: string;
  /** `parentId` of a task makes it a subtask. `null` = a root task. */
  parentId: string | null;
  /** Ids of tasks this one waits on. All of them must finish before this can. */
  dependencies: string[];
  status: TaskStatus;
  priority: TaskPriority;
  /** 0–100. Forced to 100 the moment a task completes. */
  progress: number;
  /** Who is working it: an agent id, or "user". */
  assignee: string | null;
  /** The workspace this task belongs to. Recorded, never used to read files. */
  workspace: string | null;
  createdAt: number;
  updatedAt: number;
  /** Who made the last change: "user" or "agent:<agentId>". */
  updatedBy: string;
  /** How many times this task has been (re)started. */
  attempts: number;
  /** The last failure's reason, so a retry knows what it is recovering from. */
  lastError: string | null;
  /** Bounded human-readable history, oldest first. */
  log: string[];
}

/** The persisted shape of one workspace's task file. */
interface TaskStoreFile {
  version: number;
  tasks: AiTask[];
  /** Cumulative count of secret-shaped strings redacted before writing. */
  redactions: number;
  /** True when a bound forced something to be dropped. Never set silently. */
  truncated: boolean;
}

export type TaskOpResult =
  | { ok: true; task: AiTask }
  | { ok: false; error: string };

export type TaskListResult =
  | { ok: true; tasks: AiTask[]; truncated: boolean; redactions: number }
  | { ok: false; error: string; corrupted?: boolean; corruptFile?: string };

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

export const MAX_TASKS_PER_WORKSPACE = 500;
export const MAX_TASK_TITLE = 200;
export const MAX_TASK_DESC = 2_000;
export const MAX_TASK_DEPENDENCIES = 32;
export const MAX_TASK_ASSIGNEE = 80;
export const MAX_TASK_LOG = 50;
export const MAX_TASK_LOG_LINE = 200;
/** How deep subtask nesting may go. Enough for real planning, short enough to render. */
export const MAX_TASK_DEPTH = 8;
/** A hard ceiling on one workspace's task file. Exceeding it drops oldest tasks and sets `truncated`. */
export const MAX_TASK_STORE_BYTES = 4 * 1024 * 1024;

const SCHEMA_VERSION = 1;

export const TASK_STATUSES: readonly TaskStatus[] = Object.freeze([
  "pending",
  "in_progress",
  "blocked",
  "completed",
  "cancelled",
  "failed",
]);

export const TASK_PRIORITIES: readonly TaskPriority[] = Object.freeze([
  "low",
  "medium",
  "high",
  "urgent",
]);

/** Statuses a dependency may be in for the dependent to count as unblocked. */
function isSatisfied(status: TaskStatus): boolean {
  return status === "completed" || status === "cancelled";
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

let tasksDirOverride: string | null = null;

/** Point the store at a directory. Used by tests, and the only escape hatch. */
export function setTasksDir(dir: string | null): void {
  tasksDirOverride = dir;
}

export function getTasksDir(): string {
  return tasksDirOverride ?? path.join(app.getPath("userData"), "tasks");
}

function ensureDir(): void {
  fs.mkdirSync(getTasksDir(), { recursive: true });
}

/**
 * Derive a stable, collision-resistant file key from a workspace path.
 *
 * The workspace arrives over IPC from a renderer, so it is never joined to a
 * path raw. The key is a sanitised basename plus the first 8 hex digits of the
 * SHA-1 of the (Windows-normalised) absolute path: readable in the user's data
 * folder, stable across restarts, and distinct for two folders that happen to
 * share a basename. A `null` workspace (no folder open) is one shared
 * "rootless" store.
 */
function workspaceKey(workspace: string | null): string {
  if (!workspace) return "tasks-rootless";
  const norm = process.platform === "win32" ? workspace.toLowerCase() : workspace;
  const base = path.basename(norm);
  const safe = (base.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 40) || "ws");
  const hash = crypto.createHash("sha1").update(norm).digest("hex").slice(0, 8);
  return `tasks-${safe}-${hash}`;
}

export function taskStoreFile(workspace: string | null): string {
  return path.join(getTasksDir(), `${workspaceKey(workspace)}.json`);
}

// ---------------------------------------------------------------------------
// Atomic write (mirrors the sessions store — temp file + rename + `.bak`)
// ---------------------------------------------------------------------------

function writeFileAtomic(file: string, text: string): void {
  ensureDir();
  if (fs.existsSync(file)) {
    try {
      const tmpBak = `${file}.bak.tmp`;
      fs.writeFileSync(tmpBak, fs.readFileSync(file), "utf-8");
      fs.renameSync(tmpBak, `${file}.bak`);
    } catch {
      // A missing backup must not stop a save; the atomic rename is the real
      // guarantee and `.bak` is a second chance.
    }
  }
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, "utf-8");
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Read + quarantine
// ---------------------------------------------------------------------------

function isStr(v: unknown): v is string {
  return typeof v === "string";
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function clampText(v: unknown, max: number): string {
  if (!isStr(v)) return "";
  return v.length > max ? v.slice(0, max) : v;
}

function sanitizeTask(raw: unknown): AiTask | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (!isStr(t.id) || !t.id) return null;
  const status = TASK_STATUSES.includes(t.status as TaskStatus) ? (t.status as TaskStatus) : "pending";
  const priority = TASK_PRIORITIES.includes(t.priority as TaskPriority) ? (t.priority as TaskPriority) : "medium";
  const deps = Array.isArray(t.dependencies)
    ? t.dependencies.filter((d): d is string => isStr(d)).slice(0, MAX_TASK_DEPENDENCIES)
    : [];
  const log = Array.isArray(t.log)
    ? t.log.filter((l): l is string => isStr(l)).slice(0, MAX_TASK_LOG)
    : [];
  return {
    id: t.id.slice(0, 80),
    title: clampText(t.title, MAX_TASK_TITLE),
    description: clampText(t.description, MAX_TASK_DESC),
    parentId: isStr(t.parentId) && t.parentId ? t.parentId.slice(0, 80) : null,
    dependencies: deps,
    status,
    priority,
    progress: Math.min(100, Math.max(0, Math.round(num(t.progress, 0)))),
    assignee: isStr(t.assignee) && t.assignee ? t.assignee.slice(0, MAX_TASK_ASSIGNEE) : null,
    workspace: isStr(t.workspace) ? t.workspace : null,
    createdAt: num(t.createdAt, 0),
    updatedAt: num(t.updatedAt, 0),
    updatedBy: isStr(t.updatedBy) ? t.updatedBy.slice(0, 80) : "unknown",
    attempts: Math.max(0, Math.round(num(t.attempts, 0))),
    lastError: isStr(t.lastError) ? t.lastError.slice(0, MAX_TASK_DESC) : null,
    log,
  };
}

/**
 * Read one workspace's store, quarantining a file that cannot be parsed.
 *
 * A corrupt file must not permanently block the list: it is renamed aside (bytes
 * preserved, path surfaced) and the store restarts empty, so the user gets told
 * what happened instead of an app that can never show tasks again.
 */
function loadStore(workspace: string | null): { file: TaskStoreFile; corruptFile?: string } {
  ensureDir();
  const p = taskStoreFile(workspace);
  const empty: TaskStoreFile = { version: SCHEMA_VERSION, tasks: [], redactions: 0, truncated: false };
  if (!fs.existsSync(p)) return { file: empty };
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as unknown;
    if (!raw || typeof raw !== "object") throw new Error("store is not an object");
    const parsed = raw as Record<string, unknown>;
    const tasks = Array.isArray(parsed.tasks)
      ? parsed.tasks.map(sanitizeTask).filter((x): x is AiTask => x !== null)
      : [];
    return {
      file: {
        version: num(parsed.version, SCHEMA_VERSION),
        tasks,
        redactions: Math.max(0, Math.round(num(parsed.redactions, 0))),
        truncated: parsed.truncated === true,
      },
    };
  } catch (err) {
    const corruptFile = `${p}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(p, corruptFile);
    } catch {
      // if the rename fails the original stays in place and this store keeps
      // failing loudly; refusing to sweep it under a fresh file is the point.
      return { file: empty, corruptFile };
    }
    return { file: empty, corruptFile: path.basename(corruptFile) };
  }
}

// ---------------------------------------------------------------------------
// The dependency engine
// ---------------------------------------------------------------------------

function pushLog(task: AiTask, line: string): void {
  const clean = line.length > MAX_TASK_LOG_LINE ? line.slice(0, MAX_TASK_LOG_LINE - 1) + "…" : line;
  task.log = [...task.log, clean].slice(-MAX_TASK_LOG);
}

/**
 * Keep every task honest about its dependencies.
 *
 * Runs after every mutation. A task whose dependencies are not all finished
 * cannot honestly be `in_progress` or `completed`, so those get pinned to
 * `blocked` with a log line naming exactly what it waits on; a task that *was*
 * blocked and whose dependencies are now done falls back to `pending`. Both
 * directions are facts, not judgement — nothing here invents status.
 */
function recomputeDependencies(tasks: AiTask[], now: number, by: string): void {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const t of tasks) {
    const unsatisfied = t.dependencies.filter((id) => {
      const dep = byId.get(id);
      return !dep || !isSatisfied(dep.status);
    });
    if (unsatisfied.length > 0) {
      if (t.status === "in_progress" || t.status === "completed") {
        t.status = "blocked";
        t.updatedAt = now;
        t.updatedBy = by;
        const names = unsatisfied.map((id) => byId.get(id)?.title ?? id).join(", ");
        pushLog(t, `Blocked: waiting on ${names}`);
      }
    } else if (t.status === "blocked") {
      t.status = "pending";
      t.updatedAt = now;
      t.updatedBy = by;
      pushLog(t, "Unblocked: dependencies are done");
    }
  }
}

/** True when adding `dependency` to `task` would close a dependency cycle. */
function wouldCycleDependency(tasks: AiTask[], task: AiTask, dependency: string): boolean {
  if (task.id === dependency) return true;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set<string>([task.id]);
  const stack = [dependency];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const dep = byId.get(cur);
    if (!dep) continue;
    for (const d of dep.dependencies) {
      if (d === task.id) return true;
      if (!seen.has(d)) stack.push(d);
    }
  }
  return false;
}

/** True when making `task` a child of `parentId` would nest deeper than the cap or loop. */
function parentViolation(tasks: AiTask[], task: AiTask, parentId: string | null): string | null {
  if (!parentId) return null;
  if (parentId === task.id) return "A task cannot be its own parent.";
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const parent = byId.get(parentId);
  if (!parent) return `Parent task "${parentId}" does not exist.`;
  // Walk up: the new parent must not be (or contain) the task itself.
  let depth = 0;
  let cur: AiTask | undefined = parent;
  const seen = new Set<string>();
  while (cur) {
    if (cur.id === task.id) return "That parent would make the task its own ancestor.";
    if (seen.has(cur.id)) return "The parent chain is malformed.";
    seen.add(cur.id);
    depth += 1;
    if (depth > MAX_TASK_DEPTH) return `Tasks may nest at most ${MAX_TASK_DEPTH} levels deep.`;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Change notification
// ---------------------------------------------------------------------------
//
// The store does not know about windows or IPC — it says "this workspace's
// list changed" and the registered listener decides what to do with that. The
// IPC layer registers its broadcast, so an agent-tool mutation and a panel
// button produce exactly the same push; without this, a task a run created
// would sit on disk invisibly until the panel's next remount.

type TasksChangedListener = (workspace: string | null) => void;

let tasksChangedListener: TasksChangedListener | null = null;

export function setTasksChangedListener(cb: TasksChangedListener | null): void {
  tasksChangedListener = cb;
}

function notifyChanged(workspace: string | null): void {
  try {
    tasksChangedListener?.(workspace);
  } catch {
    // A broken listener must not break the store it listens to.
  }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function newTaskId(): string {
  return `task_${crypto.randomBytes(6).toString("hex")}`;
}

/** Redact secret-shaped text in every field worth writing, counting what changed. */
function redactTask(task: AiTask, counter: { n: number }): void {
  const apply = (s: string): string => {
    const r = redactSecrets(s);
    counter.n += r.count;
    return r.text;
  };
  task.title = apply(task.title);
  task.description = apply(task.description);
  if (task.lastError) task.lastError = apply(task.lastError);
  task.log = task.log.map((l) => {
    const r = redactSecrets(l);
    counter.n += r.count;
    return r.text;
  });
}

function persist(workspace: string | null, tasks: AiTask[], redactions: number): void {
  let file: TaskStoreFile = { version: SCHEMA_VERSION, tasks, redactions, truncated: false };
  let text = JSON.stringify(file);
  if (text.length > MAX_TASK_STORE_BYTES) {
    // Drop the oldest tasks (by updated time) until the file fits, and say so.
    const sorted = [...tasks].sort((a, b) => a.updatedAt - b.updatedAt);
    while (sorted.length > 0 && text.length > MAX_TASK_STORE_BYTES) {
      sorted.shift();
      file = { version: SCHEMA_VERSION, tasks: sorted, redactions, truncated: true };
      text = JSON.stringify(file);
    }
  }
  writeFileAtomic(taskStoreFile(workspace), text);
}

export function listTasks(workspace: string | null): TaskListResult {
  const { file, corruptFile } = loadStore(workspace);
  if (corruptFile) {
    return { ok: false, error: "The task file was not readable.", corrupted: true, corruptFile };
  }
  return { ok: true, tasks: [...file.tasks], truncated: file.truncated, redactions: file.redactions };
}

export function createTask(workspace: string | null, input: TaskCreateInput, by: string): TaskOpResult {
  const title = clampText(input.title, MAX_TASK_TITLE).trim();
  if (!title) return { ok: false, error: "A task needs a title." };
  const { file, corruptFile } = loadStore(workspace);
  if (corruptFile) return { ok: false, error: "The task file was not readable." };
  if (file.tasks.length >= MAX_TASKS_PER_WORKSPACE) {
    return { ok: false, error: `This workspace already has the maximum of ${MAX_TASKS_PER_WORKSPACE} tasks.` };
  }
  const ids = new Set(file.tasks.map((t) => t.id));
  const dependencies = (input.dependencies ?? []).filter((d) => ids.has(d)).slice(0, MAX_TASK_DEPENDENCIES);
  const byId = new Map(file.tasks.map((t) => [t.id, t]));
  const now = Date.now();
  const task: AiTask = {
    id: newTaskId(),
    title,
    description: clampText(input.description, MAX_TASK_DESC).trim() || "",
    parentId: input.parentId ?? null,
    dependencies,
    status: "pending",
    priority: TASK_PRIORITIES.includes(input.priority as TaskPriority) ? (input.priority as TaskPriority) : "medium",
    progress: 0,
    assignee: input.assignee ? clampText(input.assignee, MAX_TASK_ASSIGNEE).trim() || null : null,
    workspace,
    createdAt: now,
    updatedAt: now,
    updatedBy: clampText(by, 80),
    attempts: 0,
    lastError: null,
    log: [`Created by ${clampText(by, 80)}`],
  };
  if (task.parentId) {
    const violation = parentViolation(file.tasks, task, task.parentId);
    if (violation) return { ok: false, error: violation };
  }
  for (const dep of dependencies) {
    if (dep === task.id) return { ok: false, error: "A task cannot depend on itself." };
    if (wouldCycleDependency([...file.tasks, task], task, dep)) {
      return { ok: false, error: `Adding that dependency would make "${task.title}" part of a dependency cycle.` };
    }
  }
  const tasks = [...file.tasks, task];
  const counter = { n: file.redactions };
  redactTask(task, counter);
  computeProgressFromChildren(tasks, now, by);
  recomputeDependencies(tasks, now, by);
  persist(workspace, tasks, counter.n);
  notifyChanged(workspace);
  const finished = tasks.find((t) => t.id === task.id) as AiTask;
  return { ok: true, task: finished };
}

/** A parent's progress reflects its children when the parent has any. */
function computeProgressFromChildren(tasks: AiTask[], now: number, by: string): void {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const child of tasks) {
    if (!child.parentId) continue;
    const parent = byId.get(child.parentId);
    if (!parent) continue;
    const siblings = tasks.filter((t) => t.parentId === parent.id);
    if (siblings.length === 0) continue;
    const done = siblings.filter((s) => isSatisfied(s.status));
    const next = Math.round((done.length / siblings.length) * 100);
    if (next !== parent.progress) {
      parent.progress = next;
      parent.updatedAt = now;
      parent.updatedBy = by;
    }
  }
}

export function updateTask(workspace: string | null, id: string, patch: TaskUpdateInput, by: string): TaskOpResult {
  if (!id) return { ok: false, error: "Which task?" };
  const { file, corruptFile } = loadStore(workspace);
  if (corruptFile) return { ok: false, error: "The task file was not readable." };
  const idx = file.tasks.findIndex((t) => t.id === id);
  if (idx < 0) return { ok: false, error: `No task "${id}".` };
  const now = Date.now();
  const tasks = file.tasks.map((t) => ({ ...t }));
  const task = tasks[idx];
  const byLine = clampText(by, 80);

  if (patch.title !== undefined) {
    const title = clampText(patch.title, MAX_TASK_TITLE).trim();
    if (!title) return { ok: false, error: "A task needs a title." };
    if (title !== task.title) {
      pushLog(task, `Title changed to “${title}” by ${byLine}`);
      task.title = title;
    }
  }
  if (patch.description !== undefined) {
    const desc = clampText(patch.description, MAX_TASK_DESC).trim();
    if (desc !== task.description) {
      if (desc || task.description) pushLog(task, `Description changed by ${byLine}`);
      task.description = desc;
    }
  }
  if (patch.priority !== undefined && TASK_PRIORITIES.includes(patch.priority as TaskPriority)) {
    if (patch.priority !== task.priority) {
      pushLog(task, `Priority ${task.priority} → ${patch.priority} by ${byLine}`);
      task.priority = patch.priority as TaskPriority;
    }
  }
  if (patch.assignee !== undefined) {
    const assignee = patch.assignee ? clampText(patch.assignee, MAX_TASK_ASSIGNEE).trim() : null;
    if (assignee !== task.assignee) {
      pushLog(task, `Assigned to ${assignee ?? "nobody"} by ${byLine}`);
      task.assignee = assignee;
    }
  }
  if (patch.parentId !== undefined) {
    const parentId = patch.parentId || null;
    if (parentId !== task.parentId) {
      const violation = parentViolation(tasks, task, parentId);
      if (violation) return { ok: false, error: violation };
      if (parentId) pushLog(task, `Now a subtask of ${parentId} by ${byLine}`);
      task.parentId = parentId;
    }
  }
  if (patch.dependencies !== undefined) {
    const raw = Array.isArray(patch.dependencies) ? patch.dependencies.filter((d): d is string => isStr(d)) : [];
    const deps = [...new Set(raw)].slice(0, MAX_TASK_DEPENDENCIES);
    const ids = new Set(tasks.map((t) => t.id));
    for (const d of deps) {
      if (!ids.has(d) || d === task.id) return { ok: false, error: `Dependency "${d}" does not exist or is the task itself.` };
      if (wouldCycleDependency(tasks, task, d)) return { ok: false, error: `That dependency would close a cycle.` };
    }
    if (JSON.stringify([...deps].sort()) !== JSON.stringify([...task.dependencies].sort())) {
      pushLog(task, `Dependencies changed to ${deps.length ? deps.join(", ") : "none"} by ${byLine}`);
      task.dependencies = deps;
    }
  }
  if (patch.progress !== undefined) {
    const progress = Math.min(100, Math.max(0, Math.round(num(patch.progress, 0))));
    if (progress !== task.progress) {
      pushLog(task, `Progress ${task.progress}% → ${progress}% by ${byLine}`);
      task.progress = progress;
    }
  }
  if (patch.status !== undefined && TASK_STATUSES.includes(patch.status as TaskStatus)) {
    const status = patch.status as TaskStatus;
    if (status === "completed") {
      const byId = new Map(tasks.map((t) => [t.id, t]));
      const unsatisfied = task.dependencies
        .filter((d) => {
          const dep = byId.get(d);
          return !dep || !isSatisfied(dep.status);
        })
        .map((d) => byId.get(d)?.title ?? d);
      if (unsatisfied.length > 0) return { ok: false, error: `Cannot complete “${task.title}”: it is waiting on ${unsatisfied.join(", ")}.` };
    }
    if (status !== task.status) {
      pushLog(task, `Status ${task.status} → ${status} by ${byLine}`);
      task.status = status;
    }
  }
  if (patch.status === "completed" || task.status === "completed") {
    // Completion means done: exactly 100, whatever the patch said.
    if (task.status === "completed" && task.progress !== 100) {
      pushLog(task, `Progress forced to 100% (completed) by ${byLine}`);
      task.progress = 100;
    }
  }
  if (patch.lastError !== undefined) {
    const err = clampText(patch.lastError, MAX_TASK_DESC).trim() || null;
    if (err !== task.lastError) {
      task.lastError = err;
      if (err) pushLog(task, `Failed: ${err}`);
    }
  }

  task.updatedAt = now;
  task.updatedBy = byLine;

  const counter = { n: file.redactions };
  redactTask(task, counter);
  computeProgressFromChildren(tasks, now, byLine);
  recomputeDependencies(tasks, now, byLine);
  persist(workspace, tasks, counter.n);
  notifyChanged(workspace);
  return { ok: true, task };
}

export function deleteTask(workspace: string | null, id: string): TaskOpResult {
  if (!id) return { ok: false, error: "Which task?" };
  const { file, corruptFile } = loadStore(workspace);
  if (corruptFile) return { ok: false, error: "The task file was not readable." };
  const task = file.tasks.find((t) => t.id === id);
  if (!task) return { ok: false, error: `No task "${id}".` };
  const children = file.tasks.filter((t) => t.parentId === id).map((t) => t.title);
  if (children.length > 0) {
    return { ok: false, error: `“${task.title}” has subtasks that would be orphaned: ${children.join(", ")}. Delete them first.` };
  }
  const dependent = file.tasks.filter((t) => t.dependencies.includes(id)).map((t) => t.title);
  if (dependent.length > 0) {
    return { ok: false, error: `“${task.title}” is blocking a dependency: ${dependent.join(", ")}. Remove those dependencies first.` };
  }
  const tasks = file.tasks.filter((t) => t.id !== id);
  const counter = { n: file.redactions };
  persist(workspace, tasks, counter.n);
  notifyChanged(workspace);
  return { ok: true, task };
}

export function cancelTask(workspace: string | null, id: string, reason: string | null, by: string): TaskOpResult {
  const res = updateTask(workspace, id, { status: "cancelled" }, by);
  if (!res.ok || !reason) return res;
  // The reason belongs in the history, where the failure belongs. It is read
  // back, touched in one place, redacted like every other stored line, and
  // written once — no second full update is worth the double I/O.
  const { file, corruptFile } = loadStore(workspace);
  if (corruptFile) return { ok: false, error: "The task file was not readable." };
  const reasonLine = redactSecrets(clampText(reason, MAX_TASK_LOG_LINE));
  const tasks = file.tasks.map((t) =>
    t.id === res.task.id
      ? { ...t, log: [...(t.log ?? []), `Cancelled: ${reasonLine.text}`].slice(-MAX_TASK_LOG) }
      : t,
  );
  persist(workspace, tasks, file.redactions + reasonLine.count);
  notifyChanged(workspace);
  return { ok: true, task: tasks.find((t) => t.id === res.task.id) as AiTask };
}

export function retryTask(workspace: string | null, id: string, by: string): TaskOpResult {
  if (!id) return { ok: false, error: "Which task?" };
  const { file, corruptFile } = loadStore(workspace);
  if (corruptFile) return { ok: false, error: "The task file was not readable." };
  const idx = file.tasks.findIndex((t) => t.id === id);
  if (idx < 0) return { ok: false, error: `No task "${id}".` };
  const now = Date.now();
  const byLine = clampText(by, 80);
  const tasks = file.tasks.map((t) => ({ ...t }));
  const task = tasks[idx];
  if (task.status === "completed") {
    return { ok: false, error: `“${task.title}” is already completed — reopen it with an update instead of a retry.` };
  }
  const was = task.status;
  task.status = "pending";
  task.attempts += 1;
  task.lastError = null;
  task.updatedAt = now;
  task.updatedBy = byLine;
  pushLog(task, `Retry #${task.attempts} (was ${was}) by ${byLine}`);
  const counter = { n: file.redactions };
  redactTask(task, counter);
  recomputeDependencies(tasks, now, byLine);
  persist(workspace, tasks, counter.n);
  notifyChanged(workspace);
  return { ok: true, task: tasks[idx] };
}

/**
 * The narrow interface the agent tools see.
 *
 * Every op takes the workspace and the acting id, so a task's provenance is
 * recorded no matter who changed it — an agent that reassigns a task leaves a
 * trail a user can read.
 */
export const taskService: TaskToolService = {
  list: (workspace) => {
    const res = listTasks(workspace);
    if (!res.ok) return { ok: false, error: res.error };
    const byId = new Map(res.tasks.map((t) => [t.id, t]));
    return {
      ok: true,
      tasks: [...res.tasks]
        .map((t) => ({ ...t, log: [] }))
        .sort((a, b) => {
          const pa = a.parentId ? byId.get(a.parentId)?.createdAt ?? 0 : a.createdAt;
          const pb = b.parentId ? byId.get(b.parentId)?.createdAt ?? 0 : b.createdAt;
          return (a.parentId === b.parentId ? a.createdAt - b.createdAt : pa - pb) || a.createdAt - b.createdAt;
        }),
    };
  },
  create: (workspace, input, by) => createTask(workspace, input, by),
  update: (workspace, id, patch, by) => updateTask(workspace, id, patch, by),
  cancel: (workspace, id, reason, by) => cancelTask(workspace, id, reason, by),
  retry: (workspace, id, by) => retryTask(workspace, id, by),
};

export { REDACTION_PLACEHOLDER };