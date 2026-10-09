import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  WorkspaceService,
  isPathInside,
  isValidEntryName,
  DEFAULT_EXCLUDES,
} from "../electron/services/workspace";

const OPTIONS = { showHiddenFiles: true, fileExcludes: [] };

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-ws-test-"));
}

let service: WorkspaceService;
let root: string;

beforeEach(() => {
  root = makeRoot();
  service = new WorkspaceService();
  service.setRoot(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("isValidEntryName", () => {
  it("accepts normal names", () => {
    expect(isValidEntryName("file.ts")).toBe(true);
    expect(isValidEntryName("folder name")).toBe(true);
    expect(isValidEntryName("Čośe-42")).toBe(true);
  });

  it("rejects traversal and unsafe names", () => {
    expect(isValidEntryName("..")).toBe(false);
    expect(isValidEntryName(".")).toBe(false);
    expect(isValidEntryName("a/b")).toBe(false);
    expect(isValidEntryName("a\\b")).toBe(false);
    expect(isValidEntryName("a:")).toBe(false);
    expect(isValidEntryName("a*")).toBe(false);
    expect(isValidEntryName("")).toBe(false);
    expect(isValidEntryName("  a  ")).toBe(false);
    expect(isValidEntryName("trailing.")).toBe(false);
    expect(isValidEntryName("a\u0000b")).toBe(false);
  });
});

describe("isPathInside", () => {
  it("accepts nested paths and rejects siblings", () => {
    expect(isPathInside("/a/b", "/a/b/c/d")).toBe(true);
    expect(isPathInside("/a/b", "/a/b")).toBe(true);
    expect(isPathInside("/a/b", "/a/c")).toBe(false);
    expect(isPathInside("/a/b", "/b/test")).toBe(false);
  });
});

describe("listDir", () => {
  it("excludes default generated folders and sorts directories first", () => {
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.mkdirSync(path.join(root, "dist"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "z.txt"), "");
    fs.writeFileSync(path.join(root, "a.js"), "");

    const entries = service.listDir(root, OPTIONS);
    const names = entries.map((e) => e.name);
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain(".git");
    expect(names).not.toContain("dist");
    expect(names).toEqual(["src", "a.js", "z.txt"]);
  });

  it("respects configurable excludes", () => {
    fs.mkdirSync(path.join(root, "dist"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    const entries = service.listDir(root, {
      showHiddenFiles: true,
      fileExcludes: ["dist"],
    });
    expect(entries.map((e) => e.name)).toEqual(["src"]);
  });

  it("hides dotfiles when showHiddenFiles is false", () => {
    fs.writeFileSync(path.join(root, ".env"), "");
    fs.writeFileSync(path.join(root, "readme.md"), "");
    const entries = service.listDir(root, { showHiddenFiles: false, fileExcludes: [] });
    expect(entries.map((e) => e.name)).toEqual(["readme.md"]);
  });

  it("requires the path to be inside the workspace root", () => {
    expect(() => service.listDir(os.tmpdir(), OPTIONS)).toThrow(/outside/i);
  });
});

describe("CRUD operations", () => {
  it("creates, renames, moves and deletes items", async () => {
    const file = service.createFile(root, "hello.ts");
    expect(fs.existsSync(file)).toBe(true);

    const renamed = service.renameItem(file, "hello2.ts");
    expect(renamed.endsWith("hello2.ts")).toBe(true);
    expect(fs.existsSync(renamed)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);

    fs.mkdirSync(path.join(root, "sub"), { recursive: true });
    const moved = await service.moveItem(renamed, path.join(root, "sub"));
    expect(moved).toBe(path.join(root, "sub", "hello2.ts"));
    expect(fs.existsSync(moved)).toBe(true);
    expect(fs.existsSync(renamed)).toBe(false);

    const folder = service.createFolder(root, "assets");
    fs.writeFileSync(path.join(folder, "img.png"), "x");
    service.deleteItem(folder);
    expect(fs.existsSync(folder)).toBe(false);
  });

  it("rejects rename to an existing name", () => {
    service.createFile(root, "a.ts");
    service.createFile(root, "b.ts");
    expect(() => service.renameItem(path.join(root, "a.ts"), "b.ts")).toThrow(/exists/i);
  });

  it("rejects creating with invalid names", () => {
    expect(() => service.createFile(root, "../escape")).toThrow(/invalid/i);
    expect(() => service.createFolder(root, "a/b")).toThrow(/invalid/i);
  });

  it("rejects deleting the workspace root", () => {
    expect(() => service.deleteItem(root)).toThrow(/root/i);
  });

  it("rejects paths outside the root", () => {
    const outside = path.join(os.tmpdir(), "cc-outside-test-" + Date.now());
    fs.mkdirSync(outside, { recursive: true });
    try {
      expect(() => service.deleteItem(outside)).toThrow(/outside/i);
      expect(() => service.readTextFile(outside)).toThrow(/outside/i);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects moving a folder into itself", async () => {
    fs.mkdirSync(path.join(root, "a"), { recursive: true });
    await expect(service.moveItem(path.join(root, "a"), path.join(root, "a", "b"))).rejects.toThrow(/into itself/i);
  });
});

describe("readTextFile", () => {
  it("reads utf-8 text and flags binary", () => {
    const p = path.join(root, "note.md");
    fs.writeFileSync(p, "# Hello\nworld");
    const { content, size, binary } = service.readTextFile(p);
    expect(content).toBe("# Hello\nworld");
    expect(size).toBe("# Hello\nworld".length);
    expect(binary).toBe(false);

    const bin = path.join(root, "img.bin");
    fs.writeFileSync(bin, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00]));
    const binResult = service.readTextFile(bin);
    expect(binResult.binary).toBe(true);
  });
});

describe("workspace setRoot", () => {
  it("rejects non-directory roots", () => {
    const f = path.join(root, "f.txt");
    fs.writeFileSync(f, "");
    expect(() => service.setRoot(f)).toThrow(/not a directory/i);
  });

  it("enforces root for every operation (no root set)", () => {
    const bare = new WorkspaceService();
    expect(() => bare.listDir(root, OPTIONS)).toThrow(/no workspace/i);
  });
});

describe("default excludes contract", () => {
  it("contains the required folders", () => {
    for (const name of ["node_modules", ".git", "dist", "build", "coverage", ".cache"]) {
      expect(DEFAULT_EXCLUDES).toContain(name);
    }
  });
});