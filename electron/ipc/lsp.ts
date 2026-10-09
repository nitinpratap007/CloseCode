import { ipcMain } from "electron";
import { spawnSync } from "child_process";

export function registerLspIpc(): void {
  ipcMain.handle("lsp:check", (_e, command: string) => {
    const cmd = command.split(" ")[0]?.trim();
    if (!cmd) return { found: false };
    try {
      const isWin = process.platform === "win32";
      const checker = isWin ? "where" : "which";
      const result = spawnSync(checker, [cmd], { stdio: "ignore", timeout: 2000 });
      return { found: result.status === 0 };
    } catch {
      return { found: false };
    }
  });
}
