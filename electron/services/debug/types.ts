/**
 * Shared debugger types + the DebugAdapter contract.
 *
 * The `DebugAdapter` interface is the seam that lets future language
 * debuggers plug in (Python, Java, ...). `DebugSessionManager` (adapter.ts)
 * is language-agnostic and only talks to `DebugAdapter`.
 */

export type DebugRuntimeState = "inactive" | "starting" | "running" | "paused";

export interface DebugBreakpoint {
  /** Stable id owned by the session manager (survives sessions). */
  id: string;
  /** Absolute file path. */
  file: string;
  /** 1-based line number. */
  line: number;
  resolved: boolean;
  /** Internal adapter breakpoint id (only meaningful while a session is live). */
  adapterId?: string;
}

export interface DebugVariable {
  name: string;
  /** Human-readable display value. */
  value: string;
  type: string;
  /** Present when the value can be expanded (objects/arrays/functions). */
  objectId?: string;
  expandable: boolean;
}

export interface DebugScope {
  name: string;
  variables: DebugVariable[];
}

export interface DebugFrame {
  /** Index into the current pause's callFrames. */
  frameId: number;
  functionName: string;
  /** Absolute file path when the frame lives in a real file, otherwise the raw url. */
  url: string;
  /** 1-based. */
  line: number;
  column: number;
}

export interface DebugConfig {
  /** Absolute path of the entry script/program. */
  file: string;
  cwd?: string;
  /** Extra args passed to the debuggee after the entry file. */
  args?: string[];
  env?: Record<string, string>;
  /** Breakpoints to bind before the debuggee begins running. */
  initialBreakpoints?: Array<{ file: string; line: number }>;
}

export interface DebugEvaluatedResult {
  ok: boolean;
  value: string;
  error?: string;
}

export type DebugOutputCategory = "stdout" | "stderr" | "console";

export type DebugEventPayload =
  | { type: "state"; payload: { state: DebugRuntimeState } }
  | { type: "paused"; payload: { frames: DebugFrame[]; reason: string } }
  | { type: "resumed"; payload: Record<string, never> }
  | { type: "exited"; payload: { exitCode: number | null } }
  | { type: "output"; payload: { text: string; category: DebugOutputCategory } }
  | { type: "error"; payload: { message: string } }
  | { type: "breakpointSet"; payload: DebugBreakpoint }
  | { type: "breakpointRemoved"; payload: { id: string } };

export interface DebugAdapter {
  readonly kind: string;
  /** Spawn/attach the debuggee and enable debugger capabilities. */
  start(): Promise<void>;
  stop(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stepOver(): Promise<void>;
  stepInto(): Promise<void>;
  stepOut(): Promise<void>;
  /** Returns the adapter-internal breakpoint id (non-null if registered). */
  setBreakpoint(file: string, line: number): Promise<{ id: string; resolved: boolean } | null>;
  removeBreakpoint(adapterId: string): Promise<void>;
  getVariables(frameId: number): Promise<DebugScope[]>;
  expandObject(objectId: string): Promise<DebugScope>;
  evaluate(expression: string): Promise<DebugEvaluatedResult>;
}