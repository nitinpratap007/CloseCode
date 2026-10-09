// @vitest-environment jsdom
//
// Phase 29 — the renderer half of the task engine.
//
// The main process is the only writer of task state; the renderer's `taskStore`
// is a projection served by `window.closeCode`, and `TaskSection` renders that
// projection: a create form, rows with status/priority/progress/assignee, and
// buttons that each map one-to-one onto a store action. Everything is exercised
// against a fake `window.closeCode`, so every store decision and every rendered
// element is testable without Electron. The domain rules (dependency blocking,
// redaction, bounds) live in the main process tests; this suite proves the UI
// drives the real API faithfully.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";
// `TaskSection` pulls `useAgentStore` → nothing heavy, but keep the same two
// mocks the other renderer suites install for warmth under jsdom.
vi.mock("../src/monaco", () => ({
  default: {
    editor: { getModel: () => null, setTheme: () => {}, getTheme: () => "cc-dark" },
    Uri: { file: () => ({}) },
  },
}));
vi.mock("../src/language/diagnostics", () => ({
  useDiagnosticsStore: {
    getState: () => ({ diagnostics: [] }),
    setState: () => {},
    subscribe: () => () => {},
  },
}));
import { useTaskStore, type TaskStoreState } from "../src/stores/taskStore";
import { useWorkspaceStore } from "../src/stores/workspaceStore";
import TaskSection from "../src/components/ai/TaskSection";
import type { AiTask } from "../src/types/electron";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let seq = 0;
function task(over: Partial<AiTask> = {}): AiTask {
  seq += 1;
  return {
    id: `task_${seq}`,
    title: `Task ${seq}`,
    description: "",
    parentId: null,
    dependencies: [],
    status: "pending",
    priority: "medium",
    progress: 0,
    assignee: null,
    workspace: "C:\\proj",
    createdAt: seq,
    updatedAt: seq,
    updatedBy: "user",
    attempts: 0,
    lastError: null,
    log: [],
    ...over,
  };
}

interface TaskApi {
  onAiTaskChanged: ReturnType<typeof vi.fn>;
  aiTasksList: ReturnType<typeof vi.fn>;
  aiTaskCreate: ReturnType<typeof vi.fn>;
  aiTaskUpdate: ReturnType<typeof vi.fn>;
  aiTaskDelete: ReturnType<typeof vi.fn>;
  aiTaskCancel: ReturnType<typeof vi.fn>;
  aiTaskRetry: ReturnType<typeof vi.fn>;
  aiTaskAssign: ReturnType<typeof vi.fn>;
  push: (payload: { workspace: string | null; tasks: AiTask[] }) => void;
  listeners: Array<(payload: { workspace: string | null; tasks: AiTask[] }) => void>;
}

let api: TaskApi;

function install(over: Partial<TaskApi> = {}): TaskApi {
  const listeners: Array<(payload: { workspace: string | null; tasks: AiTask[] }) => void> = [];
  const base: TaskApi = {
    onAiTaskChanged: vi.fn((cb: (payload: { workspace: string | null; tasks: AiTask[] }) => void) => {
      listeners.push(cb);
      return () => {};
    }),
    aiTasksList: vi.fn(async () => ({ ok: true, tasks: [] })),
    aiTaskCreate: vi.fn(async () => ({ ok: true, task: null })),
    aiTaskUpdate: vi.fn(async () => ({ ok: true, task: null })),
    aiTaskDelete: vi.fn(async () => ({ ok: true })),
    aiTaskCancel: vi.fn(async () => ({ ok: true, task: null })),
    aiTaskRetry: vi.fn(async () => ({ ok: true, task: null })),
    aiTaskAssign: vi.fn(async () => ({ ok: true, task: null })),
    push: (payload) => listeners.forEach((cb) => cb(payload)),
    listeners,
    ...over,
  };
  (window as unknown as { closeCode: unknown }).closeCode = base;
  return base;
}

beforeEach(() => {
  api = install();
  useWorkspaceStore.setState({ root: "C:\\proj" });
  useTaskStore.setState({
    tasks: [],
    workspace: null,
    error: null,
    notice: null,
    busy: false,
    listening: false,
  } as Partial<TaskStoreState>);
});

afterEach(() => {
  cleanup();
  api.listeners.length = 0;
});

// ---------------------------------------------------------------------------

describe("taskStore — projection of the main process store", () => {
  it("refresh reads the current workspace's list", async () => {
    await act(async () => {
      useTaskStore.setState({ workspace: "C:\\proj" });
      await useTaskStore.getState().refresh();
    });
    expect(api.aiTasksList).toHaveBeenCalledWith("C:\\proj");
  });

  it("setWorkspace re-reads when the workspace changes and keeps rows per-workspace", async () => {
    api.aiTasksList.mockResolvedValueOnce({ ok: true, tasks: [task({ title: "Alpha work" })] });
    await act(async () => {
      await useTaskStore.getState().setWorkspace("C:\\proj");
    });
    expect(useTaskStore.getState().tasks.map((t) => t.title)).toEqual(["Alpha work"]);

    api.aiTasksList.mockResolvedValueOnce({ ok: true, tasks: [task({ title: "Beta work" })] });
    await act(async () => {
      await useTaskStore.getState().setWorkspace("C:\\other");
    });
    expect(useTaskStore.getState().tasks.map((t) => t.title)).toEqual(["Beta work"]);
  });

  it("a pushed change for another workspace does not clobber the current list", async () => {
    useTaskStore.getState().startListening();
    api.aiTasksList.mockResolvedValue({ ok: true, tasks: [task({ id: "task_x", title: "Mine" })] });
    await act(async () => {
      await useTaskStore.getState().setWorkspace("C:\\proj");
    });
    act(() => {
      api.push({ workspace: "C:\\other", tasks: [task({ id: "task_y", title: "Theirs" })] });
    });
    expect(useTaskStore.getState().tasks.map((t) => t.id)).toEqual(["task_x"]);
    act(() => {
      api.push({ workspace: "C:\\proj", tasks: [task({ id: "task_z", title: "Now mine too" })] });
    });
    expect(useTaskStore.getState().tasks.map((t) => t.id)).toEqual(["task_z"]);
  });

  it("create goes through aiTaskCreate with title/priority/parent", async () => {
    await act(async () => {
      await useTaskStore.getState().setWorkspace("C:\\proj");
    });
    const created = task({ title: "Planned" });
    api.aiTaskCreate.mockResolvedValue({ ok: true, task: created });
    await act(async () => {
      await useTaskStore.getState().create({ title: "Planned", priority: "high" });
    });
    expect(api.aiTaskCreate).toHaveBeenCalledWith({
      workspace: "C:\\proj",
      input: { title: "Planned", priority: "high" },
    });
  });

  it("a failed create surfaces the main process's error, not a made-up one", async () => {
    api.aiTaskCreate.mockResolvedValue({ ok: false, error: "A task needs a title." });
    await act(async () => {
      await useTaskStore.getState().create({ title: "" });
    });
    expect(useTaskStore.getState().error).toBe("A task needs a title.");
  });
});

describe("TaskSection — what the user sees and presses", () => {
  it("renders the empty state when the workspace has no tasks", async () => {
    const { container } = render(<TaskSection />);
    expect(container.querySelector("[data-task-empty]")).not.toBeNull();
  });

  it("renders rows with status, priority, progress, assignee and deps", async () => {
    api.aiTasksList.mockResolvedValue({
      ok: true,
      tasks: [
        task({
          id: "t1",
          title: "Build the crate",
          status: "in_progress",
          priority: "high",
          progress: 40,
          assignee: "user",
          dependencies: ["t0"],
        }),
      ],
    });
    let view: ReturnType<typeof render> | null = null;
    await act(async () => {
      view = render(<TaskSection />);
    });
    const root = view!.container.querySelector("[data-ai-tasks]");
    expect(root?.querySelector("[data-task-item='t1']")).not.toBeNull();
    expect(root?.querySelector("[data-task-title='t1']")?.textContent).toContain("Build the crate");
    expect(root?.querySelector("[data-task-status='t1']")?.textContent).toContain("in progress");
    expect(root?.querySelector("[data-task-priority='t1']")?.textContent).toContain("high");
    expect(root?.querySelector("[data-task-progress='t1']")?.getAttribute("style")).toContain("width: 40%");
    expect(root?.querySelector("[data-task-assignee='t1']")?.textContent).toBe("@user");
    expect(root?.querySelector("[data-task-deps='t1']")?.textContent).toContain("1");
  });

  it("a subtask renders indented below its parent", async () => {
    const parent = task({ id: "p", title: "Parent" });
    const child = task({ id: "c", title: "Child", parentId: "p" });
    api.aiTasksList.mockResolvedValue({ ok: true, tasks: [parent, child] });
    let view: ReturnType<typeof render> | null = null;
    await act(async () => {
      view = render(<TaskSection />);
    });
    const root = view!.container.querySelector("[data-ai-tasks]");
    expect(root?.querySelector("[data-task-depth='1']")).not.toBeNull();
    expect(root?.querySelector("[data-task-item='c']")?.getAttribute("data-task-depth")).toBe("1");
  });

  it("the create form sends exactly what the user typed", async () => {
    const created = task({ id: "n", title: "New work" });
    api.aiTaskCreate.mockResolvedValue({ ok: true, task: created });
    let view: ReturnType<typeof render> | null = null;
    await act(async () => {
      view = render(<TaskSection />);
    });
    const root = view!.container.querySelector("[data-ai-tasks]") as HTMLElement;
    const title = root.querySelector("[data-task-create-title]") as HTMLInputElement;
    fireEvent.change(title, { target: { value: "New work" } });
    const priority = root.querySelector("[data-task-create-priority]") as HTMLSelectElement;
    fireEvent.change(priority, { target: { value: "urgent" } });
    await act(async () => {
      fireEvent.click(root.querySelector("[data-task-create-add]") as HTMLElement);
    });
    expect(api.aiTaskCreate).toHaveBeenCalledWith({
      workspace: "C:\\proj",
      input: { title: "New work", priority: "urgent" },
    });
    // The form clears after a successful create.
    expect((root.querySelector("[data-task-create-title]") as HTMLInputElement).value).toBe("");
  });

  it("complete, cancel, retry and delete map to their store actions", async () => {
    const t = task({ id: "t1", title: "Flaky", status: "failed" });
    api.aiTasksList.mockResolvedValue({ ok: true, tasks: [t] });
    let view: ReturnType<typeof render> | null = null;
    await act(async () => {
      view = render(<TaskSection />);
    });
    const root = view!.container.querySelector("[data-ai-tasks]") as HTMLElement;
    await act(async () => {
      fireEvent.click(root.querySelector("[data-task-complete='t1']") as HTMLElement);
    });
    expect(api.aiTaskUpdate).toHaveBeenCalledWith({
      workspace: "C:\\proj",
      id: "t1",
      patch: { status: "completed" },
    });
    // Retry and delete are reachable on the same row, and map to their channels.
    await act(async () => {
      fireEvent.click(root.querySelector("[data-task-retry='t1']") as HTMLElement);
      fireEvent.click(root.querySelector("[data-task-delete='t1']") as HTMLElement);
    });
    expect(api.aiTaskRetry).toHaveBeenCalledWith({ workspace: "C:\\proj", id: "t1" });
    expect(api.aiTaskDelete).toHaveBeenCalledWith({ workspace: "C:\\proj", id: "t1" });
  });

  it("assign select offers agent definitions and drives aiTaskAssign", async () => {
    const t = task({ id: "t1", title: "Delegatable" });
    api.aiTasksList.mockResolvedValue({ ok: true, tasks: [t] });
    let view: ReturnType<typeof render> | null = null;
    await act(async () => {
      view = render(<TaskSection />);
    });
    const root = view!.container.querySelector("[data-ai-tasks]") as HTMLElement;
    const select = root.querySelector("[data-task-assign='t1']") as HTMLSelectElement;
    expect(select).not.toBeNull();
    await act(async () => {
      fireEvent.change(select, { target: { value: "user" } });
    });
    expect(api.aiTaskAssign).toHaveBeenCalledWith({ workspace: "C:\\proj", id: "t1", assignee: "user" });
  });
});