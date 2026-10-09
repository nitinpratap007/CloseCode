import { app } from "electron";
import fs from "fs";
import path from "path";

export interface RecentProject {
  path: string;
  name: string;
  lastOpened: number;
}

const MAX_RECENT = 10;

function getRecentPath(): string {
  return path.join(app.getPath("userData"), "recent.json");
}

export function loadRecent(): RecentProject[] {
  try {
    const p = getRecentPath();
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, "utf-8")) as RecentProject[];
    }
  } catch {
    return [];
  }
  return [];
}

export function pushRecent(projectPath: string): void {
  const recent = loadRecent().filter(
    (r) => r.path.toLowerCase() !== projectPath.toLowerCase()
  );
  recent.unshift({
    path: projectPath,
    name: path.basename(projectPath),
    lastOpened: Date.now(),
  });
  fs.writeFileSync(
    getRecentPath(),
    JSON.stringify(recent.slice(0, MAX_RECENT), null, 2),
    "utf-8"
  );
}

export function removeRecent(projectPath: string): void {
  const recent = loadRecent().filter(
    (r) => r.path.toLowerCase() !== projectPath.toLowerCase()
  );
  fs.writeFileSync(
    getRecentPath(),
    JSON.stringify(recent, null, 2),
    "utf-8"
  );
}

export function clearRecent(): void {
  fs.writeFileSync(getRecentPath(), "[]", "utf-8");
}