/**
 * Node.js debug adapter — the first concrete DebugAdapter implementation.
 *
 * Strategy: spawn `node --inspect-brk=0 <script>`, discover the inspector
 * WebSocket endpoint from the child's output, then drive the process over
 * the Chrome DevTools Protocol (CDP) using Node's global WebSocket.
 *
 * Because everything goes through the DebugAdapter interface, future
 * language adapters (python, etc.) can be added without touching any UI or
 * IPC code.
 */

import { spawn, type ChildProcess } from "child_process";
import * as path from "path";
import type {
  DebugAdapter,
  DebugConfig,
  DebugFrame,
  DebugScope,
  DebugVariable,
  DebugEvaluatedResult,
  DebugEventPayload,
} from "./types";

export type AdapterEmit = (event: DebugEventPayload) => void;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function scriptPathFromUrl(raw: string): string {
  let p = raw;
  try {
    p = decodeURIComponent(p);
  } catch {}
  p = p.replace(/^file:\/\//, "");
  p = p.replace(/^\/([a-zA-Z]:)/, "$1");
  return p.split("\\").join("/");
}

function pathKey(p: string): string {
  const abs = path.resolve(p).split("\\").join("/");
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

/* ------------------------------------------------------------------ */
/* Minimal CDP client over the global WebSocket (Node 22+)             */
/* ------------------------------------------------------------------ */

interface PendingCall {
  resolve: (r: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

class CdpClient {
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<number, PendingCall>();
  private listeners = new Map<string, Set<(params: unknown) => void>>();
  private closedResolvers: Array<() => void> = [];

  connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        reject(err as Error);
        return;
      }
      this.ws = ws;
      let settled = false;
      const failTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch {}
        reject(new Error("CDP connect timeout"));
      }, 20000);
      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(failTimer);
        resolve();
      };
      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(failTimer);
        reject(new Error("CDP connection failed"));
      };
      ws.onclose = () => {
        this.ws = null;
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error("Debug session closed"));
        }
        this.pending.clear();
        for (const r of this.closedResolvers) r();
        this.closedResolvers = [];
      };
      ws.onmessage = (ev: MessageEvent) => {
        let msg: { id?: number; method?: string; params?: unknown; error?: { message?: string }; result?: unknown };
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (msg.id) {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.error) p.reject(new Error(msg.error.message ?? "CDP error"));
            else p.resolve(msg.result);
          }
          return;
        }
        if (msg.method) {
          const set = this.listeners.get(msg.method);
          if (set) {
            for (const cb of [...set]) {
              try {
                cb(msg.params);
              } catch {}
            }
          }
        }
      };
    });
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      const ws = this.ws;
      if (!ws) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("Not connected"));
        return;
      }
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  on(method: string, cb: (params: unknown) => void): void {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method)!.add(cb);
  }

  onceClosed(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.ws) {
        resolve();
        return;
      }
      this.closedResolvers.push(resolve);
    });
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
  }
}

/* ------------------------------------------------------------------ */
/* CDP types (subset)                                                  */
/* ------------------------------------------------------------------ */

interface CdpRemoteObject {
  type: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  description?: string;
  objectId?: string;
  preview?: {
    description?: string;
    properties?: Array<{ name?: string; type?: string; value?: unknown; valuePreview?: CdpRemoteObject }>;
  };
}

interface CdpCallFrame {
  callFrameId: string;
  functionName: string;
  url: string;
  location: { scriptId: string; lineNumber: number; columnNumber: number };
  scopeChain: Array<{ type: string; name?: string; object: CdpRemoteObject }>;
  this?: CdpRemoteObject;
}

/* ------------------------------------------------------------------ */
/* Node adapter                                                        */
/* ------------------------------------------------------------------ */

interface PendingBreakpoint {
  file: string;
  line: number;
  resolve: (r: { id: string; resolved: boolean } | null) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class NodeJsDebugAdapter implements DebugAdapter {
  readonly kind = "node";

  private child: ChildProcess | null = null;
  private client: CdpClient | null = null;
  private pausedFrames: CdpCallFrame[] | null = null;
  /** pathKey -> url for parsed scripts */
  private scripts = new Map<string, string>();
  private pendingBps: PendingBreakpoint[] = [];
  /** Set once the debuggee has finished or the session was stopped. */
  private finished = false;
  /** Debugger.breakpointId captured for `file:line`, used when a re-apply hits V8's duplicate error. */
  private initialBpIds = new Map<string, string>();

  constructor(
    private readonly config: DebugConfig,
    private readonly emit: AdapterEmit,
  ) {}

  /* ------------------------------ lifecycle ------------------------------ */

  async start(): Promise<void> {
    this.finished = false;
    const nodeCmd = this.resolveNodeCommand();
    const file = this.config.file;
    const cwd = this.config.cwd;

    const child = spawn(nodeCmd, ["--inspect-brk=0", ...(this.config.args ?? []), file], {
      cwd: cwd || (file ? path.dirname(file) : process.cwd()),
      env: { ...process.env, ...this.config.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;

    let wsUrl = "";
    const captureWs = (chunk: Buffer): void => {
      if (wsUrl) return;
      const m = chunk.toString("utf8").match(/ws:\/\/[^\s]+/);
      if (m) wsUrl = m[0];
    };

    child.stdout?.on("data", (c: Buffer) => {
      captureWs(c);
      this.emit({ type: "output", payload: { text: c.toString("utf8"), category: "stdout" } });
    });
    child.stderr?.on("data", (c: Buffer) => {
      captureWs(c);
      this.emit({ type: "output", payload: { text: c.toString("utf8"), category: "stderr" } });
    });
    child.on("error", (err) => {
      this.emit({
        type: "error",
        payload: { message: `Failed to start Node.js debugger: ${err.message}` },
      });
      this.emit({ type: "exited", payload: { exitCode: null } });
    });
    child.on("exit", (code) => {
      this.child = null;
      try {
        this.client?.close();
      } catch {}
      this.client = null;
      this.pausedFrames = null;
      this.scripts.clear();
      this.initialBpIds.clear();
      if (!this.finished) {
        this.emit({ type: "exited", payload: { exitCode: code ?? null } });
      }
    });

    const deadline = Date.now() + 8000;
    while (!wsUrl && Date.now() < deadline && this.child) {
      await sleep(50);
    }
    if (!wsUrl) throw new Error("Could not discover the Node.js inspector endpoint");

    const client = new CdpClient();
    await client.connect(wsUrl);
    this.client = client;
    this.registerCdp(client);

    await client.send("Debugger.enable");
    await client.send("Runtime.enable");

    // The entry script of a CommonJS program is only compiled once execution
    // begins, so its Debugger.scriptParsed arrives AFTER we resume. Bind the
    // initial breakpoints by their predicted file URL now — V8 lazily matches
    // the URL when the module compiles (Debugger.breakpointResolved), which is
    // guaranteed to happen before the script can run past our breakpoints.
    for (const ib of this.config.initialBreakpoints ?? []) {
      try {
        const r = await this.applyBreakpoint(this.urlForFile(ib.file), ib.file, ib.line);
        if (r?.id) this.initialBpIds.set(`${pathKey(ib.file)}:${ib.line}`, r.id);
      } catch {}
    }
    await client.send("Runtime.runIfWaitingForDebugger");
    this.emit({ type: "state", payload: { state: "running" } });
  }

  /** file:// URL form the inspector uses for a local entry script. */
  private urlForFile(file: string): string {
    return "file:///" + file.split("\\").join("/");
  }

  private resolveNodeCommand(): string {
    const envNode = process.env.NODE;
    if (envNode) return envNode;
    return "node";
  }

  private registerCdp(client: CdpClient): void {
    client.on("Debugger.paused", (raw) => {
      const params = raw as { callFrames: CdpCallFrame[]; reason: string };
      this.pausedFrames = params.callFrames ?? [];
      if (params.reason === "Break on start") {
        // Bootstrap pause from `--inspect-brk`. Advance past it so the
        // debuggee runs to the first user breakpoint.
        void client.send("Debugger.resume").catch(() => {});
        return;
      }
      const frames: DebugFrame[] = this.pausedFrames.map((cf, i) => {
        const rawUrl = cf.url || "";
        const displayPath = scriptPathFromUrl(rawUrl);
        return {
          frameId: i,
          functionName: cf.functionName || "(anonymous)",
          url: displayPath || rawUrl,
          line: (cf.location?.lineNumber ?? 0) + 1,
          column: (cf.location?.columnNumber ?? 0) + 1,
        };
      });
      this.emit({ type: "paused", payload: { frames, reason: params.reason ?? "other" } });
    });

    client.on("Debugger.resumed", () => {
      this.pausedFrames = null;
      this.emit({ type: "resumed", payload: {} });
    });

    client.on("Debugger.scriptParsed", (raw) => {
      const url = (raw as { url?: string }).url;
      if (!url) return;
      const key = pathKey(scriptPathFromUrl(url));
      this.scripts.set(key, url);
      this.flushPending(url, key);
    });

    client.on("Runtime.consoleAPICalled", (raw) => {
      const params = raw as { type: string; args: CdpRemoteObject[] };
      const text = (params.args ?? []).map((a) => this.remoteDisplay(a)).join(" ");
      this.emit({ type: "output", payload: { text: text || `[${params.type || "console"}]`, category: "console" } });
    });

    client.on("Runtime.executionContextDestroyed", (raw) => {
      const params = raw as { executionContextId?: number };
      // The default main execution context (id 1) is destroyed when the
      // program completes. Node keeps the process alive while an inspector
      // socket is open, so broadcast completion and close the socket to let
      // the child exit naturally with code 0.
      if (params.executionContextId !== 1 || this.finished) return;
      this.finished = true;
      try {
        client.close();
      } catch {}
      this.pausedFrames = null;
      this.emit({ type: "exited", payload: { exitCode: 0 } });
    });

    client.on("Runtime.exceptionThrown", (raw) => {
      const params = raw as { exceptionDetails?: { exception?: CdpRemoteObject; text?: string } };
      const ex = params.exceptionDetails?.exception;
      const text = ex ? this.remoteDisplay(ex) : params.exceptionDetails?.text ?? "Uncaught exception";
      this.emit({ type: "output", payload: { text, category: "stderr" } });
    });
  }

  private flushPending(url: string, key: string): void {
    const pending = this.pendingBps;
    this.pendingBps = [];
    for (const p of pending) {
      if (pathKey(p.file) === key) {
        clearTimeout(p.timer);
        this.applyBreakpoint(url, p.file, p.line)
          .then((r) => p.resolve(r))
          .catch((e) => p.reject(e));
      } else {
        this.pendingBps.push(p);
      }
    }
  }

  async stop(): Promise<void> {
    this.finished = true;
    const client = this.client;
    if (client) {
      try {
        if (this.pausedFrames) await client.send("Debugger.resume");
      } catch {}
      try {
        client.close();
      } catch {}
    }
    const child = this.child;
    if (child) {
      try {
        child.kill();
      } catch {}
    }
    this.child = null;
    this.client = null;
    this.pausedFrames = null;
    this.scripts.clear();
    this.initialBpIds.clear();
    this.pendingBps.forEach((p) => clearTimeout(p.timer));
    this.pendingBps = [];
    this.emit({ type: "state", payload: { state: "inactive" } });
  }

  /* ---------------------------- run control ----------------------------- */

  async pause(): Promise<void> {
    if (!this.client) throw new Error("No debug session");
    await this.client.send("Debugger.pause");
  }

  async resume(): Promise<void> {
    if (!this.client) throw new Error("No debug session");
    if (!this.pausedFrames) return;
    this.pausedFrames = null;
    await this.client.send("Debugger.resume");
  }

  private async step(method: "Debugger.stepOver" | "Debugger.stepInto" | "Debugger.stepOut"): Promise<void> {
    if (!this.client) throw new Error("No debug session");
    if (!this.pausedFrames) throw new Error("Not paused");
    await this.client.send(method, {});
  }

  async stepOver(): Promise<void> {
    await this.step("Debugger.stepOver");
  }

  async stepInto(): Promise<void> {
    await this.step("Debugger.stepInto");
  }

  async stepOut(): Promise<void> {
    await this.step("Debugger.stepOut");
  }

  /* ---------------------------- breakpoints ----------------------------- */

  async setBreakpoint(file: string, line: number): Promise<{ id: string; resolved: boolean } | null> {
    if (!this.client) return null;
    const key = pathKey(file);
    const url = this.scripts.get(key);
    if (url) {
      return this.applyBreakpoint(url, file, line);
    }
    return new Promise<{ id: string; resolved: boolean } | null>((resolve, reject) => {
      const p: PendingBreakpoint = {
        file,
        line,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pendingBps = this.pendingBps.filter((x) => x !== p);
          resolve(null);
        }, 20000),
      };
      this.pendingBps.push(p);
    });
  }

  private async applyBreakpoint(
    url: string,
    file: string,
    line: number,
  ): Promise<{ id: string; resolved: boolean } | null> {
    if (!this.client) return null;
    const bpKey = `${pathKey(file)}:${line}`;
    let res: unknown;
    try {
      res = await this.client.send("Debugger.setBreakpointByUrl", {
        lineNumber: Math.max(0, line - 1),
        columnNumber: 0,
        url,
      });
    } catch (err) {
      // V8 rejects a second setBreakpointByUrl for the same url+line with
      // "Breakpoint at specified location already exists." This happens when
      // the manager re-applies a breakpoint that start() already bound by
      // URL. Treat it as bound: return the id captured at bind time.
      const msg = (err as Error).message ?? "";
      if (msg.includes("already exists")) {
        const existingId = this.initialBpIds.get(bpKey);
        return { id: existingId ?? `${url}#${line}`, resolved: true };
      }
      throw err;
    }
    const r = res as { breakpointId?: string; locations?: Array<{ lineNumber: number }> };
    const resolvedLine = r.locations?.[0]?.lineNumber != null ? r.locations[0].lineNumber + 1 : line;
    const id = r.breakpointId ?? `${url}#${line}`;
    this.initialBpIds.set(bpKey, id);
    return {
      id,
      resolved: resolvedLine === line,
    };
  }

  async removeBreakpoint(adapterId: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.send("Debugger.removeBreakpoint", { breakpointId: adapterId });
    } catch {}
  }

  /* ------------------------------ variables ----------------------------- */

  async getVariables(frameId: number): Promise<DebugScope[]> {
    if (!this.client) return [];
    const frame = this.pausedFrames?.[frameId];
    if (!frame) return [];
    const out: DebugScope[] = [];
    const scopes = frame.scopeChain ?? [];
    for (const scope of scopes) {
      const objectId = scope.object?.objectId;
      if (!objectId) continue;
      try {
        const variables = await this.getProperties(objectId);
        if (variables.length === 0) continue;
        out.push({ name: scope.name || this.scopeLabel(scope.type), variables });
      } catch {
        // skip a scope we cannot read
      }
    }
    return out;
  }

  async expandObject(objectId: string): Promise<DebugScope> {
    if (!this.client) return { name: "Properties", variables: [] };
    const variables = await this.getProperties(objectId);
    return { name: "Properties", variables };
  }

  private scopeLabel(type: string): string {
    switch (type) {
      case "global":
        return "Global";
      case "closure":
        return "Closure";
      case "catch":
        return "Catch";
      case "block":
        return "Block";
      case "script":
        return "Script";
      case "eval":
        return "Eval";
      case "module":
        return "Module";
      default:
        return type.charAt(0).toUpperCase() + type.slice(1);
    }
  }

  private async getProperties(objectId: string): Promise<DebugVariable[]> {
    if (!this.client) return [];
    const res = (await this.client.send("Runtime.getProperties", {
      objectId,
      ownProperties: true,
      generatePreview: true,
    })) as { result?: Array<{ name?: string; value?: CdpRemoteObject; get?: unknown; set?: unknown }> };
    const props = res.result ?? [];
    const vars: DebugVariable[] = [];
    for (const pd of props) {
      const name = pd.name;
      if (!name || name === "__proto__" || name === "constructor") continue;
      if (pd.value) {
        vars.push(this.toVariable(name, pd.value));
      } else if (pd.get) {
        vars.push({ name, value: "… (accessor)", type: "accessor", expandable: false });
      }
      if (vars.length >= 300) break;
    }
    return vars;
  }

  private toVariable(name: string, ro: CdpRemoteObject): DebugVariable {
    if (ro.type === "string") {
      const text = typeof ro.value === "string" ? ro.value : ro.description ?? "";
      return { name, value: JSON.stringify(text), type: "string", expandable: false };
    }
    if (ro.type === "object" && ro.subtype === "null") {
      return { name, value: "null", type: "null", expandable: false };
    }
    if (ro.type === "undefined") {
      return { name, value: "undefined", type: "undefined", expandable: false };
    }
    if (ro.value !== undefined) {
      return { name, value: String(ro.value), type: ro.type, expandable: false };
    }
    if (ro.objectId) {
      const preview = ro.preview?.description;
      const desc = preview && !preview.includes("undefined") ? preview : ro.description ?? ro.type;
      return { name, value: desc, type: ro.type ?? "object", objectId: ro.objectId, expandable: true };
    }
    return { name, value: ro.description ?? ro.type ?? "?", type: ro.type ?? "?", expandable: false };
  }

  private remoteDisplay(ro: CdpRemoteObject): string {
    const v = this.toVariable("", ro);
    return v.value;
  }

  /* ------------------------------ evaluate ------------------------------ */

  async evaluate(expression: string): Promise<DebugEvaluatedResult> {
    if (!this.client) return { ok: false, value: "", error: "No active debug session" };
    const top = this.pausedFrames?.[0];
    let res: unknown;
    if (top) {
      res = await this.client.send("Debugger.evaluateOnCallFrame", {
        callFrameId: top.callFrameId,
        expression,
        returnByValue: false,
        generatePreview: true,
      });
    } else {
      res = await this.client.send("Runtime.evaluate", {
        expression,
        returnByValue: false,
        generatePreview: true,
      });
    }
    const r = res as { result: CdpRemoteObject; exceptionDetails?: { text?: string; exception?: CdpRemoteObject } };
    if (r.exceptionDetails) {
      const txt = r.exceptionDetails.exception
        ? this.remoteDisplay(r.exceptionDetails.exception)
        : r.exceptionDetails.text ?? "Evaluation failed";
      return { ok: false, value: txt, error: txt };
    }
    return { ok: true, value: this.remoteDisplay(r.result) };
  }
}