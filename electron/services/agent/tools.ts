// Close Code — AI Agent Runtime — tool invocation architecture (Phase 21)
//
// Phase 11 shipped tool calling as a `switch` statement inside `AiService`
// with a hard-coded definitions array. That made the tool set impossible to
// extend without editing the agent loop, so it is extracted here into a
// registry: the loop only ever talks to `ToolRegistry`, and adding a tool is
// now a single `register()` call.
//
// The six Phase 11 tools are migrated verbatim — same names, same arguments,
// same permission categories, same return strings — so existing agent-mode
// behaviour and its tests are unchanged.

import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { formatIssues, validateArgs } from "./schema";
import { normalizeOutcome, toolError } from "./result";
import { confineError } from "./paths";
import { SEARCH_LIMITS, truncationNote, walkWorkspace } from "./walk";
import { FILE_TOOLS } from "./tools-files";
import { GIT_TOOLS } from "./tools-git";
import { PROJECT_TOOLS } from "./tools-project";
import { WEB_TOOLS } from "./tools-web";
import { RESEARCH_TOOLS } from "./tools-research";
import type {
  AgentDefinition,
  AgentTool,
  AgentToolCategory,
  AgentToolContext,
  AgentToolOutcome,
  ToolDescriptor,
} from "./types";

export const DELEGATE_TOOL_NAME = "delegate_task";

const DENIED: AgentToolOutcome = { granted: false, text: "Permission denied by policy or user." };

/** JSON-schema shapes for the built-in tools, unchanged from Phase 11. */
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

// Path confinement moved to `paths.ts` in Phase 22, so the new tool modules can
// refuse a path and explain why without importing the registry. It is
// re-exported here because `confineToWorkspace` is part of this module's public
// surface (the runtime builds `AgentToolContext.confine` from it, and the
// Phase 21 suites import it from here).
export { confineToWorkspace } from "./paths";

/** Phase 11 `read_file`. */
const readFileTool: AgentTool = {
  name: "read_file",
  description: "Read a text file inside the workspace.",
  parameters: def("read_file", "", { path: str("Absolute path inside the workspace") }, ["path"]),
  category: "files",
  // Phase 23. Reading is not writing. Without this the gate falls back to the
  // category set (`files.read` + `files.write`), which would make a read-only
  // agent need write permission and make `files.write: deny` stop `read_file`
  // from working at all.
  capabilities: ["files.read"],
  readOnly: true,
  destructive: false,
  async execute(ctx, args): Promise<AgentToolOutcome> {
    // The path is passed to the gate so a `path`-scoped rule can apply, and so a
    // path outside the workspace pulls in `external.read`. It is the *resolved*
    // path that is sent: the gate has no business re-resolving a path the tool
    // is about to hand to `fs`.
    if (!(await ctx.authorize("files", args, { path: ctx.confine(String(args.path ?? "")) }))) return DENIED;
    const target = ctx.confine(String(args.path ?? ""));
    if (!target) return { granted: true, text: confineError(String(args.path ?? ""), ctx.workspace) };
    try {
      const stat = fs.statSync(target);
      if (stat.size > 2 * 1024 * 1024) return { granted: true, text: "Error: file too large to read." };
      return { granted: true, text: fs.readFileSync(target, "utf-8") };
    } catch (err) {
      return { granted: true, text: `Error reading file: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

/** Phase 11 `write_file`. */
const writeFileTool: AgentTool = {
  name: "write_file",
  description: "Write text content to a file inside the workspace (creates parent dirs).",
  parameters: def("write_file", "", { path: str("File path inside the workspace"), content: str("Full new file content") }, [
    "path",
    "content",
  ]),
  category: "files",
  capabilities: ["files.write"],
  readOnly: false,
  destructive: true,
  async execute(ctx, args): Promise<AgentToolOutcome> {
    if (!(await ctx.authorize("files", args, { path: ctx.confine(String(args.path ?? "")) }))) return DENIED;
    const target = ctx.confine(String(args.path ?? ""));
    if (!target) return { granted: true, text: confineError(String(args.path ?? ""), ctx.workspace) };
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const content = String(args.content ?? "");
      fs.writeFileSync(target, content, "utf-8");
      return { granted: true, text: `Wrote ${target} (${content.length} chars).` };
    } catch (err) {
      return { granted: true, text: `Error writing file: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

/** Phase 11 `list_dir`. */
const listDirTool: AgentTool = {
  name: "list_dir",
  description: "List the entries of a directory inside the workspace.",
  parameters: def("list_dir", "", { path: str("Default: workspace root") }),
  category: "files",
  capabilities: ["files.read"],
  readOnly: true,
  destructive: false,
  async execute(ctx, args): Promise<AgentToolOutcome> {
    if (!(await ctx.authorize("files", args, { path: ctx.confine(String(args.path ?? "")) || null }))) return DENIED;
    // An empty/absent path means "the workspace root", never the process cwd.
    const raw = String(args.path ?? "").trim();
    const target = raw ? ctx.confine(raw) : ctx.workspace;
    if (!target) return { granted: true, text: confineError(raw, ctx.workspace) };
    try {
      const entries = fs
        .readdirSync(target, { withFileTypes: true })
        .slice(0, 200)
        .map((e) => `${e.isDirectory() ? "[dir] " : ""}${e.name}`);
      return { granted: true, text: entries.join("\n") || "(empty directory)" };
    } catch (err) {
      return { granted: true, text: `Error listing directory: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

/** Phase 11 `search_files`. */
const searchFilesTool: AgentTool = {
  name: "search_files",
  description: "Search files in the workspace by filename (query) and/or content (text).",
  parameters: def(
    "search_files",
    "",
    { query: str("Substring of the file name"), text: str("Substring of file content") },
    ["query"],
  ),
  category: "search",
  capabilities: ["search.read"],
  readOnly: true,
  destructive: false,
  async execute(ctx, args): Promise<AgentToolOutcome> {
    if (!(await ctx.authorize("search", args))) return DENIED;
    const root = ctx.workspace;
    if (!root) return { granted: true, text: "No workspace open." };
    const query = String(args.query ?? "").toLowerCase();
    const textQuery = typeof args.text === "string" ? args.text.toLowerCase() : null;

    // Phase 22 moved the walk into `walk.ts`, shared with `grep_files`. The
    // bounds are unchanged: they are the same numbers Phase 21 used, and the
    // suite that pins them still pins them.
    const walk = walkWorkspace<string>(root, {
      ...SEARCH_LIMITS,
      readContent: textQuery !== null,
      accept: (f) => query === "" || f.name.toLowerCase().includes(query),
      visit: (f) => (textQuery && f.content && !f.content.toLowerCase().includes(textQuery) ? null : f.full),
    });

    if (!walk.results.length) {
      // A search that ran out of budget has *not* established that there is no
      // match, and must not report that it has.
      return {
        granted: true,
        text: walk.truncated
          ? `Searched ${walk.scanned} entries and stopped early; no match in that part of the workspace.`
          : "No matches.",
        status: walk.truncated ? "error" : "ok",
        ...(walk.truncated
          ? {
              error: toolError("limit_exceeded", `Search stopped after examining ${walk.scanned} entries without finding a match.`, {
                hint: "Narrow the query, or search a specific directory.",
                reportable: false,
              }),
              meta: { tool: "search_files", durationMs: 0, count: 0, truncated: true },
            }
          : { meta: { tool: "search_files", durationMs: 0, count: 0, truncated: false } }),
      };
    }
    return {
      granted: true,
      text: walk.results.join("\n") + truncationNote(walk),
      status: "ok",
      data: { files: walk.results, scanned: walk.scanned, truncated: walk.truncated },
      meta: { tool: "search_files", durationMs: 0, count: walk.results.length, truncated: walk.truncated },
    };
  },
};

/** Phase 11 `git_status`. */
const gitStatusTool: AgentTool = {
  name: "git_status",
  description: "Show the working tree status of the workspace repository.",
  parameters: { type: "object", properties: {} },
  category: "git",
  capabilities: ["git.read"],
  readOnly: true,
  destructive: false,
  execute(ctx): Promise<AgentToolOutcome> {
    return ctx.authorize("git", {}).then((ok) => {
      if (!ok) return DENIED;
      const cap = ctx.maxOutputChars;
      return new Promise<AgentToolOutcome>((resolve) => {
        exec(
          "git status --porcelain -b",
          { cwd: ctx.workspace ?? undefined, timeout: 15000, maxBuffer: 2 * 1024 * 1024 },
          (err, stdout, stderr) => {
            if (err && !stdout) {
              resolve({ granted: true, text: `git status: ${stderr.slice(0, cap) || err.message}` });
            } else {
              resolve({ granted: true, text: stdout.slice(0, cap) });
            }
          },
        );
      });
    });
  },
};

/** Phase 11 `run_terminal`. */
const runTerminalTool: AgentTool = {
  name: "run_terminal",
  description: "Run a short terminal command in the workspace. Use only for commands that finish quickly.",
  parameters: def("run_terminal", "", { command: str("Shell command to run") }, ["command"]),
  category: "terminal",
  // `shell.dangerous` is deliberately *not* declared here. It is added by the
  // gate when the command actually matches the destructive list, so a tool that
  // ran `echo` is not gated on a permission about deleting things. The gate owns
  // that decision so a tool cannot forget to make it.
  capabilities: ["shell.exec"],
  readOnly: false,
  destructive: true,
  async execute(ctx, args): Promise<AgentToolOutcome> {
    if (!(await ctx.authorize("terminal", args))) return DENIED;
    const command = String(args.command ?? "");
    if (!command.trim()) return { granted: true, text: "No command provided." };
    const cap = ctx.maxOutputChars;
    return new Promise<AgentToolOutcome>((resolve) => {
      // `signal` is what makes Stop real here: without it the child process
      // would keep running for up to the 15s cap after the user pressed Stop.
      // An aborted exec reports an AbortError, which we surface like any other
      // failure — the runtime has already abandoned this promise by then.
      exec(command, { cwd: ctx.workspace ?? undefined, timeout: 15000, maxBuffer: 1024 * 1024, signal: ctx.signal }, (err, stdout, stderr) => {
        const code = (err as { code?: number } | null)?.code;
        const out = (stdout + (err ? `\n[exit ${code}] ` + stderr : "")).slice(0, cap);
        resolve({ granted: true, text: out || "(no output)" });
      });
    });
  },
};

/**
 * Sub-agent delegation. Registered only when an agent definition declares
 * `delegates`, and always routed through `ctx.spawnChild`/`ctx.spawnChildren` so
 * the runtime keeps full ownership of the child's budget, state and
 * cancellation.
 *
 * Phase 25 adds a batch form. `agent` + `task` delegates to one subagent and
 * behaves exactly as Phase 21 did; `tasks` delegates to several at once, which
 * the runtime runs under a concurrency cap.
 *
 * The schema lists `agent`/`task`/`tasks` as all-optional rather than requiring
 * the first pair, because the pair is required *only* in the single form. A
 * schema that demanded `agent` would make the batch form unsendable, and one
 * that required nothing would let a malformed call reach the model as a runtime
 * error rather than being described. The check is in `execute`, where it can say
 * which of the two shapes it expected.
 */
export const delegateTool: AgentTool = {
  name: DELEGATE_TOOL_NAME,
  description:
    "Hand work to other CloseCode agents and get their answers back. Use `agent` + `task` for one " +
    "sub-agent, or `tasks` for several independent sub-agents that will run together and be bounded. " +
    "Good for work needing a different specialisation (a code review, a test run, a documentation " +
    "pass) rather than for work this agent can simply do itself.",
  parameters: def(
    DELEGATE_TOOL_NAME,
    "",
    {
      agent: str("Id of the sub-agent to run (single form)"),
      task: str("Self-contained task for the sub-agent (single form)"),
      tasks: {
        type: "array",
        description:
          "Several sub-tasks to run together (batch form). Each needs its own agent and task. " +
          "Results come back in this order.",
        items: {
          type: "object",
          properties: {
            agent: str("Id of the sub-agent for this task"),
            task: str("Self-contained task for that sub-agent"),
          },
          required: ["agent", "task"],
        },
      },
    },
    [],
  ),
  category: "agent",
  capabilities: ["agent.spawn"],
  readOnly: false,
  // A sub-agent gets its own permission gate and its own budget, but it can
  // still write files, so the approval prompt for `delegate_task` is one the
  // user genuinely wants to see.
  destructive: true,
  async execute(ctx, args): Promise<AgentToolOutcome> {
    if (!(await ctx.authorize("agent", args))) return DENIED;
    const batch = Array.isArray(args.tasks) ? args.tasks : null;
    // Declared outside the try so the catch block can name what failed. In the
    // batch form this stays empty and the message says "batch", which is the
    // honest description: a batch has no single target to name.
    const agentId = String(args.agent ?? "").trim();
    try {
      if (batch) {
        const parsed: Array<{ agentId: string; task: string }> = [];
        for (const raw of batch) {
          const entry = (raw ?? {}) as Record<string, unknown>;
          const agentId = String(entry.agent ?? "").trim();
          const task = String(entry.task ?? "").trim();
          if (!agentId || !task) {
            return {
              granted: true,
              text:
                "Error: every entry in `tasks` needs both `agent` and `task`. " +
                "Fix the list and call again.",
            };
          }
          parsed.push({ agentId, task });
        }
        if (parsed.length === 0) {
          return { granted: true, text: "Error: `tasks` was empty. Use `agent` + `task` for a single sub-agent." };
        }
        const results = await ctx.spawnChildren(parsed);
        // Positional, labelled by the requested id. A parent that reads this must
        // be able to tell which answer came from which sub-agent without counting.
        return {
          granted: true,
          text: results
            .map((r, i) => `### ${parsed[i].agentId}\n${r.text || r.error?.message || "(empty sub-agent response)"}`)
            .join("\n\n"),
        };
      }
      const task = String(args.task ?? "").trim();
      if (!agentId || !task) {
        return {
          granted: true,
          text: "Error: delegate_task needs either `agent` + `task`, or a `tasks` list of them.",
        };
      }
      const res = await ctx.spawnChild(agentId, task);
      if (res.error) return { granted: true, text: `Sub-agent ${agentId} failed: ${res.error.message}` };
      return { granted: true, text: res.text || "(empty sub-agent response)" };
    } catch (err) {
      return { granted: true, text: `Sub-agent ${agentId || "batch"} could not start: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

export const BUILTIN_TOOLS: readonly AgentTool[] = Object.freeze([
  readFileTool,
  writeFileTool,
  listDirTool,
  searchFilesTool,
  gitStatusTool,
  runTerminalTool,
  // Phase 22. The Phase 11 six above are unchanged in name, arguments,
  // category and behaviour; these are additive and live in their own modules so
  // no single file owns the whole tool surface.
  ...FILE_TOOLS,
  ...GIT_TOOLS,
  ...PROJECT_TOOLS,
  ...WEB_TOOLS,
  // Phase 32: the web research surface — documentation lookup and the bounded
  // research pipeline. Same `web` category and gates as the Phase 22 tools.
  ...RESEARCH_TOOLS,
]);

/** The permission categories a tool may declare. Mirrors `AgentToolCategory`. */
const TOOL_CATEGORIES: ReadonlySet<string> = new Set<AgentToolCategory>([
  "files",
  "terminal",
  "search",
  "git",
  "agent",
  "web",
  "browser",
  "tasks",
  "mcp",
  "skills",
]);

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  constructor(tools: readonly AgentTool[] = []) {
    this.registerAll(tools);
  }

  /**
   * A tool has to be complete to be registered.
   *
   * This is the enforcement half of "tools have schemas" and "tools can be
   * permission-controlled". Phase 21 accepted anything with a name and an
   * `execute`, which meant a tool could be registered with no description (the
   * model then cannot tell what it does), with a category outside the
   * permission model (so no permission ever applied to it), or with a schema
   * that is not an object schema (so validation silently accepted everything).
   * All three are caught here, at registration, rather than at the first call.
   */
  register(tool: AgentTool): void {
    if (!tool || typeof tool.name !== "string" || tool.name.length === 0) {
      throw new Error("A tool must have a non-empty name.");
    }
    if (typeof tool.execute !== "function") {
      throw new Error(`Tool "${tool.name}" must implement execute().`);
    }
    if (typeof tool.description !== "string" || tool.description.trim().length === 0) {
      throw new Error(`Tool "${tool.name}" must have a description — it is the only thing the model sees.`);
    }
    if (!TOOL_CATEGORIES.has(tool.category as string)) {
      throw new Error(
        `Tool "${tool.name}" declares category "${String(tool.category)}", which is not a permission category. ` +
          `Use one of: ${[...TOOL_CATEGORIES].join(", ")}.`,
      );
    }
    if (typeof tool.readOnly !== "boolean") {
      throw new Error(`Tool "${tool.name}" must declare readOnly: true or false.`);
    }
    const schema = tool.parameters as { type?: unknown } | undefined;
    if (!schema || typeof schema !== "object" || schema.type !== "object") {
      throw new Error(`Tool "${tool.name}" must declare parameters as a JSON Schema object ({ type: "object", … }).`);
    }
    this.tools.set(tool.name, tool);
  }

  registerAll(tools: readonly AgentTool[]): void {
    for (const t of tools) this.register(t);
  }

  /**
   * Phase 30. MCP servers come and go at runtime, so their tools must be able
   * to leave the registry without it being rebuilt. Only the MCP sync calls
   * this, and only for `mcp__*` names.
   */
  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  /**
   * A serialisable description of the whole tool set. This is what the settings
   * UI and the IPC layer read, so "what can this agent do" is answerable from
   * one place instead of by reading the loop. It carries no executable code.
   */
  describe(): ToolDescriptor[] {
    return this.names()
      .map((n) => this.tools.get(n))
      .filter((t): t is AgentTool => Boolean(t))
      .map((t) => {
        const props = (t.parameters as { properties?: Record<string, { type?: string }> } | undefined)?.properties ?? {};
        const required = (t.parameters as { required?: string[] } | undefined)?.required ?? [];
        return {
          name: t.name,
          description: t.description,
          category: t.category,
          readOnly: t.readOnly,
          destructive: t.destructive === true,
          parameters: Object.entries(props).map(([key, spec]) => `${key}:${spec?.type ?? "any"}`),
          required: [...required],
        };
      });
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  list(): AgentTool[] {
    return [...this.tools.values()];
  }

  get size(): number {
    return this.tools.size;
  }

  /**
   * Resolve the tool names an agent may use, and the OpenAI-compatible
   * `tools` payload for them. `delegate_task` is special-cased: it is only
   * ever exposed to a definition that explicitly declares `delegates`.
   */
  resolveFor(agent: AgentDefinition | null): { names: string[]; tools: Array<{ type: "function"; function: Record<string, unknown> }> } {
    const all = this.names();
    let names: string[];
    if (!agent) {
      names = all;
    } else {
      const base = agent.tools ? all.filter((n) => agent.tools!.includes(n)) : all.filter((n) => n !== DELEGATE_TOOL_NAME);
      names = agent.readOnly ? base.filter((n) => this.tools.get(n)?.readOnly === true) : base;
      const delegates = agent.delegates ?? [];
      if (delegates.length > 0 && this.tools.has(DELEGATE_TOOL_NAME)) names = [...names, DELEGATE_TOOL_NAME];
    }
    const tools = names
      .map((n) => this.tools.get(n))
      .filter((t): t is AgentTool => Boolean(t))
      .map((t) => ({
        type: "function" as const,
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    return { names, tools };
  }

  /**
   * The one door every tool call goes through.
   *
   * Phase 21's version of this method was three lines: look the name up, call
   * `execute`, return whatever came back. Phase 22 gives it four jobs, in
   * order:
   *
   *   1. **Validate** the arguments against the tool's own JSON Schema, before
   *      the body runs. Phase 21 declared schemas but never checked them, so a
   *      model sending `{path: 123}` learned about it only from an incidental
   *      `ENOENT` deep inside the filesystem.
   *   2. **Time** the call. Tools have no clock and should not have one.
   *   3. **Contain** a thrown error into a structured, recoverable outcome, so a
   *      single broken tool cannot take the whole run down.
   *   4. **Normalize** the outcome, so callers can rely on `status` / `error` /
   *      `meta` existing — including for tools written in the Phase 21 style.
   *
   * Doing it here rather than in a free function or in the agent loop is what
   * makes "tools validate their input" and "no scattered tool execution" true by
   * construction: there is exactly one path in, and a new caller cannot bypass
   * it by accident.
   *
   * The `text` a tool returns is never rewritten. It is the model's view of the
   * call, and several of those strings are asserted exactly by suites that
   * predate this phase.
   */
  async invoke(name: string, args: Record<string, unknown>, ctx: AgentToolContext): Promise<AgentToolOutcome> {
    const started = Date.now();
    const elapsed = (): number => Date.now() - started;

    const tool = this.tools.get(name);
    if (!tool) {
      // A hallucinated tool name becomes model-visible feedback, not a crash.
      return normalizeOutcome(
        {
          granted: true,
          text: `Unknown tool: ${name}`,
          status: "error",
          error: toolError("unknown_tool", `No tool named "${name}" is registered.`, {
            hint: `Available tools: ${this.names().join(", ")}.`,
          }),
        },
        name,
        elapsed(),
      );
    }

    const validation = validateArgs(tool.parameters, args);
    if (!validation.ok) {
      return normalizeOutcome(
        {
          // `granted: true` because nothing was refused: this is the model
          // calling the tool wrongly, which is recoverable feedback rather than
          // a permission event, and must not read as "denied" in the UI.
          granted: true,
          text:
            `Error: ${name} received invalid arguments — ${formatIssues(validation.issues)}. ` +
            `The schema is: ${JSON.stringify(tool.parameters)}.`,
          status: "error",
          error: toolError("invalid_input", formatIssues(validation.issues), {
            hint: "Resend the call with arguments matching the schema.",
          }),
        },
        name,
        elapsed(),
      );
    }

    try {
      const outcome = await withToolTimeout(tool.execute(ctx, validation.value), ctx.signal);
      return normalizeOutcome(outcome, name, elapsed());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return normalizeOutcome(
        {
          granted: true,
          text: `Error in ${name}: ${message}`,
          status: "error",
          error: toolError("tool_failed", message, { reportable: true }),
        },
        name,
        elapsed(),
      );
    }
  }
}

/**
 * A tool call that never settles within this window is reported as a timeout.
 * The registry cannot abort the tool's own work — that is what `ctx.signal` and
 * each tool's own cleanup are for — but it can stop a run from sitting on a
 * promise forever, and it can report a real `timeout` rather than hanging.
 */
export const TOOL_TIMEOUT_MS = 120_000;

/**
 * Bound one tool call by both the registry ceiling and the run's own signal.
 * Cancellation is checked first, so a stopped run reports "cancelled" and never
 * "timed out" — a distinction the user sees in the trace.
 */
function withToolTimeout<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = (): void => finish(() => reject(new CancelledToolCall()));
    const timer = setTimeout(
      () => finish(() => reject(new Error(`did not finish within ${Math.round(TOOL_TIMEOUT_MS / 1000)}s`))),
      TOOL_TIMEOUT_MS,
    );
    if (typeof timer.unref === "function") timer.unref();
    if (signal.aborted) {
      finish(() => reject(new CancelledToolCall()));
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => finish(() => resolve(v)),
      (e) => finish(() => reject(e)),
    );
  });
}

/**
 * A tool call abandoned because the run was stopped. Deliberately not named
 * `AbortError`: the runtime has already produced the real `cancelled` result by
 * the time this surfaces, so re-throwing it as a cancellation here would just
 * duplicate that in the trace.
 */
class CancelledToolCall extends Error {
  constructor() {
    super("The tool call was cancelled because the run was stopped.");
    this.name = "ToolCallCancelled";
  }
}

/**
 * Assemble the tool set.
 *
 * `extra` exists for the one tool that cannot be a module-level constant: the
 * browser tool needs a live Electron window, so the process wiring builds it and
 * passes it in. Everything else comes from `BUILTIN_TOOLS`, which is assembled
 * above and is the single source of truth for what a model can be offered.
 *
 * `includeDelegate` stays a parameter because the unit suites build a registry
 * without the sub-agent tool, and `createDefaultRegistry()` is the production
 * composition point.
 */
export function createBuiltinRegistry(
  includeDelegate = false,
  extra: readonly AgentTool[] = [],
): ToolRegistry {
  const tools = [...BUILTIN_TOOLS, ...(includeDelegate ? [delegateTool] : []), ...extra];
  return new ToolRegistry(tools);
}

/**
 * The permission categories a tool may declare, in the order the settings UI
 * lists them. Derived from the set `register()` actually validates against, so
 * the exported list and the enforced list cannot drift apart — Phase 22 left a
 * hardcoded five-entry copy of this behind while `web` and `browser` were being
 * added, and nothing complained because nothing read it.
 */
export const AGENT_TOOL_CATEGORIES: readonly AgentToolCategory[] = Object.freeze([...TOOL_CATEGORIES] as AgentToolCategory[]);
