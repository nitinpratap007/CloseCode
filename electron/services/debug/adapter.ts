/**
 * DebugSessionManager — language-agnostic session lifecycle.
 *
 * Owns the currently-active DebugAdapter, keeps breakpoints across
 * sessions, normalizes adapter events to DebugEventPayload and forwards
 * them to the renderer via a broadcast callback.
 */

import * as path from "path";
import type {
  DebugAdapter,
  DebugBreakpoint,
  DebugConfig,
  DebugEventPayload,
  DebugRuntimeState,
  DebugScope,
  DebugEvaluatedResult,
} from "./types";

export type DebugBroadcast = (event: DebugEventPayload) => void;

export type AdapterFactory = (config: DebugConfig, emit: DebugBroadcast) => DebugAdapter;

/** Registry for future language adapters. Default: node (CDP). */
const adapterFactories: Record<string, AdapterFactory> = {};

export function registerDebugAdapterFactory(kind: string, factory: AdapterFactory): void {
  adapterFactories[kind] = factory;
}

function normalizeKey(p: string): string {
  const abs = path.resolve(p).split("\\").join("/");
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

export class DebugSessionManager {
  private adapter: DebugAdapter | null = null;
  private adapterKind = "";
  private breakpoints: DebugBreakpoint[] = [];
  private state: DebugRuntimeState = "inactive";
  private seq = 0;

  constructor(private readonly broadcast: DebugBroadcast) {}

  private nextId(): string {
    return `bp-${++this.seq}-${Date.now().toString(36)}`;
  }

  getState(): DebugRuntimeState {
    return this.state;
  }

  getBreakpoints(): DebugBreakpoint[] {
    return this.breakpoints.map((b) => ({ ...b }));
  }

  private setState(state: DebugRuntimeState): void {
    if (this.state === state) return;
    this.state = state;
    this.broadcast({ type: "state", payload: { state } });
  }

  private handleAdapterEvent(event: DebugEventPayload): void {
    switch (event.type) {
      case "state":
        this.setState(event.payload.state);
        break;
      case "paused":
        this.state = "paused";
        break;
      case "resumed":
        this.state = "running";
        break;
      case "exited":
        this.adapter = null;
        this.adapterKind = "";
        this.state = "inactive";
        break;
      default:
        break;
    }
    this.broadcast(event);
  }

  async start(config: DebugConfig): Promise<void> {
    if (this.adapter) {
      try {
        await this.adapter.stop();
      } catch {}
      this.adapter = null;
      this.adapterKind = "";
    }

    const kind = "node";
    const factory = adapterFactories[kind];
    if (!factory) {
      throw new Error(`No debug adapter registered for "${kind}"`);
    }
    this.adapterKind = kind;
    this.setState("starting");
    const adapter = factory(
      {
        ...config,
        initialBreakpoints: this.breakpoints.map((b) => ({ file: b.file, line: b.line })),
      },
      (event) => this.handleAdapterEvent(event),
    );
    this.adapter = adapter;
    try {
      await adapter.start();
    } catch (err) {
      this.adapter = null;
      this.adapterKind = "";
      this.setState("inactive");
      throw err;
    }
    // Re-apply persistent breakpoints for the new session.
    for (const bp of this.breakpoints) {
      try {
        const r = await adapter.setBreakpoint(bp.file, bp.line);
        bp.adapterId = r?.id;
        bp.resolved = r?.resolved ?? false;
        this.broadcast({ type: "breakpointSet", payload: { ...bp } });
      } catch {}
    }
  }

  async stop(): Promise<void> {
    if (this.adapter) {
      try {
        await this.adapter.stop();
      } catch {}
    }
    this.adapter = null;
    this.adapterKind = "";
    this.setState("inactive");
  }

  async pause(): Promise<void> {
    if (!this.adapter) throw new Error("No active debug session");
    await this.adapter.pause();
  }

  async resume(): Promise<void> {
    if (!this.adapter) throw new Error("No active debug session");
    await this.adapter.resume();
  }

  async stepOver(): Promise<void> {
    if (!this.adapter) throw new Error("No active debug session");
    await this.adapter.stepOver();
  }

  async stepInto(): Promise<void> {
    if (!this.adapter) throw new Error("No active debug session");
    await this.adapter.stepInto();
  }

  async stepOut(): Promise<void> {
    if (!this.adapter) throw new Error("No active debug session");
    await this.adapter.stepOut();
  }

  async setBreakpoint(file: string, line: number): Promise<DebugBreakpoint> {
    const key = normalizeKey(file);
    const existing = this.breakpoints.find(
      (b) => normalizeKey(b.file) === key && b.line === line,
    );
    if (existing) return { ...existing };

    const bp: DebugBreakpoint = { id: this.nextId(), file, line, resolved: false };
    this.breakpoints.push(bp);
    if (this.adapter) {
      try {
        const r = await this.adapter.setBreakpoint(bp.file, bp.line);
        bp.adapterId = r?.id;
        bp.resolved = r?.resolved ?? false;
      } catch (err) {
        bp.resolved = false;
      }
    }
    this.broadcast({ type: "breakpointSet", payload: { ...bp } });
    return { ...bp };
  }

  async removeBreakpoint(id: string): Promise<void> {
    const idx = this.breakpoints.findIndex((b) => b.id === id);
    if (idx === -1) return;
    const [bp] = this.breakpoints.splice(idx, 1);
    if (this.adapter && bp.adapterId) {
      try {
        await this.adapter.removeBreakpoint(bp.adapterId);
      } catch {}
    }
    this.broadcast({ type: "breakpointRemoved", payload: { id } });
  }

  async getVariables(frameId: number): Promise<DebugScope[]> {
    if (!this.adapter) return [];
    return this.adapter.getVariables(frameId);
  }

  async expandObject(objectId: string): Promise<DebugScope> {
    if (!this.adapter) return { name: "Properties", variables: [] };
    return this.adapter.expandObject(objectId);
  }

  async evaluate(expression: string): Promise<DebugEvaluatedResult> {
    if (!this.adapter) return { ok: false, value: "", error: "No active debug session" };
    return this.adapter.evaluate(expression);
  }
}