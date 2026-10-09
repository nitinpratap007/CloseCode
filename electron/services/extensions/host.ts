// Close Code — Extension host (Phase 13)
// Extensions are discovered from userData/extensions, workspace .closecode/extensions,
// and the CC_EXTENSIONS env (semicolon-separated dirs, used by tests).
//
// Activation runs in a Node `vm` sandbox: no require, no process, no fs, no net.
// Every capability is exposed through a permission-gated `api` object.
// Commands contributed by extensions are executed via IPC from the renderer.

import { app, BrowserWindow } from "electron";
import fs from "fs";
import path from "path";
import vm from "vm";
import { exec } from "child_process";
import { parseManifest, satisfiesVersion, type ExtensionManifest, type ManifestCommand } from "./manifest";

export interface ExtensionInfo {
  id: string;
  name: string;
  displayName: string;
  version: string;
  description: string;
  publisher: string;
  enabled: boolean;
  permissions: string[];
  commands: ManifestCommand[];
  main: string | null;
  dir: string;
  loadError: string | null;
  warnings: string[];
  incompatible: boolean;
}

export interface ExecuteCommandResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

type CommandHandler = () => unknown;

interface CommandEntry {
  extensionId: string;
  id: string;
  title: string;
  handler: CommandHandler;
}

interface ActivatedExtension {
  info: ExtensionInfo;
  commands: CommandEntry[];
  deactivate: (() => unknown) | null;
}

type EmitFn = (channel: string, payload: unknown) => void;

export interface ExtensionHostOptions {
  emit: EmitFn;
  getWorkspaceRoot: () => string | null;
  userDataDir: () => string;
  /** Phase 14: whether workspace .closecode/extensions discovery is enabled. */
  getWorkspaceExtensionsEnabled?: () => boolean;
}

const SKIP_DIRS = new Set([".git", "node_modules", ".closecode"]);

export class ExtensionHost {
  private activated = new Map<string, ActivatedExtension>();
  private enabledState = new Map<string, boolean>();
  private activationErrors = new Map<string, string>();

  constructor(private options: ExtensionHostOptions) {
    this.loadEnabledState();
  }

  private broadcast(channel: string, payload: unknown): void {
    try {
      this.options.emit(channel, payload);
    } catch {
      // no window yet
    }
  }

  private extensionsDir(): string {
    const dir = path.join(this.options.userDataDir(), "extensions");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private enabledStatePath(): string {
    return path.join(this.extensionsDir(), "enabled.json");
  }

  private loadEnabledState(): void {
    try {
      const p = this.enabledStatePath();
      if (fs.existsSync(p)) {
        const parsed = JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === "boolean") this.enabledState.set(k, v);
        }
      }
    } catch {
      this.enabledState = new Map();
    }
  }

  private saveEnabledState(): void {
    try {
      const obj: Record<string, boolean> = {};
      for (const [k, v] of this.enabledState) obj[k] = v;
      fs.writeFileSync(this.enabledStatePath(), JSON.stringify(obj, null, 2), "utf-8");
    } catch (err) {
      console.error("Failed to save extension enabled-state:", err);
    }
  }

  private discoveryDirs(): string[] {
    const dirs: string[] = [];
    dirs.push(this.extensionsDir());
    const root = this.options.getWorkspaceRoot();
    if (root && this.options.getWorkspaceExtensionsEnabled?.() !== false) {
      const wsExt = path.join(root, ".closecode", "extensions");
      if (fs.existsSync(wsExt)) dirs.push(wsExt);
    }
    const envDirs = process.env.CC_EXTENSIONS;
    if (envDirs) {
      for (const d of envDirs.split(";")) {
        const t = d.trim();
        if (t) dirs.push(t);
      }
    }
    return dirs;
  }

  /** Find (id -> manifest source json) for every extension directory. */
  private findManifests(): Array<{ dir: string; json: unknown; manifestPath: string }> {
    const found: Array<{ dir: string; json: unknown; manifestPath: string }> = [];
    const seen = new Set<string>();
    for (const base of this.discoveryDirs()) {
      let entries: string[];
      try {
        entries = fs.readdirSync(base);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
        const dir = path.join(base, name);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(dir);
        } catch {
          continue;
        }
        if (!stat.isDirectory()) continue;
        const key = path.resolve(dir).toLowerCase();
        if (seen.has(key)) continue;

        let manifestPath = "";
        let json: unknown = null;
        const extJson = path.join(dir, "extension.json");
        const pkgJson = path.join(dir, "package.json");
        if (fs.existsSync(extJson)) {
          manifestPath = extJson;
          try {
            json = JSON.parse(fs.readFileSync(extJson, "utf-8"));
          } catch {
            json = null;
          }
        } else if (fs.existsSync(pkgJson)) {
          manifestPath = pkgJson;
          try {
            const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf-8"));
            json = pkg && typeof pkg === "object" && (pkg as Record<string, unknown>).closeCode ? pkg : null;
          } catch {
            json = null;
          }
        }
        if (!json) continue;
        seen.add(key);
        found.push({ dir, json, manifestPath });
      }
    }
    return found;
  }

  /** Full list of extensions (manifest-derived + runtime state). */
  list(): ExtensionInfo[] {
    const appVersion = app.getVersion();
    return this.findManifests().map(({ dir, json }) => {
      const parsed = parseManifest(json, dir);
      const ext = parsed.manifest;
      const activationError = this.activationErrors.get(ext?.id ?? "");
      const incompatible = ext ? !satisfiesVersion(appVersion, ext.engines?.closecode) : false;
      const loadError = parsed.error ?? activationError ?? null;
      const enabled = (this.enabledState.get(ext?.id ?? "") ?? true) && !incompatible && !parsed.error && !activationError;
      // Merge manifest-declared commands with commands the extension registered
      // at runtime (api.registerCommand) so the renderer can index/execute both.
      const entry = this.activated.get(ext?.id ?? "");
      const runtime = entry ? entry.commands.map((c) => ({ id: c.id, title: c.title })) : [];
      const manifestCmds = ext?.contributes?.commands ?? [];
      const seenCmd = new Set<string>();
      const commands: Array<{ id: string; title: string }> = [];
      for (const c of [...runtime, ...manifestCmds]) {
        if (!c?.id || seenCmd.has(c.id)) continue;
        seenCmd.add(c.id);
        commands.push({ id: c.id, title: c.title });
      }
      return {
        id: ext?.id ?? `invalid-${path.basename(dir)}`,
        name: ext?.name ?? "invalid",
        displayName: ext?.displayName ?? path.basename(dir),
        version: ext?.version ?? "0.0.0",
        description: ext?.description ?? "",
        publisher: ext?.publisher ?? "local",
        enabled,
        permissions: ext?.permissions ?? [],
        commands,
        main: ext?.main ?? null,
        dir,
        loadError,
        warnings: parsed.warnings ?? [],
        incompatible,
      };
    });
  }

  setEnabled(id: string, enabled: boolean): { ok: boolean; result?: ExtensionInfo[]; error?: string } {
    const info = this.list().find((e) => e.id === id);
    if (!info) return { ok: false, error: `Unknown extension: ${id}` };
    if (enabled && (info.loadError || info.incompatible)) {
      return { ok: false, error: info.loadError ?? "Extension is incompatible with this version of CloseCode." };
    }
    this.enabledState.set(id, enabled);
    this.saveEnabledState();
    if (enabled) {
      const err = this.activate(id);
      if (err) return { ok: false, error: err };
    } else {
      this.deactivate(id);
    }
    this.broadcast("extension:changed", { extensions: this.list() });
    return { ok: true, result: this.list() };
  }

  reload(): ExtensionInfo[] {
    for (const id of [...this.activated.keys()]) this.deactivate(id);
    this.enabledState.clear();
    this.loadEnabledState();
    for (const info of this.list()) {
      if (info.enabled && !info.loadError) this.activate(info.id);
    }
    const list = this.list();
    this.broadcast("extension:changed", { extensions: list });
    return list;
  }

  reloadForTest(): void {
    this.reload();
  }

  // ------------------------------------------------------------------
  // Activation
  // ------------------------------------------------------------------
  private activate(id: string): string | null {
    const existing = this.activated.get(id);
    if (existing) return null;

    const info = this.list().find((e) => e.id === id);
    if (!info) return "Unknown extension";
    if (info.loadError) return info.loadError;
    if (!info.main) return "No main entry";
    if (info.incompatible) return "Incompatible with this CloseCode version";

    const mainPath = path.join(info.dir, info.main);
    let code: string;
    try {
      code = fs.readFileSync(mainPath, "utf-8");
    } catch (err) {
      const msg = `Cannot read main entry: ${err instanceof Error ? err.message : String(err)}`;
      this.activationErrors.set(id, msg);
      this.broadcast("extension:changed", { extensions: this.list() });
      return msg;
    }

    const api = this.createExtensionApi(info);
    const sandbox: Record<string, unknown> = {
      api,
      console: {
        log: (...a: unknown[]) => this.emitLog(info.id, a),
        error: (...a: unknown[]) => this.emitLog(info.id, a, "error"),
        warn: (...a: unknown[]) => this.emitLog(info.id, a, "warn"),
      },
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      JSON,
      Math,
      Date,
      Object,
      Array,
      String,
      Number,
      Boolean,
      Promise,
      Map,
      Set,
      Error,
      RegExp,
      Symbol,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      undefined,
      NaN,
      Infinity,
    };

    const context = vm.createContext(sandbox, { name: `extension:${info.id}` });
    try {
      vm.runInContext(code, context, { filename: mainPath, timeout: 10000 });
    } catch (err) {
      const msg = `Activation threw: ${err instanceof Error ? err.message : String(err)}`;
      this.activationErrors.set(id, msg);
      this.broadcast("extension:changed", { extensions: this.list() });
      return msg;
    }

    const ctxGlobal = sandbox as Record<string, unknown>;
    const activateFn = ctxGlobal["activate"] as ((api: unknown) => unknown) | undefined;
    const deactivateFn = ctxGlobal["deactivate"] as (() => unknown) | undefined;

    const entry: ActivatedExtension = {
      info,
      commands: [],
      deactivate: deactivateFn ?? null,
    };

    // Register the entry BEFORE activate() runs: api.registerCommand needs to
    // find the active entry to attach command handlers.
    this.activated.set(id, entry);

    if (activateFn) {
      try {
        activateFn(api);
      } catch (err) {
        const msg = `Extension activate() threw: ${err instanceof Error ? err.message : String(err)}`;
        this.activated.delete(id);
        this.activationErrors.set(id, msg);
        this.broadcast("extension:changed", { extensions: this.list() });
        return msg;
      }
    }

    // Auto-register manifest-declared commands (executed via `extension:exec-command`).
    for (const cmd of info.commands) {
      if (this.commandOwners.get(cmd.id)) continue;
      entry.commands.push({
        extensionId: info.id,
        id: cmd.id,
        title: cmd.title,
        handler: () => ({ __manifestCommand: true, id: cmd.id }),
      });
    }

    this.activated.set(id, entry);
    this.activationErrors.delete(id);
    this.rebuildCommandIndex();
    this.broadcast("extension:changed", { extensions: this.list() });
    return null;
  }

  private deactivate(id: string): void {
    const entry = this.activated.get(id);
    if (!entry) return;
    try {
      if (entry.deactivate) entry.deactivate();
    } catch (err) {
      this.emitLog(id, [`deactivate() threw: ${err instanceof Error ? err.message : String(err)}`], "error");
    }
    this.activated.delete(id);
    this.rebuildCommandIndex();
  }

  private emitLog(id: string, args: unknown[], level: "log" | "warn" | "error" = "log"): void {
    try {
      this.broadcast("extension:log", {
        extensionId: id,
        level,
        message: args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "),
      });
    } catch {
      // ignore
    }
  }

  // ------------------------------------------------------------------
  // Command registry (extension-contributed)
  // ------------------------------------------------------------------
  private commandOwners = new Map<string, string>(); // command id -> extension id
  private commandHandlers = new Map<string, CommandHandler>();

  private rebuildCommandIndex(): void {
    this.commandOwners.clear();
    this.commandHandlers.clear();
    for (const entry of this.activated.values()) {
      for (const cmd of entry.commands) {
        this.commandOwners.set(cmd.id, entry.info.id);
        this.commandHandlers.set(cmd.id, cmd.handler);
      }
    }
  }

  getCommands(): Array<{ id: string; title: string; extensionId: string; enabled: boolean }> {
    const out: Array<{ id: string; title: string; extensionId: string; enabled: boolean }> = [];
    for (const entry of this.activated.values()) {
      for (const cmd of entry.commands) {
        out.push({ id: cmd.id, title: cmd.title, extensionId: entry.info.id, enabled: entry.info.enabled });
      }
    }
    return out;
  }

  executeCommand(id: string): ExecuteCommandResult {
    const handler = this.commandHandlers.get(id);
    if (!handler) return { ok: false, error: `Unknown extension command: ${id}` };
    try {
      const result = handler();
      const value = result instanceof Promise ? (result as unknown) : (result ?? null);
      if (value instanceof Promise) {
        // We cannot await inside a sync IPC handler; wrap for a well-formed response.
        const pending: ExecuteCommandResult = { ok: true, result: { __pending: true } };
        void (value as Promise<unknown>).then(
          (v) => this.broadcast("extension:exec-result", { commandId: id, ok: true, result: safeJson(v) }),
          (e) => this.broadcast("extension:exec-result", { commandId: id, ok: false, error: e instanceof Error ? e.message : String(e) }),
        );
        return pending;
      }
      return { ok: true, result: safeJson(value) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ------------------------------------------------------------------
  // Permission-gated extension API
  // ------------------------------------------------------------------
  private createExtensionApi(info: ExtensionInfo): Record<string, unknown> {
    const hasPerm = (p: string): boolean => info.permissions.includes(p);
    const extRoot = info.dir;
    const workspaceRoot = () => this.options.getWorkspaceRoot();

    const confine = (p: string): string | null => {
      const abs = path.resolve(p);
      const candidates = [extRoot, workspaceRoot()].filter((r): r is string => !!r);
      for (const root of candidates) {
        const r = path.resolve(root).toLowerCase();
        const n = abs.toLowerCase();
        if (n === r || n.startsWith(r + path.sep)) return abs;
      }
      return null;
    };

    const api: Record<string, unknown> = {
      id: info.id,
      name: info.name,
      version: info.version,
      log: (...args: unknown[]) => this.emitLog(info.id, args),
    };
    // Live workspace root: activation can happen before a folder is opened,
    // so expose the CURRENT root (or null) on every access.
    Object.defineProperty(api, "workspace", {
      enumerable: false,
      get: () => this.options.getWorkspaceRoot(),
    });

    if (hasPerm("commands")) {
      api.registerCommand = (meta: { id?: string; title?: string; execute?: unknown }) => {
        if (!meta || typeof meta !== "object") throw new Error("registerCommand requires { id, title, execute }");
        const id = String(meta.id ?? "");
        const title = String(meta.title ?? "");
        const execute = meta.execute;
        if (!id || !title) throw new Error("registerCommand requires non-empty id and title");
        if (typeof execute !== "function") throw new Error("registerCommand requires an execute function");
        if (this.commandOwners.has(id) && this.commandOwners.get(id) !== info.id) {
          throw new Error(`Command ${id} is already registered by another extension.`);
        }
        const entry = this.activated.get(info.id);
        if (!entry) throw new Error("Extension not active");
        const existing = entry.commands.find((c) => c.id === id);
        if (existing) {
          existing.handler = execute as CommandHandler;
        } else {
          entry.commands.push({ extensionId: info.id, id, title, handler: execute as CommandHandler });
        }
        this.rebuildCommandIndex();
        this.broadcast("extension:changed", { extensions: this.list() });
      };
    }

    if (hasPerm("files")) {
      api.files = {
        read: (p: string) => {
          const target = confine(String(p));
          if (!target) throw new Error("Path is outside the extension/workspace directories");
          return fs.readFileSync(target, "utf-8");
        },
        write: (p: string, content: string) => {
          const target = confine(String(p));
          if (!target) throw new Error("Path is outside the extension/workspace directories");
          fs.writeFileSync(target, String(content), "utf-8");
          return true;
        },
        list: (p?: string) => {
          const target = confine(String(p ?? extRoot));
          if (!target) throw new Error("Path is outside the extension/workspace directories");
          return fs.readdirSync(target);
        },
        exists: (p: string) => {
          const target = confine(String(p));
          return !!target && fs.existsSync(target);
        },
      };
    }

    if (hasPerm("terminal")) {
      api.terminal = {
        run: (command: string, opts?: { cwd?: string }) =>
          new Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }>((resolve) => {
            exec(String(command), { cwd: opts?.cwd ?? workspaceRoot() ?? undefined, timeout: 15000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
              resolve({ ok: !err, stdout, stderr, code: err ? (err as { code?: number }).code ?? 1 : 0 });
            });
          }),
      };
    }

    if (hasPerm("git")) {
      api.git = {
        status: () =>
          new Promise<{ ok: boolean; output: string }>((resolve) => {
            exec("git status --porcelain -b", { cwd: workspaceRoot() ?? undefined, timeout: 15000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
              resolve({ ok: !err, output: (stdout + stderr).slice(0, 20000) });
            });
          }),
      };
    }

    return api;
  }
}

function safeJson(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return { __unserializable: true };
  }
}

/** Fire a synthetic 'new window loaded' rebroadcast hook (used by IPC layer). */
export function rebroadcast(host: ExtensionHost): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("extension:changed", { extensions: host.list() });
  }
}