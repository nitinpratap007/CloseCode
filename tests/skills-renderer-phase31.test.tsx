// @vitest-environment jsdom
//
// Phase 31 — the renderer half of skills & instructions.
//
// The main process reads the files; `skillsStore` is the projection, and
// `SkillsSection` renders it: instruction files with their scopes, skills with
// their allowed-tools chips, and a preview fetched on demand. Exercised
// against a fake `window.closeCode`; the parsing, discovery and restriction
// semantics live in the main-process suites.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";
vi.mock("../src/monaco", () => ({
  default: {
    editor: { getModel: () => null, setTheme: () => {}, getTheme: () => "cc-dark" },
    Uri: { file: () => ({}) },
  },
}));
vi.mock("../src/language/diagnostics", () => ({
  useDiagnosticsStore: {
    getState: () => ({ diagnostics: [] }),
    setState: () => {},
    subscribe: () => () => {},
  },
}));
import { useSkillsStore, type SkillsStoreState } from "../src/stores/skillsStore";
import { useWorkspaceStore } from "../src/stores/workspaceStore";
import SkillsSection from "../src/components/ai/SkillsSection";
import type { InstructionFileInfo, SkillInfo } from "../src/types/electron";

let seq = 0;
function skill(over: Partial<SkillInfo> = {}): SkillInfo {
  seq += 1;
  return {
    name: `skill-${seq}`,
    description: `Skill ${seq} does things.`,
    source: "project",
    allowedTools: null,
    absolutePath: `C:\\proj\\.closecode\\skills\\skill-${seq}\\SKILL.md`,
    chars: 100,
    ...over,
  };
}

function instruction(over: Partial<InstructionFileInfo> = {}): InstructionFileInfo {
  seq += 1;
  return {
    name: `project:file-${seq}.md`,
    scope: "project",
    absolutePath: `C:\\proj\\.closecode\\instructions\\file-${seq}.md`,
    chars: 50,
    preview: "Preview text",
    ...over,
  };
}

interface SkillsApi {
  skillsList: ReturnType<typeof vi.fn>;
  skillsRead: ReturnType<typeof vi.fn>;
  instructionsList: ReturnType<typeof vi.fn>;
}

let api: SkillsApi;

beforeEach(() => {
  api = {
    skillsList: vi.fn(async () => ({ ok: true, skills: [] })),
    skillsRead: vi.fn(async () => ({ ok: true, skill: null })),
    instructionsList: vi.fn(async () => ({ ok: true, files: [] })),
  };
  (window as unknown as { closeCode: unknown }).closeCode = api;
  useWorkspaceStore.setState({ root: "C:\\proj" });
  useSkillsStore.setState({
    skills: [],
    instructions: [],
    workspace: null,
    error: null,
    busy: false,
  } as Partial<SkillsStoreState>);
});

afterEach(() => {
  cleanup();
});

describe("skillsStore — projection of the on-disk truth", () => {
  it("refresh reads skills and instructions for the current workspace", async () => {
    await act(async () => {
      await useSkillsStore.getState().setWorkspace("C:\\proj");
    });
    expect(api.skillsList).toHaveBeenCalledWith("C:\\proj");
    expect(api.instructionsList).toHaveBeenCalledWith("C:\\proj");
  });

  it("a failed read surfaces the error, verbatim", async () => {
    api.skillsList.mockResolvedValue({ ok: false, error: "disk went away" });
    await act(async () => {
      await useSkillsStore.getState().setWorkspace("C:\\proj");
    });
    expect(useSkillsStore.getState().error).toBe("disk went away");
  });

  it("changing workspace clears the previous one's rows", async () => {
    api.skillsList.mockResolvedValue({ ok: true, skills: [skill({ name: "alpha" })] });
    await act(async () => {
      await useSkillsStore.getState().setWorkspace("C:\\proj");
    });
    expect(useSkillsStore.getState().skills.map((s) => s.name)).toEqual(["alpha"]);
    api.skillsList.mockResolvedValue({ ok: true, skills: [] });
    await act(async () => {
      await useSkillsStore.getState().setWorkspace("C:\\other");
    });
    expect(useSkillsStore.getState().skills).toEqual([]);
  });
});

describe("SkillsSection — what the user sees", () => {
  it("renders the empty state with the file locations named", async () => {
    let view: ReturnType<typeof render> | null = null;
    await act(async () => {
      view = render(<SkillsSection />);
    });
    const empty = view!.container.querySelector("[data-skills-empty]");
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain(".closecode/skills/");
    expect(empty?.textContent).toContain(".closecode/instructions/");
  });

  it("renders instructions with scope chips and skills with allowed-tools chips", async () => {
    api.instructionsList.mockResolvedValue({
      ok: true,
      files: [instruction({ name: "project:security.md", scope: "project" }), instruction({ name: "user:coding-style.md", scope: "user" })],
    });
    api.skillsList.mockResolvedValue({
      ok: true,
      skills: [skill({ name: "review-diff", allowedTools: ["git_diff", "read_file"] }), skill({ name: "freeform", source: "user" })],
    });
    let view: ReturnType<typeof render> | null = null;
    await act(async () => {
      view = render(<SkillsSection />);
    });
    const root = view!.container.querySelector("[data-ai-skills]") as HTMLElement;
    expect(root.querySelector("[data-instruction='project:security.md']")).not.toBeNull();
    expect(root.querySelector("[data-instruction-scope='user:coding-style.md']")?.textContent).toBe("user");
    expect(root.querySelector("[data-skill='review-diff']")).not.toBeNull();
    expect(root.querySelector("[data-skill-tools='review-diff']")?.textContent).toContain("2 tools");
    expect(root.querySelector("[data-skill='freeform']")).not.toBeNull();
    expect(root.querySelector("[data-skill-tools='freeform']")).toBeNull();
    expect(root.querySelector("[data-skill-scope='freeform']")?.textContent).toBe("user");
  });

  it("preview fetches the body on demand and shows it", async () => {
    api.skillsList.mockResolvedValue({ ok: true, skills: [skill({ name: "review-diff" })] });
    api.skillsRead.mockResolvedValue({
      ok: true,
      skill: { ...skill({ name: "review-diff" }), body: "First read the diff carefully." },
    });
    let view: ReturnType<typeof render> | null = null;
    await act(async () => {
      view = render(<SkillsSection />);
    });
    const root = view!.container.querySelector("[data-ai-skills]") as HTMLElement;
    await act(async () => {
      fireEvent.click(root.querySelector("[data-skill-preview='review-diff']") as HTMLElement);
    });
    expect(api.skillsRead).toHaveBeenCalledWith("C:\\proj", "review-diff");
    expect(root.querySelector("[data-skill-body='review-diff']")?.textContent).toContain("First read the diff carefully.");
  });

  it("refresh re-reads from disk", async () => {
    let view: ReturnType<typeof render> | null = null;
    await act(async () => {
      view = render(<SkillsSection />);
    });
    const before = api.skillsList.mock.calls.length;
    const root = view!.container.querySelector("[data-ai-skills]") as HTMLElement;
    await act(async () => {
      fireEvent.click(root.querySelector("[data-skills-refresh]") as HTMLElement);
    });
    expect(api.skillsList.mock.calls.length).toBeGreaterThan(before);
  });
});
