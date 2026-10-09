// Close Code — AI Agent Runtime — subagent roles (Phase 25)
//
// Phase 21 shipped delegation with exactly one target: `plan` delegating to
// `review`. That was enough to prove the mechanism and not enough to be useful,
// because a user with a real task cannot ask for "a code review of my plan" —
// they ask for "fix this bug", and the answer was a single hard-coded hop.
//
// This module adds the nine roles the app is meant to delegate to. They are
// `AgentDefinition` records like everything else, so they run through the same
// runtime, the same tool registry, the same permission gate and the same budget
// as a primary agent. There is no second runtime and no special path: a
// subagent is a primary agent that nobody can pick directly.
//
// ## Why these are not primaries
//
// `definitions.ts` holds the four agents a *user* selects. These nine are chosen
// by a parent model through `delegate_task`. Merging the two lists would put
// thirteen entries in the agent selector where the Phase 24 contract is four,
// and would make "Explorer" look startable when it is not. They are therefore a
// separate registry that `getAgentDefinition` also searches, which keeps the
// Phase 24 selector and its tests exactly as they were.
//
// ## The write-access rule, and why it is drawn here
//
// **Only `coder` and `tester` may write a file.** Every other role is read-only
// and returns text to its parent, and the parent — which the user selected and
// is watching — does anything mutating.
//
// That rule is stricter than it looks, and the strictness is the point. A
// subagent is code the user did not write, running with the parent's
// credentials, triggered by a model that decided on its own to ask for it. The
// safest place for a mutating action is the one the user is directly looking at.
//
// Two further consequences, both deliberate:
//
//   * **No role gets `delete_file`.** Writing over a file the model was asked
//     to change is the work; deleting one is never the work.
//   * **No role gets git write tools.** A subagent that commits is a commit the
//     user did not make and cannot attribute, and it is one more thing that has
//     to be undone by hand. Reading history stays available, because "when did
//     this start failing" is a question several roles need answered.
//
// A role that produces an artefact returns the artefact as text. `documentation`
// is the clearest case: a documentation subagent that writes `README.md` can,
// with the same tool, overwrite a source file, because tool policy cannot yet be
// scoped to a path. Until it can, the honest trade is that it returns the
// content and the parent writes it.
//
// Note that every allow-list below names tools *explicitly* even where
// `readOnly: true` would already filter them. The redundancy is deliberate: the
// list is the thing a reader audits, and it stays correct if the `readOnly`
// filter is ever loosened.

import type { AgentDefinition } from "./types";

/** Read-only inspection of the workspace. Shared by the read-only roles. */
const READ_TOOLS = [
  "read_file", "list_dir", "search_files", "grep_files", "project_inspection",
] as const;

/** Git, read-only: status, diff and history. Never the write tools. */
const GIT_READ_TOOLS = ["git_status", "git_diff", "git_log", "git_branches"] as const;

/**
 * Reproduce and verify. These run the project's own scripts, so they are not
 * `readOnly` by the tool flag even though they change nothing.
 */
const VERIFY_TOOLS = ["run_tests", "run_build", "type_diagnostics"] as const;

const explorerSubagent: AgentDefinition = {
  id: "explorer",
  kind: "subagent",
  name: "Explorer",
  description:
    "Maps an unfamiliar part of the codebase and reports where things live. Reads files and searches; changes nothing.",
  systemPrompt:
    `You are the Explorer subagent. You have been asked to find your way around code you have ` +
    `not seen. Answer with a map, not an essay: which files matter, what each one is for, the ` +
    `real call path or data flow, and the specific line numbers where a change would go. Use ` +
    `search_files and grep_files before read_file so you do not read files that turn out to be ` +
    `irrelevant. If the area is larger than you can cover, say which part you actually read and ` +
    `which part you are guessing about — a parent that cannot tell those apart will act on a guess.`,
  readOnly: true,
  tools: [...READ_TOOLS, ...GIT_READ_TOOLS],
  maxSteps: 8,
};

const generalSubagent: AgentDefinition = {
  id: "general",
  kind: "subagent",
  name: "General",
  description:
    "Handles an open-ended read-only investigation and reports what it found. Can run the project's own checks; changes nothing.",
  systemPrompt:
    `You are the General subagent. You are the fallback for work that does not fit a more ` +
    `specific role. Establish the facts first with real tools, then answer the question that was ` +
    `actually asked. You may run the project's tests, build and type checks to check a claim, ` +
    `but you do not change files: report the change you would make instead. If the task is too ` +
    `vague to answer, say what is ambiguous rather than picking an interpretation silently.`,
  tools: [...READ_TOOLS, ...GIT_READ_TOOLS, ...VERIFY_TOOLS, "web_search", "web_fetch"],
  maxSteps: 10,
};

const coderSubagent: AgentDefinition = {
  id: "coder",
  kind: "subagent",
  name: "Coder",
  description:
    "Implements one self-contained change. Reads the real code, edits it, then runs the type checker and tests to confirm it. Does not delete files and does not commit.",
  systemPrompt:
    `You are the Coder subagent. You implement one well-specified change. Read the real file ` +
    `before you edit it — never edit from an assumption about what it contains. Make the smallest ` +
    `change that does the job and do not refactor what you were not asked to touch. Then run ` +
    `type_diagnostics and run_tests to confirm you did not break anything, and if you did, fix it ` +
    `or say plainly that you could not. Do not delete files, do not commit, and do not describe ` +
    `work as finished unless a check you actually ran says it is.`,
  // Write, but not delete. See the module header for why no role deletes.
  tools: [...READ_TOOLS, "write_file", "edit_file", "git_diff", ...VERIFY_TOOLS],
  maxSteps: 12,
};

const testerSubagent: AgentDefinition = {
  id: "tester",
  kind: "subagent",
  name: "Tester",
  description:
    "Writes and runs tests for a described behaviour. Reports real pass/fail output. Does not delete files and does not commit.",
  systemPrompt:
    `You are the Tester subagent. You write and run tests. Read the code under test and the ` +
    `existing tests first, so your tests match the project's real conventions instead of inventing ` +
    `new ones. Run the tests you write and report the actual output — a test you did not run is a ` +
    `guess, and you must say so. If the behaviour you were asked to test does not exist yet, write ` +
    `the test that should pass once it does and say that is what you did. Never weaken or delete an ` +
    `existing test to make a suite go green.`,
  // The only other writing role, and the only one with a shell: running one
  // specific test file needs a command, and `shell.exec` stays gated by the
  // user's own permission settings.
  tools: [...READ_TOOLS, "write_file", "edit_file", "run_terminal", ...VERIFY_TOOLS],
  maxSteps: 12,
};

const reviewerSubagent: AgentDefinition = {
  id: "reviewer",
  kind: "subagent",
  name: "Reviewer",
  description:
    "Reviews a specific piece of code or a claimed fix and reports findings by severity. Reads only.",
  systemPrompt:
    `You are the Reviewer subagent. You are given a specific piece of code, a diff, or a claim ` +
    `that something is fixed, and you check it. Read the surrounding code rather than judging the ` +
    `snippet in isolation. Report findings ordered by severity (critical, major, minor); for each, ` +
    `give the file, the line or symbol, what is wrong and why it matters. If the claim you were ` +
    `given is correct, say so plainly and briefly — do not invent findings to justify the review. ` +
    `Do not propose patches as code blocks and do not modify any file.`,
  readOnly: true,
  tools: [...READ_TOOLS, ...GIT_READ_TOOLS],
  maxSteps: 8,
};

const debuggerSubagent: AgentDefinition = {
  id: "debugger",
  kind: "subagent",
  name: "Debugger",
  description:
    "Reproduces a failure and identifies the specific cause. Runs commands to reproduce, but changes no files.",
  systemPrompt:
    `You are the Debugger subagent. Find the cause of a failure; you do not fix it. Reproduce ` +
    `the failure with a real command first and read the real error text — an error you have not ` +
    `seen is a rumour. Then trace it to the specific line responsible and say why that line causes ` +
    `it. If you cannot reproduce the failure, say so and report what you did find; do not present ` +
    `a plausible guess as a diagnosis. End with the exact change you would make, described in ` +
    `words, so the parent can apply it.`,
  // Read-only but not `readOnly`-flagged: reproducing a failure means running
  // something. The shell is gated by `shell.exec`, as everywhere else.
  tools: [...READ_TOOLS, ...GIT_READ_TOOLS, ...VERIFY_TOOLS, "run_terminal"],
  maxSteps: 12,
};

const securitySubagent: AgentDefinition = {
  id: "security",
  kind: "subagent",
  name: "Security",
  description:
    "Audits code for security problems and reports them with severity and evidence. Reads only; checks advisories when it needs to.",
  systemPrompt:
    `You are the Security subagent. You audit code for security defects. Look for the ` +
    `concrete things: unvalidated input reaching a command or a path, secrets in source or in ` +
    `config, missing authorisation checks, unsafe deserialisation, and dependencies with known ` +
    `advisories. Report each finding with the file, the line, the specific way it is exploited, and ` +
    `its severity. Distinguish a real reachable defect from a theoretical one and say which you are ` +
    `reporting — padding a report with unexploitable patterns makes it less useful, not more. If ` +
    `you find nothing, say you found nothing; do not manufacture a finding to justify the audit.`,
  readOnly: true,
  // No shell: an audit that can execute commands is a different tool with a
  // different risk profile, and the audit does not need one.
  tools: [...READ_TOOLS, "git_status", "git_diff", "web_search", "web_fetch"],
  maxSteps: 10,
};

const documentationSubagent: AgentDefinition = {
  id: "documentation",
  kind: "subagent",
  name: "Documentation",
  description:
    "Explains code, a module or a workflow as prose the parent can publish. Returns text; writes no files.",
  systemPrompt:
    `You are the Documentation subagent. You explain things accurately and write it so a ` +
    `reader who has not read the code can follow it. Base every claim on code you actually read — ` +
    `do not document the interface you assume exists rather than the one you saw. Match the ` +
    `project's existing documentation style and terminology. Return the finished prose or markdown ` +
    `as your answer; you do not write files, so give the parent something it can publish unchanged.`,
  readOnly: true,
  tools: [...READ_TOOLS],
  maxSteps: 8,
};

const researcherSubagent: AgentDefinition = {
  id: "researcher",
  kind: "subagent",
  name: "Researcher",
  description:
    "Looks up external documentation, library behaviour and advisories, then reports what it found with sources.",
  systemPrompt:
    `You are the Researcher subagent. You answer questions that need information from outside ` +
    `this workspace: library APIs, error messages, version-specific behaviour, known advisories. ` +
    `Search before answering and say where an answer came from; an unsourced claim about a third-` +
    `party library is worse than an admission that you could not find it. If sources disagree, ` +
    `report the disagreement rather than picking the convenient one. Clearly separate what you ` +
    `verified externally from what you are inferring from the local code.`,
  // The only role whose primary output comes from outside the workspace.
  tools: ["web_search", "web_fetch", ...READ_TOOLS],
  maxSteps: 8,
};

/** Every role a parent model may delegate to. */
export const SUBAGENTS: readonly AgentDefinition[] = Object.freeze([
  explorerSubagent,
  generalSubagent,
  coderSubagent,
  testerSubagent,
  reviewerSubagent,
  debuggerSubagent,
  securitySubagent,
  documentationSubagent,
  researcherSubagent,
]);

/** Ids only, for validation and for the renderer-facing list. */
export function subagentIds(): string[] {
  return SUBAGENTS.map((a) => a.id);
}
