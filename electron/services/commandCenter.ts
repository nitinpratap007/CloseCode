// Close Code — Natural Language Command Center (Phase 33)
//
// The layer that turns a natural-language utterance ("run tests", "find the
// login code", "create a git checkpoint") into a *controlled agent operation*.
//
// It is deliberately not a model call. Mapping a command to an action should be
// deterministic, cheap and testable — the ambiguity is resolved once, up front,
// by the keyword catalog below, and the *action itself* is a real agent run over
// the existing runtime, with real tools, real permissions and real results. If
// the request does not match a known command confidently enough, it falls back
// to the Commander agent, whose system prompt tells it to classify and execute
// anything else.
//
// Honesty rules:
//   * `runCommand` returns the concrete command id, agent id and run id it
//     decided on, so the UI can show *what* the words were mapped to.
//   * No command claims an outcome here. A command's outcome only ever comes
//     from the agent run it started — the same run record and trace the agent
//     panel already renders.
//   * Read-only commands run read-only agents (plan / review), so a "find the
//     login code" command cannot write files because its agent never may.

import type { AgentToolCategory } from "./agent/types";

export type CommandIntentId =
  | "run-tests"
  | "run-build"
  | "find-code"
  | "fix-error"
  | "explain-file"
  | "create-api"
  | "refactor"
  | "check-security"
  | "review-changes"
  | "diagnose-build"
  | "git-checkpoint"
  | "open-preview"
  | "build-project"
  | "manage-tasks"
  | "commander";

/**
 * One entry in the command catalog: a natural-language intent, the words that
 * usually signal it, the real agent it maps to, and the task that agent is
 * given. `taskTemplate` may contain `{target}`, which is replaced with whatever
 * the utterance named (a file, a symbol, a component).
 */
export interface CommandCatalogEntry {
  id: CommandIntentId;
  title: string;
  description: string;
  /** Example utterances, shown in the panel so the mapping is inspectable. */
  examples: string[];
  /** Keyword phrases that signal this command, matched case-insensitively. */
  keywords: string[];
  /** The real primary agent the command dispatches to. */
  agentId: string;
  /** Task handed to that agent; `{target}` is filled from the utterance. */
  taskTemplate: string;
  /** True when every agent this command can reach is read-only. */
  readOnly: boolean;
  /** Permission categories the command will realistically touch. */
  categories: AgentToolCategory[];
}

export const COMMAND_CATALOG: readonly CommandCatalogEntry[] = Object.freeze([
  {
    id: "run-tests",
    title: "Run Tests",
    description:
      "Runs the project's real test suite and reports actual pass/fail output. Uses the project's own npm scripts.",
    examples: ["run tests", "run the test suite", "how do the tests look?"],
    keywords: ["run tests", "run the tests", "test suite", "run unit tests", "run the tests", "tests"],
    agentId: "build",
    taskTemplate:
      "Run the project's test suite with the real run_tests tool and report the actual output and pass/fail result. If any test fails, show the failure and pinpoint the file and line. Do not claim a pass you did not observe.",
    readOnly: false,
    categories: ["terminal", "files", "search"],
  },
  {
    id: "run-build",
    title: "Build & Verify",
    description:
      "Builds the project with its own build script and reports the real result, fixing nothing unless asked.",
    examples: ["run the build", "build the project", "does it compile"],
    keywords: ["run the build", "build the project", "run build", "compile", "does it build", "does it compile"],
    agentId: "build",
    taskTemplate:
      "Run the project's real build with the run_build tool and report the actual output and exit status. If it fails, show the error and the file most likely responsible. Do not claim a passing build you did not observe.",
    readOnly: false,
    categories: ["terminal", "files"],
  },
  {
    id: "find-code",
    title: "Find Code",
    description: "Locates the code asked about and reports file paths and line numbers. Read-only.",
    examples: ["find the login code", "where is the auth handler", "locate the search bar component"],
    keywords: ["find the", "find", "where is", "where's", "locate the", "look for", "search for the code"],
    agentId: "plan",
    taskTemplate:
      "Locate the code the user asked about: {target}. Use search and read tools to find the real files and report exact file paths, line numbers and a one-line summary of what each does. Do not modify anything.",
    readOnly: true,
    categories: ["files", "search"],
  },
  {
    id: "fix-error",
    title: "Fix Error",
    description:
      "Reproduces a reported error, finds its real cause and fixes it, re-running to verify. Does not commit.",
    examples: ["fix this error", "fix the bug in the login flow", "the app crashes on save"],
    keywords: ["fix this error", "fix the error", "fix the bug", "fix bug", "fix the crash", "this error", "bug in"],
    agentId: "debug",
    taskTemplate:
      "Reproduce and fix the error the user described: {target}. Reproduce it with a real command first, read the real error text, find the specific line responsible, make the smallest change that addresses the cause, then re-run to confirm. Do not claim a fix you did not verify.",
    readOnly: false,
    categories: ["terminal", "files", "git"],
  },
  {
    id: "explain-file",
    title: "Explain File",
    description: "Explains a file or symbol in plain language against its real contents. Read-only.",
    examples: ["explain this file", "explain the auth service", "what does main.ts do", "how does the store work"],
    keywords: ["explain", "what does", "what is", "how does", "explain this file", "walk me through"],
    agentId: "review",
    taskTemplate:
      "Explain {target} in plain language against its real contents: read the actual file, describe what it does, its main pieces and any sharp edges, in a few short paragraphs. Do not modify anything.",
    readOnly: true,
    categories: ["files", "search"],
  },
  {
    id: "create-api",
    title: "Create an API",
    description:
      "Designs and implements a new API endpoint or route end to end, then verifies it builds.",
    examples: ["create an API", "add an endpoint for user login", "make a REST endpoint for products"],
    keywords: ["create an api", "add an endpoint", "make an endpoint", "create endpoint", "rest endpoint", "api for"],
    agentId: "builder",
    taskTemplate:
      "Design and implement the requested API: {target}. Inspect the existing project first, create tasks for the steps, implement the route, handler and any model or validation the project's real architecture needs, then run the project's real build and tests to verify. Report the files you changed and the real verification results.",
    readOnly: false,
    categories: ["files", "terminal", "tasks"],
  },
  {
    id: "refactor",
    title: "Refactor Component",
    description: "Refactors the named code into a cleaner shape without changing behaviour, verified by build.",
    examples: ["refactor this component", "refactor the login form", "clean up the store"],
    keywords: ["refactor", "refactoring", "clean up", "cleanup", "simplify the", "improve the code"],
    agentId: "builder",
    taskTemplate:
      "Refactor {target} so its behaviour is unchanged but its structure is cleaner. Read the current code first, decide the smallest refactor that is genuinely better, implement it, and verify with the project's real build and tests. Do not refactor what the request did not name. Report the real verification results.",
    readOnly: false,
    categories: ["files", "terminal", "tasks"],
  },
  {
    id: "check-security",
    title: "Check Security",
    description:
      "Audits the workspace for security issues using read-only tools and reports findings ranked by severity.",
    examples: ["check security", "audit the code for security issues", "security review", "is there any sql injection"],
    keywords: ["check security", "security check", "security audit", "audit for security", "security review", "vulnerabilit"],
    agentId: "review",
    taskTemplate:
      "Audit the workspace for security issues (secrets or credentials in code, injection, unsafe deserialisation, missing validation, junk dependency usage). Use read-only tools, then report findings ranked by severity with file and line for each. Do not modify anything.",
    readOnly: true,
    categories: ["files", "search", "git"],
  },
  {
    id: "review-changes",
    title: "Review My Changes",
    description:
      "Reviews the uncommitted changes in the workspace and reports findings. Read-only.",
    examples: ["review my changes", "review the diff", "what changed in my working tree"],
    keywords: ["review my changes", "review the changes", "review the diff", "review changes", "what changed", "review my code"],
    agentId: "review",
    taskTemplate:
      "Review the uncommitted changes in the workspace using git tools, then report findings ranked by severity — what each change does, anything risky or broken, and what you would verify before committing. Do not modify anything and do not commit.",
    readOnly: true,
    categories: ["git", "files"],
  },
  {
    id: "diagnose-build",
    title: "Find Why the Build Fails",
    description:
      "Finds the real cause of a failing build or test, starting from the actual error output.",
    examples: ["find why the build fails", "why does the build fail", "why is the test failing", "the build is broken"],
    keywords: ["why does the build fail", "why the build fails", "build is broken", "build fails", "build failure", "why is the build"],
    agentId: "debug",
    taskTemplate:
      "Find why the build or tests fail. Reproduce the failure with a real command, read the actual error output, and trace it to the specific file and line responsible. Report the cause and the smallest fix, but do not commit.",
    readOnly: false,
    categories: ["terminal", "files", "git"],
  },
  {
    id: "git-checkpoint",
    title: "Create a Git Checkpoint",
    description:
      "Stages the current changes and commits them with a descriptive message. Writes to the repository — requires your permission.",
    examples: ["create a git checkpoint", "commit my changes", "save a checkpoint", "make a commit"],
    keywords: ["git checkpoint", "create a checkpoint", "commit my changes", "make a commit", "save checkpoint", "commit the changes"],
    agentId: "build",
    taskTemplate:
      "Create a git checkpoint of the current state: review the diff with git tools, stage the relevant changes and commit them with a short descriptive message that summarises what changed. Do not push.",
    readOnly: false,
    categories: ["git"],
  },
  {
    id: "open-preview",
    title: "Open the Preview",
    description:
      "Starts the project's dev server and navigates a browser window to it, or reports what blocks that.",
    examples: ["open the preview", "start the dev server", "preview the app", "show me the app"],
    keywords: ["open the preview", "open preview", "dev server", "preview the app", "show the preview", "run the app"],
    agentId: "commander",
    taskTemplate:
      "Open the project's preview: inspect package.json for a dev/preview/start script, start it with run_terminal (backgrounded if needed), and use the browser tools to navigate to the local URL it serves. If the project has no web entry point or a permission blocks the run, say exactly what is missing. Report the URL you reached or the real blocker.",
    readOnly: false,
    categories: ["terminal", "browser", "files"],
  },
  {
    id: "build-project",
    title: "Build a Project",
    description:
      "The autonomous builder: inspect, plan, create tasks, implement and verify a requested feature or whole project.",
    examples: ["build me a full MERN application", "build a todo list app", "scaffold a new component"],
    keywords: ["build me", "build a", "build an", "create me a", "create a", "scaffold", "make a"],
    agentId: "builder",
    taskTemplate:
      "Build what the user asked for: {target}. Inspect the project first, create tasks for the steps, implement the files, install dependencies only where permissions allow, run the project's real build and tests to verify, and finish with a summary of the files changed and the real verification results.",
    readOnly: false,
    categories: ["files", "terminal", "tasks", "git"],
  },
  {
    id: "manage-tasks",
    title: "Manage Tasks",
    description:
      "Lists the open plan tasks for the project and reports their state. Read-only.",
    examples: ["list my tasks", "what are the plan tasks", "show open tasks"],
    keywords: ["list tasks", "plan tasks", "open tasks", "show tasks", "task list", "my tasks"],
    agentId: "plan",
    taskTemplate:
      "List the project's plan tasks with the task tools and report their current state — which are open, in progress, done, cancelled or failed — with a one-line summary of each. Do not modify anything.",
    readOnly: true,
    categories: ["tasks"],
  },
  {
    id: "commander",
    title: "Commander",
    description:
      "Anything else: the Commander classifies the request itself and carries it out — or clearly explains what blocks it.",
    examples: ["do whatever makes sense here", "my preview won't load", "migrate the api to v2"],
    // Deliberately empty: this entry never wins keyword scoring. It is the
    // explicit target of the no-match fallback, and a plain "Commander" button.
    keywords: [],
    agentId: "commander",
    taskTemplate:
      "Carry out this natural-language command: {target}\n\nClassify the request and take the narrowest real action that answers it, using tools or delegation. Verify any claim about the project with a real command, and if something blocks you, say exactly what.",
    readOnly: false,
    categories: ["files", "terminal", "search", "git", "browser"],
  },
]);

export interface CommandInference {
  /**
   * The best catalog match, or `null` when the utterance matched no known
   * command — in which case `run` dispatches to the Commander agent instead.
   */
  entry: CommandCatalogEntry | null;
  /** Whatever the utterance named after the command words were removed. */
  target: string;
  /** 0-1; how confidently the utterance matched the catalog. */
  confidence: number;
}

/**
 * Deterministic natural-language inference: score every catalog entry by how
 * many of its keyword phrases appear in the utterance, then strip the matched
 * phrases to recover the target ("the login flow" out of "fix this error in the
 * login flow"). Confidence is 1 when every keyword of the winning entry matched,
 * otherwise the share of matched keywords — the fallback to the Commander agent
 * is the honest answer to "this looked like a command but I cannot pin it down".
 */
export function inferCommand(rawRequest: string): CommandInference {
  const request = rawRequest.trim();
  if (!request) {
    return { entry: null, target: "", confidence: 0 };
  }
  const lower = request.toLowerCase();
  let best: CommandCatalogEntry | null = null;
  let bestScore = 0;
  for (const entry of COMMAND_CATALOG) {
    let score = 0;
    for (const kw of entry.keywords) {
      if (lower.includes(kw)) score += kw.length;
    }
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }

  // No keyword matched at all — this is not a known command. Route to the
  // Commander agent, whose job is classifying the unclassifiable. That is the
  // honest fallback: we do not pretend to have understood the words.
  if (bestScore === 0 || !best) {
    const commander = COMMAND_CATALOG.find((e) => e.id === "commander") ?? null;
    return { entry: commander, target: request, confidence: 0 };
  }

  // Confidence: how much of the winning entry's *most distinctive* signal
  // matched. A request that matched only a weak keyword ("tests" from "explain
  // the tests") scores below one, which the panel can surface as "mapped, but
  // not confidently".
  const entryLongest = Math.max(...best.keywords.map((k) => k.length));
  const matchedLongest = Math.max(...best.keywords.filter((k) => lower.includes(k)).map((k) => k.length));
  const confidence = Math.max(0.35, matchedLongest / entryLongest);

  let target = request;
  let remaining = lower;
  for (const kw of best.keywords) {
    if (remaining.includes(kw)) remaining = remaining.split(kw).join(" ");
  }
  // Collapse what survived into a clean, bounded target phrase.
  target = remaining
    .replace(/\s+/g, " ")
    .replace(/^(please|pls|kindly|i want (you )?to|i need (you )?to|can you|could you|help me|let's|lets|just)\s+/i, "")
    .trim();
  target = target.replace(/(^|[^a-z0-9])the\s+/gi, "$1").trim();
  while (/^\s*(about|with|for|on|to|a|an|me)\s+/i.test(target)) target = target.replace(/^\s*(about|with|for|on|to|a|an|me)\s+/i, "").trim();
  if (target.length > 140) target = target.slice(0, 140);
  return { entry: best, target, confidence };
}

/** Fill a task template with a target, or trim it when there is none. */
export function applyTarget(template: string, target: string): string {
  if (!target) return template.replace(/\s*\{target\}/i, "").trim();
  return template.replace(/\{target\}/i, target);
}

export interface RunCommandOptions {
  request: string;
  workspace: string | null;
  sessionId?: string | null;
}

/** Omit request but require workspace (the caller always provides it). */
type RunOpts = Omit<RunCommandOptions, "request"> & { workspace: string | null };

export interface RunCommandResult {
  commandId: CommandIntentId;
  title: string;
  agentId: string;
  task: string;
  runId: string;
  readOnly: boolean;
}

export interface CommandCenterDeps {
  /** Starts a real agent run and resolves with its id. Throws for hard errors. */
  startRun: (opts: {
    agentId: string;
    task: string;
    workspace: string | null;
    sessionId?: string | null;
  }) => Promise<{ runId: string }>;
}

/**
 * Create the command center with an injected run starter. Production wires this
 * to the singleton runtime via `buildRunSpec`; unit tests inject a fake so the
 * mapping logic is tested without a model endpoint.
 */
export function createCommandCenter(deps: CommandCenterDeps) {
  return {
    catalog: (): CommandCatalogEntry[] => COMMAND_CATALOG.map((e) => ({ ...e, keywords: [...e.keywords] })),
    infer: inferCommand,
    /**
     * Map an utterance to a concrete command and start the real agent run it
     * names. Returns the command id, agent id, task and run id so the caller can
     * render *what the words mapped to* and follow the real run in the panel.
     */
    async run(request: string, opts: RunOpts): Promise<RunCommandResult> {
      const trimmed = request.trim();
      if (!trimmed) throw new Error("A command needs words.");
      if (trimmed.length > 2000) throw new Error("Command too long.");
      const { entry, target } = this.infer(trimmed);
      if (!entry) throw new Error("No command matched and no fallback is available.");
      const task = applyTarget(entry.taskTemplate, target);
      const { runId } = await deps.startRun({
        agentId: entry.agentId,
        task,
        workspace: opts.workspace ?? null,
        sessionId: opts.sessionId ?? null,
      });
      return {
        commandId: entry.id,
        title: entry.title,
        agentId: entry.agentId,
        task,
        runId,
        readOnly: entry.readOnly,
      };
    },
  };
}

export type CommandCenter = ReturnType<typeof createCommandCenter>;