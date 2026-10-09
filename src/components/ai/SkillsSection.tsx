// Close Code — skills & instructions panel section (Phase 31)
//
// The read-only mirror of two on-disk truths: the instruction files that ride
// every prompt, and the skills the model may invoke. Nothing here is editable
// — the files are edited in the editor itself, this panel exists so the user
// can answer "what will the AI be told?" without opening a terminal:
//
//   * which instruction files load, from which scope, at what size, with a
//     preview of exactly the words the model gets;
//   * which skills exist, from which scope, with their allowed-tools
//     restriction visible up front — a skill that narrows a run says so before
//     anyone invokes it.

import { useEffect, useState } from "react";
import { useSkillsStore } from "../../stores/skillsStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import type { SkillInfo } from "../../types/electron";

function SkillRow({ skill, workspace }: { skill: SkillInfo; workspace: string | null }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const toggle = async (): Promise<void> => {
    const next = !open;
    setOpen(next);
    if (next && body === null) {
      const res = await window.closeCode.skillsRead(workspace, skill.name);
      if (res.ok && res.skill) setBody(res.skill.body);
      else setErr(res.error ?? "The skill could not be read.");
    }
  };

  return (
    <div className="flex flex-col rounded border border-cc-border/60 bg-cc-surface/40 px-2 py-1.5" data-skill={skill.name} data-skill-source={skill.source}>
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="text-[11px] font-medium text-cc-text truncate" title={skill.description || skill.name} data-skill-name={skill.name}>
          ⚡ {skill.name}
        </span>
        <span className={`text-[9px] shrink-0 ${skill.source === "project" ? "text-cc-accent" : "text-cc-muted"}`} data-skill-scope={skill.name}>
          {skill.source}
        </span>
        {skill.allowedTools && (
          <span className="text-[9px] text-amber-400 shrink-0" title={`While this skill is active, the run may only use: ${skill.allowedTools.join(", ")}`} data-skill-tools={skill.name}>
            ⛨ {skill.allowedTools.length} tools
          </span>
        )}
        <button
          type="button"
          className="ml-auto text-[10px] px-1.5 py-0.5 rounded border border-cc-border hover:bg-cc-surface text-cc-muted hover:text-cc-text shrink-0"
          onClick={() => void toggle()}
          data-skill-preview={skill.name}
        >
          {open ? "hide" : "preview"}
        </button>
      </div>
      {skill.description && (
        <div className="mt-0.5 text-[10px] text-cc-muted truncate" title={skill.description} data-skill-desc={skill.name}>
          {skill.description}
        </div>
      )}
      {open && (
        <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded border border-cc-border/60 bg-cc-surface/60 p-1.5 text-[10px] text-cc-text" data-skill-body={skill.name}>
          {err ?? body ?? "reading…"}
        </pre>
      )}
    </div>
  );
}

export default function SkillsSection(): React.JSX.Element {
  const store = useSkillsStore();
  const workspaceRoot = useWorkspaceStore((s) => s.root) ?? null;

  useEffect(() => {
    void store.setWorkspace(workspaceRoot);
  }, [workspaceRoot]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="px-3 py-2 border-b border-cc-border shrink-0 max-h-56 overflow-y-auto" data-ai-skills>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[11px] font-semibold text-cc-muted uppercase tracking-wide">
          Skills &amp; Instructions
          {store.skills.length + store.instructions.length > 0 ? ` (${store.skills.length + store.instructions.length})` : ""}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {store.busy && <span className="text-[11px] text-cc-muted">reading…</span>}
          <button
            type="button"
            className="text-[10px] px-1.5 py-0.5 rounded border border-cc-border hover:bg-cc-surface text-cc-muted hover:text-cc-text"
            onClick={() => void store.refresh()}
            title="Re-read skills and instructions from disk"
            data-skills-refresh
          >
            refresh
          </button>
        </div>
      </div>

      {store.error && (
        <div className="mb-1.5 text-[11px] text-red-400 bg-red-500/10 border border-red-500/30 rounded px-2 py-1" data-ai-skills-error>
          {store.error}
        </div>
      )}

      {store.skills.length === 0 && store.instructions.length === 0 ? (
        <div className="text-[11px] text-cc-muted" data-skills-empty>
          No skills or instruction files yet. Create <code>.closecode/skills/&lt;name&gt;/SKILL.md</code> or{" "}
          <code>.closecode/instructions/*.md</code> in the workspace (or in the app's user folder) — they are read from
          disk, not configured here.
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {store.instructions.length > 0 && (
            <div>
              <div className="text-[10px] font-semibold text-cc-muted uppercase tracking-wide mb-0.5">
                Instructions sent with every prompt ({store.instructions.length})
              </div>
              {store.instructions.map((f) => (
                <div key={f.name} className="flex items-center gap-1.5 text-[11px]" title={f.preview} data-instruction={f.name}>
                  <span className="text-cc-text truncate">📋 {f.name}</span>
                  <span className={`text-[9px] shrink-0 ${f.scope === "project" ? "text-cc-accent" : "text-cc-muted"}`} data-instruction-scope={f.name}>
                    {f.scope}
                  </span>
                  <span className="text-[9px] text-cc-muted shrink-0 ml-auto">{f.chars} chars</span>
                </div>
              ))}
            </div>
          )}
          {store.skills.length > 0 && (
            <div>
              <div className="text-[10px] font-semibold text-cc-muted uppercase tracking-wide mb-0.5">Skills ({store.skills.length})</div>
              {store.skills.map((s) => (
                <SkillRow key={`${s.source}:${s.name}`} skill={s} workspace={workspaceRoot} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
