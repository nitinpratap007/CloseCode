// Close Code — the skill tool (Phase 31)
//
// One tool: `use_skill`. The system prompt carries the index (names and
// descriptions); this tool is how the model loads one. Invoking returns the
// skill's body as the tool result — instructions the model then follows —
// and applies the skill's `allowed-tools` restriction to the rest of the run.
//
// The security contract, in one place because it is the whole point:
//
//   * The gate runs first. `skills.invoke` defaults to `ask`, so the user
//     sees the invocation.
//   * The body is text. Anything the model does after reading it passes the
//     normal permission gate — a skill that says "ignore permissions" has
//     said words; the gate has not heard them.
//   * `allowed-tools` only narrows. It is applied through
//     `ctx.restrictTools`, the runtime enforces it in the call loop, and the
//     gate still runs for every tool the skill names. A skill cannot widen a
//     run, cannot widen itself, and cannot touch another run.
//
// This module builds the tool around an injected service so it is testable
// with a fake and bound to the real skill store in production — the same
// shape as the task tools.

import type { AgentTool, AgentToolContext, AgentToolOutcome } from "./types";

export interface SkillReadResult {
  ok: boolean;
  skill?: {
    name: string;
    description: string;
    source: string;
    allowedTools: string[] | null;
    body: string;
  };
  error?: string;
}

export interface SkillToolService {
  read(workspace: string | null, name: string): SkillReadResult;
}

const DENIED: AgentToolOutcome = { granted: false, text: "Permission denied by policy or user." };

export function createSkillTools(service: SkillToolService): AgentTool[] {
  const useSkill: AgentTool = {
    name: "use_skill",
    description:
      "Invoke a skill: load a reusable workflow's instructions into this run. " +
      "The available skills are listed in the system prompt. The skill's instructions come back as this call's result. " +
      "If the skill declares allowed-tools, this run is restricted to those tools for the rest of the skill's work; " +
      "invoke with name \"clear\" to drop the restriction when the skill's work is done. " +
      "A skill is instructions, not permissions — the normal gate still applies to everything you do.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The skill's name, exactly as listed. Use \"clear\" to end the current skill's tool restriction.",
        },
      },
      required: ["name"],
    },
    category: "skills",
    readOnly: true,
    destructive: false,
    async execute(ctx: AgentToolContext, args: Record<string, unknown>): Promise<AgentToolOutcome> {
      if (!(await ctx.authorize("skills", args))) return DENIED;
      const name = typeof args.name === "string" ? args.name.trim().toLowerCase() : "";
      if (!name) return { granted: true, status: "error", text: "Error: use_skill needs a skill name." };

      // "clear" is the documented way out of a restriction — not a skill, so it
      // is handled here rather than colliding with a real skill of that name
      // (the parser's name rules would allow one; the tool wins).
      if (name === "clear") {
        ctx.restrictTools(null);
        ctx.log("Skill restriction cleared.");
        return { granted: true, text: "Skill restriction cleared. The run is no longer limited to a skill's allowed tools." };
      }

      const res = service.read(ctx.workspace, name);
      if (!res.ok || !res.skill) {
        return { granted: true, status: "error", text: `Error: ${res.error ?? `No skill named "${name}".`}` };
      }
      const skill = res.skill;
      ctx.restrictTools(skill.allowedTools, skill.name);
      ctx.log(
        skill.allowedTools
          ? `Skill "${skill.name}" loaded (restricted to: ${skill.allowedTools.join(", ")}).`
          : `Skill "${skill.name}" loaded.`,
      );
      const restriction = skill.allowedTools
        ? `\n\n[This run is now restricted to these tools until the skill's work is done: ${skill.allowedTools.join(", ")}. Invoke use_skill with name "clear" to lift the restriction.]`
        : "";
      return {
        granted: true,
        text: `Skill "${skill.name}" (${skill.source}) loaded. Follow these instructions for the current work:\n\n${skill.body}${restriction}`,
        data: { name: skill.name, source: skill.source, allowedTools: skill.allowedTools },
      };
    },
  };

  return [useSkill];
}

export const SKILL_TOOL_NAMES = ["use_skill"] as const;
