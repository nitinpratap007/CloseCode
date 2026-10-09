// Close Code — AI Agent Runtime — agent definitions (Phase 21, 24, 25)
//
// An agent is *data*, not a class: an id, a system prompt, a tool policy and a
// step ceiling. That is what makes "multiple future agents" an additive change
// — a new entry here is immediately selectable in the UI and runnable by the
// same runtime, with no new subsystem.
//
// Phase 24 names the four *primary* agents: build, plan, review, debug. They
// are four different jobs, not four moods:
//
//   build   — implement a requested change
//   plan    — investigate and produce an implementation plan, changing nothing
//   review  — read code and report findings, changing nothing
//   debug   — reproduce a failure, find its cause, fix it
//
// Phase 33 adds two more primary agents, so the picker offers six:
//
//   commander — turn a natural-language command into a real action
//   builder   — autonomously build a feature or whole project, verified
//
// All four are real: each runs the same genuine model loop with a genuinely
// different tool policy and objective. Nothing is stubbed, and nothing here is a
// personality applied to one undifferentiated agent — the tool policies
// genuinely differ, and the runtime *enforces* them (see `agentPolicyRefusal` in
// runtime.ts, which Phase 24 added because a policy the model can talk its way
// out of is not a policy).
//
// ## Phase 25: two registries, one runtime
//
// This file holds the four agents a *user* originally picked plus the two Phase 33
// entrants. `subagents.ts` holds the nine roles a parent *model* delegates to.
// They are separate lists on purpose, and the reason is a UI one rather than an
// architectural flourish: the agent picker must keep offering only the agents
// that can be started, because a user can only usefully start a primary agent.
// Listing fifteen would advertise nine agents that cannot be started at all,
// which is a button that does nothing.
//
// Everything else is shared. A subagent is an `AgentDefinition` that
// `getAgentDefinition` can resolve, so it runs through the same loop, the same
// tool registry, the same permission gate and the same budget as a primary. There
// is no second runtime and no special path, and that is the property worth
// protecting: a subagent cannot do anything a primary could not, it can only be
// *chosen* differently. The two lists differ in who picks them, not in what they
// are.

import type { AgentDefinition } from "./types";
import { SUBAGENTS, subagentIds } from "./subagents";

/**
 * Shared preamble. Kept byte-for-byte identical to the Phase 11 system prompt
 * so the existing assistant/chat behaviour does not drift.
 */
export const BASE_SYSTEM_PROMPT =
  `You are the AI assistant built into CloseCode, a desktop code editor. ` +
  `Be concise and accurate. When the user asks you to modify a file, respond with the ` +
  `complete new file content inside a single fenced code block labelled with the file's language ` +
  `(e.g. \`\`\`js). Never truncate output with placeholder comments. If you are used as an agent, ` +
  `call tools instead of guessing about file contents.`;

/**
 * Build agent — the one that implements a requested change.
 *
 * The general-purpose implementer: read the code, change it, verify it. Every
 * tool, because implementing a change may legitimately need any of them. It
 * still passes through the same permission gate as everyone else (Phase 23) —
 * having the tools is not the same as being permitted to use them.
 *
 * The step ceiling was raised from 6 in Phase 24. Six was chosen when this agent
 * was the only one and had to cover investigation, implementation and checking
 * in one budget; as a named "Build" agent whose job is specifically the change,
 * 8 is the smallest ceiling that does not cut a two-file change off mid-edit.
 */
const buildAgent: AgentDefinition = {
  id: "build",
  kind: "primary",
  name: "Build Agent",
  description:
    "Implements a requested change. Reads the code, edits it, runs commands to verify, and can commit. Subject to your permission settings.",
  systemPrompt:
    `You are running as the Build agent inside CloseCode. Your job is to implement a ` +
    `requested change. Work in small verified steps: read the real file contents with a ` +
    `tool before you make any claim about them, make one change at a time, and re-read a ` +
    `file after you write it to confirm the result. Use the narrowest change that does the ` +
    `job — do not refactor what you were not asked to touch. If part of the request is ` +
    `unclear or you could not do it, say so plainly instead of claiming success.`,
  // Phase 25. `build` gained delegation. It is the generalist — the agent a user
  // reaches for when they do not know which specialism the task needs — and Phase
  // 24 gave it every tool except `delegate_task`. Handing the rest of the work to
  // a subagent is now the better answer for the parts of a change that are really
  // exploration, testing or documentation, so it can.
  //
  // It is given the *whole* roster rather than a curated subset. A user who picked
  // Build has already declined to pick a specialism, so the model should be free
  // to choose one; an arbitrary exclusion would only make a capability appear
  // missing at the moment it is needed. `plan` is the opposite case and gets a
  // narrow set, because a plan that runs tests or writes code has stopped being a
  // plan.
  //
  // `debug` deliberately still cannot, for the reason in its own comment above:
  // losing the thread is worst exactly when something is already broken.
  delegates: [
    "explorer", "general", "coder", "tester", "reviewer",
    "debugger", "security", "documentation", "researcher",
  ],
  maxDepth: 1,
  maxSteps: 8,
};

/**
 * Planning agent. Read-only by construction: it can gather the facts it needs
 * but cannot change anything, so a plan can never be half-applied.
 * It may delegate a review of its own draft to the review sub-agent.
 *
 * "By construction" became true in Phase 24. It was only true in the prompt
 * before that — the runtime advertised 13 read-only tools but would still execute
 * `write_file` or `run_terminal` if the model asked for one by name.
 */
const planAgent: AgentDefinition = {
  id: "plan",
  kind: "primary",
  name: "Plan Agent",
  description:
    "Investigates the workspace with read-only tools and returns a numbered implementation plan. Cannot change any file.",
  systemPrompt:
    `You are running as the Plan agent inside CloseCode. Your job is to produce an ` +
    `implementation plan, never to make changes. First use read-only tools to learn ` +
    `the real state of the code you are planning around. Then answer with: ` +
    `1) the current situation, 2) a numbered list of concrete steps, each naming the ` +
    `files to touch, 3) the risks or unknowns, and 4) how to verify each step. ` +
    `Do not write or run anything. If the task is ambiguous, state the assumption you made.`,
  readOnly: true,
  // Phase 25. `review` stays in the list because it was the original delegation
  // target and removing it would break a saved workflow for no gain; the new
  // roles join it rather than replace it. `explorer` and `researcher` are here
  // because a plan built on assumptions about unfamiliar code is the failure this
  // agent is most prone to.
  delegates: ["review", "explorer", "researcher", "security"],
  maxDepth: 1,
  maxSteps: 8,
};

/**
 * Review agent. Read-only by construction, and a valid sub-agent target for the
 * plan agent's `delegate_task` call.
 *
 * Distinct from `plan` in two ways that are both enforced, not merely described:
 * it has no `delegates`, so it cannot hand work to another agent and call that a
 * review; and its prompt asks for findings ranked by severity against code that
 * already exists, where `plan` asks for steps against code that does not exist
 * yet. They share a tool set because the honest answer is that reading code is
 * reading code — the difference is the question being asked of it.
 */
const reviewAgent: AgentDefinition = {
  id: "review",
  kind: "primary",
  name: "Review Agent",
  description:
    "Reviews code with read-only tools and reports findings ranked by severity. Never edits files.",
  systemPrompt:
    `You are running as the Review agent inside CloseCode. Review the code you are ` +
    `given using read-only tools, then report findings ordered by severity ` +
    `(critical, major, minor). For each finding give the file, the line or symbol, ` +
    `what is wrong, and why it matters. Call out anything that looks correct only ` +
    `briefly, and finish with a one-paragraph overall assessment. Do not propose ` +
    `patches as code blocks and do not modify any file.`,
  readOnly: true,
  maxSteps: 8,
};

/**
 * Debug agent — reproduce a failure, find its cause, fix it.
 *
 * Added in Phase 24, and the only agent with an *explicit* tool allow-list. The
 * other three differ from each other by read-only-ness and step ceiling, which
 * was enough while there were three; with a fourth agent that also writes files,
 * "build and debug are both read-write" stopped being a distinction a user could
 * act on. Two exclusions make it a real choice:
 *
 *   * **No git write tools.** A debugger fixes code; it does not commit. Making
 *     the user review and commit a fix is the discipline, and it keeps
 *     `git.write` out of the agent most likely to be run in a hurry on a
 *     failing build. The git *read* tools stay, because history is how you find
 *     out when the failure started.
 *   * **No `delegate_task`.** A debugger that spawns sub-agents is a debugger
 *     whose reasoning you cannot follow, and a failure is precisely the moment
 *     you least want to lose the thread.
 *
 * It keeps `run_tests`, `run_build` and `type_diagnostics` because reproducing
 * the failure is the whole method: a fix for a bug you have not reproduced is a
 * guess. The step ceiling is the highest of the four, for the same reason — a
 * debug loop is run, read, hypothesize, verify, fix, re-run, and that is more
 * steps than any other job here.
 */
const debugAgent: AgentDefinition = {
  id: "debug",
  kind: "primary",
  name: "Debug Agent",
  description:
    "Investigates a failure and fixes it. Reproduces the failure first, reads the real error, changes code, and re-runs to verify. Does not commit.",
  systemPrompt:
    `You are running as the Debug agent inside CloseCode. Your job is to find the actual ` +
    `cause of a failure and fix it. Do not guess: first reproduce the failure with a real ` +
    `command (run_tests, run_build, or type_diagnostics) and read the real error text, then ` +
    `find the specific line responsible, then make the smallest change that addresses the ` +
    `cause rather than the symptom, then re-run the same command to confirm the failure is ` +
    `gone. If you cannot reproduce it, say so and report what you did find — do not present a ` +
    `guess as a fix. If the fix needs a change you are not allowed to make, name the change ` +
    `instead of making it. Never delete a test to make a suite pass.`,
  tools: [
    // Reading
    "read_file", "list_dir", "search_files", "grep_files", "project_inspection",
    // Fixing
    "write_file", "edit_file", "delete_file",
    // History, read-only: when did this start failing
    "git_status", "git_diff", "git_log", "git_branches",
    // Reproduce and verify
    "run_terminal", "run_tests", "run_build", "type_diagnostics",
    // Look up an error message or a library's documented behaviour
    "web_search", "web_fetch",
  ],
  maxSteps: 12,
};

/**
 * Commander agent — the "natural language command center".
 *
 * Added in Phase 33. Where build/plan/review/debug each assume a kind of work,
 * the Commander's job is to *decide* the kind of work a natural-language
 * command is asking for, then do it or hand it to the specialist who does. The
 * distinction from `build` is enforced, not cosmetic: the prompt orders it to
 * classify the request first, to prefer the narrowest real action that answers
 * it, to delegate when a dedicated role exists, and — the phase's honesty rule —
 * to verify with a real command before claiming success. It shares Build's tool
 * set because an unclassifiable request may need any tool; what differs is that
 * the Commander is expected to justify the route it took in its answer.
 */
const commanderAgent: AgentDefinition = {
  id: "commander",
  kind: "primary",
  name: "Commander Agent",
  description:
    "Turns a natural-language command into a real action. Classifies the request, picks the right built-in tools or delegates to the right specialist, and verifies with real commands before reporting. Can write files.",
  systemPrompt:
    `You are the Commander agent inside CloseCode. The user gave you a natural-language ` +
    `command and expects it to actually happen, not to be summarised. First classify the ` +
    `request: is it testing, debugging, reviewing, exploring, explaining, implementing, ` +
    `version control, or something else? Then choose the narrowest real action that ` +
    `answers it and carry it out with tools. If a specialised agent fits better, delegate ` +
    `to it. Never pretend an action happened: every claim must be backed by a real tool ` +
    `result — run the project's own commands (run_tests, run_build, type_diagnostics) ` +
    `when the command is about whether something works, and report the actual output and ` +
    `exit status. If the command is ambiguous or cannot be done here, say exactly what is ` +
    `blocking it instead of inventing a result.`,
  // The whole delegation roster, the same rationale as `build`: a commander's
  // first duty is choosing the right specialist, so it needs every option open.
  delegates: [
    "explorer", "general", "coder", "tester", "reviewer",
    "debugger", "security", "documentation", "researcher", "review",
  ],
  maxDepth: 1,
  maxSteps: 10,
};

/**
 * Builder agent — the autonomous project builder.
 *
 * Added in Phase 33. The "Build me a full MERN application" agent: takes a
 * goal, inspects the real project, decides what to build, creates tasks from
 * the plan, implements the files, and then *verifies* — the phase's honesty
 * rule is that the Agent never claims success it did not measure. Its step
 * ceiling is the highest of any agent because the pipeline (inspect → plan →
 * tasks → implement → run → fix → test → verify → present) is genuinely more
 * steps than any other job here.
 *
 * When run through the phase's orchestration (the build record flow) the plan
 * step happens in a separate Plan-agent run and the user approves it here; when
 * the user starts the Builder directly from the picker, the prompt requires it
 * to produce its own plan and tasks before touching any file.
 */
const builderAgent: AgentDefinition = {
  id: "builder",
  kind: "primary",
  name: "Builder Agent",
  description:
    "Autonomously builds a requested feature or full project: inspects the workspace, plans, creates tasks, implements files, installs what is needed and run builds and tests to verify real results before reporting. Subject to your permission settings.",
  systemPrompt:
    `You are the Builder agent inside CloseCode, an autonomous project builder. Your job ` +
    `is to turn the user's goal into a working project or feature, end to end. Work in ` +
    `this order: (1) INSPECT — use project_inspection, read_file and list_dir to learn the ` +
    `real state of the workspace before planning anything; (2) PLAN — if no plan is given, ` +
    `write a short numbered plan into your first answer, naming the files you will create; ` +
    `(3) TASKS — create one task per plan step with task_create and complete each one as ` +
    `you finish it; (4) IMPLEMENT — write the files, one small verified change at a time, ` +
    `re-reading what you write; (5) DEPENDENCIES — if the project needs packages, install ` +
    `them with run_terminal only where your permission settings allow it, and say if they ` +
    `do not; (6) RUN AND VERIFY — run the project's real commands (run_build, run_tests, ` +
    `type_diagnostics) and read the actual output; a step is done only when its real ` +
    `command passes; (7) FIX — when a command fails, read the real error and fix the cause, ` +
    `never the symptom, then re-run; (8) PRESENT — finish with a short summary that states ` +
    `exactly what changed (files created or edited), which commands you ran and their real ` +
    `results, and anything you could not do. Honesty rules: never claim a build, test or ` +
    `type-check passed that you did not run; never invent test results or file contents; ` +
    `state plainly when a step is blocked by permissions or an unknown.`,
  delegates: [
    "explorer", "general", "coder", "tester", "reviewer",
    "debugger", "security", "documentation", "researcher", "review",
  ],
  maxDepth: 1,
  maxSteps: 22,
};

const ALL: readonly AgentDefinition[] = Object.freeze([
  buildAgent,
  planAgent,
  reviewAgent,
  debugAgent,
  commanderAgent,
  builderAgent,
]);

export const DEFAULT_AGENT_ID = buildAgent.id;

/**
 * Agents a *user* picks. `agent:definitions` returns exactly these, which is the
 * contract the Phase 24 selector and its tests are built on.
 */
export function listAgentDefinitions(): AgentDefinition[] {
  return ALL.map((a) => ({ ...a }));
}

/**
 * Phase 25. The roles a parent model delegates to.
 *
 * Kept out of `listAgentDefinitions` on purpose. These are not startable from the
 * UI — they are reachable only through `delegate_task`, from a parent whose
 * `delegates` list names them — so offering them in the selector would advertise
 * fifteen agents where six can actually be run, and those six are the only
 * ones a user is meant to choose between.
 */
export function listSubagentDefinitions(): AgentDefinition[] {
  return SUBAGENTS.map((a) => ({ ...a }));
}

/** Primary ids only. This is the set the UI offers. */
export function agentIds(): string[] {
  return ALL.map((a) => a.id);
}

/**
 * Phase 25. Every id the runtime can resolve, primaries and subagents.
 *
 * Separate from `agentIds` because that one is a statement about the UI, and
 * conflating the two is how a `delegates` entry ends up naming a role that
 * nothing can resolve. Validation of delegation targets uses this.
 */
export function allAgentIds(): string[] {
  return [...agentIds(), ...subagentIds()];
}

/**
 * Ids that used to be real and now resolve to a renamed agent.
 *
 * Phase 21 shipped one agent as `default`. Phase 24 splits "the one agent" into
 * four and gives the general-purpose one a name that says what it does, so
 * `default` became `build`. The id is still in persisted renderer state, in old
 * run records and in the fallback path of `agent:start`, so it is translated at
 * the boundary instead of being left to fail.
 *
 * Aliases resolve *here*, at the one place that hands out definitions, rather
 * than at each call site. That matters for more than convenience: a run
 * recorded as `default` but reported as `build` would look up per-agent
 * permissions under the wrong key, so the user's `agent:build` rules would
 * silently not apply to it.
 */
const AGENT_ALIASES: Readonly<Record<string, string>> = Object.freeze({ default: buildAgent.id });

/** Resolve any historical or user-supplied id to the agent it now means. */
export function canonicalAgentId(id: string): string {
  const clean = id.trim();
  if (!clean) return DEFAULT_AGENT_ID;
  return Object.prototype.hasOwnProperty.call(AGENT_ALIASES, clean) ? AGENT_ALIASES[clean] : clean;
}

export function getAgentDefinition(id: string): AgentDefinition | undefined {
  const wanted = canonicalAgentId(id);
  const found = ALL.find((a) => a.id === wanted) ?? SUBAGENTS.find((a) => a.id === wanted);
  return found ? { ...found } : undefined;
}
