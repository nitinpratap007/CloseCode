// Phase 31 — instruction files and skills.
//
// Structure: the loaders (real files in real temp directories — the properties
// that matter are filesystem properties), the SKILL.md parser, discovery and
// shadowing, the tool as a unit, and the runtime's restriction semantics in
// real runs over scripted transports. The acceptance criterion "skills cannot
// bypass security permissions" is proven twice: by the gate (a skill's body is
// just text) and by the restriction being narrow-only.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { AgentRuntime, type AgentRuntimeOptions } from "../electron/services/agent/runtime";
import { createBuiltinRegistry } from "../electron/services/agent/tools";
import { createSkillTools, type SkillToolService } from "../electron/services/agent/tools-skills";
import { parseSkillFile } from "../electron/services/skills";
import type { AgentToolContext } from "../electron/services/agent/types";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "cc-skills-userdata-"));
vi.mock("electron", () => ({
  app: { getPath: () => userData },
}));

type InstrMod = typeof import("../electron/services/instructions");
type SkillsMod = typeof import("../electron/services/skills");

let userDir: string;
let wsDir: string;
let im: InstrMod;
let sm: SkillsMod;

async function load(): Promise<void> {
  vi.resetModules();
  im = await import("../electron/services/instructions");
  sm = await import("../electron/services/skills");
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-skills-user-"));
  wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-skills-ws-"));
  im.setInstructionsUserDataDir(userDir);
  sm.setSkillsUserDataDir(userDir);
}

function writeUser(rel: string, text: string): void {
  const file = path.join(userDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

function writeWs(rel: string, text: string): void {
  const file = path.join(wsDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

beforeEach(async () => {
  await load();
});

afterEach(() => {
  for (const d of [userDir, wsDir]) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // disposable
    }
  }
});

const SKILL_MD = (fm: string, body: string): string => `---\n${fm}\n---\n${body}`;

// ---------------------------------------------------------------------------

describe("1. instruction files: two scopes, bounded, deterministic", () => {
  it("loads user and project instructions with scope-prefixed names, user first", () => {
    writeUser("instructions/coding-style.md", "Prefer named exports.");
    writeWs(".closecode/instructions/security.md", "Never log secrets.");
    const files = im.collectInstructions(wsDir);
    expect(files.map((f) => f.name)).toEqual(["user:coding-style.md", "project:security.md"]);
    expect(files[0].scope).toBe("user");
    expect(files[1].scope).toBe("project");
  });

  it("project files are not read without a workspace, and user files always are", () => {
    writeUser("instructions/a.md", "user rule");
    writeWs(".closecode/instructions/b.md", "project rule");
    expect(im.collectInstructions(null).map((f) => f.name)).toEqual(["user:a.md"]);
  });

  it("ignores non-markdown, empties and giant files; sorts alphabetically", () => {
    writeUser("instructions/z.md", "zeta");
    writeUser("instructions/a.md", "alpha");
    writeUser("instructions/skip.txt", "not markdown");
    writeUser("instructions/empty.md", "   \n");
    writeUser("instructions/huge.md", "x".repeat(200 * 1024));
    const files = im.collectInstructions(null);
    expect(files.map((f) => f.name)).toEqual(["user:a.md", "user:z.md"]);
  });

  it("caps the per-file size and says so in the text", () => {
    writeUser("instructions/long.md", "y".repeat(40_000));
    const files = im.collectInstructions(null);
    expect(files).toHaveLength(1);
    expect(files[0].text.length).toBeLessThan(33_000);
    expect(files[0].text).toContain("truncated");
  });

  it("the rendered block labels every file; the empty case is an empty block", () => {
    expect(im.renderInstructionBlock(wsDir).text).toBe("");
    writeUser("instructions/coding-style.md", "Two-space indent.");
    writeWs(".closecode/instructions/testing.md", "Vitest, not Jest.");
    const block = im.renderInstructionBlock(wsDir);
    expect(block.text).toContain("--- user:coding-style.md ---");
    expect(block.text).toContain("Two-space indent.");
    expect(block.text).toContain("--- project:testing.md ---");
    expect(block.text).toContain("Vitest, not Jest.");
    expect(block.files).toHaveLength(2);
  });

  it("the panel listing carries previews and absolute paths, not full text", () => {
    writeUser("instructions/coding-style.md", "x".repeat(2000));
    const list = im.listInstructionFiles(null);
    expect(list).toHaveLength(1);
    expect(list[0].preview.length).toBeLessThanOrEqual(601);
    expect(list[0].absolutePath).toContain("coding-style.md");
    expect((list[0] as Record<string, unknown>).text).toBeUndefined();
  });
});

describe("2. SKILL.md parsing and discovery", () => {
  it("parses a well-formed skill: name, description, allowed-tools, body", () => {
    const skill = parseSkillFile(SKILL_MD("name: review-diff\ndescription: Review the diff.\nallowed-tools: git_diff, read_file", "Check style first."), "/tmp/x/SKILL.md", "project");
    expect(skill).not.toBeNull();
    expect(skill?.name).toBe("review-diff");
    expect(skill?.description).toBe("Review the diff.");
    expect(skill?.allowedTools).toEqual(["git_diff", "read_file"]);
    expect(skill?.body).toBe("Check style first.");
    expect(skill?.source).toBe("project");
  });

  it("refuses files without frontmatter, a bad name, or an empty body", () => {
    expect(parseSkillFile("no frontmatter at all", "/f", "user")).toBeNull();
    expect(parseSkillFile(SKILL_MD("description: no name here", "body"), "/f", "user")).toBeNull();
    expect(parseSkillFile(SKILL_MD("name: BAD NAME!", "body"), "/f", "user")).toBeNull();
    expect(parseSkillFile(SKILL_MD("name: ok-name", "   "), "/f", "user")).toBeNull();
  });

  it("an empty allowed-tools list means unrestricted, not nothing-at-all", () => {
    const skill = parseSkillFile(SKILL_MD("name: free\ndescription: d\nallowed-tools:", "body"), "/f", "user");
    expect(skill?.allowedTools).toBeNull();
  });

  it("discovery finds project and user skills; project shadows a same-named user skill", () => {
    writeUser("skills/shared/SKILL.md", SKILL_MD("name: shared\ndescription: user version", "user body"));
    writeWs(".closecode/skills/shared/SKILL.md", SKILL_MD("name: shared\ndescription: project version", "project body"));
    writeWs(".closecode/skills/local/SKILL.md", SKILL_MD("name: local\ndescription: only project", "local body"));
    const skills = sm.discoverSkills(wsDir);
    expect(skills.map((s) => s.name).sort()).toEqual(["local", "shared"]);
    const shared = skills.find((s) => s.name === "shared");
    expect(shared?.source).toBe("project");
    expect(shared?.body).toBe("project body");
  });

  it("directories without a SKILL.md and malformed skills are skipped silently", () => {
    writeWs(".closecode/skills/nofile/README.md", "not a skill");
    writeWs(".closecode/skills/broken/SKILL.md", "garbage");
    writeWs(".closecode/skills/good/SKILL.md", SKILL_MD("name: good\ndescription: works", "body"));
    expect(sm.discoverSkills(wsDir).map((s) => s.name)).toEqual(["good"]);
  });

  it("readSkill names the available skills when the name is wrong", () => {
    writeWs(".closecode/skills/alpha/SKILL.md", SKILL_MD("name: alpha\ndescription: a", "body"));
    const missing = sm.readSkill(wsDir, "nope");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("alpha");
    const found = sm.readSkill(wsDir, "alpha");
    expect(found.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The tool as a unit
// ---------------------------------------------------------------------------

function fakeService(over: Partial<SkillToolService> = {}): SkillToolService & { reads: Array<{ workspace: string | null; name: string }> } {
  const reads: Array<{ workspace: string | null; name: string }> = [];
  const svc: SkillToolService = {
    read: (workspace, name) => {
      reads.push({ workspace, name });
      if (name === "review-diff") {
        return {
          ok: true,
          skill: {
            name: "review-diff",
            description: "Review the diff.",
            source: "project",
            allowedTools: ["search_files"],
            body: "First read the diff.",
          },
        };
      }
      return { ok: false, error: `No skill named "${name}". Available: review-diff.` };
    },
    ...over,
  };
  return Object.assign(svc, { reads });
}

function makeCtx(over: { authorize?: () => Promise<boolean> } = {}): AgentToolContext & { restricted: Array<{ names: string[] | null; skillName?: string }> } {
  const restricted: Array<{ names: string[] | null; skillName?: string }> = [];
  const ctx = {
    runId: "run_test",
    agentId: "build",
    workspace: "C:\\proj",
    signal: new AbortController().signal,
    deadline: Date.now() + 60_000,
    maxOutputChars: 10_000,
    authorize: over.authorize ?? (async () => true),
    log: () => undefined,
    restricted,
    restrictTools: (names: string[] | null, skillName?: string) => restricted.push({ names, skillName }),
  } as unknown as AgentToolContext & { restricted: Array<{ names: string[] | null; skillName?: string }> };
  return ctx;
}

describe("3. the use_skill tool", () => {
  it("invoking returns the body and applies the skill's restriction", async () => {
    const svc = fakeService();
    const [tool] = createSkillTools(svc);
    const ctx = makeCtx();
    const out = await tool.execute(ctx, { name: "review-diff" });
    expect(out.granted).toBe(true);
    expect(out.text).toContain("First read the diff.");
    expect(out.text).toContain("restricted");
    expect(ctx.restricted).toEqual([{ names: ["search_files"], skillName: "review-diff" }]);
    expect(svc.reads[0]).toEqual({ workspace: "C:\\proj", name: "review-diff" });
  });

  it("an unknown skill is a readable error naming what exists, with no restriction applied", async () => {
    const svc = fakeService();
    const [tool] = createSkillTools(svc);
    const ctx = makeCtx();
    const out = await tool.execute(ctx, { name: "nope" });
    expect(out.status).toBe("error");
    expect(out.text).toContain("review-diff");
    expect(ctx.restricted).toEqual([]);
  });

  it('"clear" lifts the restriction without touching the service', async () => {
    const svc = fakeService();
    const [tool] = createSkillTools(svc);
    const ctx = makeCtx();
    const out = await tool.execute(ctx, { name: "clear" });
    expect(out.granted).toBe(true);
    expect(ctx.restricted).toEqual([{ names: null, skillName: undefined }]);
    expect(svc.reads).toHaveLength(0);
  });

  it("the gate runs first: a denied invocation loads nothing", async () => {
    const svc = fakeService();
    const [tool] = createSkillTools(svc);
    const ctx = makeCtx({ authorize: async () => false });
    const out = await tool.execute(ctx, { name: "review-diff" });
    expect(out.granted).toBe(false);
    expect(svc.reads).toHaveLength(0);
    expect(ctx.restricted).toEqual([]);
  });

  it("is read-only and in the skills category", () => {
    const [tool] = createSkillTools(fakeService());
    expect(tool.category).toBe("skills");
    expect(tool.readOnly).toBe(true);
    expect(tool.destructive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The runtime: the restriction is enforced, and it can only narrow
// ---------------------------------------------------------------------------

function scriptedTransport(script: Array<{ content?: string; toolCalls?: Array<{ name: string; args: unknown }> }>): {
  transport: NonNullable<AgentRuntimeOptions["createTransport"]>;
} {
  let i = 0;
  const transport = async () => {
    const turn = script[Math.min(i, script.length - 1)];
    i += 1;
    return {
      content: turn.content ?? "",
      toolCalls: (turn.toolCalls ?? []).map((tc, n) => ({
        id: `call-${i}-${n}`,
        name: tc.name,
        arguments: JSON.stringify(tc.args),
      })),
      streamed: false,
    };
  };
  return { transport };
}

function makeRuntime(script: Array<{ content?: string; toolCalls?: Array<{ name: string; args: unknown }> }>, svc?: SkillToolService): AgentRuntime {
  const { transport } = scriptedTransport(script);
  return new AgentRuntime({
    registry: createBuiltinRegistry(true, createSkillTools(svc ?? fakeService())),
    createTransport: () => transport,
    onEvent: () => undefined,
    skills: () => [{ name: "review-diff", description: "Review the diff.", allowedTools: ["search_files"] }],
  });
}

const SPEC = {
  agentId: "build",
  task: "Do the work.",
  workspace: "C:\\proj",
  endpoint: { url: "http://127.0.0.1:11434", model: "t", key: null },
  temperature: 0,
  timeoutMs: 5000,
  stream: true,
};

describe("4. the runtime enforces the restriction, and it only narrows", () => {
  it("the system prompt indexes the skills with their restriction", async () => {
    const calls: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const transport = async (req: { messages: Array<{ role: string; content: string }> }) => {
      calls.push(req);
      return { content: "done", toolCalls: [], streamed: false };
    };
    const runtime = new AgentRuntime({
      registry: createBuiltinRegistry(true, createSkillTools(fakeService())),
      createTransport: () => transport,
      onEvent: () => undefined,
      skills: () => [{ name: "review-diff", description: "Review the diff.", allowedTools: ["search_files"] }],
    });
    await runtime.run({ ...SPEC, permissions: { skills: "allow" } });
    const system = calls[0].messages.find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain("review-diff");
    expect(system).toContain("restricted to: search_files");
  });

  it("after invoking a restricted skill, a call outside its tools is refused with the skill named", async () => {
    const runtime = makeRuntime([
      { toolCalls: [{ name: "use_skill", args: { name: "review-diff" } }] },
      { toolCalls: [{ name: "write_file", args: { path: "C:\\proj\\x.txt", content: "x" } }] },
      { content: "Stopped." },
    ]);
    const result = await runtime.run({ ...SPEC, permissions: { files: "allow", skills: "allow" } });
    expect(result.status).toBe("completed");
    const trace = runtime.getRun(result.runId)?.trace ?? [];
    const skillCall = trace.find((t) => t.kind === "tool" && (t as { tool?: string }).tool === "use_skill") as { granted?: boolean } | undefined;
    expect(skillCall?.granted).toBe(true);
    const writeCall = trace.find((t) => t.kind === "tool" && (t as { tool?: string }).tool === "write_file") as { granted?: boolean; text?: string } | undefined;
    expect(writeCall?.granted).toBe(false);
    // The trace line is the generic denial summary; the refusal's own words —
    // naming the skill and what it allows — ride the tool message the model
    // actually receives.
    const toolMessage = runtime.getRun(result.runId)?.messages.find((msg) => msg.role === "tool" && (msg as { name?: string }).name === "write_file");
    expect(toolMessage?.content).toContain("review-diff");
    expect(toolMessage?.content).toContain("search_files");
  });

  it("a tool the skill names still passes the normal gate — the restriction cannot widen", async () => {
    // The skill allows write_file; the user's policy denies it. Both apply.
    const svc = fakeService({
      read: () => ({
        ok: true,
        skill: { name: "review-diff", description: "d", source: "project", allowedTools: ["write_file"], body: "Write the file." },
      }),
    });
    const runtime = makeRuntime([
      { toolCalls: [{ name: "use_skill", args: { name: "review-diff" } }] },
      { toolCalls: [{ name: "write_file", args: { path: "C:\\proj\\x.txt", content: "x" } }] },
      { content: "Stopped." },
    ], svc);
    const result = await runtime.run({ ...SPEC, permissions: { files: "deny", skills: "allow" } });
    expect(result.status).toBe("completed");
    const trace = runtime.getRun(result.runId)?.trace ?? [];
    const writeCall = trace.find((t) => t.kind === "tool" && (t as { tool?: string }).tool === "write_file") as { granted?: boolean } | undefined;
    expect(writeCall?.granted).toBe(false); // the gate's deny stands
  });

  it('"clear" lifts the restriction mid-run and the next call runs', async () => {
    const runtime = makeRuntime([
      { toolCalls: [{ name: "use_skill", args: { name: "review-diff" } }] },
      { toolCalls: [{ name: "use_skill", args: { name: "clear" } }] },
      { toolCalls: [{ name: "write_file", args: { path: "C:\\proj\\x.txt", content: "x" } }] },
      { content: "Done." },
    ]);
    const result = await runtime.run({ ...SPEC, permissions: { files: "allow", skills: "allow" } });
    expect(result.status).toBe("completed");
    const trace = runtime.getRun(result.runId)?.trace ?? [];
    const writeCall = trace.find((t) => t.kind === "tool" && (t as { tool?: string }).tool === "write_file") as { granted?: boolean } | undefined;
    // Granted is the assertion — the write itself may still fail on the
    // nonexistent C:\proj path, which is the tool's own recoverable error and
    // not a restriction or gate event.
    expect(writeCall?.granted).toBe(true);
  });

  it("an unrestricted skill leaves the run unrestricted", async () => {
    const svc = fakeService({
      read: () => ({
        ok: true,
        skill: { name: "review-diff", description: "d", source: "user", allowedTools: null, body: "Freeform." },
      }),
    });
    const runtime = makeRuntime([
      { toolCalls: [{ name: "use_skill", args: { name: "review-diff" } }] },
      { toolCalls: [{ name: "search_files", args: { query: "x" } }] },
      { content: "Done." },
    ], svc);
    const result = await runtime.run({ ...SPEC, permissions: { search: "allow", skills: "allow" } });
    expect(result.status).toBe("completed");
    const trace = runtime.getRun(result.runId)?.trace ?? [];
    const searchCall = trace.find((t) => t.kind === "tool" && (t as { tool?: string }).tool === "search_files") as { granted?: boolean } | undefined;
    expect(searchCall?.granted).toBe(true);
  });
});
