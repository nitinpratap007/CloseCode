// Close Code — AI Agent Runtime — file and content tools (Phase 22)
//
// `edit_file` and `grep_files`. Both sit alongside the Phase 11 tools rather
// than replacing them, because they do genuinely different jobs:
//
//   * `write_file` (Phase 11) replaces a file wholesale. For a 900-line file
//     that means the model has to reproduce 900 lines correctly to change one,
//     which it frequently cannot.
//   * `edit_file` changes an exact, unique span. The failure mode is the
//     opposite and much safer: if the span is missing or ambiguous, nothing is
//     written and the model is told which.
//
//   * `search_files` (Phase 11) does a plain substring search.
//   * `grep_files` does a real regular expression with line numbers and context,
//     which is what an agent actually needs to locate a symbol or a call site.
//
// Neither tool ever rewrites the model's own text, and `edit_file` reports the
// exact number of replacements it made so the model can verify the edit landed
// where it intended rather than guessing.

import fs from "fs";
import path from "path";
import { deniedResult, errorResult, okResult } from "./result";
import { confinedOrRefusal } from "./paths";
import { SEARCH_LIMITS, truncationNote, walkWorkspace } from "./walk";
import type { AgentTool, AgentToolOutcome } from "./types";

const MAX_EDIT_FILE_BYTES = 2 * 1024 * 1024;

/** Lines scanned within one file. Bounds a minified or generated 200k-line file. */
const MAX_GREP_LINES_PER_FILE = 5_000;

/**
 * `edit_file` — replace an exact span in a file.
 *
 * The one safety property worth stating plainly: **an ambiguous edit writes
 * nothing.** If `find` occurs more than once and `replace_all` was not set, the
 * tool reports the number of occurrences and stops. A tool that guessed which
 * occurrence was meant would silently corrupt a file, and the model would have
 * no way to tell from the result that it had.
 */
export const editFileTool: AgentTool = {
  name: "edit_file",
  description:
    "Replace an exact string in a file. The string must appear exactly once unless replace_all is true. " +
    "Prefer this over write_file for changes to existing files: it cannot accidentally drop the rest of the file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File to edit, inside the workspace." },
      find: { type: "string", description: "Exact existing text to replace, including indentation.", minLength: 1 },
      replace: { type: "string", description: "The new text to put in its place." },
      replace_all: {
        type: "boolean",
        description: "Replace every occurrence. Defaults to false, which requires exactly one match.",
        default: false,
      },
    },
    required: ["path", "find", "replace"],
    additionalProperties: false,
  },
  category: "files",
  capabilities: ["files.write"],
  readOnly: false,
  destructive: true,
  async execute(ctx, args): Promise<AgentToolOutcome> {
    if (!(await ctx.authorize("files", args, { path: ctx.confine(String(args.path ?? "")) }))) return deniedResult();

    const located = confinedOrRefusal(ctx, String(args.path ?? ""));
    if ("refusal" in located) {
      return errorResult("outside_workspace", located.refusal, {
        text: located.refusal,
        hint: "Use a path inside the open workspace folder.",
      });
    }
    const target = located.path;

    let content: string;
    try {
      const stat = fs.statSync(target);
      if (!stat.isFile()) {
        return errorResult("invalid_input", `edit_file was given a path that is not a file: ${target}`, {
          text: `Error: ${target} is not a file. Use list_dir to see what is there.`,
          hint: "edit_file only changes files. Use write_file to create one.",
        });
      }
      if (stat.size > MAX_EDIT_FILE_BYTES) {
        return errorResult("limit_exceeded", `${path.basename(target)} is ${stat.size} bytes, over the ${MAX_EDIT_FILE_BYTES} limit for edit_file.`, {
          text: `Error: file too large to edit safely (${stat.size} bytes).`,
          hint: "Edit a smaller file, or use run_terminal with a scripted edit.",
        });
      }
      content = fs.readFileSync(target, "utf-8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const missing = (err as { code?: string })?.code === "ENOENT";
      return errorResult(missing ? "not_found" : "tool_failed", message, {
        text: missing ? `Error: no such file: ${target}` : `Error reading ${target}: ${message}`,
        ...(missing ? { hint: "Check the path with search_files or list_dir." } : {}),
      });
    }

    const find = String(args.find);
    const replace = String(args.replace);
    const replaceAll = args.replace_all === true;

    // Counted, not assumed: the whole point is to refuse when the model has not
    // been specific enough.
    let occurrences = 0;
    let at = content.indexOf(find);
    while (at !== -1) {
      occurrences += 1;
      at = content.indexOf(find, at + find.length);
    }

    if (occurrences === 0) {
      return errorResult("not_found", `The text to replace was not found in ${target}.`, {
        text: `Error: the exact text to replace does not appear in ${path.basename(target)}. Nothing was written.`,
        hint: "Read the file first and copy the text exactly, including indentation and line endings.",
        data: { path: target, occurrences: 0 },
      });
    }
    if (occurrences > 1 && !replaceAll) {
      const lines = lineNumbersOf(content, find);
      return errorResult("conflict", `The text to replace occurs ${occurrences} times in ${target}.`, {
        text:
          `Error: the text to replace occurs ${occurrences} times in ${path.basename(target)}, so nothing was written. ` +
          `It appears at line(s) ${lines.join(", ")}.`,
        hint: "Include more surrounding context in `find` so it is unique, or set replace_all to true if you mean every occurrence.",
        data: { path: target, occurrences, lines },
      });
    }

    const next = replaceAll
      ? content.split(find).join(replace)
      : content.replace(find, () => replace);
    const changed = next.length - content.length;

    try {
      fs.writeFileSync(target, next, "utf-8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult("tool_failed", message, {
        text: `Error writing ${target}: ${message}`,
      });
    }

    const where = lineOfOffset(content, content.indexOf(find));
    return okResult(
      `Replaced ${occurrences === 1 ? "1 occurrence" : `${occurrences} occurrences`} in ${target} ` +
        `(first at line ${where}, ${changed >= 0 ? "+" : ""}${changed} chars).`,
      {
        data: { path: target, replacements: occurrences, firstLine: where, deltaChars: changed },
        meta: { path: target, count: occurrences },
      },
    );
  },
};

/** 1-based line numbers of every occurrence of `needle`. Capped for the message. */
function lineNumbersOf(content: string, needle: string): number[] {
  const lines: number[] = [];
  let line = 1;
  let index = 0;
  for (;;) {
    const at = content.indexOf(needle, index);
    if (at === -1) break;
    line += countNewlines(content, index, at);
    lines.push(line);
    index = at + needle.length;
    if (lines.length >= 20) break;
  }
  return lines;
}

function countNewlines(content: string, from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i += 1) if (content.charCodeAt(i) === 10) n += 1;
  return n;
}

function lineOfOffset(content: string, offset: number): number {
  if (offset <= 0) return 1;
  return 1 + countNewlines(content, 0, offset);
}

/**
 * Phase 23. `delete_file` — remove a file or directory inside the workspace.
 *
 * Added because `files.delete` is one of the operations the permission system
 * has to govern, and a permission with no tool behind it is a switch that does
 * nothing. Shipping the permission without the tool would have made the
 * "delete" half of the requirement decorative.
 *
 * Two properties are worth stating, because they are what make a delete tool
 * usable by a model rather than merely safe:
 *
 *   * **The root cannot be deleted.** `path` resolving to the workspace root is
 *     refused outright, before any permission prompt, because there is no
 *     permission a user can sensibly be asked about that would make deleting
 *     their open folder a reasonable answer.
 *   * **Directories are refused.** A recursive delete is a different act with a
 *     different blast radius, and the model can always issue one `delete_file` per
 *     entry. `rm -rf` through a shell is the shape this exists to avoid, and it
 *     stays behind `shell.dangerous`, which defaults to denied.
 */
export const deleteFileTool: AgentTool = {
  name: "delete_file",
  description:
    "Delete a single file inside the workspace. Refuses directories and the workspace root. " +
    "Only use this when the task explicitly calls for removing a file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File to delete, inside the workspace.", minLength: 1 },
    },
    required: ["path"],
    additionalProperties: false,
  },
  category: "files",
  capabilities: ["files.delete"],
  readOnly: false,
  destructive: true,
  async execute(ctx, args): Promise<AgentToolOutcome> {
    const located = confinedOrRefusal(ctx, String(args.path ?? ""));
    if ("refusal" in located) {
      return errorResult("outside_workspace", located.refusal, {
        text: located.refusal,
        hint: "Use a path inside the open workspace folder.",
      });
    }
    const target = located.path;

    // Checked after confinement, so this compares two real absolute paths rather
    // than a caller-supplied string against the root.
    const root = ctx.workspace ? path.resolve(ctx.workspace) : null;
    if (root && path.resolve(target).toLowerCase() === root.toLowerCase()) {
      return errorResult("invalid_input", "Refusing to delete the workspace root.", {
        text: "Error: refusing to delete the workspace root. Close the folder first if that is really what you want.",
        hint: "Delete specific files inside it instead.",
      });
    }

    if (!(await ctx.authorize("files", args, { path: target }))) return deniedResult();

    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(target);
    } catch {
      return errorResult("not_found", `No such file: ${target}`, {
        text: `Error: ${target} does not exist, so nothing was deleted.`,
        hint: "Check the path with list_dir or search_files.",
      });
    }

    if (stat.isDirectory()) {
      // Not a `capability` check but a genuine refusal: no permission mode turns
      // a recursive delete of a tree into a reasonable one-shot action, and the
      // per-file path is always available.
      return errorResult("invalid_input", `${target} is a directory, not a file.`, {
        text: `Error: ${target} is a directory. Delete its files one at a time, or ask the user to remove it.`,
        hint: "Delete the entries individually with delete_file.",
      });
    }

    try {
      fs.unlinkSync(target);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult("tool_failed", message, { text: `Error deleting ${target}: ${message}` });
    }

    return okResult(`Deleted ${target} (${stat.size} bytes). This cannot be undone from the agent.`, {
      data: { path: target, bytes: stat.size },
    });
  },
};

/**
 * `grep_files` — regular-expression search with line numbers.
 *
 * Rejects an invalid pattern as `invalid_input` rather than throwing: a model
 * that sends a broken regex should be told which pattern failed to compile, not
 * handed a stack trace. Rejection happens before the walk starts, so a bad
 * pattern never costs a filesystem pass.
 */
export const grepFilesTool: AgentTool = {
  name: "grep_files",
  description:
    "Search file contents with a JavaScript regular expression. Returns matching lines with file:line references. " +
    "Use this to find where a symbol is defined or used; use search_files to find files by name.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "JavaScript regular expression, e.g. `export function createRun`.", minLength: 1 },
      include: {
        type: "string",
        description: "Only search paths containing this text, e.g. `.ts` or `src/agent`.",
        default: "",
      },
      ignore_case: { type: "boolean", description: "Case-insensitive match.", default: false },
      max_results: {
        type: "integer",
        description: "Maximum matching lines to return.",
        minimum: 1,
        maximum: 200,
        default: 50,
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  category: "search",
  capabilities: ["search.read"],
  readOnly: true,
  destructive: false,
  async execute(ctx, args): Promise<AgentToolOutcome> {
    if (!(await ctx.authorize("search", args))) return deniedResult();

    const root = ctx.workspace;
    if (!root) {
      const message = "Error: no workspace folder is open, so there is nothing to search.";
      return errorResult("no_workspace", message, { text: message });
    }

    const source = String(args.pattern);
    let regex: RegExp;
    try {
      // No `g` flag: this walk visits each line once and matches it, so a global
      // regex would carry `lastIndex` between lines and skip matches.
      regex = new RegExp(source, args.ignore_case === true ? "i" : "");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult("invalid_input", `The pattern ${source} is not a valid regular expression: ${message}`, {
        text: `Error: ${source} is not a valid regular expression — ${message}. Nothing was searched.`,
        hint: "Escape regex metacharacters (for example `(` as `\\(`) or use a plain substring with search_files.",
      });
    }

    const include = String(args.include ?? "").toLowerCase();
    const maxResults = typeof args.max_results === "number" ? args.max_results : 50;

    interface Hit {
      file: string;
      line: number;
      text: string;
    }
    // Per-file cap as well as an overall cap: one 10 000-line file must not eat
    // the entire result budget and hide the other 400 files that matched.
    const PER_FILE_CAP = 20;
    const perFile = new Map<string, number>();

    const walk = walkWorkspace<Hit>(root, {
      ...SEARCH_LIMITS,
      maxResults,
      readContent: true,
      accept: (f) => include === "" || f.rel.toLowerCase().includes(include),
      visit: (f) => {
        if (!f.content) return null;
        const seen = perFile.get(f.full) ?? 0;
        if (seen >= PER_FILE_CAP) return null;
        const out: Hit[] = [];
        const lines = f.content.split("\n");
        for (let i = 0; i < lines.length && i < MAX_GREP_LINES_PER_FILE; i += 1) {
          if (!regex.test(lines[i])) continue;
          out.push({ file: f.rel, line: i + 1, text: lines[i].trim().slice(0, 300) });
          if (out.length >= PER_FILE_CAP) break;
        }
        if (!out.length) return null;
        perFile.set(f.full, seen + out.length);
        return out;
      },
    });

    if (!walk.results.length) {
      return walk.truncated
        ? errorResult("limit_exceeded", `No match for ${source} in the part of the workspace that was searched.`, {
            text: `Searched ${walk.scanned} entries and stopped early; no match for ${source} in that part of the workspace.`,
            hint: "Narrow the pattern, or set `include` to the directory you expect.",
          })
        : okResult(`No match for ${source} in the workspace.`, { meta: { count: 0 } });
    }

    const body = walk.results.map((h) => `${h.file}:${h.line}: ${h.text}`).join("\n");
    return okResult(body + truncationNote(walk), {
      data: {
        pattern: source,
        hits: walk.results,
        scanned: walk.scanned,
        truncated: walk.truncated,
      },
      meta: { count: walk.results.length, truncated: walk.truncated },
    });
  },
};

// Phase 23 adds `delete_file`, so `files.delete` is a permission with a real
// operation behind it rather than a switch with nothing attached.
export const FILE_TOOLS: readonly AgentTool[] = Object.freeze([editFileTool, grepFilesTool, deleteFileTool]);
