// Close Code — skills & instructions IPC (Phase 31)
//
// The panel's read-only window onto the skill store and the instruction files.
// Three channels, all `{ ok, … }` envelopes. There is no write channel on
// purpose: skills and instructions are the user's files, edited in the editor
// itself — an IPC editor would be a second, worse editor, and "the files are
// the truth" is what keeps the run path and the panel path identical.

import { ipcMain } from "electron";
import { listInstructionFiles } from "../services/instructions";
import { listSkills, readSkill } from "../services/skills";

function fail(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

function workspaceOf(payload: unknown): string | null {
  if (payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).workspace === "string") {
    return (payload as Record<string, unknown>).workspace as string;
  }
  return null;
}

export function registerSkillsIpc(): void {
  ipcMain.handle("skills:list", (_e, payload: unknown) => {
    try {
      return { ok: true, skills: listSkills(workspaceOf(payload)) };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("skills:read", (_e, payload: { name?: unknown; workspace?: unknown }) => {
    try {
      const name = typeof payload?.name === "string" ? payload.name : "";
      if (!name) return fail("Which skill?");
      const res = readSkill(workspaceOf(payload), name);
      if (!res.ok) return fail(res.error);
      return { ok: true, skill: res.skill };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("instructions:list", (_e, payload: unknown) => {
    try {
      return { ok: true, files: listInstructionFiles(workspaceOf(payload)) };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });
}
