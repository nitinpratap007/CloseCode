import { getCommandByShortcut } from "./registry";

function isMac(): boolean {
  return navigator.platform.includes("Mac");
}

// Build shortcut string from KeyboardEvent, e.g. "Ctrl+Shift+P", "Ctrl+`", "Ctrl+K Ctrl+O" chords not handled here
export function eventToShortcut(e: KeyboardEvent): string | null {
  // Ignore pure modifier presses
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return null;

  const parts: string[] = [];
  if (e.ctrlKey || (isMac() && e.metaKey)) parts.push("Ctrl");
  if (e.metaKey && !isMac()) parts.push("Meta"); // keep explicit for non-mac
  if (isMac() && e.metaKey && !e.ctrlKey) {
    // On Mac, Cmd is Meta; we normalize Cmd to Ctrl for registry lookup
    // But eventToShortcut will produce "Ctrl+..." for Cmd+...
    // So we already pushed Ctrl above
  }
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");

  // Normalize key: single char upper, others as-is
  let key = e.key;
  if (key.length === 1) key = key.toUpperCase();
  else if (key === "`") key = "`";
  else if (key === ",") key = ",";
  else if (key === " ") key = "Space";
  // For letters, we already uppercased

  parts.push(key);
  return parts.join("+");
}

function isInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  // Monaco's textarea is inside .monaco-editor
  if (target.closest(".monaco-editor")) return false; // let Monaco handle, but we still want Ctrl+S etc even when editor focused
  return false;
}

export interface ShortcutManagerOptions {
  onPaletteToggle: () => void;
}

export function createShortcutManager(opts: ShortcutManagerOptions): () => void {
  const handler = (e: KeyboardEvent): void => {
    // Palette toggles: Ctrl+Shift+P, F1, Ctrl+P (quick open) — handle before registry
    const isMac_ = isMac();
    const mod = isMac_ ? e.metaKey : e.ctrlKey;
    if (mod && e.shiftKey && e.key.toLowerCase() === "p") {
      e.preventDefault();
      opts.onPaletteToggle();
      return;
    }
    if (e.key === "F1") {
      e.preventDefault();
      opts.onPaletteToggle();
      return;
    }
    // Ctrl+P quick open — also palette (Phase 4 spec: Ctrl+P is palette/quick open)
    if (mod && !e.shiftKey && e.key.toLowerCase() === "p") {
      // Let palette handle quick open as searchable commands filtered by file
      // For now, also palette toggle
      e.preventDefault();
      opts.onPaletteToggle();
      return;
    }

    // For other shortcuts, build string and lookup
    // Don't intercept if user is typing in palette input itself — palette handles its own keys
    const target = e.target as HTMLElement | null;
    if (target instanceof HTMLElement && target.closest("[data-command-palette]")) return;

    // Focus management shortcuts
    // F6 to focus the editor
    if (e.key === "F6") {
      e.preventDefault();
      const editorEl = document.querySelector('[data-monaco-editor]') as HTMLElement;
      editorEl?.focus();
      return;
    }
    // Ctrl+` to focus terminal
    if (e.ctrlKey && e.key === "`") {
      e.preventDefault();
      const terminalEl = document.querySelector('[data-bottom-panel="true"]') as HTMLElement;
      terminalEl?.focus();
      return;
    }

    const shortcut = eventToShortcut(e);
    if (!shortcut) return;

    // Avoid hijacking when typing in non-editor inputs, except for global commands like Save
    // We allow Ctrl+S/W etc even in inputs? But Ctrl+S in input should still save.
    // For single char without mod, don't intercept if in input
    const hasMod = e.ctrlKey || e.metaKey || e.altKey;
    if (!hasMod && isInputTarget(target)) return;

    const cmd = getCommandByShortcut(shortcut);
    if (!cmd) return;

    // Don't double-handle Monaco's own Find/Replace when editor is focused? We want our registry to trigger Monaco action, which is fine.
    // But if Monaco already handles Ctrl+F, preventing default twice is okay.

    e.preventDefault();
    e.stopPropagation();
    try {
      const r = cmd.execute();
      if (r instanceof Promise) void r.catch((err) => console.error(`Shortcut ${shortcut} → ${cmd.id} failed:`, err));
    } catch (err) {
      console.error(`Shortcut ${shortcut} → ${cmd.id} failed:`, err);
    }
  };

  window.addEventListener("keydown", handler, { capture: true });
  return () => window.removeEventListener("keydown", handler, { capture: true } as AddEventListenerOptions);
}

// Expose for tests
export function __eventToShortcutForTest(e: Partial<KeyboardEvent>): string | null {
  return eventToShortcut(e as KeyboardEvent);
}
