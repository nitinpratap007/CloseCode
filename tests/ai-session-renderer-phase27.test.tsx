// @vitest-environment jsdom
//
// Phase 27 — the renderer half of persistent AI sessions.
//
// These two files shipped with **zero** unit tests, which is not a matter of taste:
// `vitest.config.ts` had no `.tsx` in `include` and no DOM environment, so there was
// no way to write one. That made the honest answer to "is this tested?" "not the part
// a user actually touches" — the E2E suite proves the controls exist by looking for
// `data-*` attributes, which says nothing about what happens when rename is cancelled
// or whether "keep it" really keeps.
//
// Both gaps are closed here:
//
//   * `sessionStore` is driven against a fake `window.closeCode`, so every action's
//     *decision* is tested — what it sends, what it refuses, what it reports, and what
//     it swallows. The store is the renderer's whole contract with the main process.
//   * `SessionBar` is rendered for real, and the paths a user can take are clicked
//     rather than described.
//
// The store singleton is reset between tests because it is a module-level `create()`,
// which is exactly how it behaves in the app.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";
import { useSessionStore, type SessionStoreState } from "../src/stores/sessionStore";
import { useWorkspaceStore } from "../src/stores/workspaceStore";
import SessionBar from "../src/components/ai/SessionBar";
import type { AiSession, AiSessionSummary, AiSessionHistoryTurn } from "../src/types/electron";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function summary(over: Partial<AiSessionSummary> = {}): AiSessionSummary {
  return {
    id: "s-one",
    name: "The flaky test",
    workspace: "C:\\ws",
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now(),
    status: "open",
    forkedFrom: null,
    turnCount: 2,
    runCount: 1,
    toolCallCount: 3,
    bytes: 2_048,
    redactions: 0,
    truncated: false,
    corrupted: false,
    ...over,
  };
}

function session(over: Partial<AiSession> = {}): AiSession {
  return {
    version: 1,
    id: "s-one",
    name: "The flaky test",
    workspace: "C:\\ws",
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now(),
    status: "open",
    forkedFrom: null,
    turns: [{ id: "t1", role: "user", text: "read the notes file", at: 1 }],
    runs: [],
    redactions: 0,
    truncated: false,
    ...over,
  };
}

interface FakeApi {
  aiSessionsList: ReturnType<typeof vi.fn>;
  aiSessionCreate: ReturnType<typeof vi.fn>;
  aiSessionOpen: ReturnType<typeof vi.fn>;
  aiSessionUpdate: ReturnType<typeof vi.fn>;
  aiSessionDelete: ReturnType<typeof vi.fn>;
  aiSessionFork: ReturnType<typeof vi.fn>;
  aiSessionTurn: ReturnType<typeof vi.fn>;
  onAiSessionChanged: ReturnType<typeof vi.fn>;
  /** Everything the fake pushes to listeners, so a test can fire the real callback. */
  push: (payload: { activeId: string | null; sessions: AiSessionSummary[] }) => void;
  listeners: number;
}

let api: FakeApi;

/**
 * A `window.closeCode` with the eight session members, defaulting to success.
 *
 * Every one is a `vi.fn` so a test can assert on what the store *sent*, which is the
 * only way to catch a store that quietly passes the wrong id — a bug that looks
 * correct in the UI and corrupts the wrong conversation.
 */
function installApi(): FakeApi {
  const listeners: Array<(p: { activeId: string | null; sessions: AiSessionSummary[] }) => void> = [];
  const f = {
    aiSessionsList: vi.fn(async () => ({ ok: true, sessions: [summary()] })),
    aiSessionCreate: vi.fn(async () => ({ ok: true, session: session() })),
    aiSessionOpen: vi.fn(async () => ({ ok: true, session: session(), history: [] })),
    aiSessionUpdate: vi.fn(async () => ({ ok: true, sessions: [summary()] })),
    aiSessionDelete: vi.fn(async () => ({ ok: true, sessions: [] })),
    aiSessionFork: vi.fn(async () => ({ ok: true, session: session({ id: "s-two", forkedFrom: "s-one" }) })),
    aiSessionTurn: vi.fn(async () => ({ ok: true, name: "The flaky test" })),
    onAiSessionChanged: vi.fn((cb: (p: { activeId: string | null; sessions: AiSessionSummary[] }) => void) => {
      listeners.push(cb);
      return () => {};
    }),
  };
  (window as unknown as { closeCode: unknown }).closeCode = f;
  return {
    ...f,
    push: (payload) => listeners.forEach((l) => l(payload)),
    get listeners() {
      return listeners.length;
    },
  } as FakeApi;
}

const IDLE: Omit<SessionStoreState, keyof Pick<SessionStoreState,
  "startListening" | "refresh" | "create" | "open" | "rename" | "setStatus" | "remove" |
  "fork" | "recordTurn" | "noteRunFiled" | "takeResumeHistory" | "clearError" | "dismissCorrupted">> = {
  sessions: [],
  activeId: null,
  current: null,
  resumeHistory: [],
  corrupted: null,
  error: null,
  notice: null,
  busy: false,
  listening: false,
};

beforeEach(() => {
  api = installApi();
  useSessionStore.setState({ ...IDLE });
  useWorkspaceStore.setState({ root: "C:\\ws", rootName: "ws" } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

describe("session store · what it sends to the main process", () => {
  it("a cold launch with nothing stored starts a session rather than showing an empty bar", async () => {
    api.aiSessionsList.mockResolvedValue({ ok: true, sessions: [] });
    api.aiSessionOpen.mockResolvedValue({ ok: false, error: "No session is open." });
    api.aiSessionCreate.mockResolvedValue({ ok: true, session: session({ id: "s-new", name: "New" }) });
    await act(async () => {
      await useSessionStore.getState().refresh();
    });
    // A first launch must not open onto a bar that says "no sessions", with the
    // feature invisible until the user reads the documentation.
    expect(api.aiSessionCreate).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState().activeId).toBe("s-new");
  });

  it("a cold launch resumes the session that was open, and says which", async () => {
    api.aiSessionOpen.mockResolvedValue({
      ok: true,
      session: session({ name: "Last night's bug" }),
      history: [],
    });
    await act(async () => {
      await useSessionStore.getState().refresh();
    });
    expect(api.aiSessionCreate).not.toHaveBeenCalled();
    expect(useSessionStore.getState().current?.name).toBe("Last night's bug");
    expect(useSessionStore.getState().notice).toMatch(/Last night's bug/);
  });

  it("a session is created against the open workspace, by path only", async () => {
    api.aiSessionCreate.mockResolvedValue({ ok: true, session: session({ id: "s-new" }) });
    await act(async () => {
      await useSessionStore.getState().create();
    });
    // The path is recorded so a conversation knows which project it belongs to. No
    // file is ever copied out of it.
    expect(api.aiSessionCreate).toHaveBeenCalledWith({ workspace: "C:\\ws" });
  });

  it("a refusal is shown with its reason, not swallowed", async () => {
    api.aiSessionCreate.mockResolvedValue({
      ok: false,
      error: "This app already holds 200 sessions, which is the limit. Delete one you no longer need, then try again — nothing was deleted for you.",
    });
    await act(async () => {
      await useSessionStore.getState().create();
    });
    expect(useSessionStore.getState().error).toMatch(/200 sessions/);
    expect(useSessionStore.getState().busy).toBe(false);
  });

  it("a thrown IPC error becomes a message, not an unhandled rejection", async () => {
    api.aiSessionsList.mockRejectedValue(new Error("ipc down"));
    await act(async () => {
      await useSessionStore.getState().refresh();
    });
    expect(useSessionStore.getState().error).toBe("ipc down");
  });

  it("an unreadable list is an error, not an empty list", async () => {
    api.aiSessionsList.mockResolvedValue({ ok: false, error: "The sessions directory is unreadable." });
    await act(async () => {
      await useSessionStore.getState().refresh();
    });
    expect(useSessionStore.getState().error).toMatch(/unreadable/);
  });

  it("a corrupt session is reported as corrupt, with where its bytes went", async () => {
    api.aiSessionsList.mockResolvedValue({ ok: true, sessions: [] });
    api.aiSessionOpen.mockResolvedValue({
      ok: false,
      error: "That session could not be read.",
      summary: summary({
        id: "s-bad",
        corrupted: true,
        corruptReason: "not valid JSON",
        corruptFile: "C:\\ud\\sessions\\s-bad.json.corrupt-1712",
      }),
    });
    await act(async () => {
      await useSessionStore.getState().refresh();
    });
    expect(useSessionStore.getState().corrupted?.corruptFile).toContain("s-bad.json.corrupt-");
    // Not "you have no sessions", which would be a different fact and a false one.
    expect(api.aiSessionCreate).not.toHaveBeenCalled();
  });

  it("the push listener is registered once, however many times startListening runs", () => {
    useSessionStore.getState().startListening();
    useSessionStore.getState().startListening();
    useSessionStore.getState().startListening();
    expect(api.onAiSessionChanged).toHaveBeenCalledTimes(1);
  });

  it("a push replaces the list, which is how the bar stops lagging the conversation", () => {
    useSessionStore.getState().startListening();
    act(() => {
      api.push({
        activeId: "s-one",
        sessions: [summary({ turnCount: 7, runCount: 2, redactions: 3, truncated: true })],
      });
    });
    const s = useSessionStore.getState();
    expect(s.sessions[0].turnCount).toBe(7);
    expect(s.sessions[0].redactions).toBe(3);
    expect(s.sessions[0].truncated).toBe(true);
  });

  it("open stores the replay history, because that is the whole point of resuming", async () => {
    const history: AiSessionHistoryTurn[] = [
      { role: "user", content: "read the notes file" },
      { role: "assistant", content: "it says the runtime is real" },
    ];
    api.aiSessionOpen.mockResolvedValue({ ok: true, session: session(), history });
    await act(async () => {
      await useSessionStore.getState().open("s-one");
    });
    expect(useSessionStore.getState().resumeHistory).toHaveLength(2);
    expect(useSessionStore.getState().notice).toMatch(/restored/);
  });

  it("the replay history is handed over once, because the run now holds it", async () => {
    api.aiSessionOpen.mockResolvedValue({
      ok: true,
      session: session(),
      history: [{ role: "user", content: "earlier" }],
    });
    await act(async () => {
      await useSessionStore.getState().open("s-one");
    });
    let taken: AiSessionHistoryTurn[] = [];
    act(() => {
      taken = useSessionStore.getState().takeResumeHistory();
    });
    expect(taken).toHaveLength(1);
    // Sending it again would duplicate the whole conversation inside the prompt.
    expect(useSessionStore.getState().takeResumeHistory()).toHaveLength(0);
  });

  it("opening clears a previously reported corruption", async () => {
    useSessionStore.setState({
      corrupted: summary({ id: "s-bad", corrupted: true, corruptFile: "x" }),
    });
    api.aiSessionOpen.mockResolvedValue({ ok: true, session: session(), history: [] });
    await act(async () => {
      await useSessionStore.getState().open("s-one");
    });
    expect(useSessionStore.getState().corrupted).toBeNull();
  });

  it("rename refuses a blank name without troubling the main process", async () => {
    await act(async () => {
      await useSessionStore.getState().rename("s-one", "   ");
    });
    expect(api.aiSessionUpdate).not.toHaveBeenCalled();
    expect(useSessionStore.getState().error).toMatch(/cannot be empty/);
  });

  it("rename updates the list and the open session together", async () => {
    useSessionStore.setState({ sessions: [summary()], activeId: "s-one", current: session() });
    api.aiSessionUpdate.mockResolvedValue({ ok: true, sessions: [summary({ name: "Renamed" })] });
    await act(async () => {
      await useSessionStore.getState().rename("s-one", "  Renamed  ");
    });
    expect(api.aiSessionUpdate).toHaveBeenCalledWith({ id: "s-one", name: "Renamed" });
    // Both copies. A rename visible in the list but not in the header is the exact
    // small lie that makes a user stop trusting the panel.
    expect(useSessionStore.getState().sessions[0].name).toBe("Renamed");
    expect(useSessionStore.getState().current?.name).toBe("Renamed");
  });

  it("close keeps the session open in the store — closing is not deleting", async () => {
    useSessionStore.setState({ sessions: [summary()], activeId: "s-one", current: session() });
    api.aiSessionUpdate.mockResolvedValue({ ok: true, sessions: [summary({ status: "closed" })] });
    await act(async () => {
      await useSessionStore.getState().setStatus("s-one", "closed");
    });
    expect(useSessionStore.getState().current?.status).toBe("closed");
    expect(useSessionStore.getState().notice).toMatch(/kept, not deleted/i);
    expect(api.aiSessionDelete).not.toHaveBeenCalled();
  });

  it("deleting the open session closes it, and reopens something", async () => {
    useSessionStore.setState({ sessions: [summary()], activeId: "s-one", current: session() });
    api.aiSessionDelete.mockResolvedValue({ ok: true, sessions: [] });
    api.aiSessionsList.mockResolvedValue({ ok: true, sessions: [summary({ id: "s-two" })] });
    api.aiSessionOpen.mockResolvedValue({ ok: true, session: session({ id: "s-two" }), history: [] });
    await act(async () => {
      await useSessionStore.getState().remove("s-one");
    });
    // Leaving `current` pointing at a deleted session is how a user ends up writing
    // turns into nothing.
    expect(useSessionStore.getState().current?.id).toBe("s-two");
  });

  it("deleting some *other* session leaves the open one alone", async () => {
    useSessionStore.setState({ sessions: [summary()], activeId: "s-one", current: session() });
    api.aiSessionDelete.mockResolvedValue({ ok: true, sessions: [summary()] });
    await act(async () => {
      await useSessionStore.getState().remove("s-other");
    });
    expect(useSessionStore.getState().current?.id).toBe("s-one");
  });

  it("fork moves to the copy and keeps the conversation available for replay", async () => {
    useSessionStore.setState({ sessions: [summary()], activeId: "s-one", current: session() });
    api.aiSessionFork.mockResolvedValue({
      ok: true,
      session: session({ id: "s-two", name: "The flaky test (fork)", forkedFrom: "s-one" }),
      history: [{ role: "user", content: "earlier" }],
    });
    await act(async () => {
      await useSessionStore.getState().fork("s-one");
    });
    expect(useSessionStore.getState().activeId).toBe("s-two");
    expect(useSessionStore.getState().current?.forkedFrom).toBe("s-one");
    expect(useSessionStore.getState().resumeHistory).toHaveLength(1);
    expect(useSessionStore.getState().notice).toMatch(/untouched/i);
  });

  it("a chat turn is sent with the session it belongs to", async () => {
    useSessionStore.setState({ activeId: "s-one", current: session() });
    await act(async () => {
      await useSessionStore.getState().recordTurn("user", "hello", "t9");
    });
    expect(api.aiSessionTurn).toHaveBeenCalledWith({ id: "s-one", role: "user", text: "hello", turnId: "t9" });
  });

  it("a closed session is not a write target", async () => {
    useSessionStore.setState({
      activeId: "s-one",
      current: session({ status: "closed" }),
    });
    await act(async () => {
      await useSessionStore.getState().recordTurn("user", "after close");
    });
    // "Close" means done. Appending anyway would make the word mean nothing.
    expect(api.aiSessionTurn).not.toHaveBeenCalled();
  });

  it("a turn with no open session is dropped rather than sent to nothing", async () => {
    useSessionStore.setState({ activeId: null, current: null });
    await act(async () => {
      await useSessionStore.getState().recordTurn("user", "orphan");
    });
    expect(api.aiSessionTurn).not.toHaveBeenCalled();
  });

  it("a lost turn does not raise an error banner over a conversation", async () => {
    useSessionStore.setState({ activeId: "s-one", current: session() });
    api.aiSessionTurn.mockRejectedValue(new Error("disk full"));
    await act(async () => {
      await useSessionStore.getState().recordTurn("user", "hello");
    });
    // One chat turn is not worth interrupting a conversation for, and the run and
    // the session file are unaffected. The failure is real; the banner would be a lie.
    expect(useSessionStore.getState().error).toBeNull();
  });

  it("a filed run re-reads the session, and spends the replay history", async () => {
    useSessionStore.setState({
      activeId: "s-one",
      current: session(),
      resumeHistory: [{ role: "user", content: "earlier" }],
    });
    api.aiSessionOpen.mockResolvedValue({
      ok: true,
      session: session({ runs: [{ id: "r1" } as never] }),
      history: [],
    });
    await act(async () => {
      await useSessionStore.getState().noteRunFiled("s-one");
    });
    expect(api.aiSessionOpen).toHaveBeenCalledWith({ id: "s-one", activate: false });
    expect(useSessionStore.getState().resumeHistory).toHaveLength(0);
  });

  it("errors and corruption can both be dismissed", () => {
    useSessionStore.setState({ error: "boom", corrupted: summary({ corrupted: true }) });
    act(() => {
      useSessionStore.getState().clearError();
      useSessionStore.getState().dismissCorrupted();
    });
    expect(useSessionStore.getState().error).toBeNull();
    expect(useSessionStore.getState().corrupted).toBeNull();
  });

  it("a create whose session does not appear in the list does not recurse forever", async () => {
    // This test exists because it found a crash. `refresh` created a session when the
    // store was empty, and `create` ended by calling `refresh` — so a create that
    // succeeded while the list still read empty was `refresh → create → refresh`,
    // unbounded, writing a new session file every iteration. The mock reproduces that
    // state exactly: creation succeeds, the list stays empty.
    api.aiSessionsList.mockResolvedValue({ ok: true, sessions: [] });
    api.aiSessionOpen.mockResolvedValue({ ok: false, error: "No session is open." });
    api.aiSessionCreate.mockResolvedValue({ ok: true, session: session({ id: "s-new" }) });

    await act(async () => {
      await useSessionStore.getState().refresh();
    });

    // One create, not two hundred. The count is the assertion: without the flag this
    // number climbs until the process runs out of memory.
    expect(api.aiSessionCreate).toHaveBeenCalledTimes(1);
  });

  it("a refresh that was told not to create leaves the store empty and says so", async () => {
    api.aiSessionsList.mockResolvedValue({ ok: true, sessions: [] });
    api.aiSessionOpen.mockResolvedValue({ ok: false, error: "No session is open." });
    await act(async () => {
      await useSessionStore.getState().refresh({ createIfEmpty: false });
    });
    expect(api.aiSessionCreate).not.toHaveBeenCalled();
    expect(useSessionStore.getState().current).toBeNull();
    expect(useSessionStore.getState().activeId).toBeNull();
  });

  it("a failed open does not quietly invent a session to replace it", async () => {
    api.aiSessionsList.mockResolvedValue({ ok: true, sessions: [] });
    api.aiSessionOpen.mockResolvedValue({ ok: false, error: "That session could not be opened." });
    await act(async () => {
      await useSessionStore.getState().open("s-gone");
    });
    expect(api.aiSessionCreate).not.toHaveBeenCalled();
    expect(useSessionStore.getState().error).toMatch(/could not be opened/);
  });

  it("deleting the last session does not immediately create a replacement", async () => {
    useSessionStore.setState({ sessions: [summary()], activeId: "s-one", current: session() });
    api.aiSessionDelete.mockResolvedValue({ ok: true, sessions: [] });
    await act(async () => {
      await useSessionStore.getState().remove("s-one");
    });
    // A delete the user confirmed must be a delete, not a swap for a blank session
    // that immediately appears in the same place.
    expect(api.aiSessionCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The bar
// ---------------------------------------------------------------------------

/**
 * Rendered through a subscriber, not a snapshot.
 *
 * `AgentSection` passes the live store state down, so a bare `getState()` snapshot
 * would render once and then never update — the test would pass on the first paint
 * and tell you nothing about what the user sees a second later.
 */
function Harness(): React.JSX.Element {
  const state = useSessionStore();
  return <SessionBar state={state} />;
}

function show(): HTMLElement {
  return render(<Harness />).container;
}

function openList(root: HTMLElement): void {
  fireEvent.click(root.querySelector("[data-session-list-toggle]") as HTMLElement);
}

/** `[data-foo]` and `[data-foo="id"]` are different queries; this does both. */
function byId(root: HTMLElement, attr: string, id: string): HTMLElement | null {
  return root.querySelector(`[${attr}="${id}"]`);
}

describe("session bar · what a user actually sees and can do", () => {
  it("says plainly that nothing is open, rather than showing a blank", () => {
    const root = show();
    expect(root.querySelector("[data-session-name]")?.getAttribute("data-session-name")).toBe("none");
    expect(root.textContent).toMatch(/No session open/);
  });

  it("shows the open session's name and its counts", () => {
    useSessionStore.setState({
      activeId: "s-one",
      current: session({ name: "The flaky test" }),
      sessions: [summary({ turnCount: 4, runCount: 2 })],
    });
    const root = show();
    expect(root.querySelector("[data-session-name]")?.textContent).toBe("The flaky test");
    expect(root.querySelector("[data-session-meta]")?.textContent).toBe("4 turn(s) · 2 run(s)");
  });

  it("counts come from the pushed list, not from the open session's stale copy", () => {
    // `current` still says 2 turns because it was read before the last three were
    // written. The summary was pushed after them. The bar must show the newer number,
    // or the count next to a user's own chat is a count they cannot rely on.
    useSessionStore.setState({
      activeId: "s-one",
      current: session(),
      sessions: [summary({ turnCount: 5 })],
    });
    expect(show().querySelector("[data-session-meta]")?.textContent).toContain("5 turn(s)");
  });

  it("a redaction is visible without expanding the list", () => {
    useSessionStore.setState({
      activeId: "s-one",
      current: session(),
      sessions: [summary({ redactions: 2 })],
    });
    const root = show();
    // A redaction a user cannot see is a redaction they cannot reason about.
    expect(root.querySelector("[data-session-redactions]")?.textContent).toBe("2 redacted");
    expect(root.querySelector("[data-session-list]")).toBeNull();
  });

  it("a trimmed session says so rather than pretending to be whole", () => {
    useSessionStore.setState({
      activeId: "s-one",
      current: session(),
      sessions: [summary({ truncated: true })],
    });
    expect(show().textContent).toMatch(/trimmed/);
  });

  it("an empty store says it is empty, and offers the control that fixes it", () => {
    const root = show();
    openList(root);
    expect(root.querySelector("[data-session-list-empty]")).not.toBeNull();
    expect(root.querySelector("[data-session-new]")).not.toBeNull();
  });

  it("the list stays hidden until it is asked for", () => {
    useSessionStore.setState({ sessions: [summary()], activeId: "s-one", current: session() });
    const root = show();
    expect(root.querySelector("[data-session-list]")).toBeNull();
    expect(root.querySelector("[data-session-list-toggle]")?.textContent).toBe("1 saved");
    openList(root);
    expect(root.querySelector("[data-session-list]")).not.toBeNull();
    expect(root.querySelector("[data-session-list-toggle]")?.textContent).toBe("hide");
  });

  it("a row reports turns, runs, tool calls, size and age", () => {
    useSessionStore.setState({ sessions: [summary()], activeId: "s-one", current: session() });
    const root = show();
    openList(root);
    const detail = byId(root, "data-session-row-detail", "s-one")?.textContent ?? "";
    expect(detail).toMatch(/2 turns/);
    expect(detail).toMatch(/1 run/);
    expect(detail).toMatch(/3 tool calls/);
    expect(root.textContent).toMatch(/2\.0 KB/);
    expect(root.textContent).toMatch(/just now|ago/);
  });

  it("an empty session is described as empty, not as missing", () => {
    useSessionStore.setState({
      sessions: [summary({ id: "s-empty", name: "Blank", turnCount: 0, runCount: 0, toolCallCount: 0 })],
    });
    const root = show();
    openList(root);
    expect(byId(root, "data-session-row-detail", "s-empty")?.textContent).toBe("empty");
  });

  it("the open session is marked and cannot be re-opened", () => {
    useSessionStore.setState({
      sessions: [summary(), summary({ id: "s-two", name: "Other" })],
      activeId: "s-one",
      current: session(),
    });
    const root = show();
    openList(root);
    expect(byId(root, "data-session-row", "s-one")?.getAttribute("data-session-row-active")).toBe("true");
    expect(byId(root, "data-session-row", "s-two")?.getAttribute("data-session-row-active")).toBe("false");
    expect((byId(root, "data-session-open", "s-one") as HTMLButtonElement).disabled).toBe(true);
    expect((byId(root, "data-session-open", "s-two") as HTMLButtonElement).disabled).toBe(false);
  });

  it("clicking a row opens that session", async () => {
    useSessionStore.setState({
      sessions: [summary(), summary({ id: "s-two", name: "Other" })],
      activeId: "s-one",
      current: session(),
    });
    api.aiSessionOpen.mockResolvedValue({ ok: true, session: session({ id: "s-two", name: "Other" }), history: [] });
    const root = show();
    openList(root);
    await act(async () => {
      fireEvent.click(byId(root, "data-session-open", "s-two") as HTMLElement);
    });
    expect(api.aiSessionOpen).toHaveBeenCalledWith({ id: "s-two" });
    expect(useSessionStore.getState().activeId).toBe("s-two");
  });

  it("a closed session says so, and offers reopen rather than close", () => {
    useSessionStore.setState({ sessions: [summary({ id: "s-c", status: "closed" })] });
    const root = show();
    openList(root);
    expect(byId(root, "data-session-open", "s-c")?.textContent).toMatch(/\(closed\)/);
    expect(byId(root, "data-session-toggle-status", "s-c")?.textContent).toBe("reopen");
    expect(byId(root, "data-session-row", "s-c")?.getAttribute("data-session-row-status")).toBe("closed");
  });

  it("closing a session is one click and keeps it", async () => {
    useSessionStore.setState({ sessions: [summary({ id: "s-one" })] });
    api.aiSessionUpdate.mockResolvedValue({ ok: true, sessions: [summary({ status: "closed" })] });
    const root = show();
    openList(root);
    await act(async () => {
      fireEvent.click(byId(root, "data-session-toggle-status", "s-one") as HTMLElement);
    });
    expect(api.aiSessionUpdate).toHaveBeenCalledWith({ id: "s-one", status: "closed" });
    expect(api.aiSessionDelete).not.toHaveBeenCalled();
  });

  it("renaming commits on Enter, with the text that was typed", async () => {
    useSessionStore.setState({ sessions: [summary()] });
    const root = show();
    openList(root);
    fireEvent.click(byId(root, "data-session-rename", "s-one") as HTMLElement);
    const input = root.querySelector("[data-session-rename-input]") as HTMLInputElement;
    expect(input).not.toBeNull();
    fireEvent.change(input, { target: { value: "Renamed by keyboard" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(api.aiSessionUpdate).toHaveBeenCalledWith({ id: "s-one", name: "Renamed by keyboard" });
  });

  it("Escape abandons a rename without saving it", async () => {
    useSessionStore.setState({ sessions: [summary()] });
    const root = show();
    openList(root);
    fireEvent.click(byId(root, "data-session-rename", "s-one") as HTMLElement);
    const input = root.querySelector("[data-session-rename-input]") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "never typed" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(api.aiSessionUpdate).not.toHaveBeenCalled();
    expect(root.querySelector("[data-session-rename-input]")).toBeNull();
  });

  it("the cancel button abandons a rename too", () => {
    useSessionStore.setState({ sessions: [summary()] });
    const root = show();
    openList(root);
    fireEvent.click(byId(root, "data-session-rename", "s-one") as HTMLElement);
    fireEvent.click(root.querySelector("[data-session-rename-cancel]") as HTMLElement);
    expect(api.aiSessionUpdate).not.toHaveBeenCalled();
    expect(root.querySelector("[data-session-rename-input]")).toBeNull();
  });

  it("the save button commits a rename", async () => {
    useSessionStore.setState({ sessions: [summary()] });
    const root = show();
    openList(root);
    fireEvent.click(byId(root, "data-session-rename", "s-one") as HTMLElement);
    fireEvent.change(root.querySelector("[data-session-rename-input]") as HTMLInputElement, {
      target: { value: "Saved by button" },
    });
    await act(async () => {
      fireEvent.click(root.querySelector("[data-session-rename-save]") as HTMLElement);
    });
    expect(api.aiSessionUpdate).toHaveBeenCalledWith({ id: "s-one", name: "Saved by button" });
  });

  it("an emptied rename box is a no-op, not a session called \"\"", async () => {
    useSessionStore.setState({ sessions: [summary()] });
    const root = show();
    openList(root);
    fireEvent.click(byId(root, "data-session-rename", "s-one") as HTMLElement);
    fireEvent.change(root.querySelector("[data-session-rename-input]") as HTMLInputElement, {
      target: { value: "   " },
    });
    await act(async () => {
      fireEvent.click(root.querySelector("[data-session-rename-save]") as HTMLElement);
    });
    expect(api.aiSessionUpdate).not.toHaveBeenCalled();
  });

  it("delete asks first — the first click must not destroy anything", () => {
    useSessionStore.setState({ sessions: [summary()] });
    const root = show();
    openList(root);
    fireEvent.click(byId(root, "data-session-delete", "s-one") as HTMLElement);
    // It is the only control here that destroys data.
    expect(api.aiSessionDelete).not.toHaveBeenCalled();
    expect(root.querySelector("[data-session-delete-confirm]")).not.toBeNull();
  });

  it("the confirmation states exactly what will be lost", () => {
    useSessionStore.setState({ sessions: [summary({ turnCount: 5, runCount: 3 })] });
    const root = show();
    openList(root);
    fireEvent.click(byId(root, "data-session-delete", "s-one") as HTMLElement);
    const text = byId(root, "data-session-delete-confirm", "s-one")?.textContent ?? "";
    expect(text).toMatch(/5 turn\(s\)/);
    expect(text).toMatch(/3 run\(s\)/);
    expect(text).toMatch(/cannot be undone/i);
  });

  it("'keep it' really keeps it", () => {
    useSessionStore.setState({ sessions: [summary()] });
    const root = show();
    openList(root);
    fireEvent.click(byId(root, "data-session-delete", "s-one") as HTMLElement);
    fireEvent.click(byId(root, "data-session-delete-confirm-no", "s-one") as HTMLElement);
    // The most important negative assertion in this file: a confirmation dialog
    // whose cancel button was wired to the destructive action.
    expect(api.aiSessionDelete).not.toHaveBeenCalled();
    expect(root.querySelector("[data-session-delete-confirm]")).toBeNull();
  });

  it("confirming a delete deletes it", async () => {
    useSessionStore.setState({ sessions: [summary()] });
    api.aiSessionDelete.mockResolvedValue({ ok: true, sessions: [] });
    const root = show();
    openList(root);
    fireEvent.click(byId(root, "data-session-delete", "s-one") as HTMLElement);
    await act(async () => {
      fireEvent.click(byId(root, "data-session-delete-confirm-yes", "s-one") as HTMLElement);
    });
    expect(api.aiSessionDelete).toHaveBeenCalledWith({ id: "s-one" });
  });

  it("a delete is scoped to the row that asked for it", async () => {
    useSessionStore.setState({ sessions: [summary(), summary({ id: "s-two", name: "Other" })] });
    api.aiSessionDelete.mockResolvedValue({ ok: true, sessions: [] });
    const root = show();
    openList(root);
    fireEvent.click(byId(root, "data-session-delete", "s-two") as HTMLElement);
    await act(async () => {
      fireEvent.click(byId(root, "data-session-delete-confirm-yes", "s-two") as HTMLElement);
    });
    // A confirm bound to the wrong row deletes the wrong conversation.
    expect(api.aiSessionDelete).toHaveBeenCalledWith({ id: "s-two" });
  });

  it("a fork is one click on the right row", async () => {
    useSessionStore.setState({ sessions: [summary(), summary({ id: "s-two", name: "Other" })] });
    api.aiSessionFork.mockResolvedValue({ ok: true, session: session({ id: "s-two", forkedFrom: "s-one" }) });
    const root = show();
    openList(root);
    await act(async () => {
      fireEvent.click(byId(root, "data-session-fork", "s-two") as HTMLElement);
    });
    expect(api.aiSessionFork).toHaveBeenCalledWith({ id: "s-two" });
  });

  it("corruption is shown with the path the bytes were moved to", () => {
    useSessionStore.setState({
      corrupted: summary({
        id: "s-bad",
        corrupted: true,
        corruptReason: "not valid JSON",
        corruptFile: "C:\\ud\\sessions\\s-bad.json.corrupt-1712",
      }),
    });
    const root = show();
    const banner = root.querySelector("[data-session-corrupt]");
    expect(banner?.textContent).toMatch(/not valid JSON/);
    expect(banner?.textContent).toMatch(/s-bad\.json\.corrupt-1712/);
    // "Moved, not deleted" — because that is the difference between a bug and data loss.
    expect(banner?.textContent).toMatch(/moved, not deleted/i);
  });

  it("a corrupt session is dismissible, so it cannot block the panel forever", () => {
    useSessionStore.setState({ corrupted: summary({ corrupted: true, corruptFile: "x" }) });
    const root = show();
    fireEvent.click(root.querySelector("[data-session-corrupt-dismiss]") as HTMLElement);
    expect(useSessionStore.getState().corrupted).toBeNull();
  });

  it("a row marked unreadable says so in the list too", () => {
    useSessionStore.setState({ sessions: [summary({ id: "s-bad", corrupted: true })] });
    const root = show();
    openList(root);
    expect(byId(root, "data-session-row-corrupt", "s-bad")?.textContent).toBe("unreadable");
  });

  it("an error is shown with its reason and can be dismissed", () => {
    useSessionStore.setState({ error: "This app already holds 200 sessions, which is the limit." });
    const root = show();
    expect(root.querySelector("[data-session-error]")?.textContent).toMatch(/200 sessions/);
    fireEvent.click(root.querySelector("[data-session-error-dismiss]") as HTMLElement);
    expect(useSessionStore.getState().error).toBeNull();
  });

  it("an error and a notice are never both on screen", () => {
    // An error next to a reassuring notice reads as though the operation succeeded.
    useSessionStore.setState({ error: "boom", notice: "Started something." });
    const root = show();
    expect(root.querySelector("[data-session-error]")).not.toBeNull();
    expect(root.querySelector("[data-session-notice]")).toBeNull();
  });

  it("busy is visible and the controls that would conflict are disabled", () => {
    useSessionStore.setState({ busy: true });
    const root = show();
    expect(root.querySelector("[data-session-busy]")).not.toBeNull();
    expect((root.querySelector("[data-session-new]") as HTMLButtonElement).disabled).toBe(true);
  });

  it("every operation has a control — no placeholder buttons", () => {
    useSessionStore.setState({ sessions: [summary()], activeId: "s-one", current: session() });
    const root = show();
    openList(root);
    // The phase promised seven operations. Each must be reachable by clicking.
    for (const attr of [
      "data-session-new",
      "data-session-list-toggle",
      "data-session-open",
      "data-session-rename",
      "data-session-fork",
      "data-session-toggle-status",
      "data-session-delete",
    ]) {
      expect(root.querySelector(`[${attr}]`), `missing ${attr}`).not.toBeNull();
    }
  });

  it("renders a full store of sessions without falling over", () => {
    // `MAX_SESSIONS` is 200, so this is not a hypothetical list length.
    useSessionStore.setState({
      sessions: Array.from({ length: 200 }, (_, i) =>
        summary({ id: `s-${i}`, name: `Session ${i}`, updatedAt: Date.now() - i * 60_000 }),
      ),
      activeId: "s-0",
      current: session({ id: "s-0" }),
    });
    const root = show();
    openList(root);
    expect(root.querySelectorAll("[data-session-row]")).toHaveLength(200);
  });
});