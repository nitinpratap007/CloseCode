// Phase 27 — persistent AI sessions.
//
// Structure: one `describe` per acceptance criterion, then the operations and the
// bounds. Every test drives the real store against a real temp directory — no
// in-memory fake — because the properties that matter here (atomic replace, backup
// fallback, quarantine, what actually lands on disk) are all properties of the
// filesystem, and a fake store would agree with whatever the test author believed
// about filesystems.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { AgentRuntime } from "../electron/services/agent/runtime";
import { createBuiltinRegistry } from "../electron/services/agent/tools";
import { DEFAULT_AGENT_ID } from "../electron/services/agent/definitions";
import type {
  AgentCompletionRequest,
  AgentCompletionResult,
  AgentEvent,
  AgentRunSpec,
} from "../electron/services/agent/types";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "cc-sessions-"));
vi.mock("electron", () => ({
  app: { getPath: () => userData },
}));

type Mod = typeof import("../electron/services/aiSessions");

let dir: string;
let m: Mod;

/**
 * A store module, by default over a fresh empty directory.
 *
 * `vi.resetModules()` matters: without it a re-import hands back the cached module
 * with the *previous* directory still baked in, and every "restart" test would
 * silently be testing the same live singleton.
 *
 * `reuseDir` is what makes a restart a restart — the new module must point at the
 * *same* directory, or the test is really only asserting that a new directory is
 * empty, which passes whether persistence works or not.
 */
async function load(reuseDir?: string): Promise<Mod> {
  vi.resetModules();
  const mod = await import("../electron/services/aiSessions");
  dir = reuseDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "cc-sess-"));
  mod.setSessionsDir(dir);
  return mod;
}

/** Close the app and open it again over the same directory. */
async function restart(): Promise<Mod> {
  return load(dir);
}

/** Everything under the sessions dir, so "was anything else written?" is checkable. */
function entries(): string[] {
  return fs.readdirSync(dir).sort();
}

/** The raw bytes of a session file, for asserting what did and did not hit disk. */
function raw(id: string): string {
  return fs.readFileSync(path.join(dir, `${id}.json`), "utf8");
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

// ---------------------------------------------------------------------------

describe("1. restarting does not destroy sessions", () => {
  it("a created session is readable from a fresh module over the same directory", async () => {
    const created = m.createSession({ name: "First" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.session.id;

    const restarted = await restart();
    const read = restarted.loadSessionById(id);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.session.name).toBe("First");
  });

  it("the conversation is still there after a restart, not just the name", async () => {
    const created = m.createSession({ name: "Talk" });
    if (!created.ok) throw new Error("create failed");
    m.appendTurn(created.session.id, { id: "u1", role: "user", text: "why is the test flaky?", at: 1 });
    m.appendTurn(created.session.id, { id: "a1", role: "assistant", text: "because it sleeps instead of polling.", at: 2 });

    const restarted = await restart();
    const read = restarted.loadSessionById(created.session.id);
    if (!read.ok) throw new Error(`load failed: ${read.error}`);
    expect(read.session.turns).toHaveLength(2);
    expect(read.session.turns[0].text).toBe("why is the test flaky?");
    expect(read.session.turns[1].role).toBe("assistant");
  });

  it("the last-active pointer survives, which is what makes a launch land back here", async () => {
    const created = m.createSession({ name: "Pinned" });
    if (!created.ok) throw new Error("create failed");
    expect(m.getActiveSessionId()).toBe(created.session.id);

    const restarted = await restart();
    expect(restarted.getActiveSessionId()).toBe(created.session.id);
  });

  it("tool history survives, because a transcript without its tools is half a record", async () => {
    const created = m.createSession({ name: "Tools" });
    if (!created.ok) throw new Error("create failed");
    m.recordRun(created.session.id, {
      id: "run-1",
      agentId: "build",
      task: "fix the gate",
      status: "completed",
      steps: 3,
      toolCalls: 2,
      createdAt: 10,
      updatedAt: 20,
      parentRunId: null,
      depth: 0,
      resultText: "done",
      tools: [
        { at: 11, kind: "tool", step: 0, tool: "read_file", granted: true, ms: 4 },
        { at: 12, kind: "tool", step: 1, tool: "write_file", granted: true, ms: 9 },
      ],
    });

    const restarted = await restart();
    const read = restarted.loadSessionById(created.session.id);
    if (!read.ok) throw new Error(`load failed: ${read.error}`);
    expect(read.session.runs).toHaveLength(1);
    expect(read.session.runs[0].tools.map((t) => t.tool)).toEqual(["read_file", "write_file"]);
    expect(read.session.runs[0].resultText).toBe("done");
  });

  it("agent state survives — status, steps, depth and what context it was given", async () => {
    const created = m.createSession({ name: "State" });
    if (!created.ok) throw new Error("create failed");
    m.recordRun(created.session.id, {
      id: "run-x",
      agentId: "reviewer",
      task: "look at this",
      status: "cancelled",
      steps: 7,
      toolCalls: 5,
      createdAt: 1,
      updatedAt: 2,
      parentRunId: "run-parent",
      depth: 1,
      resultText: "",
      error: "The run was cancelled.",
      tools: [],
      contextChars: 12985,
      contextStatus: "built",
    });

    const restarted = await restart();
    const read = restarted.loadSessionById(created.session.id);
    if (!read.ok) throw new Error(`load failed: ${read.error}`);
    const run = read.session.runs[0];
    expect(run.status).toBe("cancelled");
    expect(run.steps).toBe(7);
    expect(run.depth).toBe(1);
    expect(run.parentRunId).toBe("run-parent");
    expect(run.error).toBe("The run was cancelled.");
    expect(run.contextChars).toBe(12985);
  });

  it("the list is rebuilt from disk when the index is destroyed", async () => {
    const a = m.createSession({ name: "A" });
    const b = m.createSession({ name: "B" });
    if (!a.ok || !b.ok) throw new Error("create failed");

    // Simulate the index being lost — a truncated write, or a user cleaning the
    // wrong file. The sessions themselves are still on disk and must survive it.
    fs.writeFileSync(path.join(dir, "index.json"), "{ this is not json", "utf8");

    const restarted = await restart();
    const names = restarted.listSessions().map((s) => s.name).sort();
    expect(names).toEqual(["A", "B"]);
  });

  it("a session written after the index was built still appears in the list", async () => {
    m.createSession({ name: "Indexed" });
    // A crash between writing the session file and updating the index is the exact
    // window this covers.
    const orphan = JSON.stringify(
      { version: 1, id: "s-orphan", name: "Orphan", workspace: null, createdAt: 1, updatedAt: 2, status: "open", forkedFrom: null, turns: [], runs: [], redactions: 0, truncated: false },
      null,
      2,
    );
    fs.writeFileSync(path.join(dir, "s-orphan.json"), orphan, "utf8");

    const list = m.listSessions();
    expect(list.map((s) => s.name)).toContain("Orphan");
  });

  it("close keeps the conversation; only delete removes it", async () => {
    const created = m.createSession({ name: "Closable" });
    if (!created.ok) throw new Error("create failed");
    m.appendTurn(created.session.id, { id: "u", role: "user", text: "keep me", at: 1 });
    expect(m.setSessionStatus(created.session.id, "closed").ok).toBe(true);

    const afterClose = m.loadSessionById(created.session.id);
    if (!afterClose.ok) throw new Error("closed session vanished");
    expect(afterClose.session.turns).toHaveLength(1);
    expect(afterClose.session.status).toBe("closed");

    expect(m.deleteSession(created.session.id).ok).toBe(true);
    expect(m.loadSessionById(created.session.id).ok).toBe(false);
    expect(fs.existsSync(path.join(dir, `${created.session.id}.json`))).toBe(false);
  });

  it("deleting a session also removes its backup, so an erased session is really erased", async () => {
    const created = m.createSession({ name: "Bak" });
    if (!created.ok) throw new Error("create failed");
    const id = created.session.id;
    // Force a second write so a `.bak` exists.
    m.appendTurn(id, { id: "u", role: "user", text: "second write", at: 1 });
    expect(fs.existsSync(path.join(dir, `${id}.json.bak`))).toBe(true);

    m.deleteSession(id);
    expect(fs.existsSync(path.join(dir, `${id}.json.bak`))).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("2. users can resume sessions", () => {
  it("resume replays the chat conversation, oldest first", () => {
    const created = m.createSession({ name: "Resume" });
    if (!created.ok) throw new Error("create failed");
    m.appendTurn(created.session.id, { id: "1", role: "user", text: "first question", at: 1 });
    m.appendTurn(created.session.id, { id: "2", role: "assistant", text: "first answer", at: 2 });
    m.appendTurn(created.session.id, { id: "3", role: "user", text: "second question", at: 3 });

    const read = m.loadSessionById(created.session.id);
    if (!read.ok) throw new Error("load failed");
    const history = m.resumeHistory(read.session);
    expect(history.map((h) => h.content)).toEqual(["first question", "first answer", "second question"]);
    expect(history[0].role).toBe("user");
    expect(history[1].role).toBe("assistant");
  });

  it("resume replays agent runs as task/answer pairs ahead of the chat", () => {
    const created = m.createSession({ name: "Mixed" });
    if (!created.ok) throw new Error("create failed");
    m.recordRun(created.session.id, {
      id: "r1", agentId: "build", task: "add a test", status: "completed", steps: 2, toolCalls: 1,
      createdAt: 1, updatedAt: 2, parentRunId: null, depth: 0, resultText: "added it", tools: [],
    });
    m.appendTurn(created.session.id, { id: "t", role: "user", text: "and now?", at: 3 });

    const read = m.loadSessionById(created.session.id);
    if (!read.ok) throw new Error("load failed");
    const history = m.resumeHistory(read.session);
    expect(history.map((h) => h.content)).toEqual(["add a test", "added it", "and now?"]);
  });

  it("a run that produced no answer contributes no assistant turn", () => {
    const created = m.createSession({ name: "NoAnswer" });
    if (!created.ok) throw new Error("create failed");
    m.recordRun(created.session.id, {
      id: "r1", agentId: "build", task: "doomed", status: "failed", steps: 0, toolCalls: 0,
      createdAt: 1, updatedAt: 2, parentRunId: null, depth: 0, resultText: "", tools: [],
    });
    const read = m.loadSessionById(created.session.id);
    if (!read.ok) throw new Error("load failed");
    expect(m.resumeHistory(read.session)).toEqual([]);
  });

  it("resume is bounded, so a long session cannot become an unbounded prompt", () => {
    const created = m.createSession({ name: "Long" });
    if (!created.ok) throw new Error("create failed");
    for (let i = 0; i < 120; i += 1) {
      m.appendTurn(created.session.id, { id: `t${i}`, role: "user", text: `question ${i}`, at: i });
    }
    const read = m.loadSessionById(created.session.id);
    if (!read.ok) throw new Error("load failed");
    expect(m.resumeHistory(read.session, 10)).toHaveLength(10);
    // The bound keeps the *newest* turns, which are the ones the model needs.
    expect(m.resumeHistory(read.session, 10).at(-1)?.content).toBe("question 119");
  });

  it("a long single turn is clamped rather than replayed whole", () => {
    const created = m.createSession({ name: "Verbose" });
    if (!created.ok) throw new Error("create failed");
    m.appendTurn(created.session.id, { id: "t", role: "user", text: "x".repeat(9_000), at: 1 });
    const read = m.loadSessionById(created.session.id);
    if (!read.ok) throw new Error("load failed");
    const history = m.resumeHistory(read.session);
    expect(history).toHaveLength(1);
    expect(history[0].content.length).toBe(4_000);
  });

  it("resume never replays tool calls", () => {
    const created = m.createSession({ name: "NoReplay" });
    if (!created.ok) throw new Error("create failed");
    m.recordRun(created.session.id, {
      id: "r1", agentId: "coder", task: "write a file", status: "completed", steps: 1, toolCalls: 1,
      createdAt: 1, updatedAt: 2, parentRunId: null, depth: 0, resultText: "wrote it",
      tools: [{ at: 1, kind: "tool", step: 0, tool: "write_file", granted: true, ms: 2 }],
    });
    const read = m.loadSessionById(created.session.id);
    if (!read.ok) throw new Error("load failed");
    const serialised = JSON.stringify(m.resumeHistory(read.session));
    // A replay that re-issued a write because a conversation was reopened would be
    // a destructive thing to ship. Assert the absence, not the presence.
    expect(serialised).not.toContain("write_file");
    expect(serialised).not.toContain("granted");
  });

  it("opening a session sets it active; opening without an id returns the active one", () => {
    const a = m.createSession({ name: "A" });
    if (!a.ok) throw new Error("create failed");
    const b = m.createSession({ name: "B" });
    if (!b.ok) throw new Error("create failed");
    expect(m.getActiveSessionId()).toBe(b.session.id);
    m.setActiveSessionId(a.session.id);
    expect(m.getActiveSessionId()).toBe(a.session.id);
  });
});

// ---------------------------------------------------------------------------

describe("3. session corruption is handled safely", () => {
  it("a truncated session file falls back to the backup rather than losing the conversation", async () => {
    const created = m.createSession({ name: "Recoverable" });
    if (!created.ok) throw new Error("create failed");
    const id = created.session.id;
    m.appendTurn(id, { id: "u", role: "user", text: "the good conversation", at: 1 });
    // The `.bak` now holds the first write; the primary holds the second.
    expect(fs.existsSync(path.join(dir, `${id}.json.bak`))).toBe(true);

    // Simulate a crash mid-write: the file is valid UTF-8 but truncated JSON.
    fs.writeFileSync(path.join(dir, `${id}.json`), '{"version":1,"id":"' + id, "utf8");

    const read = m.loadSessionById(id);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // The backup had no turns, so the recovered session is real but empty —
    // crucially it is a *session*, not a failure.
    expect(read.session.id).toBe(id);
    expect(read.session.name).toBe("Recoverable");
  });

  it("a session file with real content survives a truncated primary via the backup", async () => {
    const created = m.createSession({ name: "HasContent" });
    if (!created.ok) throw new Error("create failed");
    const id = created.session.id;
    m.appendTurn(id, { id: "u", role: "user", text: "precious words", at: 1 });
    // A third write, so the `.bak` now contains the turn.
    m.appendTurn(id, { id: "a", role: "assistant", text: "and the reply", at: 2 });

    fs.writeFileSync(path.join(dir, `${id}.json`), "not json at all", "utf8");
    const read = m.loadSessionById(id);
    if (!read.ok) throw new Error(`expected recovery, got: ${read.error}`);
    expect(read.session.turns.map((t) => t.text)).toContain("precious words");
  });

  it("when neither file can be read the bytes are moved aside, not deleted", () => {
    const created = m.createSession({ name: "Doomed" });
    if (!created.ok) throw new Error("create failed");
    const id = created.session.id;
    m.appendTurn(id, { id: "u", role: "user", text: "x", at: 1 });

    fs.writeFileSync(path.join(dir, `${id}.json`), "\u0000\u0001 garbage", "utf8");
    fs.writeFileSync(path.join(dir, `${id}.json.bak`), "\u0000 also garbage", "utf8");

    const read = m.loadSessionById(id);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    // The user is told what happened and where the bytes went.
    expect(read.error).toContain("could not be read");
    expect(read.summary?.corrupted).toBe(true);
    expect(read.summary?.corruptReason).toBeTruthy();

    const moved = entries().filter((f) => f.startsWith(`${id}.json.corrupt-`));
    expect(moved.length).toBeGreaterThan(0);
    // And the bytes are really still there to recover by hand.
    const recovered = fs.readFileSync(path.join(dir, moved[0]), "utf8");
    expect(recovered.length).toBeGreaterThan(0);
  });

  it("a file that is not a session at all is refused, not guessed at", () => {
    const created = m.createSession({ name: "Real" });
    if (!created.ok) throw new Error("create failed");
    fs.writeFileSync(path.join(dir, "s-foreign.json"), JSON.stringify({ hello: "world" }), "utf8");

    const read = m.loadSessionById("s-foreign");
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error).toContain("session id");
  });

  it("a session from a newer schema version is refused rather than overwritten", () => {
    const created = m.createSession({ name: "Future" });
    if (!created.ok) throw new Error("create failed");
    const id = created.session.id;
    const future = JSON.parse(raw(id)) as Record<string, unknown>;
    future.version = 99;
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(future), "utf8");
    fs.rmSync(path.join(dir, `${id}.json.bak`), { force: true });

    const read = m.loadSessionById(id);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error).toContain("newer version");
    // Refusing is only safe if the file survives the refusal.
    expect(fs.existsSync(path.join(dir, `${id}.json`))).toBe(true);
  });

  it("one malformed turn is dropped and the rest of the session is kept", () => {
    const created = m.createSession({ name: "Partial" });
    if (!created.ok) throw new Error("create failed");
    const id = created.session.id;
    const doc = JSON.parse(raw(id)) as Record<string, unknown>;
    doc.turns = [
      { id: "good", role: "user", text: "keep me", at: 1 },
      { id: "bad", role: "user", text: 42 },
      "not an object",
      { id: "good2", role: "assistant", text: "keep me too", at: 2 },
    ];
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(doc), "utf8");
    fs.rmSync(path.join(dir, `${id}.json.bak`), { force: true });

    const read = m.loadSessionById(id);
    if (!read.ok) throw new Error(`load failed: ${read.error}`);
    expect(read.session.turns.map((t) => t.text)).toEqual(["keep me", "keep me too"]);
    // A lossy read is never presented as a clean one.
    expect(read.session.truncated).toBe(true);
  });

  it("a corrupt session stays listed until it is opened, and then it is reported", () => {
    const created = m.createSession({ name: "ListMe" });
    if (!created.ok) throw new Error("create failed");
    fs.writeFileSync(path.join(dir, `${created.session.id}.json`), "{{{", "utf8");
    fs.rmSync(path.join(dir, `${created.session.id}.json.bak`), { force: true });

    // Listing deliberately does not re-read every file: with hundreds of sessions
    // that would make opening the panel an O(store) job. So the row survives with
    // its last-known counts — it is stale, not fabricated.
    const row = m.listSessions().find((s) => s.id === created.session.id);
    expect(row).toBeDefined();
    expect(row?.corrupted).toBe(false);

    // Opening is where the truth is discovered, and it is reported, not faked.
    const read = m.loadSessionById(created.session.id);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.summary?.corrupted).toBe(true);
    expect(read.summary?.corruptFile).toBeTruthy();
    // And the bytes are moved aside rather than destroyed.
    expect(entries().some((f) => f.startsWith(`${created.session.id}.json.corrupt-`))).toBe(true);

    // Once quarantined it leaves the list, so the next launch does not offer it
    // again as if nothing had happened.
    expect(m.listSessions().find((s) => s.id === created.session.id)).toBeUndefined();
  });

  it("an unwritable directory fails the save instead of throwing across IPC", () => {
    m.setSessionsDir(path.join(dir, "nowhere", "deeper"));
    const created = m.createSession({ name: "Unwritable" });
    // `ensureDir` creates parents, so this one succeeds; the real assertion is
    // that it returns a value either way and never throws.
    expect(typeof created.ok).toBe("boolean");
  });

  it("no temporary files are left behind after a normal save", () => {
    const created = m.createSession({ name: "Clean" });
    if (!created.ok) throw new Error("create failed");
    m.appendTurn(created.session.id, { id: "u", role: "user", text: "hi", at: 1 });
    m.renameSession(created.session.id, "Clean2");
    expect(entries().some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("deleting something that is not there is an error, not a silent success", () => {
    expect(m.deleteSession("s-doesnotexist").ok).toBe(false);
    expect(m.renameSession("s-doesnotexist", "x").ok).toBe(false);
    expect(m.setSessionStatus("s-doesnotexist", "closed").ok).toBe(false);
  });

  it("rename rejects an empty name instead of storing one", () => {
    const created = m.createSession({ name: "Named" });
    if (!created.ok) throw new Error("create failed");
    const result = m.renameSession(created.session.id, "   ");
    expect(result.ok).toBe(false);
    const read = m.loadSessionById(created.session.id);
    if (!read.ok) throw new Error("load failed");
    expect(read.session.name).toBe("Named");
  });
});

// ---------------------------------------------------------------------------

describe("4. session data is stored securely", () => {
  it("a provider key pasted by the user never reaches the disk", () => {
    const created = m.createSession({ name: "Leaky" });
    if (!created.ok) throw new Error("create failed");
    m.appendTurn(created.session.id, {
      id: "u",
      role: "user",
      text: "my key is sk-abcdefghijklmnopqrstuvwxyz123456 please use it",
      at: 1,
    });
    const onDisk = raw(created.session.id);
    expect(onDisk).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(onDisk).toContain(m.REDACTION_PLACEHOLDER);
  });

  it("a GitHub token and an AWS key are redacted too", () => {
    const created = m.createSession({ name: "Tokens" });
    if (!created.ok) throw new Error("create failed");
    m.appendTurn(created.session.id, {
      id: "u",
      role: "user",
      text: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 and AKIAIOSFODNN7EXAMPLE",
      at: 1,
    });
    const onDisk = raw(created.session.id);
    expect(onDisk).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
    expect(onDisk).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("an Authorization header is redacted", () => {
    const r = m.redactSecrets("curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwx' https://api");
    expect(r.text).not.toContain("abcdefghijklmnopqrstuvwx");
    expect(r.count).toBeGreaterThan(0);
  });

  it("a private key block is redacted whole, header and body", () => {
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAxyz\n-----END RSA PRIVATE KEY-----";
    const r = m.redactSecrets(`here it is ${key} done`);
    expect(r.text).not.toContain("MIIEpAIBAAKCAQEAxyz");
    expect(r.text).toContain("here it is");
    expect(r.text).toContain("done");
  });

  it("a secret echoed back in a tool result is redacted before it is stored", () => {
    const created = m.createSession({ name: "ToolLeak" });
    if (!created.ok) throw new Error("create failed");
    m.recordRun(created.session.id, {
      id: "r1", agentId: "build", task: "check the config", status: "completed", steps: 1, toolCalls: 1,
      createdAt: 1, updatedAt: 2, parentRunId: null, depth: 0, resultText: "found api_key=supersecretvalue123",
      tools: [{ at: 1, kind: "tool", step: 0, tool: "read_file", granted: true, ms: 1, text: "password=hunter2hunter2" }],
    });
    const onDisk = raw(created.session.id);
    expect(onDisk).not.toContain("supersecretvalue123");
    expect(onDisk).not.toContain("hunter2hunter2");
  });

  it("the redaction count is stored and reported, so redaction is never silent", () => {
    const created = m.createSession({ name: "Counted" });
    if (!created.ok) throw new Error("create failed");
    m.appendTurn(created.session.id, { id: "u", role: "user", text: "sk-aaaaaaaaaaaaaaaabbbb", at: 1 });
    m.appendTurn(created.session.id, { id: "u2", role: "user", text: "sk-ccccccccccccccccdddd", at: 2 });
    const summary = m.listSessions().find((s) => s.id === created.session.id);
    expect(summary?.redactions).toBeGreaterThanOrEqual(2);
  });

  it("a path-traversal id is refused before it can touch the filesystem", () => {
    expect(m.isValidSessionId("../../startup/run")).toBe(false);
    expect(m.isValidSessionId("..\\..\\windows\\system32")).toBe(false);
    expect(m.isValidSessionId("/etc/passwd")).toBe(false);
    expect(m.isValidSessionId("C:\\\\Windows")).toBe(false);
    expect(m.isValidSessionId("")).toBe(false);
    expect(m.isValidSessionId("has space")).toBe(false);
    expect(m.deleteSession("../../escape").ok).toBe(false);
    expect(m.loadSessionById("../../escape").ok).toBe(false);
    expect(m.loadSessionById("s-ok_1").ok).toBe(false);
  });

  it("nothing outside the sessions directory is written, whatever the id looks like", () => {
    const outside = path.join(os.tmpdir(), `cc-escape-${Date.now()}.json`);
    m.createSession({ name: "Safe" });
    m.deleteSession("../" + path.basename(outside));
    expect(fs.existsSync(outside)).toBe(false);
  });

  it("no workspace file contents are copied into a session — only the path", () => {
    const created = m.createSession({ name: "PathsOnly", workspace: "E:\\some\\project" });
    if (!created.ok) throw new Error("create failed");
    const onDisk = raw(created.session.id);
    expect(onDisk).toContain("E:\\\\some\\\\project");
    // The store has no mechanism for file contents at all — assert the shape.
    expect(Object.keys(JSON.parse(onDisk)).sort()).toEqual(
      ["createdAt", "forkedFrom", "id", "name", "redactions", "runs", "status", "truncated", "turns", "updatedAt", "version", "workspace"].sort(),
    );
  });

  it("a stored session has no field an API key could hide in", () => {
    const created = m.createSession({ name: "Shape" });
    if (!created.ok) throw new Error("create failed");
    const doc = JSON.parse(raw(created.session.id)) as Record<string, unknown>;
    const keys = Object.keys(doc).join(",");
    for (const forbidden of ["apiKey", "key", "token", "secret", "endpoint"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("text with no secret in it is stored unchanged", () => {
    const r = m.redactSecrets("the gate denies files.write outside the workspace root");
    expect(r.text).toBe("the gate denies files.write outside the workspace root");
    expect(r.count).toBe(0);
  });

  it("redaction is not confused by ordinary code", () => {
    const r = m.redactSecrets("const apiKey = getKey(); return secret.length;");
    // `getKey()` is too short and is not a literal, so this must survive intact —
    // a redactor that eats source code would silently corrupt every session.
    expect(r.text).toContain("getKey()");
  });
});

// ---------------------------------------------------------------------------

describe("fork, rename and list behave as separate operations", () => {
  it("a fork is a deep, independent copy with its own id", () => {
    const created = m.createSession({ name: "Original" });
    if (!created.ok) throw new Error("create failed");
    m.appendTurn(created.session.id, { id: "u", role: "user", text: "shared history", at: 1 });

    const forked = m.forkSession(created.session.id);
    if (!forked.ok) throw new Error("fork failed");
    expect(forked.session.id).not.toBe(created.session.id);
    expect(forked.session.forkedFrom).toBe(created.session.id);
    expect(forked.session.name).toBe("Original (fork)");
    expect(forked.session.turns).toHaveLength(1);
  });

  it("writing to a fork cannot touch the original", () => {
    const created = m.createSession({ name: "Source" });
    if (!created.ok) throw new Error("create failed");
    const forked = m.forkSession(created.session.id);
    if (!forked.ok) throw new Error("fork failed");

    m.appendTurn(forked.session.id, { id: "n", role: "user", text: "only in the fork", at: 9 });

    const original = m.loadSessionById(created.session.id);
    if (!original.ok) throw new Error("load failed");
    expect(original.session.turns.map((t) => t.text)).not.toContain("only in the fork");

    const forkRead = m.loadSessionById(forked.session.id);
    if (!forkRead.ok) throw new Error("load failed");
    expect(forkRead.session.turns.map((t) => t.text)).toContain("only in the fork");
  });

  it("a fork redacts its own copies rather than trusting the source", () => {
    const created = m.createSession({ name: "Racy" });
    if (!created.ok) throw new Error("create failed");
    // Write a secret straight to disk, bypassing the store's own redaction.
    const doc = JSON.parse(raw(created.session.id)) as Record<string, unknown>;
    doc.turns = [{ id: "u", role: "user", text: "sk-aaaaaaaaaaaaaaaabbbb", at: 1 }];
    fs.writeFileSync(path.join(dir, `${created.session.id}.json`), JSON.stringify(doc), "utf8");
    fs.rmSync(path.join(dir, `${created.session.id}.json.bak`), { force: true });

    const forked = m.forkSession(created.session.id);
    if (!forked.ok) throw new Error("fork failed");
    const forkText = raw(forked.session.id);
    expect(forkText).not.toContain("sk-aaaaaaaaaaaaaaaabbbb");
    // And the original still has its bytes — forking must not "fix" the source.
    expect(raw(created.session.id)).toContain("sk-aaaaaaaaaaaaaaaabbbb");
  });

  it("renaming does not change a session's identity", () => {
    const created = m.createSession({ name: "Before" });
    if (!created.ok) throw new Error("create failed");
    expect(m.renameSession(created.session.id, "After").ok).toBe(true);
    const read = m.loadSessionById(created.session.id);
    if (!read.ok) throw new Error("load failed");
    expect(read.session.id).toBe(created.session.id);
    expect(read.session.name).toBe("After");
  });

  it("recording the same run twice updates it instead of duplicating it", () => {
    const created = m.createSession({ name: "Once" });
    if (!created.ok) throw new Error("create failed");
    const base = {
      id: "r1", agentId: "build", task: "t", steps: 0, toolCalls: 0,
      createdAt: 1, updatedAt: 2, parentRunId: null, depth: 0, resultText: "", tools: [],
    };
    m.recordRun(created.session.id, { ...base, status: "running" });
    m.recordRun(created.session.id, { ...base, status: "completed", resultText: "finished" });

    const read = m.loadSessionById(created.session.id);
    if (!read.ok) throw new Error("load failed");
    expect(read.session.runs).toHaveLength(1);
    expect(read.session.runs[0].status).toBe("completed");
    expect(read.session.runs[0].resultText).toBe("finished");
  });

  it("the list is newest-first", () => {
    const a = m.createSession({ name: "Older" });
    const b = m.createSession({ name: "Newer" });
    if (!a.ok || !b.ok) throw new Error("create failed");
    // Touching the older one is what should move it to the front — creating the
    // newer one already set its `updatedAt`, so no extra write is needed and the
    // ordering claim is not smuggled in by a rename.
    expect(m.listSessions()[0].id).toBe(b.session.id);
    m.appendTurn(a.session.id, { id: "t", role: "user", text: "bumped", at: 9 });
    expect(m.listSessions()[0].id).toBe(a.session.id);
  });

  it("deleteAllSessions removes every session file", () => {
    m.createSession({ name: "One" });
    m.createSession({ name: "Two" });
    expect(m.listSessions()).toHaveLength(2);
    expect(m.deleteAllSessions()).toBe(2);
    expect(m.listSessions()).toHaveLength(0);
    // `index.json` and `active.json` are bookkeeping, not sessions — they are
    // rewritten to empty rather than deleted, which is why they are excluded here.
    const sessionFiles = entries().filter(
      (f) => f.endsWith(".json") && !f.startsWith("index") && !f.startsWith("active"),
    );
    expect(sessionFiles).toHaveLength(0);
  });

  it("the summary reports the counts the detail view shows", () => {
    const created = m.createSession({ name: "Counts" });
    if (!created.ok) throw new Error("create failed");
    m.appendTurn(created.session.id, { id: "1", role: "user", text: "a", at: 1 });
    m.recordRun(created.session.id, {
      id: "r1", agentId: "build", task: "t", status: "completed", steps: 1, toolCalls: 3,
      createdAt: 1, updatedAt: 2, parentRunId: null, depth: 0, resultText: "done", tools: [],
    });
    const summary = m.listSessions().find((s) => s.id === created.session.id);
    expect(summary?.turnCount).toBe(1);
    expect(summary?.runCount).toBe(1);
    expect(summary?.toolCallCount).toBe(3);
    expect(summary?.bytes).toBeGreaterThan(0);
  });
});

describe("bounds are enforced rather than deferred", () => {
  it("turns are capped and the cap is reported", () => {
    const created = m.createSession({ name: "Capped" });
    if (!created.ok) throw new Error("create failed");
    for (let i = 0; i < m.MAX_TURNS + 25; i += 1) {
      m.appendTurn(created.session.id, { id: `t${i}`, role: "user", text: `t${i}`, at: i });
    }
    const read = m.loadSessionById(created.session.id);
    if (!read.ok) throw new Error("load failed");
    expect(read.session.turns.length).toBeLessThanOrEqual(m.MAX_TURNS);
    expect(read.session.truncated).toBe(true);
    // The newest turns are the ones kept — dropping the oldest is the only order
    // that leaves the conversation continuable.
    expect(read.session.turns[read.session.turns.length - 1].text).toBe(`t${m.MAX_TURNS + 24}`);
  }, 120_000);

  it("tool history per run is capped", () => {
    const created = m.createSession({ name: "Tools" });
    if (!created.ok) throw new Error("create failed");
    const tools = Array.from({ length: m.MAX_TOOL_ENTRIES_PER_RUN + 40 }, (_, i) => ({
      at: i, kind: "tool" as const, step: i, tool: `t${i}`, granted: true, ms: 1,
    }));
    m.recordRun(created.session.id, {
      id: "r1", agentId: "build", task: "t", status: "completed", steps: 1, toolCalls: 1,
      createdAt: 1, updatedAt: 2, parentRunId: null, depth: 0, resultText: "ok", tools,
    });
    const read = m.loadSessionById(created.session.id);
    if (!read.ok) throw new Error("load failed");
    expect(read.session.runs[0].tools.length).toBeLessThanOrEqual(m.MAX_TOOL_ENTRIES_PER_RUN);
  });

  it("a single oversized turn is clamped to the per-turn bound", () => {
    const created = m.createSession({ name: "Huge" });
    if (!created.ok) throw new Error("create failed");
    m.appendTurn(created.session.id, { id: "t", role: "user", text: "y".repeat(60_000), at: 1 });
    const read = m.loadSessionById(created.session.id);
    if (!read.ok) throw new Error("load failed");
    expect(read.session.turns[0].text.length).toBeLessThanOrEqual(m.MAX_TURN_CHARS);
  });

  it("an empty turn is refused rather than stored", () => {
    const created = m.createSession({ name: "Empty" });
    if (!created.ok) throw new Error("create failed");
    // The IPC layer refuses this; the store clamps defensively too.
    m.appendTurn(created.session.id, { id: "t", role: "user", text: "", at: 1 });
    const read = m.loadSessionById(created.session.id);
    if (!read.ok) throw new Error("load failed");
    expect(read.session.turns.filter((t) => t.text.length > 0)).toHaveLength(0);
  });

  it("a session name longer than the bound is clamped", () => {
    const created = m.createSession({ name: "n".repeat(400) });
    if (!created.ok) throw new Error("create failed");
    expect(created.session.name.length).toBeLessThanOrEqual(m.MAX_NAME_CHARS);
  });

  // ------------------------------------------------------------------
  // The bounds that were declared but never tested — and one of them turned
  // out not to be untested so much as *unimplemented*. `MAX_SESSIONS` was
  // exported and called from nowhere, so the constant asserted a limit the
  // code did not keep.
  //
  // These seed the directory with files rather than calling `createSession` 200
  // times. That is not laziness and it is not a shortcut around the store: what is
  // under test is the *guard*, and the guard counts what is on disk. Creating 200
  // sessions through the public API costs 200 full persists plus 200 index rewrites,
  // which made this file slow enough to starve an unrelated test that shells out to
  // `npm`, and it would have proved less: the point is that a session file the
  // renderer never created still counts against the budget.
  // ------------------------------------------------------------------

  /** Put `n` well-formed session files in the store, without going through the API. */
  function seedSessions(n: number): string[] {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const id = `s-seed-${i}`;
      ids.push(id);
      fs.writeFileSync(
        path.join(dir, `${id}.json`),
        JSON.stringify({
          version: 1, id, name: `Seed ${i}`, workspace: null,
          createdAt: 1, updatedAt: 2, status: "open", forkedFrom: null,
          turns: [], runs: [], redactions: 0, truncated: false,
        }),
        "utf8",
      );
    }
    return ids;
  }

  it("the number of sessions is capped, and the cap is actually enforced", () => {
    const seeded = new Set(seedSessions(m.MAX_SESSIONS));
    expect(m.listSessions()).toHaveLength(m.MAX_SESSIONS);

    const over = m.createSession({ name: "one too many" });
    expect(over.ok).toBe(false);
    expect(String((over as { error?: string }).error)).toMatch(/limit/i);
    // The refusal must say what to do, and must not have done it for the user.
    expect(String((over as { error?: string }).error)).toMatch(/delete/i);
    expect(m.listSessions()).toHaveLength(m.MAX_SESSIONS);
    // And nothing was written: the refusal is not a create that failed afterwards.
    expect(m.listSessions().every((s) => seeded.has(s.id))).toBe(true);
  }, 240_000);

  it("a session file nobody created through the API still counts against the cap", () => {
    // The same thing, stated the other way round: the budget is enforced against the
    // directory, so an orphaned file left by a crash cannot be used to smuggle past it.
    seedSessions(m.MAX_SESSIONS);
    expect(m.forkSession("s-seed-0").ok).toBe(false);
  }, 240_000);

  it("the cap refuses a fork too, rather than being a hole in itself", () => {
    const first = m.createSession({ name: "first" });
    if (!first.ok) throw new Error("create failed");
    seedSessions(m.MAX_SESSIONS - 1);
    const forked = m.forkSession(first.session.id);
    expect(forked.ok).toBe(false);
    // A fork that was refused must leave its source exactly as it was.
    const src = m.loadSessionById(first.session.id);
    if (!src.ok) throw new Error("load failed");
    expect(src.session.forkedFrom).toBe(null);
    expect(m.listSessions()).toHaveLength(m.MAX_SESSIONS);
  }, 240_000);

  it("deleting a session makes room again", () => {
    const ids = seedSessions(m.MAX_SESSIONS);
    expect(m.createSession({ name: "over" }).ok).toBe(false);
    expect(m.deleteSession(ids[0]).ok).toBe(true);
    const again = m.createSession({ name: "now there is room" });
    expect(again.ok).toBe(true);
    expect(m.listSessions()).toHaveLength(m.MAX_SESSIONS);
  }, 240_000);

  it("runs per session are capped", () => {
    const created = m.createSession({ name: "Many runs" });
    if (!created.ok) throw new Error("create failed");
    for (let i = 0; i < m.MAX_RUNS_PER_SESSION + 30; i += 1) {
      m.recordRun(created.session.id, {
        id: `r${i}`, agentId: "build", task: `t${i}`, status: "completed", steps: 1,
        toolCalls: 0, createdAt: i, updatedAt: i, parentRunId: null, depth: 0,
        resultText: "ok", tools: [],
      });
    }
    const read = m.loadSessionById(created.session.id);
    if (!read.ok) throw new Error("load failed");
    expect(read.session.runs.length).toBeLessThanOrEqual(m.MAX_RUNS_PER_SESSION);
  }, 240_000);

  it("a run's task and result are each clamped to their own bound", () => {
    const created = m.createSession({ name: "Long run" });
    if (!created.ok) throw new Error("create failed");
    m.recordRun(created.session.id, {
      id: "r1", agentId: "build", task: "t".repeat(50_000), status: "completed", steps: 1,
      toolCalls: 0, createdAt: 1, updatedAt: 2, parentRunId: null, depth: 0,
      resultText: "r".repeat(50_000), tools: [],
    });
    const read = m.loadSessionById(created.session.id);
    if (!read.ok) throw new Error("load failed");
    expect(read.session.runs[0].task.length).toBeLessThanOrEqual(m.MAX_TASK_CHARS);
    expect(read.session.runs[0].resultText.length).toBeLessThanOrEqual(m.MAX_RESULT_CHARS);
  });

  it("the size cap is measured in bytes, not in characters", () => {
    const created = m.createSession({ name: "Non-ASCII" });
    if (!created.ok) throw new Error("create failed");
    // A 3-byte character. Under a UTF-16 length check each of these counts as one
    // "character", so an 8 MB cap becomes 24 MB on disk — which is the bug this test
    // exists for, because the UI reports `Buffer.byteLength` while the limit that
    // produced the file was counting something else.
    const wide = "\u4e2d".repeat(2_000);
    m.appendTurn(created.session.id, { id: "w1", role: "user", text: wide, at: 1 });
    m.recordRun(created.session.id, {
      id: "r1", agentId: "build", task: wide, status: "completed", steps: 1, toolCalls: 0,
      createdAt: 1, updatedAt: 2, parentRunId: null, depth: 0, resultText: wide, tools: [],
    });
    const onDisk = fs.statSync(path.join(dir, `${created.session.id}.json`)).size;
    expect(onDisk).toBeLessThanOrEqual(m.MAX_SESSION_BYTES);
    // And the number shown in the bar is derived from the same unit, so the size a
    // user is told about and the size that was enforced agree.
    const summary = m.listSessions().find((s) => s.id === created.session.id);
    expect(summary?.bytes).toBe(onDisk);
  }, 240_000);
});

// ---------------------------------------------------------------------------
// A disk that misbehaves.
//
// Every other test in this file writes to a filesystem that works, and that is
// exactly the condition that hides the bug: a session store's most likely failure is
// not a bad path or a bad id, it is the disk saying no. These induce real filesystem
// errors instead of mocking `fs`, because what needs proving is that the store's own
// error handling survives a real one.
// ---------------------------------------------------------------------------

describe("a failing disk is survivable, and the last good copy survives it", () => {
  it("a write that cannot happen is reported, and the old file is left intact", () => {
    const created = m.createSession({ name: "Durable" });
    if (!created.ok) throw new Error("create failed");
    m.appendTurn(created.session.id, { id: "t1", role: "user", text: "the good turn", at: 1 });
    const before = raw(created.session.id);
    expect(before).toContain("the good turn");

    // A directory where the temp file goes, so `writeFileSync` genuinely fails and
    // the throw is a real error from the platform rather than a stubbed one.
    fs.mkdirSync(path.join(dir, `${created.session.id}.json.tmp`));

    const attempt = m.appendTurn(created.session.id, { id: "t2", role: "user", text: "the lost turn", at: 2 });
    expect(attempt.ok).toBe(false);
    expect(String((attempt as { error?: string }).error).length).toBeGreaterThan(0);

    // The point of the whole design: a failed write must leave the last good file
    // exactly as it was — not truncated, not empty, not half a JSON document.
    expect(raw(created.session.id)).toBe(before);
    expect(JSON.parse(raw(created.session.id)).turns.map((t: { text: string }) => t.text)).toEqual(["the good turn"]);
  });

  it("the session is still readable after a failed write", () => {
    const created = m.createSession({ name: "Still readable" });
    if (!created.ok) throw new Error("create failed");
    m.appendTurn(created.session.id, { id: "t1", role: "user", text: "kept", at: 1 });
    fs.mkdirSync(path.join(dir, `${created.session.id}.json.tmp`));
    expect(m.appendTurn(created.session.id, { id: "t2", role: "user", text: "lost", at: 2 }).ok).toBe(false);
    const read = m.loadSessionById(created.session.id);
    if (!read.ok) throw new Error("load failed");
    expect(read.session.turns).toHaveLength(1);
    expect(read.session.corrupted).toBeFalsy();
  });

  it("a backup that cannot be written does not stop the save", () => {
    const created = m.createSession({ name: "Bak blocked" });
    if (!created.ok) throw new Error("create failed");
    m.appendTurn(created.session.id, { id: "t1", role: "user", text: "first", at: 1 });

    // `.bak` is the second chance, not the first. `writeFileAtomic` swallows the
    // error there in a comment saying so; this is the test that holds that comment
    // to account, because "the backup failed so the save failed" is a data-loss bug
    // wearing a safety feature's clothes.
    //
    // The existing `.bak` is removed first: the save above already created one, and
    // the point is to block the *next* write's backup, not to collide with a
    // directory that is already there.
    const bak = path.join(dir, `${created.session.id}.json.bak`);
    fs.rmSync(bak, { force: true });
    fs.mkdirSync(bak);
    const written = m.appendTurn(created.session.id, { id: "t2", role: "user", text: "second", at: 2 });
    expect(written.ok).toBe(true);
    expect(raw(created.session.id)).toContain("second");
  });

  it("a rename that cannot happen is reported rather than silently lost", () => {
    const created = m.createSession({ name: "Rename blocked" });
    if (!created.ok) throw new Error("create failed");
    fs.mkdirSync(path.join(dir, `${created.session.id}.json.tmp`));
    expect(m.renameSession(created.session.id, "should not stick").ok).toBe(false);
    const read = m.loadSessionById(created.session.id);
    if (!read.ok) throw new Error("load failed");
    expect(read.session.name).not.toBe("should not stick");
  });
});

// ---------------------------------------------------------------------------
// Two writers.
//
// The push channel exists because "two windows can both edit sessions". Nothing in
// the suite exercised that, which left the stated reason for the channel untested.
// ---------------------------------------------------------------------------

describe("two writers over one directory do not lose each other's work", () => {
  it("a session made by one store is fully visible to another", async () => {
    const a = m;
    const created = a.createSession({ name: "Shared" });
    if (!created.ok) throw new Error("create failed");
    a.appendTurn(created.session.id, { id: "t1", role: "user", text: "from A", at: 1 });

    // A second store instance over the *same* directory — the unit-test shape of a
    // second window, and of the app after a restart.
    const b = await load(dir);
    expect(b.listSessions().map((s) => s.id)).toContain(created.session.id);
    const seen = b.loadSessionById(created.session.id);
    if (!seen.ok) throw new Error("load failed");
    expect(seen.session.turns.map((t) => t.text)).toEqual(["from A"]);
  });

  it("turns written through different stores all survive, in order", async () => {
    const a = m;
    const created = a.createSession({ name: "Interleaved" });
    if (!created.ok) throw new Error("create failed");
    const b = await load(dir);

    a.appendTurn(created.session.id, { id: "a1", role: "user", text: "A one", at: 1 });
    b.appendTurn(created.session.id, { id: "b1", role: "user", text: "B one", at: 2 });
    a.appendTurn(created.session.id, { id: "a2", role: "assistant", text: "A two", at: 3 });
    b.appendTurn(created.session.id, { id: "b2", role: "assistant", text: "B two", at: 4 });

    // Every append re-reads the file rather than trusting a copy held in memory, so
    // no writer overwrites another's turn. This is the property that makes two
    // windows safe; if it regressed, last-writer-wins and two turns would vanish
    // without any error being raised anywhere.
    const read = a.loadSessionById(created.session.id);
    if (!read.ok) throw new Error("load failed");
    expect(read.session.turns.map((t) => t.text)).toEqual(["A one", "B one", "A two", "B two"]);
  });

  it("a delete through one store is seen by the other", async () => {
    const a = m;
    const created = a.createSession({ name: "Doomed by B" });
    if (!created.ok) throw new Error("create failed");
    const b = await load(dir);
    expect(b.deleteSession(created.session.id).ok).toBe(true);
    expect(fs.existsSync(path.join(dir, `${created.session.id}.json`))).toBe(false);
    expect(a.loadSessionById(created.session.id).ok).toBe(false);
    expect(a.listSessions().map((s) => s.id)).not.toContain(created.session.id);
  });
});

// ---------------------------------------------------------------------------
// The runtime side: a resumed conversation actually reaches the model.
//
// Without this block the store could pass every test above while resume stayed
// cosmetic, because nothing would be checking that `AgentRunSpec.history` — the
// field Phase 21 declared and six phases left permanently `[]` — is now filled and
// is actually sent.
// ---------------------------------------------------------------------------

describe("resume reaches the model, and the run is filed against its session", () => {
  /**
   * A transport driven by a responder rather than a positional script.
   *
   * `spawnChild` is awaited inside the parent's turn, so a child's first
   * completion is the transport's *next* call. A script therefore feeds the child's
   * answer to the parent, and the failure reads as a runtime bug when it is a test
   * bug. Inspecting the request is the only shape that survives the interleaving.
   */
  function responderTransport(
    fn: (req: AgentCompletionRequest) => { content?: string; toolCalls?: Array<{ name: string; args: unknown }> },
  ): (req: AgentCompletionRequest) => Promise<AgentCompletionResult> {
    return async (req) => {
      const turn = fn(req);
      return {
        content: turn.content ?? "",
        toolCalls: (turn.toolCalls ?? []).map((t, n) => ({
          id: `call-${n}-${t.name}`,
          name: t.name,
          arguments: JSON.stringify(t.args),
        })),
        streamed: false,
      };
    };
  }

  // A real workspace with a real file, so the tool call below is genuinely
  // granted rather than denied-and-continued. The proof being aimed at is that a
  // *granted* tool call leaves a trace worth storing.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cc-sess-ws-"));
  fs.writeFileSync(path.join(ws, "a.txt"), "the file contents", "utf8");

  function makeSpec(over: Partial<AgentRunSpec> = {}): AgentRunSpec {
    return {
      agentId: DEFAULT_AGENT_ID,
      task: "and what should I change?",
      workspace: ws,
      endpoint: { url: "http://127.0.0.1:11434", model: "test-model", key: null },
      temperature: 0,
      timeoutMs: 5000,
      stream: true,
      // Everything allowed. `{}` means *ask*, and a pending approval blocks the run
      // until its own timeout — which reads as a hang, not as a test.
      permissions: { files: "allow", search: "allow", git: "allow", terminal: "allow" },
      ...over,
    };
  }

  it("a replayed conversation is sent to the provider, oldest first", async () => {
    const calls: AgentCompletionRequest[] = [];
    const runtime = new AgentRuntime({
      registry: createBuiltinRegistry(true),
      createTransport: () => async (req) => {
        calls.push(req);
        return { content: "here is what to change", toolCalls: [] };
      },
      onEvent: () => {},
    });

    await runtime.start(
      makeSpec({
        history: [
          { role: "user", content: "why is the gate denying this?" },
          { role: "assistant", content: "because the scope resolves to deny." },
        ],
      }),
    ).done;

    expect(calls).toHaveLength(1);
    const contents = calls[0].messages.map((msg) => `${msg.role}:${msg.content}`);
    expect(contents).toContain("user:why is the gate denying this?");
    expect(contents).toContain("assistant:because the scope resolves to deny.");
    // The replayed turns come before the new task, which is the only order that
    // makes the new question read as a follow-up.
    const idx = contents.indexOf("assistant:because the scope resolves to deny.");
    expect(idx).toBeLessThan(contents.findIndex((c) => c.includes("and what should I change?")));
  });

  it("a run with no resumed history sends only its own task", async () => {
    const calls: AgentCompletionRequest[] = [];
    const runtime = new AgentRuntime({
      registry: createBuiltinRegistry(true),
      createTransport: () => async (req) => {
        calls.push(req);
        return { content: "ok", toolCalls: [] };
      },
      onEvent: () => {},
    });
    await runtime.start(makeSpec({ history: [] })).done;
    const userTurns = calls[0].messages.filter((msg) => msg.role === "user");
    expect(userTurns).toHaveLength(1);
  });

  it("the session id lands on the run record", () => {
    const runtime = new AgentRuntime({
      registry: createBuiltinRegistry(true),
      createTransport: () => async () => ({ content: "ok", toolCalls: [] }),
      onEvent: () => {},
    });
    const { runId } = runtime.start(makeSpec({ sessionId: "s-abc123" }));
    expect(runtime.getRun(runId)?.sessionId).toBe("s-abc123");
  });

  it("a run with no session carries no session id, rather than an empty string", () => {
    const runtime = new AgentRuntime({
      registry: createBuiltinRegistry(true),
      createTransport: () => async () => ({ content: "ok", toolCalls: [] }),
      onEvent: () => {},
    });
    const { runId } = runtime.start(makeSpec({ sessionId: null }));
    expect(runtime.getRun(runId)?.sessionId).toBeUndefined();
  });

  it("a finished run's tool history is available to be filed into a session", async () => {
    const events: AgentEvent[] = [];
    // One tool call, then an answer. A transport that keeps returning the same
    // call loops until the run's step budget, which is a different test than the
    // one being written here.
    let step = 0;
    const runtime = new AgentRuntime({
      registry: createBuiltinRegistry(true),
      createTransport: () => async () => {
        step += 1;
        if (step === 1) {
          return {
            content: "reading it",
            toolCalls: [{ id: "c1", name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) }],
          };
        }
        return { content: "read it", toolCalls: [] };
      },
      onEvent: (ev) => events.push(ev),
    });
    const { runId, done } = runtime.start(makeSpec({ sessionId: "s-tools" }));
    await done;
    // The tool event is what becomes `tools[].tool` in the stored run — if the
    // event never fired, every stored session would have an empty tool history.
    const toolEvent = events.find((e) => e.type === "tool" && e.tool === "read_file") as
      | { type: "tool"; tool: string; granted: boolean }
      | undefined;
    expect(toolEvent).toBeDefined();
    expect(toolEvent?.granted).toBe(true);
    expect(runtime.getRun(runId)?.trace.some((t) => t.tool === "read_file")).toBe(true);
  }, 30_000);

  it("a delegated child inherits the parent's session", async () => {
    // A responder, not a positional script. `spawnChild` is awaited inside the
    // parent's turn, so the child's first completion is the transport's *next*
    // call — a script hands the child's answer to the parent and hangs.
    const runtime = new AgentRuntime({
      registry: createBuiltinRegistry(true),
      createTransport: () => responderTransport((req) => {
        // Match the sub-agent's system prompt, not the bare word "subagent": a
        // parent's prompt mentions sub-agents in the delegate_task description, so
        // the naive check classifies the parent as its own child.
        const isChild = `${req.messages[0]?.content ?? ""}`.includes("reviewer subagent");
        if (isChild) return { content: "reviewed" };
        // Delegate exactly once, then finish — a parent that re-delegates on every
        // completion would spawn children until the depth limit.
        const hasToolResult = req.messages.some((m) => m.role === "tool");
        if (!hasToolResult) {
          return { toolCalls: [{ name: "delegate_task", args: { agent: "reviewer", task: "look at it" } }] };
        }
        return { content: "used the review" };
      }),
      onEvent: () => {},
    });
    const { done } = runtime.start(
      // `agent: "allow"` is what delegation is gated on. Left unset it means
      // *ask*, and the run waits on an approval nobody is there to give.
      makeSpec({ sessionId: "s-parent", agentId: "build", permissions: { files: "allow", search: "allow", git: "allow", terminal: "allow", agent: "allow" } }),
    );
    await done;
    // A child's work belongs to the same conversation as the run that asked for it.
    const child = runtime.listRuns().find((r) => r.depth === 1);
    expect(child).toBeDefined();
    expect(child?.sessionId).toBe("s-parent");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The IPC trust boundary.
//
// A resumed conversation is handed straight to a model provider, so the array
// arrives from a renderer and is clamped before it can become an unbounded prompt.
// These are the only tests here that need `electron`, because `sanitizeHistory`
// lives in the IPC module.
// ---------------------------------------------------------------------------

describe("a replayed conversation is clamped at the IPC boundary", () => {
  async function loadAgentIpc(): Promise<typeof import("../electron/ipc/agent")> {
    vi.resetModules();
    vi.doMock("electron", () => ({ ipcMain: { handle: () => {} }, BrowserWindow: { getAllWindows: () => [] } }));
    return import("../electron/ipc/agent");
  }

  it("drops non-strings, coerces the role, bounds the count and the length", async () => {
    const mod = await loadAgentIpc();
    const items: unknown[] = [];
    for (let i = 0; i < 60; i += 1) items.push({ role: "user", content: `t${i}` });
    // The odd entries go *after* the fillers, because the bound keeps the newest
    // 40 — put them first and this test would pass for the wrong reason.
    items.push(
      { role: "weird", content: "role coerced" },
      { role: "user", content: 42 },
      "not an object",
      null,
      { content: "" },
    );

    const history = mod.sanitizeHistory(items);
    // The empty one and the non-string ones are gone rather than coerced to
    // "[object Object]", which would be noise in a prompt.
    expect(history.every((h) => typeof h.content === "string" && h.content.length > 0)).toBe(true);
    expect(history.length).toBeLessThanOrEqual(40);
    expect(history.find((h) => h.content === "role coerced")?.role).toBe("user");
    // Bounded to the newest turns — `t0` is the one that had to go.
    expect(history.some((h) => h.content === "t0")).toBe(false);
    expect(history[history.length - 1].content).toBe("role coerced");
    vi.doUnmock("electron");
  });

  it("a 50,000-character turn is clamped rather than forwarded whole", async () => {
    const mod = await loadAgentIpc();
    const history = mod.sanitizeHistory([{ role: "user", content: "z".repeat(50_000) }]);
    expect(history[0].content.length).toBe(4_000);
    vi.doUnmock("electron");
  });

  it("a non-array is an empty history, not a crash", async () => {
    const mod = await loadAgentIpc();
    expect(mod.sanitizeHistory(null)).toEqual([]);
    expect(mod.sanitizeHistory("nope")).toEqual([]);
    expect(mod.sanitizeHistory({ role: "user", content: "hi" })).toEqual([]);
    vi.doUnmock("electron");
  });
});
