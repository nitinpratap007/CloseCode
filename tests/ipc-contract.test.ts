// Close Code — Phase 19 unit tests: IPC Contract Verification.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

describe("IPC Contract", () => {
  const root = path.join(__dirname, "..");
  const preloadPath = path.join(root, "electron", "preload.ts");
  const electronDir = path.join(root, "electron");

  function extractRendererChannels(content: string): string[] {
    const channels: string[] = [];
    const invokeRegex = /ipcRenderer\.invoke\(["'`](\w[\w-:.]*)/g;
    const sendRegex = /ipcRenderer\.send\(["'`](\w[\w-:.]*)/g;
    let m: RegExpExecArray | null;
    while ((m = invokeRegex.exec(content)) !== null) channels.push(m[1]);
    while ((m = sendRegex.exec(content)) !== null) channels.push(m[1]);
    return [...new Set(channels)];
  }

  function extractMainHandlers(dir: string): string[] {
    const handlers: string[] = [];
    // Match ipcMain.handle("channel", ...) and ipcMain.on("channel", ...) across lines
    const handleRegex = /ipcMain\.(?:handle|on)\(\s*["'`](\w[\w-:.]*)/g;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts"));
    for (const f of files) {
      const content = fs.readFileSync(path.join(dir, f), "utf-8");
      let m: RegExpExecArray | null;
      while ((m = handleRegex.exec(content)) !== null) handlers.push(m[1]);
    }
    return [...new Set(handlers)];
  }

  it("preload.ts exists", () => {
    expect(fs.existsSync(preloadPath)).toBe(true);
  });

  it("ipc directory exists", () => {
    expect(fs.existsSync(path.join(electronDir, "ipc"))).toBe(true);
  });

  it("all renderer channels have main handlers", () => {
    const preload = fs.readFileSync(preloadPath, "utf-8");
    const rendererChannels = extractRendererChannels(preload);
    const mainHandlers = extractMainHandlers(path.join(electronDir, "ipc"));
    // Also scan main.ts directly for handlers defined there
    const mainTsHandlers = extractMainHandlers(electronDir);
    const allMainHandlers = [...new Set([...mainHandlers, ...mainTsHandlers])];

    const missing = rendererChannels.filter((ch) => !allMainHandlers.includes(ch));
    expect(missing).toEqual([]);
  });

  it("no duplicate channel names", () => {
    const preload = fs.readFileSync(preloadPath, "utf-8");
    const channels = extractRendererChannels(preload);
    const unique = [...new Set(channels)];
    expect(channels.length).toBe(unique.length);
  });

  it("has at least 40 IPC channels", () => {
    const preload = fs.readFileSync(preloadPath, "utf-8");
    const channels = extractRendererChannels(preload);
    expect(channels.length).toBeGreaterThanOrEqual(40);
  });

  it("get-app-info channel exists in preload", () => {
    const preload = fs.readFileSync(preloadPath, "utf-8");
    const channels = extractRendererChannels(preload);
    expect(channels).toContain("get-app-info");
  });

  it("get-app-info handler exists in main.ts", () => {
    const mainTs = fs.readFileSync(path.join(electronDir, "main.ts"), "utf-8");
    expect(mainTs).toContain("get-app-info");
  });
});
