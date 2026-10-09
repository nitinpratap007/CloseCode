// Close Code — AI Agent — task tools (Phase 29)
//
// The seven tools that let a model maintain the persistent task list: create,
// update, list, complete, cancel, retry and assign. They are the "the AI should
// be able to maintain a structured task list instead of relying only on
// conversation text" half of Phase 29 — the durable half lives in
// `electron/services/aiTasks.ts`, which this module never imports at runtime.
//
// The store is injected as a narrow `TaskToolService` by the process wiring
// (`instance.ts` → `createDefaultRegistry` → `createTaskTools`), exactly like the
// browser tool's live window. Each tool closes over its own service handle, so
// a unit suite can build the tools over a fake service that never touches the
// disk, while the real app's tools and its IPC speak to the same store
// instance — a task a run creates is on disk and in the user's panel in the
// same instant.
//
// Boundaries the tools keep deliberately:
//
//   * **No delete.** An agent that deletes tracked work can destroy the
//     planning around it faster than any file tool ever did; cancellation (which
//     keeps the record and the history) is the honest way out. Deletion is a
//     user decision, and only the UI offers it.
//   * **No fabrication.** Every tool's answer describes what the store actually
//     did — a create returns the new id, an update returns the new status, and a
//     domain rule the store refused (a cycle, a dependency that is not done)
//     comes back as an honest error the model can read and recover from, never
//     as a claimed success.
//   * **One gate.** Every tool authorizes the `tasks` category first. A
//     permission refusal is a `granted: false` outcome — a permission event, not
//     an error the model should argue with.

import type { AgentTool, AgentToolContext, AgentToolOutcome } from "./types";
import type { AiTask, TaskPriority, TaskStatus } from "../aiTasks";

// ---------------------------------------------------------------------------
// The narrow store interface the tools see
// ---------------------------------------------------------------------------

export interface TaskCreateInput {
  title: string;
  description?: string;
  parentId?: string | null;
  priority?: TaskPriority;
  dependencies?: string[];
  assignee?: string | null;
}

export interface TaskUpdateInput {
  title?: string;
  description?: string;
  priority?: TaskPriority;
  status?: TaskStatus;
  progress?: number;
  assignee?: string | null;
  parentId?: string | null;
  dependencies?: string[];
  lastError?: string | null;
}

export type TaskToolResult =
  | { ok: true; task: AiTask }
  | { ok: false; error: string };

export interface TaskToolListResult {
  ok: boolean;
  tasks?: AiTask[];
  error?: string;
}

export interface TaskToolService {
  list(workspace: string | null): TaskToolListResult;
  create(workspace: string | null, input: TaskCreateInput, by: string): TaskToolResult;
  update(workspace: string | null, id: string, patch: TaskUpdateInput, by: string): TaskToolResult;
  cancel(workspace: string | null, id: string, reason: string | null, by: string): TaskToolResult;
  retry(workspace: string | null, id: string, by: string): TaskToolResult;
}

// ---------------------------------------------------------------------------
// Schema helpers (same JSON-Schema shape the other built-ins use)
// ---------------------------------------------------------------------------

function def(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return { type: "object", properties: parameters, ...(required.length ? { required } : {}) };
}

function str(desc: string): Record<string, unknown> {
  return { type: "string", description: desc };
}

const STATUSES: readonly string[] = ["pending", "in_progress", "blocked", "completed", "cancelled", "failed"];
const PRIORITIES: readonly string[] = ["low", "medium", "high", "urgent"];

const DENIED: AgentToolOutcome = { granted: false, text: "Permission denied by policy or user." };

function taskError(message: string): AgentToolOutcome {
  return { granted: true, status: "error", text: `Error: ${message}` };
}

function actor(ctx: { agentId?: string }): string {
  return ctx.agentId ? `agent:${ctx.agentId}` : "agent";
}

function workspaceOf(ctx: { workspace?: string | null }): string | null {
  return ctx.workspace ?? null;
}

/** Absent means "don't touch"; `null`/`""` mean "clear"; a string is kept. */
function nullableStr(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  return typeof v === "string" ? v : undefined;
}

function makeTools(service: TaskToolService): AgentTool[] {
  const authorize = async (ctx: Pick<AgentToolContext, "authorize">, args: Record<string, unknown>): Promise<boolean> =>
    ctx.authorize("tasks", args);

  const create: AgentTool = {
    name: "task_create",
    description:
      "Create a task in the persistent task list. Use it to record planned or discovered work instead of leaving it only in conversation text. " +
      "parentId makes the new task a subtask of an existing one; dependencies lists task ids this work waits on. Returns the new task id.",
    parameters: def(
      "task_create",
      "",
      {
        title: str("Short, specific title for the work."),
        description: str("Optional detail: what done looks like, constraints, references."),
        parentId: str("Optional id of an existing task this is a subtask of."),
        priority: str(`Optional: ${PRIORITIES.join(", ")}. Defaults to medium.`),
        assignee: str("Optional who should do it: an agent id or \"user\"."),
        dependencies: {
          type: "array",
          description: "Optional ids of tasks this work waits on.",
          items: { type: "string" },
        },
      },
      ["title"],
    ),
    category: "tasks",
    readOnly: false,
    destructive: false,
    async execute(ctx, args): Promise<AgentToolOutcome> {
      if (!(await authorize(ctx, args))) return DENIED;
      const title = typeof args.title === "string" ? args.title : "";
      if (!title.trim()) return taskError("task_create needs a title.");
      const input: TaskCreateInput = { title };
      if (typeof args.description === "string") input.description = args.description;
      const parent = nullableStr(args.parentId);
      if (parent !== undefined) input.parentId = parent;
      if (typeof args.priority === "string") input.priority = args.priority as TaskPriority;
      const assignee = nullableStr(args.assignee);
      if (assignee !== undefined) input.assignee = assignee;
      if (Array.isArray(args.dependencies)) {
        input.dependencies = args.dependencies.filter((d): d is string => typeof d === "string");
      }
      const res = service.create(workspaceOf(ctx), input, actor(ctx));
      if (!res.ok) return taskError(res.error);
      return {
        granted: true,
        text: `Created task ${res.task.id}: “${res.task.title}” (${res.task.status}, ${res.task.priority}).`,
        data: { id: res.task.id, title: res.task.title, status: res.task.status },
      };
    },
  };

  const update: AgentTool = {
    name: "task_update",
    description:
      "Change an existing task: title, description, priority, status, progress (0-100), assignee, parentId, or dependencies. " +
      "Use status \"failed\" with lastError to record a failure so it can be retried. Completing a task that is still waiting on " +
      "unfinished dependencies is refused; that is a fact, not a preference.",
    parameters: def(
      "task_update",
      "",
      {
        id: str("The task id to change."),
        title: str("New title."),
        description: str("New description."),
        priority: str(`New priority: ${PRIORITIES.join(", ")}.`),
        status: str(`New status: ${STATUSES.join(", ")}.`),
        progress: { type: "number", description: "New progress as an integer 0-100." },
        assignee: str("New assignee (an agent id or \"user\"), or \"\" to clear."),
        parentId: str("New parent task id, or \"\" to make it a root task."),
        dependencies: {
          type: "array",
          description: "Full replacement list of dependency task ids.",
          items: { type: "string" },
        },
        lastError: str("The failure reason, when setting status to \"failed\"."),
      },
      ["id"],
    ),
    category: "tasks",
    readOnly: false,
    destructive: false,
    async execute(ctx, args): Promise<AgentToolOutcome> {
      if (!(await authorize(ctx, args))) return DENIED;
      const id = typeof args.id === "string" ? args.id : "";
      if (!id) return taskError("task_update needs a task id.");
      const patch: TaskUpdateInput = {};
      const pick = (k: keyof TaskUpdateInput, v: unknown, guard: (x: unknown) => boolean): void => {
        if (guard(v)) patch[k] = v as never;
      };
      pick("title", args.title, (v) => typeof v === "string");
      pick("description", args.description, (v) => typeof v === "string");
      pick("priority", args.priority, (v) => typeof v === "string");
      pick("status", args.status, (v) => typeof v === "string");
      pick("progress", args.progress, (v) => typeof v === "number" && Number.isFinite(v));
      pick("dependencies", args.dependencies, (v) => Array.isArray(v));
      pick("lastError", args.lastError, (v) => typeof v === "string" || v === null);
      const assignee = nullableStr(args.assignee);
      if (assignee !== undefined) patch.assignee = assignee;
      const parent = nullableStr(args.parentId);
      if (parent !== undefined) patch.parentId = parent;
      const res = service.update(workspaceOf(ctx), id, patch, actor(ctx));
      if (!res.ok) return taskError(res.error);
      const t = res.task;
      return {
        granted: true,
        text: `Updated task ${t.id}: status ${t.status}, progress ${t.progress}%.`,
        data: { id: t.id, status: t.status, progress: t.progress },
      };
    },
  };

  const list: AgentTool = {
    name: "task_list",
    description:
      "List the current workspace's tasks from the persistent task list. " +
      "Use it before creating or updating tasks so you work from facts instead of assumptions about what already exists. " +
      "status filters to one status; parentId filters to one task's subtasks.",
    parameters: def("task_list", "", {
      status: str(`Optional filter: ${STATUSES.join(", ")}.`),
      parentId: str("Optional: only list subtasks of this task id."),
    }),
    category: "tasks",
    readOnly: true,
    destructive: false,
    async execute(ctx, args): Promise<AgentToolOutcome> {
      if (!(await authorize(ctx, args))) return DENIED;
      const res = service.list(workspaceOf(ctx));
      if (!res.ok || !res.tasks) return taskError(res.error ?? "The task list could not be read.");
      const status = typeof args.status === "string" ? args.status : null;
      const parentId = typeof args.parentId === "string" ? args.parentId : null;
      const rows = res.tasks.filter(
        (t) => (!status || t.status === status) && (parentId === null || t.parentId === parentId),
      );
      if (rows.length === 0) return { granted: true, text: "No tasks match that filter.", data: { count: 0 } };
      const lines = rows.map((t) => {
        const deps = t.dependencies.length ? ` deps:[${t.dependencies.join(",")}]` : "";
        const sub = t.parentId ? ` under:${t.parentId}` : "";
        return `${t.id} “${t.title}” (${t.status}, ${t.priority}, ${t.progress}%${t.assignee ? `, @${t.assignee}` : ""}${deps}${sub})`;
      });
      return {
        granted: true,
        text: `${rows.length} task${rows.length === 1 ? "" : "s"}:\n${lines.join("\n")}`,
        data: { count: rows.length, ids: rows.map((r) => r.id) },
      };
    },
  };

  const complete: AgentTool = {
    name: "task_complete",
    description:
      "Mark a task completed. Its progress becomes 100. Refused (with the reason) if the task still depends on unfinished work.",
    parameters: def("task_complete", "", { id: str("The task id to complete.") }, ["id"]),
    category: "tasks",
    readOnly: false,
    destructive: false,
    async execute(ctx, args): Promise<AgentToolOutcome> {
      if (!(await authorize(ctx, args))) return DENIED;
      const id = typeof args.id === "string" ? args.id : "";
      if (!id) return taskError("task_complete needs a task id.");
      const res = service.update(workspaceOf(ctx), id, { status: "completed" }, actor(ctx));
      if (!res.ok) return taskError(res.error);
      return {
        granted: true,
        text: `Completed task ${id}: “${res.task.title}”.`,
        data: { id, status: "completed", progress: 100 },
      };
    },
  };

  const cancel: AgentTool = {
    name: "task_cancel",
    description:
      "Cancel a task: it is no longer being pursued, but its record and history are kept. " +
      "Use reason to say why, so a human reading the log sees the decision. Write off abandoned work with cancel, not delete — " +
      "there is no delete tool for tasks.",
    parameters: def(
      "task_cancel",
      "",
      {
        id: str("The task id to cancel."),
        reason: str("Optional short reason, recorded in the task's history."),
      },
      ["id"],
    ),
    category: "tasks",
    readOnly: false,
    destructive: false,
    async execute(ctx, args): Promise<AgentToolOutcome> {
      if (!(await authorize(ctx, args))) return DENIED;
      const id = typeof args.id === "string" ? args.id : "";
      if (!id) return taskError("task_cancel needs a task id.");
      const reason = typeof args.reason === "string" && args.reason.trim() ? args.reason : null;
      const res = service.cancel(workspaceOf(ctx), id, reason, actor(ctx));
      if (!res.ok) return taskError(res.error);
      return {
        granted: true,
        text: `Cancelled task ${id}: “${res.task.title}”.${reason ? ` Reason: ${reason}` : ""}`,
        data: { id, status: "cancelled" },
      };
    },
  };

  const retry: AgentTool = {
    name: "task_retry",
    description:
      "Re-open a failed or cancelled task for another attempt. Its attempt counter is incremented, its last error is cleared, " +
      "and its status returns to pending. Refused for a completed task (reopen it with task_update instead).",
    parameters: def("task_retry", "", { id: str("The task id to retry.") }, ["id"]),
    category: "tasks",
    readOnly: false,
    destructive: false,
    async execute(ctx, args): Promise<AgentToolOutcome> {
      if (!(await authorize(ctx, args))) return DENIED;
      const id = typeof args.id === "string" ? args.id : "";
      if (!id) return taskError("task_retry needs a task id.");
      const res = service.retry(workspaceOf(ctx), id, actor(ctx));
      if (!res.ok) return taskError(res.error);
      return {
        granted: true,
        text: `Retrying task ${id}: “${res.task.title}” is ${res.task.status} again (attempt ${res.task.attempts}).`,
        data: { id, status: res.task.status, attempts: res.task.attempts },
      };
    },
  };

  const assign: AgentTool = {
    name: "task_assign",
    description:
      "Assign a task to someone — an agent id from the agent list, or \"user\". Reassigning replaces the previous assignee.",
    parameters: def(
      "task_assign",
      "",
      {
        id: str("The task id to assign."),
        assignee: str("Who should do it: an agent id or \"user\"."),
      },
      ["id", "assignee"],
    ),
    category: "tasks",
    readOnly: false,
    destructive: false,
    async execute(ctx, args): Promise<AgentToolOutcome> {
      if (!(await authorize(ctx, args))) return DENIED;
      const id = typeof args.id === "string" ? args.id : "";
      if (!id) return taskError("task_assign needs a task id.");
      const assignee = typeof args.assignee === "string" && args.assignee.trim() ? args.assignee.trim() : null;
      if (!assignee) return taskError("task_assign needs an assignee.");
      const res = service.update(workspaceOf(ctx), id, { assignee }, actor(ctx));
      if (!res.ok) return taskError(res.error);
      return {
        granted: true,
        text: `Assigned task ${id} to ${assignee}.`,
        data: { id, assignee },
      };
    },
  };

  return [create, update, list, complete, cancel, retry, assign];
}

/**
 * Assemble the seven task tools over the caller's service instance.
 *
 * The process wiring passes the app's one real store here (`createDefaultRegistry`),
 * and unit suites pass a fake — the tools do not care which, because all they
 * ever do is translate arguments and describe results.
 */
export function createTaskTools(service: TaskToolService): AgentTool[] {
  return makeTools(service);
}

export const TASK_TOOL_NAMES: readonly string[] = Object.freeze([
  "task_create",
  "task_update",
  "task_list",
  "task_complete",
  "task_cancel",
  "task_retry",
  "task_assign",
]);