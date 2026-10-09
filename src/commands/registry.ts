//////////////////////////////////////////////////////////
// Close Code — Command Registry
// Single source of truth for all commands.
// UI and keyboard shortcuts derive from this map.
// Never hardcode command buttons independently.
//////////////////////////////////////////////////////////

export type CommandId =
  | "open-file"
  | "open-folder"
  | "close-folder"
  | "save"
  | "save-as"
  | "save-all"
  | "close-tab"
  | "close-all-tabs"
  | "toggle-sidebar"
  | "toggle-explorer"
  | "toggle-terminal"
  | "find"
  | "replace"
  | "search-workspace"
  | "replace-workspace"
  | "go-to-line"
  | "go-to-symbol"
  | "go-to-definition"
  | "find-references"
  | "rename-symbol"
  | "show-hover"
  | "trigger-completion"
  | "trigger-signature-help"
  | "view-problems"
  | "format-document"
  | "git-status"
  | "settings"
  | "theme-picker"
  | "theme-cycle"
  | "debug-continue"
  | "debug-stop"
  | "debug-pause"
  | "debug-step-over"
  | "debug-step-into"
  | "debug-step-out"
  | "toggle-breakpoint"
  | "debug-console"
  | "debug-view"
  | "ai-view"
  | "extensions-view";

export type CommandShortcut = string;

export interface CommandMeta {
  id: CommandId;
  title: string;
  shortcut: string;
  description?: string;
  execute: () => unknown;
}

const registry = new Map<CommandId, CommandMeta>();
const shortcutIndex = new Map<string, CommandId>();

function normalizeShortcut(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "");
}

export function registerCommand(meta: CommandMeta): void {
  if (registry.has(meta.id)) {
    throw new Error(`Command already registered: ${meta.id}`);
  }
  const norm = normalizeShortcut(meta.shortcut);
  if (norm && shortcutIndex.has(norm)) {
    const conflict = shortcutIndex.get(norm)!;
    throw new Error(`Shortcut conflict: "${meta.shortcut}" already used by "${conflict}" (tried to assign to "${meta.id}")`);
  }
  registry.set(meta.id, meta);
  if (norm) shortcutIndex.set(norm, meta.id);
}

export function unregisterCommand(id: CommandId): void {
  const meta = registry.get(id);
  if (!meta) return;
  registry.delete(id);
  shortcutIndex.delete(normalizeShortcut(meta.shortcut));
}

export function getCommand(id: CommandId): CommandMeta | undefined {
  return registry.get(id);
}

export function getAllCommands(): CommandMeta[] {
  return [...registry.values()];
}

export function getCommandByShortcut(shortcut: string): CommandMeta | undefined {
  const id = shortcutIndex.get(normalizeShortcut(shortcut));
  return id ? registry.get(id) : undefined;
}

export function executeCommand(id: CommandId): Promise<void> {
  const meta = registry.get(id);
  if (!meta) return Promise.reject(new Error(`Unknown command: ${id}`));
  try {
    const r = meta.execute() as unknown;
    return r instanceof Promise ? (r as Promise<unknown>).then(() => undefined) : Promise.resolve();
  } catch (err) {
    console.error(`Command "${id}" failed:`, err);
    return Promise.reject(err);
  }
}

export function clearRegistryForTesting(): void {
  registry.clear();
  shortcutIndex.clear();
}

export function searchCommands(query: string): CommandMeta[] {
  const q = query.trim().toLowerCase();
  if (!q) return getAllCommands();
  return getAllCommands().filter(
    (c) => c.title.toLowerCase().includes(q) || c.id.toLowerCase().includes(q) || c.description?.toLowerCase().includes(q),
  );
}
