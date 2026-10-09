import type { LanguageId, LSPConfig } from "./types";

// LSP Manager — placeholder architecture for external language servers
// For Phase 7, we implement discovery and lifecycle stubs, but do not bundle huge servers.
// Future phases can implement JSON-RPC via child_process.

export interface LSPStatus {
  id: LanguageId;
  config: LSPConfig;
  found: boolean;
  running: boolean;
  error?: string;
}

const lspStatuses = new Map<LanguageId, LSPStatus>();

// Check if a command exists in PATH (best-effort, no shell interpolation)
async function commandExists(command: string): Promise<boolean> {
  const cmd = command.split(" ")[0];
  if (!cmd) return false;
  try {
    // Use window.closeCode.getPlatform to decide which check, but in renderer we can just try to use `where`/`which` via main IPC if available
    // For now, we assume not found unless explicitly configured via settings
    // We expose a main IPC `lsp:check` that does a safe check without shell interpolation
    if (typeof window !== "undefined" && (window as unknown as Record<string, unknown>).closeCode) {
      const api = (window as unknown as { closeCode: { checkLSP?: (cmd: string) => Promise<{ found: boolean }> } }).closeCode;
      if (api.checkLSP) {
        const res = await api.checkLSP(cmd);
        return res.found;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export async function discoverLSP(id: LanguageId, config: LSPConfig): Promise<LSPStatus> {
  const cmd = config.path ?? config.command.split(" ")[0];
  const found = await commandExists(cmd);
  const status: LSPStatus = {
    id,
    config,
    found,
    running: false,
    error: found ? undefined : `Language server not found: ${cmd} (install it or set path in settings)`,
  };
  lspStatuses.set(id, status);
  return status;
}

export async function startLSP(id: LanguageId): Promise<LSPStatus | null> {
  const status = lspStatuses.get(id);
  if (!status) return null;
  if (!status.found) {
    console.warn(`[LSP] Cannot start ${id}: not found`);
    return status;
  }
  // For now, we don't actually spawn the server — Phase 7 is architecture only
  // In future, we would do: const proc = spawn(status.config.command, status.config.args, { stdio: "pipe" })
  // and set up JSON-RPC.
  status.running = true;
  lspStatuses.set(id, status);
  console.info(`[LSP] Started ${id} (mock)`);
  return status;
}

export function stopLSP(id: LanguageId): void {
  const status = lspStatuses.get(id);
  if (!status) return;
  status.running = false;
  lspStatuses.set(id, status);
  console.info(`[LSP] Stopped ${id}`);
}

export function getLSPStatus(id: LanguageId): LSPStatus | undefined {
  return lspStatuses.get(id);
}

export function getAllLSPStatuses(): LSPStatus[] {
  return [...lspStatuses.values()];
}

export function clearLSPForTesting(): void {
  lspStatuses.clear();
}
