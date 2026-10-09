// Close Code — skills (Phase 31)
//
// A skill is a reusable AI workflow the user (or the repo) writes down once and
// the model can invoke by name: "review the diff the way we always review
// diffs", "write the migration the way this project writes migrations". The
// shape is the one the ecosystem converged on — a directory per skill with a
// `SKILL.md` inside:
//
//   <workspace>/.closecode/skills/<name>/SKILL.md     (project skills)
//   <userData>/skills/<name>/SKILL.md                 (user skills)
//
//   ---
//   name: review-diff
//   description: Review the current diff the way this project reviews diffs.
//   allowed-tools: git_diff, read_file, search_files
//   ---
//   <the workflow, in prose, read by the model when the skill is invoked>
//
// WHAT A SKILL IS NOT: it is not code, and it is not a permission. The body is
// instructions the model reads; anything the model then *does* goes through
// the same tool gate as anything else. `allowed-tools` can only ever *narrow*
// what the run may call while the skill is active — it can name a tool the
// user has denied and the denial still stands, because the restriction and the
// gate both apply and neither widens the other. That is the whole security
// story, stated here because the gate alone must never be the whole story.
//
// Discovery is per-call and cheap: two directories, bounded counts, no cache —
// a run and the panel both see the files as they are on disk at that moment.
// There is deliberately no file watching (see the report's limitations).

import fs from "fs";
import path from "path";
import { app } from "electron";

export type SkillSource = "user" | "project";

export interface SkillInfo {
  name: string;
  description: string;
  source: SkillSource;
  /** Tool names the skill restricts the run to, or null for unrestricted. */
  allowedTools: string[] | null;
  absolutePath: string;
  chars: number;
}

export interface Skill extends SkillInfo {
  body: string;
}

export const MAX_SKILLS_PER_SCOPE = 16;
export const MAX_SKILL_NAME = 48;
export const MAX_SKILL_DESC = 200;
export const MAX_SKILL_BODY_CHARS = 24_000;
export const MAX_SKILL_ALLOWED_TOOLS = 32;
export const SKILL_FILE_NAME = "SKILL.md";
export const PROJECT_SKILLS_DIR = path.join(".closecode", "skills");

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

let userDataOverride: string | null = null;

/** Tests point the user scope at a temp directory, like the other stores. */
export function setSkillsUserDataDir(dir: string): void {
  userDataOverride = dir;
}

function userSkillsDir(): string {
  return path.join(userDataOverride ?? app.getPath("userData"), "skills");
}

function projectSkillsDir(workspace: string): string {
  return path.join(workspace, PROJECT_SKILLS_DIR);
}

/** Parse one SKILL.md. Returns null when the file is not a skill at all. */
export function parseSkillFile(text: string, absolutePath: string, source: SkillSource): Skill | null {
  const match = text.match(/^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const [, frontmatter, bodyRaw] = match;

  let name = "";
  let description = "";
  let allowedTools: string[] | null = null;
  for (const line of frontmatter.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "name") name = value;
    else if (key === "description") description = value;
    else if (key === "allowed-tools" || key === "allowed_tools") {
      const tools = value
        .split(/[\s,]+/)
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, MAX_SKILL_ALLOWED_TOOLS);
      // An empty list would mean "may do nothing at all" — almost certainly an
      // authoring mistake, so it is treated as absent rather than as a trap.
      allowedTools = tools.length > 0 ? tools : null;
    }
  }

  name = name.trim().toLowerCase().slice(0, MAX_SKILL_NAME);
  if (!name || !NAME_RE.test(name)) return null;
  const body = bodyRaw.trim();
  if (!body) return null;

  return {
    name,
    description: description.slice(0, MAX_SKILL_DESC),
    source,
    allowedTools,
    absolutePath,
    chars: Math.min(body.length, MAX_SKILL_BODY_CHARS),
    body:
      body.length > MAX_SKILL_BODY_CHARS
        ? `${body.slice(0, MAX_SKILL_BODY_CHARS)}\n… (truncated to the ${MAX_SKILL_BODY_CHARS}-character skill body cap)`
        : body,
  };
}

function readScope(dir: string, source: SkillSource): Skill[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Skill[] = [];
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_SKILLS_PER_SCOPE);
  for (const dirName of dirs) {
    const file = path.join(dir, dirName, SKILL_FILE_NAME);
    let text: string;
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size > MAX_SKILL_BODY_CHARS * 4) continue;
      text = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const skill = parseSkillFile(text, file, source);
    if (skill) out.push(skill);
  }
  return out;
}

/**
 * Every discoverable skill. Project skills shadow user skills of the same
 * name — the repo knows its own workflows better than the person's defaults.
 */
export function discoverSkills(workspace: string | null): Skill[] {
  const byName = new Map<string, Skill>();
  for (const skill of readScope(userSkillsDir(), "user")) byName.set(skill.name, skill);
  for (const skill of readScope(projectSkillsDir(workspace ?? "__none__"), "project")) byName.set(skill.name, skill);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Metadata view for the panel and the system-prompt index — no bodies. */
export function listSkills(workspace: string | null): SkillInfo[] {
  return discoverSkills(workspace).map(({ body: _body, ...info }) => info);
}

/** The full skill, for invocation and for the panel's preview. */
export function readSkill(workspace: string | null, name: string): { ok: true; skill: Skill } | { ok: false; error: string } {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return { ok: false, error: "A skill name is required." };
  const found = discoverSkills(workspace).find((s) => s.name === wanted);
  if (!found) {
    const known = discoverSkills(workspace).map((s) => s.name);
    return {
      ok: false,
      error: `No skill named "${wanted}".${known.length > 0 ? ` Available: ${known.join(", ")}.` : " No skills are defined for this workspace or user."}`,
    };
  }
  return { ok: true, skill: found };
}
