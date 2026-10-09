import fs from "fs";
import path from "path";

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface ListOptions {
  showHiddenFiles: boolean;
  fileExcludes: string[];
}

export const DEFAULT_EXCLUDES = [
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  "coverage",
  ".cache",
  ".parcel-cache",
  ".turbo",
  ".next",
  ".nuxt",
  ".idea",
  "__pycache__",
  ".pyc",
  ".venv",
  "venv",
  "site-packages",
  "target",
  "Pods",
  "vendor",
  "bin",
  "obj",
  ".DS_Store",
];

const ILLEGAL_NAME = /[<>:"/\\|?*\u0000-\u001f]/;
const RESERVED_NAMES = new Set([".", "..", "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"]);

const isWindows = process.platform === "win32";

export function normalizePath(p: string): string {
  const resolved = path.resolve(p);
  return isWindows ? resolved.toLowerCase() : resolved;
}

export function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(normalizePath(parent), normalizePath(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function isValidEntryName(name: string): boolean {
  if (!name || name.length === 0) return false;
  if (name.trim() !== name) return false;
  if (name.endsWith(".") || name.endsWith(" ") || name.endsWith("\t")) return false;
  if (ILLEGAL_NAME.test(name)) return false;
  if (RESERVED_NAMES.has(name.toUpperCase())) return false;
  return true;
}

function isExcluded(name: string, opts: ListOptions): boolean {
  if (!opts.showHiddenFiles && name.startsWith(".")) return true;
  const excludeSet = new Set<string>([
    ...DEFAULT_EXCLUDES,
    ...(opts.fileExcludes ?? []).map((e) => e.trim()).filter((e) => e.length > 0),
  ]);
  return excludeSet.has(isWindows ? name.toLowerCase() : name);
}

export class WorkspaceService {
  private root: string | null = null;

  setRoot(root: string): void {
    const resolved = path.resolve(root);
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      throw new Error(`Not a directory: ${resolved}`);
    }
    this.root = resolved;
  }

  getRoot(): string | null {
    return this.root;
  }

  private assertInsideRoot(p: string): string {
    if (!this.root) {
      throw new Error("No workspace folder is open.");
    }
    const resolved = path.resolve(p);
    if (!isPathInside(this.root, resolved)) {
      throw new Error(`Path is outside the workspace folder: ${resolved}`);
    }
    return resolved;
  }

  listDir(dirPath: string, opts: ListOptions): DirEntry[] {
    const resolved = this.assertInsideRoot(dirPath);
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(resolved, { withFileTypes: true });
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }

    const entries: DirEntry[] = [];
    for (const d of dirents) {
      if (d.name === ".git" || d.name === "node_modules") continue;
      if (isExcluded(d.name, opts)) continue;
      entries.push({
        name: d.name,
        path: path.join(resolved, d.name),
        isDirectory: d.isDirectory(),
      });
    }

    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      const an = a.name.toLowerCase();
      const bn = b.name.toLowerCase();
      if (an === bn) return a.name < b.name ? -1 : 1;
      return an < bn ? -1 : 1;
    });

    return entries;
  }

  createFile(dirPath: string, name: string): string {
    if (!isValidEntryName(name)) {
      throw new Error(`Invalid file name: "${name}"`);
    }
    const resolved = this.assertInsideRoot(dirPath);
    const target = path.join(resolved, name);
    this.assertInsideRoot(target);
    if (fs.existsSync(target)) {
      throw new Error(`"${name}" already exists`);
    }
    fs.writeFileSync(target, "", "utf-8");
    return target;
  }

  createFolder(dirPath: string, name: string): string {
    if (!isValidEntryName(name)) {
      throw new Error(`Invalid folder name: "${name}"`);
    }
    const resolved = this.assertInsideRoot(dirPath);
    const target = path.join(resolved, name);
    this.assertInsideRoot(target);
    if (fs.existsSync(target)) {
      throw new Error(`"${name}" already exists`);
    }
    fs.mkdirSync(target, { recursive: false });
    return target;
  }

  renameItem(oldPath: string, newName: string): string {
    if (!isValidEntryName(newName)) {
      throw new Error(`Invalid name: "${newName}"`);
    }
    const resolved = this.assertInsideRoot(oldPath);
    const parent = path.dirname(resolved);
    const target = path.join(parent, newName);
    this.assertInsideRoot(target);
    if (resolutionEquals(resolved, target)) return target;
    if (fs.existsSync(target)) {
      throw new Error(`"${newName}" already exists`);
    }
    fs.renameSync(resolved, target);
    return target;
  }

  deleteItem(p: string): void {
    const resolved = this.assertInsideRoot(p);
    if (this.root && resolutionEquals(resolved, this.root)) {
      throw new Error("The workspace root itself cannot be deleted.");
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }

  async moveItem(src: string, destDir: string): Promise<string> {
    const resolvedSrc = this.assertInsideRoot(src);
    const resolvedDest = this.assertInsideRoot(destDir);
    const target = path.join(resolvedDest, path.basename(resolvedSrc));
    this.assertInsideRoot(target);

    if (resolutionEquals(resolvedSrc, target)) return target;
    if (isPathInside(resolvedSrc, resolvedDest)) {
      throw new Error("Cannot move a folder into itself.");
    }
    if (fs.existsSync(target)) {
      throw new Error(`"${path.basename(resolvedSrc)}" already exists in destination.`);
    }

    try {
      fs.renameSync(resolvedSrc, target);
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === "EXDEV" || nodeErr.code === "EPERM" || nodeErr.code === "EACCES") {
        await copyRecursive(resolvedSrc, target);
        fs.rmSync(resolvedSrc, { recursive: true, force: true });
      } else {
        throw err;
      }
    }
    return target;
  }

  readTextFile(p: string): { content: string; size: number; binary: boolean } {
    const resolved = this.assertInsideRoot(p);
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      throw new Error("Cannot open a directory as text.");
    }
    const buf = fs.readFileSync(resolved);
    const text = buf.toString("utf-8");
    let binary = text.includes("\u0000");
    if (!binary) {
      const lossy = countLossyChars(text);
      binary = buf.length > 0 && lossy / buf.length > 0.01;
    }
    return { content: binary ? "" : text, size: buf.length, binary };
  }
}

function resolutionEquals(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

async function copyRecursive(src: string, dest: string): Promise<void> {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const dirent of fs.readdirSync(src, { withFileTypes: true })) {
      await copyRecursive(path.join(src, dirent.name), path.join(dest, dirent.name));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

function countLossyChars(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0xfffd) count++;
  }
  return count;
}