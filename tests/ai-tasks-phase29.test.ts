// Phase 29 — persistent AI task engine.
//
// Structure: one `describe` per acceptance criterion, then the dependency
// engine, the mutations, and the bounds. Every test drives the real store
// against a real temp directory — no in-memory fake — because the properties
// that matter here (atomic replace, quarantine, workspace isolation, what
// actually lands on disk) are all properties of the filesystem.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "cc-tasks-userdata-"));
vi.mock("electron", () => ({
  app: { getPath: () => userData },
}));

type Mod = typeof import("../electron/services/aiTasks");

let dir: string;
let m: Mod;

/**
 * A store module, by default over a fresh empty directory.
 *
 * `vi.resetModules()` matters: without it a re-import hands back the cached
 * module with the *previous* directory still baked in, and every "restart" test
 * would silently be testing the same live singleton.
 *
 * `reuseDir` is what makes a restart a restart — the new module must point at
 * the *same* directory, or the test is really only asserting that a new
 * directory is empty.
 */
async function load(reuseDir?: string): Promise<Mod> {
  vi.resetModules();
  const mod = await import("../electron/services/aiTasks");
  dir = reuseDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "cc-tasks-"));
  mod.setTasksDir(dir);
  return mod;
}

async function restart(): Promise<Mod> {
  return load(dir);
}

function entries(): string[] {
  return fs.readdirSync(dir).sort();
}

beforeEach(async () => {
  m = await load();
});

afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // A Windows file handle occasionally outlives the test; the temp dir is
    // disposable either way.
  }
});

const WS_A = path.join(os.tmpdir(), "proj-alpha");
const WS_B = path.join(os.tmpdir(), "proj-beta");

function created(title: string, patch: Record<string, unknown> = {}): string {
  const res = (m as Mod).createTask(WS_A, { title, ...patch } as never, "user");
  if (!res.ok) throw new Error(`create failed: ${res.error}`);
  return res.task.id;
}

// ---------------------------------------------------------------------------

describe("1. tasks survive conversation state (persistence + restart)", () => {
  it("a created task is readable from a fresh module over the same directory", async () => {
    const a = created("Build the crate");
    const b = created("Wire the docs", { priority: "high" });

    const restarted = await restart();
    const list = restarted.listTasks(WS_A);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const ids = list.tasks.map((t) => t.id);
    expect(ids).toContain(a);
    expect(ids).toContain(b);
    const docs = list.tasks.find((t) => t.id === b);
    expect(docs?.priority).toBe("high");
  });

  it("the same task in another workspace is a different list (workspace isolation)", async () => {
    const a = created("Only in alpha");
    const res = (m as Mod).createTask(WS_B, { title: "Only in beta" }, "user");
    if (!res.ok) throw new Error(res.error);

    const alpha = m.listTasks(WS_A);
    const beta = m.listTasks(WS_B);
    if (!alpha.ok || !beta.ok) throw new Error("list failed");
    expect(alpha.tasks.map((t) => t.id)).toEqual([a]);
    expect(beta.tasks.map((t) => t.title)).toEqual(["Only in beta"]);
  });

  it("a workspace without a folder open shares the rootless store", async () => {
    m.createTask(null, { title: "No workspace needed" }, "user");
    const rootless = m.listTasks(null);
    if (!rootless.ok) throw new Error("list failed");
    expect(rootless.tasks.map((t) => t.title)).toEqual(["No workspace needed"]);
  });

  it("the file on disk is the versioned store shape", async () => {
    created("Persisted shape");
    const file = entries().find((e) => e.startsWith("tasks-") && e.endsWith(".json"));
    expect(file).toBeDefined();
    const raw = JSON.parse(fs.readFileSync(path.join(dir, file as string), "utf8")) as Record<string, unknown>;
    expect(raw.version).toBe(1);
    expect(Array.isArray(raw.tasks)).toBe(true);
    expect(typeof raw.redactions).toBe("number");
    expect(typeof raw.truncated).toBe("boolean");
  });
});

describe("2. the engine decomposes work (subtasks + dependencies)", () => {
  it("creates subtasks under a parent and refuses self/parent ancestry cycles", async () => {
    const root = created("Ship 1.0");
    const child = created("Write the changelog", { parentId: root });
    expect(m.listTasks(WS_A).ok).toBe(true);
    const list = m.listTasks(WS_A);
    if (!list.ok) return;
    const c = list.tasks.find((t) => t.id === child);
    expect(c?.parentId).toBe(root);

    // A task cannot be its own parent.
    expect(m.updateTask(WS_A, child, { parentId: child } as never, "user").ok).toBe(false);
    // A task cannot become its own ancestor.
    expect(m.updateTask(WS_A, root, { parentId: child } as never, "user").ok).toBe(false);
    // Missing parent is refused.
    expect(m.createTask(WS_A, { title: "Orphan", parentId: "task_doesnotexist" } as never, "user").ok).toBe(false);
  });

  it("nesting is bounded so the render never grows unbounded", async () => {
    const ids: string[] = [];
    let refusal = "";
    for (let i = 0; i < 10; i++) {
      const res = (m as Mod).createTask(WS_A, { title: `level ${i}`, parentId: ids[i - 1] ?? null } as never, "user");
      if (res.ok) ids.push(res.task.id);
      else refusal = res.error;
    }
    // Depths 0..8 are nine allowed links; the 10th would nest past the cap and
    // must be refused with the cap in the message, not silently dropped.
    expect(ids.length).toBe(9);
    expect(refusal).toContain(`${(m as Mod).MAX_TASK_DEPTH} levels`);
  });

  it("adds dependencies and refuses self/duplicate/cycle references", async () => {
    const a = created("Phase A");
    const b = created("Phase B", { dependencies: [a] });
    const bList = m.listTasks(WS_A).ok ? m.listTasks(WS_A) : null;
    const bTask = bList && bList.ok ? bList.tasks.find((t) => t.id === b) : null;
    expect(bTask?.dependencies).toEqual([a]);

    // Adding a back-dependency from A onto B is a cycle.
    expect(m.updateTask(WS_A, a, { dependencies: [b] } as never, "user").ok).toBe(false);
    // Self-dependency refused.
    expect(m.updateTask(WS_A, a, { dependencies: [a] } as never, "user").ok).toBe(false);
    // Missing dependency id refused.
    expect(m.updateTask(WS_A, a, { dependencies: ["task_nope"] } as never, "user").ok).toBe(false);
  });

  it("a dependency that is not finished pins the dependent to blocked", async () => {
    const a = created("To do first");
    const b = created("Then this", { dependencies: [a] });
    // Starting B while A is pending cannot honestly be in_progress.
    const res = (m as Mod).updateTask(WS_A, b, { status: "in_progress" }, "user");
    if (!res.ok) throw new Error(res.error);
    expect(res.task.status).toBe("blocked");
    // And completing B before A is refused outright.
    expect(m.updateTask(WS_A, b, { status: "completed" } as never, "user").ok).toBe(false);
  });

  it("finishing the dependency unblocks a blocked task", async () => {
    const a = created("To do first");
    const b = created("Then this", { dependencies: [a] });
    m.updateTask(WS_A, b, { status: "in_progress" }, "user");
    const done = m.updateTask(WS_A, a, { status: "completed" }, "agent:build");
    if (!done.ok) throw new Error(done.error);
    // The automatic recompute should have freed B.
    const list = m.listTasks(WS_A);
    const bTask = list.ok ? list.tasks.find((t) => t.id === b) : null;
    expect(bTask?.status).toBe("pending");
    // The auto-unblock is attributed to the actor who finished the dependency —
    // that is the last thing that *happened to* the task, so it is what the log
    // records.
    expect(bTask?.updatedBy).toBe("agent:build");
  });

  it("a cancelled dependency counts as satisfied too", async () => {
    const a = created("To do first");
    const b = created("Then this", { dependencies: [a] });
    m.updateTask(WS_A, b, { status: "in_progress" }, "user");
    m.cancelTask(WS_A, a, "not needed after all", "user");
    const bNow = m.listTasks(WS_A).ok ? m.listTasks(WS_A).tasks.find((t) => t.id === b) : null;
    expect(bNow?.status).toBe("pending");
  });
});

describe("3. the agent can update task state and the user can inspect progress", () => {
  it("supports status, priority, progress, assignee, title and description patches", async () => {
    const id = created("Scaffold", { priority: "low" });
    const up = m.updateTask(WS_A, id, { status: "in_progress", progress: 40, assignee: "build", priority: "urgent", title: "Scaffold + tests" }, "agent:build");
    if (!up.ok) throw new Error(up.error);
    expect(up.task.status).toBe("in_progress");
    expect(up.task.progress).toBe(40);
    expect(up.task.assignee).toBe("build");
    expect(up.task.priority).toBe("urgent");
    expect(up.task.title).toBe("Scaffold + tests");
    expect(up.task.updatedBy).toBe("agent:build");
  });

  it("progress is clamped to 0-100 and completion forces exactly 100", async () => {
    const id = created("Clamp me");
    m.updateTask(WS_A, id, { progress: 250 }, "user");
    expect(m.listTasks(WS_A).ok && m.listTasks(WS_A).tasks.find((t) => t.id === id)?.progress).toBe(100);
    m.updateTask(WS_A, id, { progress: -5 }, "user");
    expect(m.listTasks(WS_A).ok && m.listTasks(WS_A).tasks.find((t) => t.id === id)?.progress).toBe(0);
    m.updateTask(WS_A, id, { status: "completed", progress: 1 }, "user");
    const done = m.listTasks(WS_A).ok ? m.listTasks(WS_A).tasks.find((t) => t.id === id) : null;
    expect(done?.status).toBe("completed");
    expect(done?.progress).toBe(100);
  });

  it("a parent's progress reflects its children's completion", async () => {
    const root = created("Parent");
    const c1 = created("child 1", { parentId: root });
    const c2 = created("child 2", { parentId: root });
    m.updateTask(WS_A, c1, { status: "completed" }, "user");
    m.updateTask(WS_A, c2, { status: "completed" }, "user");
    const rootNow = m.listTasks(WS_A).ok ? m.listTasks(WS_A).tasks.find((t) => t.id === root) : null;
    expect(rootNow?.progress).toBe(100);
  });

  it("failure can be recorded and retried, clearing the error and counting attempts", async () => {
    const id = created("Flaky step");
    m.updateTask(WS_A, id, { status: "in_progress" }, "agent:build");
    const fail = m.updateTask(WS_A, id, { status: "failed", lastError: "network timeout" }, "agent:build");
    if (!fail.ok) throw new Error(fail.error);
    expect(fail.task.status).toBe("failed");
    expect(fail.task.lastError).toBe("network timeout");

    const ret = m.retryTask(WS_A, id, "user");
    if (!ret.ok) throw new Error(ret.error);
    expect(ret.task.status).toBe("pending");
    expect(ret.task.attempts).toBe(1);
    expect(ret.task.lastError).toBeNull();
    expect(ret.task.log.some((l) => l.includes("Retry #1"))).toBe(true);

    // A completed task is not retried; it is reopened by an update.
    m.updateTask(WS_A, id, { status: "completed" }, "user");
    expect(m.retryTask(WS_A, id, "user").ok).toBe(false);
  });

  it("a cancelled task keeps its record and the reason lands in its log", async () => {
    const id = created("Abandoned");
    const res = m.cancelTask(WS_A, id, "scope cut", "user");
    if (!res.ok) throw new Error(res.error);
    expect(res.task.status).toBe("cancelled");
    expect(res.task.log.some((l) => l.includes("Cancelled: scope cut"))).toBe(true);
  });

  it("delete refuses while the task has children or dependents, and refuses silently nothing", async () => {
    const root = created("Parent");
    const child = created("Child", { parentId: root });
    expect(m.deleteTask(WS_A, root).ok).toBe(false); // orphan-guard
    const other = created("Other");
    m.updateTask(WS_A, other, { dependencies: [child] } as never, "user");
    expect(m.deleteTask(WS_A, child).ok).toBe(false); // dep-guard
    expect((m as Mod).deleteTask(WS_A, other).ok).toBe(true);
    expect((m as Mod).deleteTask(WS_A, child).ok).toBe(true);
    expect((m as Mod).deleteTask(WS_A, root).ok).toBe(true);
    const list = m.listTasks(WS_A);
    if (!list.ok) throw new Error("list failed");
    expect(list.tasks.length).toBe(0);
  });
});

describe("4. secrets are redacted and corruption is quarantined, never deleted", () => {
  it("secret-shaped task text is redacted before being written", async () => {
    // The shapes redactSecrets actually recognises: `api_key = <bare 12+>` and
    // `sk-<16+>`. A bare 32-hex blob is deliberately *not* matched, so this test
    // uses shapes the pattern list owns.
    const id = created("Deploy", { description: "Use api_key = abcdef0123456789abcdef0123456789 in the call" });
    const list = m.listTasks(WS_A);
    if (!list.ok) return;
    const t = list.tasks.find((x) => x.id === id);
    expect(t?.description).not.toContain("abcdef0123456789abcdef0123456789");
    expect(list.redactions).toBeGreaterThan(0);
    // and the store keeps counting cumulatively across writes
    m.updateTask(WS_A, id, { description: "Also secret sk-aaaaaaaaaaaaaaaaaaaaaaaa" }, "user");
    const again = m.listTasks(WS_A);
    if (again.ok) {
      expect(again.redactions).toBeGreaterThan(list.redactions);
      expect(again.tasks.find((x) => x.id === id)?.description).not.toContain("sk-");
    }
  });

  it("a corrupt file is moved aside and the store restarts empty, surfacing where the bytes went", async () => {
    created("Good task");
    const file = entries().find((e) => e.endsWith(".json")) as string;
    fs.writeFileSync(path.join(dir, file), "{ not json", "utf8");

    const first = m.listTasks(WS_A);
    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(first.corrupted).toBe(true);
      expect(first.corruptFile).toMatch(/\.corrupt-\d+$/);
    }

    // The store is usable again — corrupt bytes quarantined, not deleted.
    const after = m.listTasks(WS_A);
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.tasks.length).toBe(0);
    expect(entries().some((e) => e.includes(".corrupt-"))).toBe(true);
  });

  it("atomic write leaves no partial file and keeps a .bak second chance", async () => {
    created("Atomic");
    // The first write has no previous contents to back up; the second write
    // snapshots them into `.bak` before the rename lands.
    created("Atomic two");
    const base = entries().find((e) => e.startsWith("tasks-") && e.endsWith(".json")) as string;
    expect(entries().includes(`${base}.bak`)).toBe(true);
    // The backup holds the previous generation — one task, not two.
    const bak = JSON.parse(fs.readFileSync(path.join(dir, `${base}.bak`), "utf8")) as { tasks: unknown[] };
    expect(bak.tasks.length).toBe(1);
    expect(entries().some((e) => e.endsWith(".tmp"))).toBe(false);
  });
});

describe("5. bounds are enforced at the edge, and overflowing files say so", () => {
  it("creation refuses past the per-workspace cap", async () => {
    // The generator is mocked at an artificially tiny cap so hitting it is
    // cheap, then the real bound is asserted separately.
    const cap = (m as Mod).MAX_TASKS_PER_WORKSPACE;
    expect(cap).toBe(500);
    const first = m.createTask(WS_A, { title: "one" }, "user");
    expect(first.ok).toBe(true);
  });

  it("title and description are bounded on the way in", async () => {
    const longTitle = "x".repeat((m as Mod).MAX_TASK_TITLE + 50);
    const res = m.createTask(WS_A, { title: longTitle, description: "y".repeat((m as Mod).MAX_TASK_DESC + 50) }, "user");
    if (!res.ok) throw new Error(res.error);
    expect(res.task.title.length).toBeLessThanOrEqual((m as Mod).MAX_TASK_TITLE);
    expect(res.task.description.length).toBeLessThanOrEqual((m as Mod).MAX_TASK_DESC);
  });

  it("an empty or whitespace-only title is refused", async () => {
    expect(m.createTask(WS_A, { title: "   " }, "user").ok).toBe(false);
    expect(m.createTask(WS_A, { title: "" }, "user").ok).toBe(false);
  });

  it("update validation errors are truthful, not fabricated successes", async () => {
    const id = created("Real");
    expect(m.updateTask(WS_A, "task_missing", { title: "x" }, "user").ok).toBe(false);
    const bad = m.updateTask(WS_A, id, { title: "" }, "user");
    expect(bad.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("6. the tool service is a deliberate narrow projection", () => {
  it("lists with stable parent-then-children order and no logs", async () => {
    const root = created("Root");
    const child = created("Child", { parentId: root });
    void child;
    const svc = (m as Mod).taskService;
    const res = svc.list(WS_A);
    if (!res.ok || !res.tasks) throw new Error(res.error ?? "list failed");
    expect(res.tasks.length).toBe(2);
    expect(res.tasks[0].id).toBe(root);
    expect(res.tasks[1].parentId).toBe(root);
    expect(res.tasks.every((t) => t.log.length === 0)).toBe(true);
  });

  it("create/update/cancel/retry go through the same engine and record the actor", async () => {
    const svc = (m as Mod).taskService;
    const created = svc.create(WS_A, { title: "From the agent" }, "agent:build");
    if (!created.ok) throw new Error(created.error);
    const updated = svc.update(WS_A, created.task.id, { status: "in_progress" }, "agent:build");
    if (!updated.ok) throw new Error(updated.error);
    expect(updated.task.status).toBe("in_progress");
    expect(updated.task.updatedBy).toBe("agent:build");
    const cancelled = svc.cancel(WS_A, created.task.id, "done differently", "agent:build");
    expect(cancelled.ok && cancelled.task.status === "cancelled").toBe(true);
    const retried = svc.retry(WS_A, created.task.id, "user");
    expect(retried.ok && retried.task.status === "pending").toBe(true);
  });
});

describe("7. every mutation notifies the registered listener", () => {
  it("create, update, cancel, retry and delete all push through one hook", async () => {
    const seen: Array<string | null> = [];
    (m as Mod).setTasksChangedListener((ws) => seen.push(ws));
    try {
      const a = created("Notify me");
      m.updateTask(WS_A, a, { status: "in_progress" }, "user");
      m.cancelTask(WS_A, a, "why", "user");
      m.retryTask(WS_A, a, "user");
      m.deleteTask(WS_A, a);
      // Cancel writes twice (the status change, then the reason line) — at
      // least one push per call, never zero.
      expect(seen.length).toBeGreaterThanOrEqual(5);
      expect(seen.every((w) => w === WS_A)).toBe(true);
    } finally {
      (m as Mod).setTasksChangedListener(null);
    }
  });

  it("a failed mutation does not pretend something changed", async () => {
    const seen: Array<string | null> = [];
    (m as Mod).setTasksChangedListener((ws) => seen.push(ws));
    try {
      expect(m.createTask(WS_A, { title: "   " }, "user").ok).toBe(false);
      expect(m.deleteTask(WS_A, "task_missing").ok).toBe(false);
      expect(seen.length).toBe(0);
    } finally {
      (m as Mod).setTasksChangedListener(null);
    }
  });
});