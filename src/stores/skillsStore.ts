// Close Code — skills & instructions store (Phase 31)
//
// Renderer projection of what the skill store and the instruction loader see
// on disk *right now*. There is no push channel on purpose: the files are the
// truth, runs re-discover per run, and the panel re-reads on mount, on
// workspace change, and on the user's Refresh — a file watcher would be a
// third truth with its own failure modes.
//
// This store invents nothing: every row comes from `skills:list` /
// `instructions:list` over IPC, and a skill's body is fetched only when the
// user asks to preview it.

import { create } from "zustand";
import type { InstructionFileInfo, SkillInfo } from "../types/electron";

export interface SkillsStoreState {
  skills: SkillInfo[];
  instructions: InstructionFileInfo[];
  workspace: string | null;
  error: string | null;
  busy: boolean;

  setWorkspace: (workspace: string | null) => Promise<void>;
  refresh: () => Promise<void>;
  clearError: () => void;
}

function msg(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : typeof err === "string" ? err : fallback;
}

export const useSkillsStore = create<SkillsStoreState>((set, get) => ({
  skills: [],
  instructions: [],
  workspace: null,
  error: null,
  busy: false,

  setWorkspace: async (workspace) => {
    if (workspace === get().workspace) return;
    set({ workspace, skills: [], instructions: [], error: null });
    await get().refresh();
  },

  refresh: async () => {
    const workspace = get().workspace;
    set({ busy: true });
    try {
      const [skills, instructions] = await Promise.all([
        window.closeCode.skillsList(workspace),
        window.closeCode.instructionsList(workspace),
      ]);
      set({
        busy: false,
        skills: skills.ok && skills.skills ? skills.skills : [],
        instructions: instructions.ok && instructions.files ? instructions.files : [],
        error: !skills.ok ? (skills.error ?? "Skills could not be read.") : !instructions.ok ? (instructions.error ?? "Instructions could not be read.") : null,
      });
    } catch (err) {
      set({ busy: false, error: msg(err, "Skills could not be read.") });
    }
  },

  clearError: () => set({ error: null }),
}));
