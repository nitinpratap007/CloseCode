// Close Code — AI Agent Runtime — version-control tools (Phase 22)
//
// Phase 11 shipped exactly one git tool, `git_status`, which shelled out to
// `git status --porcelain -b` directly. Every other git operation the app
// already performs for the user — diff, log, branches, stage, commit, checkout —
// went through `electron/services/git.ts` and was unreachable from an agent.
//
// These tools call that same service rather than re-implementing it, which is
// the point: the agent and the Git panel now share one code path, so there is no
// second implementation that can drift from the first. It also means the app's
// existing "is git installed?" check and its path validation apply unchanged.
//
// The split that matters:
//   * `git_status`, `git_diff`, `git_log`, `git_branches` — read-only, so the
//     plan and review agents get them.
//   * `git_stage`, `git_commit`, `git_create_branch`, `git_checkout` — mutate
//     the repository: `readOnly: false`, and `destructive` on the ones that
//     record a change the user did not ask for by name.
//
// `git_reset` and `git_clean` are deliberately absent. Both destroy work, and
// neither has a confirmation anywhere in the Git panel, so exposing them to a
// model would allow a class of irreversible operation the UI itself guards
// against.

import {
  checkGitInstalled,
  commit,
  createBranch,
  getBranches,
  getDiff,
  getFileHistory,
  getLog,
  getRemotes,
  getRemoteBranches,
  getMergeBase,
  getConflictFiles,
  getConflictContent,
  getBranchTrackingInfo,
  getCommitDetails,
  getRepositoryStats,
  generateCommitMessageFromDiff,
  isGitRepository,
  stageAll,
  stageFiles,
  switchBranch,
  unstageFiles,
} from "../git";
import { deniedResult, errorResult, okResult } from "./result";
import type { AgentTool, AgentToolOutcome } from "./types";

/**
 * Every git tool needs a repository, and needs to be able to say *why* there is
 * not one. Distinguishing "git is not installed" from "this folder is not a
 * repository" matters: the first is the user's environment, the second is the
 * model's wrong assumption about where it is.
 */
function requireRepo(ctx: { workspace: string | null }): { cwd: string } | { failure: AgentToolOutcome } {
  if (!ctx.workspace) {
    return { failure: errorResult("no_workspace", "No workspace folder is open.", { text: "Error: no workspace folder is open." }) };
  }
  if (!checkGitInstalled()) {
    return {
      failure: errorResult(
        "not_supported",
        "git was not found on this machine.",
        {
          text: "Error: git is not installed or not on PATH, so repository operations are unavailable.",
          hint: "Install git, or restart the app after adding it to PATH.",
        },
      ),
    };
  }
  if (!isGitRepository(ctx.workspace)) {
    return {
      failure: errorResult("not_found", `${ctx.workspace} is not inside a git repository.`, {
        text: `Error: ${ctx.workspace} is not a git repository.`,
        hint: "Run `git init` first, or open a folder that already is one.",
      }),
    };
  }
  return { cwd: ctx.workspace };
}

/** Turn a synchronous git service call into a structured outcome. */
function fromGitCall<T>(code: "tool_failed" | "not_found" | "conflict", run: () => T):
  | { ok: true; value: T }
  | { ok: false; outcome: AgentToolOutcome } {
  try {
    return { ok: true, value: run() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, outcome: errorResult(code, message, { text: `Error: ${message}` }) };
  }
}

/**
 * git wants paths relative to the *repository* root, and the model tends to send
 * either a bare name or a full workspace path. Both are normalised here, so a
 * model does not have to know where the repository root sits inside the folder
 * the user opened.
 */
function toRepoPath(root: string, p: string): string {
  const norm = p.replace(/\\/g, "/").replace(/^\.\//, "");
  const rootNorm = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (norm.startsWith(rootNorm + "/")) return norm.slice(rootNorm.length + 1);
  return norm;
}

export const gitDiffTool: AgentTool = {
  name: "git_diff",
  description: "Show the git diff for the workspace: all unstaged changes, or one file, or the staged changes.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Limit the diff to this file.", default: "" },
      staged: { type: "boolean", description: "Show staged changes instead of working-tree changes.", default: false },
    },
    required: [],
    additionalProperties: false,
  },
  category: "git",
  capabilities: ["git.read"],
  readOnly: true,
  destructive: false,
  async execute(ctx, args): Promise<AgentToolOutcome> {
    if (!(await ctx.authorize("git", args))) return deniedResult();
    const repo = requireRepo(ctx);
    if ("failure" in repo) return repo.failure;

    const raw = String(args.path ?? "").trim();
    const filePath = raw ? toRepoPath(repo.cwd, raw) : undefined;
    const staged = args.staged === true;

    const call = fromGitCall("tool_failed", () => getDiff(repo.cwd, filePath, staged));
    if (!call.ok) return call.outcome;
    const diff = call.value;
    if (!diff.trim()) {
      return okResult(staged ? "No staged changes." : "No unstaged changes.", { meta: { count: 0 } });
    }
    const files = [...diff.matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1]);
    const truncated = diff.length > ctx.maxOutputChars;
    return okResult(diff.slice(0, ctx.maxOutputChars), {
      data: { files, staged },
      meta: { count: files.length, bytes: diff.length, truncated },
    });
  },
};

export const gitLogTool: AgentTool = {
  name: "git_log",
  description: "Show recent commits, newest first. Optionally only for one file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Only commits touching this file.", default: "" },
      limit: { type: "integer", description: "How many commits to show.", minimum: 1, maximum: 100, default: 20 },
    },
    required: [],
    additionalProperties: false,
  },
  category: "git",
  capabilities: ["git.read"],
  readOnly: true,
  destructive: false,
  async execute(ctx, args): Promise<AgentToolOutcome> {
    if (!(await ctx.authorize("git", args))) return deniedResult();
    const repo = requireRepo(ctx);
    if ("failure" in repo) return repo.failure;

    const limit = typeof args.limit === "number" ? args.limit : 20;
    const raw = String(args.path ?? "").trim();

    const call = fromGitCall("tool_failed", () =>
      raw ? getFileHistory(repo.cwd, toRepoPath(repo.cwd, raw), limit) : getLog(repo.cwd, limit),
    );
    if (!call.ok) return call.outcome;

    const entries = call.value;
    if (!entries.length) {
      return okResult(raw ? `No commits touch ${raw}.` : "This repository has no commits yet.", { meta: { count: 0 } });
    }
    const body = entries
      .map((e) => `${e.shortHash || e.hash.slice(0, 8)} ${e.date ? `${e.date} ` : ""}${e.author ? `${e.author} ` : ""}— ${e.message}`)
      .join("\n");
    return okResult(body, {
      data: { commits: entries.map((e) => ({ hash: e.hash, message: e.message })) },
      meta: { count: entries.length },
    });
  },
};

export const gitBranchesTool: AgentTool = {
  name: "git_branches",
  description: "List the local and remote git branches, marking the one currently checked out.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  category: "git",
  capabilities: ["git.read"],
  readOnly: true,
  destructive: false,
  async execute(ctx, args): Promise<AgentToolOutcome> {
    if (!(await ctx.authorize("git", args))) return deniedResult();
    const repo = requireRepo(ctx);
    if ("failure" in repo) return repo.failure;
    const call = fromGitCall("tool_failed", () => getBranches(repo.cwd));
    if (!call.ok) return call.outcome;
    if (!call.value.length) return okResult("No branches.", { meta: { count: 0 } });
    const body = call.value
      .map((b) => `${b.current ? "* " : "  "}${b.name}${b.remote ? ` (upstream ${b.remote})` : ""}`)
      .join("\n");
    return okResult(body, {
      data: { branches: call.value.map((b) => ({ name: b.name, current: b.current === true })) },
      meta: { count: call.value.length },
    });
  },
};

export const gitStageTool: AgentTool = {
  name: "git_stage",
  description:
    "Stage files for the next commit. With no `paths`, stages every change. Staging is reversible " +
    "(it does not touch file contents); use unstage=true to take files back out of the index.",
  parameters: {
    type: "object",
    properties: {
      paths: {
        type: "array",
        description: "Workspace-relative file paths. Omit to stage every change.",
        items: { type: "string" },
      },
      unstage: { type: "boolean", description: "Unstage instead of stage.", default: false },
    },
    required: [],
    additionalProperties: false,
  },
  category: "git",
  capabilities: ["git.write"],
  readOnly: false,
  destructive: false,
  async execute(ctx, args): Promise<AgentToolOutcome> {
    if (!(await ctx.authorize("git", args))) return deniedResult();

    const paths = Array.isArray(args.paths)
      ? args.paths.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
      : [];
    const unstage = args.unstage === true;

    // There is deliberately no "unstage everything" path: `unstageFiles` needs
    // explicit paths, and silently mapping an empty list onto `git reset HEAD`
    // would be a destructive operation the Git panel does not offer either.
    //
    // Checked before the repository check on purpose. "unstage everything" is a
    // refusal about the *request*, not about the machine, so the model should be
    // told that even when the folder happens not to be a repository — otherwise
    // the same request reads as "no such folder" here and "not allowed" there.
    if (unstage && paths.length === 0) {
      return errorResult("invalid_input", "unstage needs explicit paths.", {
        text: "Error: unstage requires at least one path. This tool will not unstage the whole repository implicitly.",
        hint: "Pass `paths`, or use the Git panel to unstage everything.",
      });
    }

    const repo = requireRepo(ctx);
    if ("failure" in repo) return repo.failure;

    const call = fromGitCall("not_found", () => {
      if (paths.length === 0) {
        stageAll(repo.cwd);
        return "";
      }
      const rel = paths.map((p) => toRepoPath(repo.cwd, p.trim()));
      if (unstage) unstageFiles(repo.cwd, rel);
      else stageFiles(repo.cwd, rel);
      return rel.join(", ");
    });
    if (!call.ok) return call.outcome;

    const scope = paths.length === 0 ? "every change" : call.value;
    return okResult(`${unstage ? "Unstaged" : "Staged"} ${scope}.`, {
      data: { paths: paths.length ? paths : "all", unstage },
      meta: { count: paths.length },
    });
  },
};

export const gitCommitTool: AgentTool = {
  name: "git_commit",
  description:
    "Commit the staged changes with a message. Only what is already staged is committed — " +
    "stage the files with git_stage first if something is still unstaged.",
  parameters: {
    type: "object",
    properties: {
      message: { type: "string", description: "Commit message. The first line is the summary.", minLength: 1 },
    },
    required: ["message"],
    additionalProperties: false,
  },
  category: "git",
  capabilities: ["git.write"],
  readOnly: false,
  destructive: true,
  async execute(ctx, args): Promise<AgentToolOutcome> {
    if (!(await ctx.authorize("git", args))) return deniedResult();

    // Same reasoning as git_stage: a missing message is a refusal about the
    // request, so it is reported before we ask the machine whether it has a repo.
    const message = String(args.message ?? "").trim();
    if (!message) {
      return errorResult("invalid_input", "A commit message is required.", {
        text: "Error: a commit message is required.",
        hint: "Resend with a non-empty `message`.",
      });
    }

    const repo = requireRepo(ctx);
    if ("failure" in repo) return repo.failure;

    const call = fromGitCall("conflict", () => commit(repo.cwd, message));
    if (!call.ok) {
      // "Nothing staged" and "no author identity" are the two failures a model
      // hits constantly, and git's wording for both is unhelpful. Each gets the
      // action that actually fixes it.
      const text = call.outcome.text;
      if (/nothing to commit|no changes added|please tell me who you are/i.test(text)) {
        return errorResult("conflict", "git refused the commit.", {
          text:
            "Error: git refused the commit — " +
            (/please tell me who you are/i.test(text)
              ? "this repository has no author identity configured."
              : "there is nothing staged to commit.") +
            " Nothing was committed.",
          hint: /please tell me who you are/i.test(text)
            ? "Set git user.name and user.email, then commit again."
            : "Stage the files with git_stage, then commit again.",
        });
      }
      return call.outcome;
    }
    return okResult(`Committed ${message.split("\n")[0]} as ${call.value.slice(0, 12)}.`, {
      data: { message, hash: call.value },
      meta: { count: 1 },
    });
  },
};

export const gitCreateBranchTool: AgentTool = {
  name: "git_create_branch",
  description: "Create a new git branch from the current HEAD and switch to it.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "New branch name.", minLength: 1 },
    },
    required: ["name"],
    additionalProperties: false,
  },
  category: "git",
  capabilities: ["git.write"],
  readOnly: false,
  destructive: false,
  async execute(ctx, args): Promise<AgentToolOutcome> {
    if (!(await ctx.authorize("git", args))) return deniedResult();
    const repo = requireRepo(ctx);
    if ("failure" in repo) return repo.failure;
    const name = String(args.name ?? "").trim();
    const call = fromGitCall("conflict", () => createBranch(repo.cwd, name));
    if (!call.ok) return call.outcome;
    return okResult(`Created and switched to branch ${name}.`, { data: { name } });
  },
};

export const gitCheckoutTool: AgentTool = {
  name: "git_checkout",
  description:
    "Switch to an existing git branch. Uncommitted changes stay in the working tree, and git refuses the " +
    "switch if a change would be overwritten.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Branch to switch to.", minLength: 1 },
    },
    required: ["name"],
    additionalProperties: false,
  },
  category: "git",
  capabilities: ["git.write"],
  readOnly: false,
  destructive: false,
  async execute(ctx, args): Promise<AgentToolOutcome> {
    if (!(await ctx.authorize("git", args))) return deniedResult();
    const repo = requireRepo(ctx);
    if ("failure" in repo) return repo.failure;
    const name = String(args.name ?? "").trim();

    // Checked first so the model gets "no such branch, here are the real ones"
    // instead of git's wording, and so a typo cannot be mistaken for a
    // checkout that failed for a different reason.
    const branches = fromGitCall("tool_failed", () => getBranches(repo.cwd));
    if (!branches.ok) return branches.outcome;
    if (!branches.value.some((b) => b.name === name)) {
      const known = branches.value.map((b) => b.name).join(", ") || "none";
      return errorResult("not_found", `There is no branch named ${name}.`, {
        text: `Error: no branch named ${name}. Known branches: ${known}.`,
        hint: "Use git_branches to list them, then resend with an exact name.",
        data: { known: branches.value.map((b) => b.name) },
      });
    }

    const call = fromGitCall("conflict", () => switchBranch(repo.cwd, name));
    if (!call.ok) return call.outcome;
    return okResult(`Switched to ${name}.`, { data: { name } });
  },
};

/** List git remotes with their URLs. */
export const gitRemotesTool: AgentTool = {
  name: "git_remotes",
  description: "List all git remotes with their fetch and push URLs.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  category: "git",
  capabilities: ["git.read"],
  readOnly: true,
  destructive: false,
  async execute(ctx, _args): Promise<AgentToolOutcome> {
    if (!(await ctx.authorize("git", _args))) return deniedResult();
    const repo = requireRepo(ctx);
    if ("failure" in repo) return repo.failure;
    const call = fromGitCall("tool_failed", () => getRemotes(repo.cwd));
    if (!call.ok) return call.outcome;
    const remotes = call.value;
    if (!remotes.length) return okResult("No remotes configured.", { meta: { count: 0 } });
    const body = remotes.map((r) => `${r.name}\t${r.fetchUrl}${r.pushUrl !== r.fetchUrl ? ` (push: ${r.pushUrl})` : ""}`).join("\n");
    return okResult(body, { data: { remotes: remotes.map((r) => ({ name: r.name, fetch: r.fetchUrl, push: r.pushUrl })) }, meta: { count: remotes.length } });
  },
};

/** Show merge conflicts with conflict markers. */
export const gitMergeConflictsTool: AgentTool = {
  name: "git_merge_conflicts",
  description: "List files with merge conflicts and show the conflict markers for a specific file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Show conflict markers for this file. Omit to list all conflicted files.", default: "" },
    },
    required: [],
    additionalProperties: false,
  },
  category: "git",
  capabilities: ["git.read"],
  readOnly: true,
  destructive: false,
  async execute(ctx, args): Promise<AgentToolOutcome> {
    if (!(await ctx.authorize("git", args))) return deniedResult();
    const repo = requireRepo(ctx);
    if ("failure" in repo) return repo.failure;
    const raw = String(args.path ?? "").trim();
    if (raw) {
      // Show conflict markers for a specific file
      const call = fromGitCall("tool_failed", () => getConflictContent(repo.cwd, raw));
      if (!call.ok) return call.outcome;
      const content = call.value;
      if (!content.trim()) return okResult(`No conflicts in ${raw}.`, { meta: { count: 0 } });
      return okResult(`Conflicts in ${raw}:\n\n${content}`, { meta: { count: 1 } });
    }
    // List all conflicted files
    const call = fromGitCall("tool_failed", () => getConflictFiles(repo.cwd));
    if (!call.ok) return call.outcome;
    const files = call.value;
    if (!files.length) return okResult("No merge conflicts.", { meta: { count: 0 } });
    const body = files.map((f) => `- ${f}`).join("\n");
    return okResult(`Files with merge conflicts:\n${body}`, { data: { files }, meta: { count: files.length } });
  },
};

/** Suggest resolution for a merge conflict. */
export const gitConflictResolutionSuggestTool: AgentTool = {
  name: "git_conflict_resolution_suggest",
  description: "Analyze a conflicted file and suggest a resolution strategy (ours, theirs, manual).",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Conflicted file to analyze.", minLength: 1 },
    },
    required: ["path"],
    additionalProperties: false,
  },
  category: "git",
  capabilities: ["git.read"],
  readOnly: true,
  destructive: false,
  async execute(ctx, args): Promise<AgentToolOutcome> {
    if (!(await ctx.authorize("git", args))) return deniedResult();
    const repo = requireRepo(ctx);
    if ("failure" in repo) return repo.failure;
    const raw = String(args.path ?? "").trim();
    const call = fromGitCall("tool_failed", () => getConflictContent(repo.cwd, raw));
    if (!call.ok) return call.outcome;
    const content = call.value;
    if (!content.trim()) return okResult(`No conflicts in ${raw}.`, { meta: { count: 0 } });
    // Count conflict markers
    const oursCount = (content.match(/<<<<<<< /g) || []).length;
    const theirsCount = (content.match(/>>>>>>> /g) || []).length;
    const bothCount = (content.match(/=======/g) || []).length;
    let suggestion = "";
    if (oursCount === theirsCount && oursCount > 0) {
      suggestion = "Multiple conflict sections found. Review each section individually. Consider using 'ours' for your changes or 'theirs' for incoming changes per section.";
    } else if (oursCount > 0 && theirsCount > 0) {
      suggestion = "Single conflict section. Use 'git checkout --ours <file>' to keep your version, or 'git checkout --theirs <file>' to accept incoming changes. For mixed changes, edit manually.";
    } else {
      suggestion = "Conflict markers detected but pattern unclear. Manual review recommended.";
    }
    return okResult(`Conflict analysis for ${raw}:\n- Ours markers: ${oursCount}\n- Theirs markers: ${theirsCount}\n- Separator markers: ${bothCount}\n\nSuggestion: ${suggestion}`, { data: { path: raw, ours: oursCount, theirs: theirsCount, separators: bothCount } });
  },
};

/** Show branch tracking information (upstream, ahead/behind). */
export const gitBranchTrackingTool: AgentTool = {
  name: "git_branch_tracking",
  description: "Show upstream tracking info for all branches: current branch upstream, ahead/behind counts.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  category: "git",
  capabilities: ["git.read"],
  readOnly: true,
  destructive: false,
  async execute(ctx, _args): Promise<AgentToolOutcome> {
    if (!(await ctx.authorize("git", _args))) return deniedResult();
    const repo = requireRepo(ctx);
    if ("failure" in repo) return repo.failure;
    const call = fromGitCall("tool_failed", () => getBranchTrackingInfo(repo.cwd));
    if (!call.ok) return call.outcome;
    const info = call.value;
    const lines: string[] = [];
    if (info.current) {
      lines.push(`Current branch: ${info.current}${info.upstream ? ` -> ${info.upstream} (ahead ${info.ahead}, behind ${info.behind})` : " (no upstream)"}`);
    }
    if (info.branches.length > 0) {
      lines.push("\nAll branches:");
      for (const b of info.branches) {
        if (b.upstream) {
          lines.push(`  ${b.name} -> ${b.upstream} (ahead ${b.ahead}, behind ${b.behind})`);
        } else {
          lines.push(`  ${b.name} (no upstream)`);
        }
      }
    }
    return okResult(lines.join("\n") || "No branch tracking info.", { data: info, meta: { count: info.branches.length } });
  },
};

/** Generate a conventional commit message from staged changes. */
export const gitCommitMessageSuggestTool: AgentTool = {
  name: "git_commit_message_suggest",
  description: "Generate a conventional commit message from the currently staged changes (or working tree if nothing staged).",
  parameters: {
    type: "object",
    properties: {
      staged: { type: "boolean", description: "Use staged changes instead of working tree.", default: true },
    },
    required: [],
    additionalProperties: false,
  },
  category: "git",
  capabilities: ["git.read"],
  readOnly: true,
  destructive: false,
  async execute(ctx, args): Promise<AgentToolOutcome> {
    if (!(await ctx.authorize("git", args))) return deniedResult();
    const repo = requireRepo(ctx);
    if ("failure" in repo) return repo.failure;
    const staged = args.staged === true;
    const call = fromGitCall("tool_failed", () => getDiff(repo.cwd, undefined, staged));
    if (!call.ok) return call.outcome;
    const diff = call.value;
    if (!diff.trim()) return okResult(staged ? "No staged changes to analyze." : "No working tree changes to analyze.", { meta: { count: 0 } });
    const message = generateCommitMessageFromDiff(diff);
    const files = [...diff.matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1]);
    return okResult(`Suggested commit message:\n\n${message}\n\nFiles: ${files.join(", ")}`, { data: { message, files, staged }, meta: { count: files.length } });
  },
};

/** Analyze commit history for patterns. */
export const gitHistoryAnalyzeTool: AgentTool = {
  name: "git_history_analyze",
  description: "Analyze commit history for patterns: commit frequency, contributors, file hotspots, conventional commit usage.",
  parameters: {
    type: "object",
    properties: {
      limit: { type: "integer", description: "Number of recent commits to analyze.", minimum: 1, maximum: 500, default: 100 },
    },
    required: [],
    additionalProperties: false,
  },
  category: "git",
  capabilities: ["git.read"],
  readOnly: true,
  destructive: false,
  async execute(ctx, args): Promise<AgentToolOutcome> {
    if (!(await ctx.authorize("git", args))) return deniedResult();
    const repo = requireRepo(ctx);
    if ("failure" in repo) return repo.failure;
    const limit = typeof args.limit === "number" ? args.limit : 100;
    const call = fromGitCall("tool_failed", () => getLog(repo.cwd, limit));
    if (!call.ok) return call.outcome;
    const commits = call.value;
    if (!commits.length) return okResult("No commits to analyze.", { meta: { count: 0 } });
    // Analyze patterns
    const types: Record<string, number> = {};
    const scopes: Record<string, number> = {};
    const authors: Record<string, number> = {};
    const hours: Record<number, number> = {};
    for (const c of commits) {
      const msg = c.message;
      const typeMatch = msg.match(/^(\w+)(?:\(([^)]+)\))?:/);
      if (typeMatch) {
        types[typeMatch[1]] = (types[typeMatch[1]] || 0) + 1;
        if (typeMatch[2]) scopes[typeMatch[2]] = (scopes[typeMatch[2]] || 0) + 1;
      } else {
        types["(no prefix)"] = (types["(no prefix)"] || 0) + 1;
      }
      authors[c.author] = (authors[c.author] || 0) + 1;
      if (c.date) {
        const hour = new Date(c.date).getHours();
        hours[hour] = (hours[hour] || 0) + 1;
      }
    }
    const topTypes = Object.entries(types).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const topScopes = Object.entries(scopes).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const topAuthors = Object.entries(authors).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const peakHours = Object.entries(hours).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const conventionalPct = commits.length > 0 ? Math.round((commits.filter((c) => /^\w+(\([^)]+\))?:/.test(c.message)).length / commits.length) * 100) : 0;
    const body = [
      `Analyzed ${commits.length} recent commits:`,
      `\nCommit types: ${topTypes.map(([t, c]) => `${t} (${c})`).join(", ")}`,
      `\nTop scopes: ${topScopes.map(([s, c]) => `${s} (${c})`).join(", ")}`,
      `\nTop contributors: ${topAuthors.map(([a, c]) => `${a} (${c})`).join(", ")}`,
      `\nPeak commit hours: ${peakHours.map(([h, c]) => `${h}:00 (${c})`).join(", ")}`,
      `\nConventional commit usage: ${conventionalPct}%`,
    ].join("");
    return okResult(body, { data: { types, scopes, authors, hours, conventionalPct }, meta: { count: commits.length } });
  },
};

/** High-level repository understanding: branches, remotes, tags, stats. */
export const gitRepoUnderstandTool: AgentTool = {
  name: "git_repo_understand",
  description: "Get a high-level overview of the repository: branches, remotes, tags, commit stats, contributors.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  category: "git",
  capabilities: ["git.read"],
  readOnly: true,
  destructive: false,
  async execute(ctx, _args): Promise<AgentToolOutcome> {
    if (!(await ctx.authorize("git", _args))) return deniedResult();
    const repo = requireRepo(ctx);
    if ("failure" in repo) return repo.failure;
    const stats = getRepositoryStats(repo.cwd);
    const remotes = getRemotes(repo.cwd);
    const remoteBranches = getRemoteBranches(repo.cwd);
    const branches = getBranches(repo.cwd);
    const body = [
      `Repository Overview:`,
      `  Total commits: ${stats.totalCommits}`,
      `  Branches: ${stats.totalBranches} (${branches.filter(b => !b.isRemote).length} local, ${branches.filter(b => b.isRemote).length} remote)`,
      `  Remotes: ${stats.totalRemotes} (${remotes.map(r => r.name).join(", ") || "none"})`,
      `  Remote branches: ${remoteBranches.length}`,
      `  Tags: ${stats.totalTags}`,
      `  Contributors: ${stats.contributors}`,
      `  First commit: ${stats.firstCommitDate || "unknown"}`,
      `  Last commit: ${stats.lastCommitDate || "unknown"}`,
    ].join("\n");
    return okResult(body, { data: { stats, remotes: remotes.map(r => r.name), branches: branches.map(b => b.name) }, meta: { count: stats.totalBranches } });
  },
};

export const GIT_TOOLS: readonly AgentTool[] = Object.freeze([
  gitDiffTool,
  gitLogTool,
  gitBranchesTool,
  gitStageTool,
  gitCommitTool,
  gitCreateBranchTool,
  gitCheckoutTool,
  gitRemotesTool,
  gitMergeConflictsTool,
  gitConflictResolutionSuggestTool,
  gitBranchTrackingTool,
  gitCommitMessageSuggestTool,
  gitHistoryAnalyzeTool,
  gitRepoUnderstandTool,
]);
