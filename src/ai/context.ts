// Close Code — AI context builder (Phase 11, extended in Phase 26)
// The ONLY thing ever sent to an external service is what this function
// assembles, and it is fully user-controlled. Everything is bounded:
//   - selected code        (Monaco selection)
//   - current file         (capped)
//   - diagnostics          (current file markers)
//   - open files           (other tabs, capped total)
//   - user-approved text   (custom note)
// The UI shows exact per-part character counts so privacy is always visible.
//
// Phase 26 added `buildEditorSnapshot` below, which reads the same three sources
// (Monaco, the editor store, the diagnostics store) and hands them to the main
// process for an agent run. `buildAiContext` now consumes that one reader
// instead of reaching for the stores a second time, so the two paths cannot
// disagree about what the editor currently holds.

import type { AiContextBundle, AiContextPart } from "./types";
import type { EditorSnapshot } from "../types/electron";
import { useEditorStore, getCachedContent } from "../stores/editorStore";
import { useDiagnosticsStore } from "../language/diagnostics";

// `EditorSnapshot` is declared once, in `src/types/electron.d.ts`, and imported
// here rather than re-declared. The shape crosses the preload bridge, so a second
// copy could drift from the one the main process clamps against — and the drift
// would only surface as context the user cannot account for.

export interface AiContextSelection {
  selectedCode: boolean;
  currentFile: boolean;
  diagnostics: boolean;
  moreFiles: boolean;
  customText: string;
}

export const DEFAULT_CONTEXT_SELECTION: AiContextSelection = {
  selectedCode: true,
  currentFile: true,
  diagnostics: false,
  moreFiles: false,
  customText: "",
};

const CURRENT_FILE_CAP = 60_000; // chars of the active file sent to AI
const MORE_FILES_TOTAL_CAP = 60_000; // total chars across other open tabs
const MORE_FILES_MAX = 10;
const CUSTOM_TEXT_CAP = 10_000;

/** Phase 26. Caps applied here so a huge editor state is never even sent. */
const SNAPSHOT_MAX_ACTIVE = 200_000;
const SNAPSHOT_MAX_SELECTION = 40_000;
const SNAPSHOT_MAX_OPEN = 40;
const SNAPSHOT_MAX_DIAGNOSTICS = 500;

function getSelectedText(): { text: string; present: boolean; startLine: number; endLine: number } {
  try {
    const w = window as unknown as Record<string, unknown>;
    const ed = w.__monacoEditor as
      | {
          getModel?: () => { getValueInRange?: (range: unknown) => string } | null;
          getSelection?: () => {
            startLineNumber: number;
            startColumn: number;
            endLineNumber: number;
            endColumn: number;
          } | null;
        }
      | undefined;
    if (!ed?.getModel || !ed?.getSelection) return { text: "", present: false, startLine: 0, endLine: 0 };
    const sel = ed.getSelection();
    const model = ed.getModel();
    if (!sel || !model?.getValueInRange) return { text: "", present: false, startLine: 0, endLine: 0 };
    if (sel.startLineNumber === sel.endLineNumber && sel.startColumn === sel.endColumn) {
      return { text: "", present: false, startLine: 0, endLine: 0 };
    }
    const text = model.getValueInRange(sel);
    // Phase 26. The line numbers travel with the text now, so the agent path can
    // say *where* a selection is instead of only quoting it. Read once, here,
    // rather than by a second `getSelection` call that could in principle observe
    // a different selection than the one the text came from.
    return { text, present: text.trim().length > 0, startLine: sel.startLineNumber, endLine: sel.endLineNumber };
  } catch {
    return { text: "", present: false, startLine: 0, endLine: 0 };
  }
}

function isRealFile(p: string): boolean {
  return Boolean(p) && !p.startsWith("untitled:");
}

/**
 * Phase 26. Read the editor once, for anyone who needs to know what is on screen.
 *
 * The main process cannot read any of this: the Monaco selection lives in a
 * renderer-only object graph, and the diagnostics come from a TypeScript worker
 * that also only exists here. So it is pushed rather than pulled, and this is
 * the one function that decides what "the editor" means.
 *
 * `activeContent` is the live buffer rather than the file on disk, and
 * `activeDirty` travels with it so the engine can label it honestly. An agent
 * reasoning about saved code while the user is looking at unsaved code is
 * answering a question nobody asked. Other tabs are sent as *paths* only — their
 * bodies are read in the main process, which is why an unsaved background tab can
 * be slightly stale.
 *
 * Capped here rather than only in the main process: a 200 KB buffer crossing
 * `contextIsolation` on every preview is a cost the user should not pay. The
 * main process clamps again, because the payload is untrusted either way.
 */
export function buildEditorSnapshot(): EditorSnapshot {
  const state = useEditorStore.getState();
  const activePath = state.activePath;
  const sel = getSelectedText();
  const diags = useDiagnosticsStore.getState().diagnostics;
  const real = activePath && isRealFile(activePath) ? activePath : null;
  const activeContent = real ? getCachedContent(real) : "";

  return {
    activePath: real,
    activeContent:
      activeContent.length > SNAPSHOT_MAX_ACTIVE ? activeContent.slice(0, SNAPSHOT_MAX_ACTIVE) : activeContent,
    activeDirty: real ? state.tabs.some((t) => t.path === real && t.dirty) : false,
    selection: sel.present
      ? {
          text: sel.text.length > SNAPSHOT_MAX_SELECTION ? sel.text.slice(0, SNAPSHOT_MAX_SELECTION) : sel.text,
          startLine: sel.startLine || 1,
          endLine: sel.endLine || 1,
        }
      : null,
    openPaths: state.tabs
      .map((t) => t.path)
      .filter(isRealFile)
      .slice(0, SNAPSHOT_MAX_OPEN),
    diagnostics: diags.slice(0, SNAPSHOT_MAX_DIAGNOSTICS).map((d) => ({
      file: d.file,
      line: d.line,
      severity: d.severity,
      message: d.message,
    })),
  };
}

function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n… [truncated by CloseCode]";
}

export function buildAiContext(sel: AiContextSelection): AiContextBundle {
  const parts: AiContextPart[] = [];
  // Phase 26. One read of the editor, shared with the agent path. Reading the
  // stores a second time here would mean two functions disagreeing about which
  // file is active and what the selection is, which is a class of bug the
  // context panel would then display as fact.
  const snap = buildEditorSnapshot();
  const activePath = snap.activePath;
  const fileLabel = activePath ? activePath.split(/[\\/]/).pop() ?? activePath : "active file";

  if (sel.selectedCode && snap.selection) {
    const text = snap.selection.text;
    parts.push({
      label: "Selected code",
      text: `Selected code in ${fileLabel}:\n\`\`\`\n${cap(text, CURRENT_FILE_CAP)}\n\`\`\``,
    });
  }

  if (sel.currentFile && activePath && snap.activeContent.length > 0) {
    parts.push({
      label: `Current file: ${activePath}`,
      text: `File: ${activePath}\n\`\`\`\n${cap(snap.activeContent, CURRENT_FILE_CAP)}\n\`\`\``,
    });
  }

  if (sel.diagnostics && activePath) {
    const diags = snap.diagnostics.filter((d) => d.file === activePath).slice(0, 50);
    if (diags.length > 0) {
      const lines = diags.map((d) => `[${d.severity}] line ${d.line}: ${d.message}`).join("\n");
      parts.push({ label: "Diagnostics", text: `Diagnostics for ${fileLabel}:\n${lines}` });
    }
  }

  if (sel.moreFiles) {
    // Phase 26. Still reading buffers directly, unlike the parts above: this one
    // deliberately includes the *unsaved* contents of background tabs, which the
    // agent path cannot see (it only gets their paths). The trade is the point —
    // the chat panel is user-curated and interactive, the agent path is automatic.
    const otherTabs = useEditorStore
      .getState()
      .tabs.filter((t) => t.path !== activePath && isRealFile(t.path))
      .slice(0, MORE_FILES_MAX);
    let budget = MORE_FILES_TOTAL_CAP;
    const chunks: string[] = [];
    for (const tab of otherTabs) {
      const content = getCachedContent(tab.path);
      if (!content) continue;
      const slice = cap(content, Math.min(CURRENT_FILE_CAP, budget));
      budget -= slice.length;
      chunks.push(`File: ${tab.path}\n\`\`\`\n${slice}\n\`\`\``);
      if (budget <= 0) break;
    }
    if (chunks.length > 0) {
      parts.push({ label: "Other open files", text: chunks.join("\n\n") });
    }
  }

  if (sel.customText.trim()) {
    parts.push({ label: "User note", text: cap(sel.customText.trim(), CUSTOM_TEXT_CAP) });
  }

  const totalChars = parts.reduce((acc, p) => acc + p.text.length, 0);
  return { parts, totalChars };
}

/** Serialize the bundle into a single string embedded in the system prompt. */
export function serializeAiContext(bundle: AiContextBundle): string {
  if (bundle.parts.length === 0) return "";
  const header = "Below is editor context provided by the user (CloseCode).\n";
  const body = bundle.parts.map((p) => `### ${p.label}\n${p.text}`).join("\n\n");
  return `${header}\n${body}`;
}