// Close Code — persistent task list section (Phase 29)
//
// The user's half of the task engine: create, inspect, complete, cancel, retry,
// assign and delete — all through the task store, which is a projection of the
// main process's store files. The agent's half lives in the task tools and shows
// up in the AgentSection's trace; this panel shows the same list from the other
// side of the same store, so a task a run creates appears here in the same
// instant, and a task this panel completes is a fact the next run reads from
// `task_list`.
//
// The list is workspace-scoped and follows the open folder. Nothing here
// invents a task: rows come from the store, buttons map one-to-one onto IPC
// channels, and every failure the main process reports is rendered as-is.

import { useEffect, useMemo, useState } from "react";
import { useTaskStore } from "../../stores/taskStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useAgentStore } from "../../stores/agentStore";
import type { AiTask, TaskPriority, TaskStatus } from "../../types/electron";

const STATUS_STYLE: Record<TaskStatus, string> = {
  pending: "text-cc-muted",
  in_progress: "text-sky-400",
  blocked: "text-amber-400",
  completed: "text-green-500",
  cancelled: "text-cc-muted line-through",
  failed: "text-red-400",
};

const STATUS_TEXT: Record<TaskStatus, string> = {
  pending: "pending",
  in_progress: "in progress",
  blocked: "blocked",
  completed: "done",
  cancelled: "cancelled",
  failed: "failed",
};

const PRIORITY_TEXT: Record<TaskPriority, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  urgent: "urgent",
};

const PRIORITY_STYLE: Record<TaskPriority, string> = {
  low: "text-cc-muted",
  medium: "text-cc-text",
  high: "text-amber-400",
  urgent: "text-red-400",
};

interface FlatRow {
  task: AiTask;
  depth: number;
}

/** Flatten the parent/child graph into render order: each task directly after its parent. */
function flatten(tasks: AiTask[]): FlatRow[] {
  const byParent = new Map<string | null, AiTask[]>();
  for (const t of tasks) {
    const key = t.parentId ?? null;
    const list = byParent.get(key) ?? [];
    list.push(t);
    byParent.set(key, list);
  }
  const orderedByCreated = (list: AiTask[] | undefined): AiTask[] =>
    [...(list ?? [])].sort((a, b) => a.createdAt - b.createdAt);
  const rows: FlatRow[] = [];
  const walk = (parentId: string | null, depth: number): void => {
    for (const task of orderedByCreated(byParent.get(parentId))) {
      rows.push({ task, depth });
      walk(task.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

export default function TaskSection(): React.JSX.Element {
  const store = useTaskStore();
  const workspaceRoot = useWorkspaceStore((s) => s.root) ?? null;
  const agentDefs = useAgentStore((s) => s.definitions);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [parent, setParent] = useState("");

  // One subscription for both concerns: the store listens for pushes and reads
  // the current workspace's list.
  useEffect(() => {
    store.startListening();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow the open folder. Re-pointing clears the previous workspace's rows —
  // a task from the last project is not allowed to masquerade as this one's.
  useEffect(() => {
    void store.setWorkspace(workspaceRoot);
  }, [workspaceRoot]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => flatten(store.tasks), [store.tasks]);
  const taskTitles = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of store.tasks) map.set(t.id, t.title);
    return map;
  }, [store.tasks]);

  const submit = (): void => {
    const trimmed = title.trim();
    if (!trimmed) return;
    const input: { title: string; description?: string; priority: TaskPriority; parentId?: string } = {
      title: trimmed,
      priority,
    };
    if (description.trim()) input.description = description.trim();
    if (parent) input.parentId = parent;
    void store.create(input).then(() => {
      setTitle("");
      setDescription("");
      setParent("");
      setPriority("medium");
    });
  };

  return (
    <div className="px-3 py-2 border-b border-cc-border shrink-0 max-h-72 overflow-y-auto" data-ai-tasks>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[11px] font-semibold text-cc-muted uppercase tracking-wide">
          Tasks{rows.length > 0 ? ` (${rows.length})` : ""}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {store.busy && <span className="text-[11px] text-cc-muted">saving…</span>}
        </div>
      </div>

      {store.error && (
        <div
          className="mb-1.5 text-[11px] text-red-400 bg-red-500/10 border border-red-500/30 rounded px-2 py-1"
          data-ai-task-error
        >
          {store.error}
        </div>
      )}
      {store.notice && (
        <div
          className="mb-1.5 text-[11px] text-cc-muted bg-cc-surface border border-cc-border rounded px-2 py-1"
          data-ai-task-notice
        >
          {store.notice}
        </div>
      )}

      {/* Create form */}
      <div className="mb-2 flex flex-col gap-1">
        <div className="flex items-center gap-1.5">
          <input
            className="flex-1 min-w-0 bg-cc-surface border border-cc-border rounded px-2 py-1 text-xs text-cc-text outline-none"
            placeholder="New task… (also creatable by the AI)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            data-task-create-title
          />
          <select
            className="bg-cc-surface border border-cc-border rounded px-1 py-1 text-[11px] text-cc-muted outline-none"
            value={priority}
            onChange={(e) => setPriority(e.target.value as TaskPriority)}
            data-task-create-priority
          >
            {(Object.keys(PRIORITY_TEXT) as TaskPriority[]).map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="text-[11px] px-2 py-1 rounded border border-cc-border hover:bg-cc-surface text-cc-text"
            onClick={submit}
            disabled={!title.trim()}
            data-task-create-add
          >
            Add
          </button>
        </div>
        {store.tasks.length > 0 && (
          <div className="flex items-center gap-1.5">
            <select
              className="flex-1 min-w-0 bg-cc-surface border border-cc-border rounded px-2 py-1 text-[11px] text-cc-muted outline-none"
              value={parent}
              onChange={(e) => setParent(e.target.value)}
              data-task-create-parent
            >
              <option value="">Subtask of… (none)</option>
              {store.tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title.length > 48 ? `${t.title.slice(0, 48)}…` : t.title}
                </option>
              ))}
            </select>
            <input
              className="flex-1 min-w-0 bg-cc-surface border border-cc-border rounded px-2 py-1 text-[11px] text-cc-text outline-none"
              placeholder="Optional description…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              data-task-create-description
            />
          </div>
        )}
      </div>

      {/* List */}
      {rows.length === 0 ? (
        <div className="text-[11px] text-cc-muted" data-task-empty>
          No tasks for this workspace yet.
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {rows.map(({ task, depth }) => (
            <div
              key={task.id}
              className="flex flex-col gap-1 rounded border border-cc-border/60 bg-cc-surface/40 px-2 py-1.5"
              style={{ marginLeft: `${Math.min(depth, 6) * 12}px` }}
              data-task-item={task.id}
              data-task-depth={depth}
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <span className={`text-[11px] shrink-0 ${STATUS_STYLE[task.status]}`} data-task-status={task.id}>
                  {STATUS_TEXT[task.status]}
                </span>
                <span
                  className="text-[11px] font-medium text-cc-text truncate"
                  title={task.description || task.title}
                  data-task-title={task.id}
                >
                  {task.title}
                </span>
                <span className={`text-[10px] shrink-0 ${PRIORITY_STYLE[task.priority]}`} data-task-priority={task.id}>
                  {PRIORITY_TEXT[task.priority]}
                </span>
                {task.dependencies.length > 0 && (
                  <span className="text-[10px] text-amber-400 shrink-0" data-task-deps={task.id}>
                    ⛓ {task.dependencies.length}
                  </span>
                )}
                {task.assignee && (
                  <span className="text-[10px] text-cc-muted shrink-0" data-task-assignee={task.id}>
                    @{task.assignee}
                  </span>
                )}
                <div className="ml-auto flex items-center gap-1 shrink-0">
                  {(task.status === "pending" || task.status === "blocked") && (
                    <button
                      type="button"
                      className="text-[10px] px-1.5 py-0.5 rounded border border-cc-border hover:bg-cc-surface text-cc-muted hover:text-cc-text"
                      onClick={() => void store.update(task.id, { status: "in_progress" })}
                      title="Start working"
                      data-task-start={task.id}
                    >
                      start
                    </button>
                  )}
                  {task.status !== "completed" && task.status !== "cancelled" && (
                    <button
                      type="button"
                      className="text-[10px] px-1.5 py-0.5 rounded border border-green-500/40 hover:bg-green-500/10 text-green-500"
                      onClick={() => void store.update(task.id, { status: "completed" })}
                      title="Mark completed"
                      data-task-complete={task.id}
                    >
                      ✓
                    </button>
                  )}
                  {task.status !== "completed" && task.status !== "cancelled" && (
                    <button
                      type="button"
                      className="text-[10px] px-1.5 py-0.5 rounded border border-cc-border hover:bg-cc-surface text-cc-muted hover:text-cc-text"
                      onClick={() => void store.cancel(task.id)}
                      title="Cancel (keeps the record)"
                      data-task-cancel={task.id}
                    >
                      ✕
                    </button>
                  )}
                  {(task.status === "failed" || task.status === "cancelled") && (
                    <button
                      type="button"
                      className="text-[10px] px-1.5 py-0.5 rounded border border-amber-500/40 hover:bg-amber-500/10 text-amber-400"
                      onClick={() => void store.retry(task.id)}
                      title="Retry"
                      data-task-retry={task.id}
                    >
                      ↻
                    </button>
                  )}
                  <button
                    type="button"
                    className="text-[10px] px-1.5 py-0.5 rounded border border-cc-border hover:bg-red-500/10 text-cc-muted hover:text-red-400"
                    onClick={() => void store.remove(task.id)}
                    title="Delete"
                    data-task-delete={task.id}
                  >
                    🗑
                  </button>
                  <select
                    className="bg-cc-surface border border-cc-border rounded px-1 py-0.5 text-[10px] text-cc-muted outline-none max-w-24"
                    value={task.assignee ?? ""}
                    onChange={(e) => void store.assign(task.id, e.target.value || null)}
                    title="Assign to…"
                    data-task-assign={task.id}
                  >
                    <option value="">assign…</option>
                    <option value="user">user</option>
                    {agentDefs.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.id}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {(task.progress > 0 || task.status === "completed" || task.status === "failed") && (
                <div className="flex items-center gap-1.5">
                  <div className="flex-1 h-1 bg-cc-surface rounded overflow-hidden">
                    <div
                      className="h-full bg-cc-accent rounded"
                      style={{ width: `${task.progress}%` }}
                      data-task-progress={task.id}
                    />
                  </div>
                  <span className="text-[10px] text-cc-muted">{task.progress}%</span>
                </div>
              )}
              {task.lastError && (
                <div className="text-[10px] text-red-400 break-words" data-task-error={task.id}>
                  {task.lastError}
                </div>
              )}
              {task.dependencies.length > 0 && (
                <div className="text-[10px] text-amber-400/90 break-words" data-task-dep-names={task.id}>
                  waits on: {task.dependencies.map((d) => taskTitles.get(d) ?? d).join(", ")}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}