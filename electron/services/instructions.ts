// Close Code — instruction files (Phase 31)
//
// Where the AI learns how the user and the project want code written. Two
// scopes, one renderer-agnostic loader:
//
//   * user    — `<userData>/instructions/*.md`        (this person's habits:
//                                                        coding style, review
//                                                        preferences, anything
//                                                        that follows them
//                                                        across projects)
//   * project — `<workspace>/.closecode/instructions/*.md`
//                                                        (this repo's rules:
//                                                        architecture, testing,
//                                                        security, project-rules)
//
// They are instructions, not conversation: nothing here is redacted, because
// nothing here is stored by the app — the files are the user's own, written to
// be sent. Both scopes land in the agent's context bundle (via the Phase 26
// engine's instructions part) and in the plain-chat system prompt, bounded the
// same in both places, because "the model was told" must be one fact, not two.
//
// Bounds are the honesty mechanism: a 3 MB "coding-style.md" is no longer
// instructions, it is an accident, and the loader says so by truncating at a
// visible cap rather than silently ballooning every prompt.

import fs from "fs";
import path from "path";
import { app } from "electron";

export type InstructionScope = "user" | "project";

export interface InstructionFile {
  /** Display path: `user:coding-style.md` or `project:security.md`. */
  name: string;
  scope: InstructionScope;
  /** Absolute path on disk. Never sent to the model; for the panel. */
  absolutePath: string;
  chars: number;
  text: string;
}

export const MAX_INSTRUCTION_FILES_PER_SCOPE = 8;
export const MAX_INSTRUCTION_FILE_CHARS = 32_000;
export const MAX_INSTRUCTION_SCOPE_CHARS = 48_000;
export const INSTRUCTION_DIR_NAME = "instructions";
export const PROJECT_INSTRUCTION_DIR = path.join(".closecode", "instructions");

let userDataOverride: string | null = null;

/** Tests point the user scope at a temp directory, like the other stores. */
export function setInstructionsUserDataDir(dir: string): void {
  userDataOverride = dir;
}

function userInstructionsDir(): string {
  return path.join(userDataOverride ?? app.getPath("userData"), INSTRUCTION_DIR_NAME);
}

function projectInstructionsDir(workspace: string): string {
  return path.join(workspace, PROJECT_INSTRUCTION_DIR);
}

/** `.md` files only, alphabetically — deterministic, so prompts are stable. */
function readScope(dir: string, scope: InstructionScope): InstructionFile[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: InstructionFile[] = [];
  let scopeChars = 0;
  const names = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_INSTRUCTION_FILES_PER_SCOPE);
  for (const name of names) {
    const absolutePath = path.join(dir, name);
    let text: string;
    try {
      const st = fs.statSync(absolutePath);
      if (st.size > MAX_INSTRUCTION_FILE_CHARS * 4) {
        // Absurdly large: don't even read it; the cap below would clip it, and
        // reading a gigabyte to keep 32k is how builds stall.
        continue;
      }
      text = fs.readFileSync(absolutePath, "utf-8");
    } catch {
      continue;
    }
    const trimmed = text.trim();
    if (!trimmed) continue;
    if (scopeChars + trimmed.length > MAX_INSTRUCTION_SCOPE_CHARS) {
      const left = MAX_INSTRUCTION_SCOPE_CHARS - scopeChars;
      if (left <= 200) break; // not worth a fragment
      out.push({
        name: `${scope}:${name}`,
        scope,
        absolutePath,
        chars: left,
        text: `${trimmed.slice(0, left)}\n… (truncated to the ${MAX_INSTRUCTION_SCOPE_CHARS}-character ${scope} instruction budget)`,
      });
      break;
    }
    const clipped =
      trimmed.length > MAX_INSTRUCTION_FILE_CHARS
        ? `${trimmed.slice(0, MAX_INSTRUCTION_FILE_CHARS)}\n… (truncated to the ${MAX_INSTRUCTION_FILE_CHARS}-character per-file cap)`
        : trimmed;
    scopeChars += clipped.length;
    out.push({ name: `${scope}:${name}`, scope, absolutePath, chars: clipped.length, text: clipped });
  }
  return out;
}

/**
 * All instruction files for a workspace: user scope first (the person), then
 * project scope (the repo), so when both say something the project's words are
 * the later, closer ones.
 */
export function collectInstructions(workspace: string | null): InstructionFile[] {
  const out: InstructionFile[] = [];
  out.push(...readScope(userInstructionsDir(), "user"));
  if (workspace) out.push(...readScope(projectInstructionsDir(workspace), "project"));
  return out;
}

/**
 * The block injected into agent context and the chat system prompt. Empty
 * string when nothing exists — an absent block is a smaller prompt, not an
 * error.
 */
export function renderInstructionBlock(workspace: string | null): { text: string; files: InstructionFile[] } {
  const files = collectInstructions(workspace);
  if (files.length === 0) return { text: "", files };
  const body = files.map((f) => `--- ${f.name} ---\n${f.text}`).join("\n\n");
  return {
    text:
      "The user and the project have provided these instructions. Follow them unless they conflict with a direct request:\n\n" +
      body,
    files,
  };
}

/** Panel view: metadata only, with a bounded preview so the panel can quote. */
export function listInstructionFiles(workspace: string | null): Array<Omit<InstructionFile, "text"> & { preview: string }> {
  return collectInstructions(workspace).map((f) => ({
    name: f.name,
    scope: f.scope,
    absolutePath: f.absolutePath,
    chars: f.chars,
    preview: f.text.length > 600 ? `${f.text.slice(0, 600)}…` : f.text,
  }));
}
