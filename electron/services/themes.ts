// Close Code — Custom theme files (Phase 15)
// Discovers theme.json files from userData/themes and workspace
// .closecode/themes, and reads them for the renderer theme engine.

import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

export interface CustomThemeMeta {
  name: string;
  type: "dark" | "light";
  scope: "user" | "workspace";
  file: string;
}

export function getUserThemesDir(): string {
  return path.join(app.getPath("userData"), "themes");
}

export function listCustomThemes(root: string | null): CustomThemeMeta[] {
  const out: CustomThemeMeta[] = [];
  // Workspace entries are listed first so a workspace theme shadows a
  // same-named user theme (the renderer keeps the first definition it sees).
  const dirs: Array<[string, "user" | "workspace"]> = [];
  if (root) dirs.push([path.join(root, ".closecode", "themes"), "workspace"]);
  dirs.push([getUserThemesDir(), "user"]);

  for (const [dir, scope] of dirs) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".json"));
    } catch {
      continue; // dir missing → nothing to discover
    }
    for (const fileName of names) {
      const full = path.join(dir, fileName);
      try {
        const json = JSON.parse(fs.readFileSync(full, "utf-8")) as {
          name?: unknown;
          type?: unknown;
        };
        const name =
          typeof json?.name === "string" && json.name.trim().length > 0
            ? json.name.trim()
            : fileName.replace(/\.json$/i, "");
        out.push({
          name,
          type: json?.type === "light" ? "light" : "dark",
          scope,
          file: full,
        });
      } catch {
        // unreadable/invalid file → skip discovery (picker won't show it)
      }
    }
  }

  out.sort((a, b) =>
    a.name.localeCompare(b.name) || (a.scope === b.scope ? 0 : a.scope === "workspace" ? -1 : 1),
  );
  return out;
}

export function readCustomTheme(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}