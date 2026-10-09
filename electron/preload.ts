import { contextBridge, ipcRenderer, clipboard } from "electron";

export interface AppInfo {
  version: string;
  electron: string;
  node: string;
  chrome: string;
  platform: string;
}

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface RecentProject {
  path: string;
  name: string;
  lastOpened: number;
}

export interface Settings {
  theme: "dark" | "light" | "system";
  editorTheme: string;
  accentColor: string;
  fontSize: number;
  fontFamily: string;
  tabSize: number;
  wordWrap: "off" | "on" | "wordWrapColumn" | "bounded";
  minimap: boolean;
  lineNumbers: boolean;
  showHiddenFiles: boolean;
  fileExcludes: string[];
  autoSave: "off" | "afterDelay";
  autoSaveDelay: number;
  // Phase 14 additions
  cursorBlinking: "blink" | "smooth" | "phase" | "expand" | "solid";
  bracketPairColorization: boolean;
  smoothScrolling: boolean;
  mouseWheelZoom: boolean;
  autoClosingBrackets: "always" | "languageDefined" | "beforeWhitespace" | "never";
  fontLigatures: boolean;
  showStatusBar: boolean;
  terminalFontSize: number;
  terminalCursorBlink: boolean;
  terminalScrollback: number;
  shellPath: string;
  gitEnabled: boolean;
  gitAutoRefresh: boolean;
  languageAutoDetect: boolean;
  defaultLanguage: string;
  formatOnPaste: boolean;
  extensionsDeveloperMode: boolean;
  workspaceExtensionDiscovery: boolean;
  rememberRecentProjects: boolean;
  aiContextAutoInclude: boolean;
  largeFileThreshold: number;
  contentCacheMax: number;
  searchDebounceMs: number;
}

export type SettingValue = string | number | boolean | string[];
export type SettingType = "boolean" | "number" | "enum" | "string" | "stringArray";

export interface SettingDefinition {
  id: string;
  category: string;
  label: string;
  description: string;
  type: SettingType;
  default?: SettingValue;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  external?: "ai";
  keywords?: string[];
}

export interface SettingsCategoryInfo {
  id: string;
  label: string;
  description: string;
}

export interface SettingsSnapshot {
  defaults: Record<string, SettingValue>;
  user: Record<string, SettingValue>;
  workspace: Record<string, SettingValue>;
  effective: Record<string, SettingValue>;
}

export interface CustomThemeMeta {
  name: string;
  type: "dark" | "light";
  scope: "user" | "workspace";
  file: string;
}

export interface SearchOptions {
  isRegex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  include: string;
  exclude: string;
}

export interface SearchResult {
  file: string;
  line: number;
  column: number;
  preview: string;
  lineText: string;
  matchText: string;
  matchLength: number;
}

export interface SearchResponse {
  results: SearchResult[];
  totalFiles: number;
  searchedFiles: number;
  truncated: boolean;
}

export interface FileContent {
  content: string;
  size: number;
  binary: boolean;
}

export type DebugRuntimeState = "inactive" | "starting" | "running" | "paused";

export interface DebugBreakpoint {
  id: string;
  file: string;
  line: number;
  resolved: boolean;
}

export interface DebugVariable {
  name: string;
  value: string;
  type: string;
  objectId?: string;
  expandable: boolean;
}

export interface DebugScope {
  name: string;
  variables: DebugVariable[];
}

export interface DebugFrame {
  frameId: number;
  functionName: string;
  url: string;
  line: number;
  column: number;
}

export interface DebugConfig {
  file: string;
  cwd?: string;
  args?: string[];
  env?: Record<string, string>;
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

// --- AI (Phase 11/12) ---
export type AiProviderType = "local" | "openai" | "custom";
export type AiPermissionMode = "ask" | "allow" | "deny";

export interface AiConfigData {
  provider: AiProviderType;
  baseUrl: string;
  localBaseUrl: string;
  model: string;
  localModel: string;
  temperature: number;
  timeoutMs: number;
  stream: boolean;
  toolMode: "chat" | "agent";
  permissions: Record<string, AiPermissionMode>;
}

export interface AiLocalRuntime {
  name: string;
  baseUrl: string;
  models: string[];
}

// --- Model Manager (Phase 36) ---
export type ProviderApiType = "openai-compatible" | "anthropic" | "google" | "local" | "custom";
export type ProviderPricingTier = "free" | "freemium" | "paid" | "unknown";

export interface ProviderQuotaInfo {
  rpm?: number;
  tpm?: number;
  rpd?: number;
  summary?: string;
}

export interface ProviderModelInfo {
  id: string;
  name: string;
  contextWindow?: number;
  supportsTools?: boolean;
  supportsVision?: boolean;
  pricingTier?: ProviderPricingTier;
  inputCostPer1M?: number;
  outputCostPer1M?: number;
}

export interface ProviderCatalogEntry {
  id: string;
  name: string;
  apiType: ProviderApiType;
  defaultBaseUrl: string;
  transportImplemented: boolean;
  requiresApiKey: boolean;
  pricingTier: ProviderPricingTier;
  quota?: ProviderQuotaInfo;
  knownModels: ProviderModelInfo[];
  defaultModel?: string;
  isLocal: boolean;
  available: boolean;
  description?: string;
  docsUrl?: string;
}

export interface ProviderQuotaInfo {
  rpm?: number;
  tpm?: number;
  rpd?: number;
  summary?: string;
}

export interface ProviderRecord {
  id: string;
  name: string;
  baseUrl: string;
  kind: "local" | "remote";
  model: string;
  builtin: boolean;
  hasKey: boolean;
}

export interface ProviderStatus {
  id: string;
  name: string;
  catalog: ProviderCatalogEntry;
  configured: boolean;
  hasApiKey: boolean;
  currentModel: string;
  availableModels: ProviderModelInfo[];
  configStatus: "not_configured" | "needs_key" | "needs_model" | "ready" | "error";
  error?: string;
}

export interface ModelManagerState {
  activeProviderId: string;
  activeModelId: string;
  providers: ProviderStatus[];
}

export type ModelManagerCatalogEntry = ProviderCatalogEntry;
export type ModelManagerProviderStatus = ProviderStatus;
export type ModelManagerProviderRecord = ProviderRecord;

export interface ResolvedEndpoint {
  url: string;
  model: string;
  key: string | null;
}

export interface AiApprovalRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface AiChatRequest {
  id: string;
  messages: Array<{ role: string; content: string }>;
  context: string;
  workspace: string | null;
}

export type AiChatEvent =
  | { type: "stream"; payload: { id: string; delta: string } }
  | { type: "done"; payload: { id: string; text: string; toolSteps: number } }
  | { type: "agent"; payload: { id: string; note: string } }
  | { type: "tool"; payload: { id: string; tool: string; args: Record<string, unknown>; result: string; granted: boolean } }
  | { type: "approval"; payload: AiApprovalRequest }
  | { type: "compaction"; payload: { id: string; record: CompactionRecord } }
  | { type: "error"; payload: { id: string; message: string } };

// --- Agent runtime (Phase 21) ---

export type AgentStatus =
  | "idle"
  | "starting"
  | "running"
  | "awaiting_approval"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "failed";

export type AgentErrorKind =
  | "config"
  | "network"
  | "auth"
  | "rate_limit"
  | "provider"
  | "timeout"
  | "aborted"
  | "budget"
  | "tool"
  | "internal";

export type AgentStatusKind = "starting" | "thinking" | "acting" | "observing" | "waiting";

export interface AgentErrorInfo {
  kind: AgentErrorKind;
  message: string;
  code?: string | number;
  tool?: string;
  recoverable: boolean;
  at: number;
}

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: AgentToolCall[];
}

export interface AgentTraceEntry {
  at: number;
  kind: "status" | "tool" | "error" | "compaction";
  step: number;
  level?: AgentStatusKind;
  text?: string;
  tool?: string;
  granted?: boolean;
  ms?: number;
}

export interface AgentResult {
  runId: string;
  agentId: string;
  status: "completed" | "cancelled" | "failed";
  text: string;
  steps: number;
  toolCalls: number;
  durationMs: number;
  cancelled: boolean;
  error?: AgentErrorInfo;
}

/**
 * Phase 28. What one context compaction did. Mirrors
 * `electron/services/agent/compaction.ts`.
 */
export interface PreservedCounts {
  decisions: number;
  issues: number;
  toolResults: number;
}

export interface CompactionRecord {
  at: number;
  passes: number;
  step?: number;
  budgetChars: number;
  beforeChars: number;
  afterChars: number;
  beforeMessages: number;
  afterMessages: number;
  digestChars: number;
  kept: PreservedCounts;
  omitted: PreservedCounts;
  digestLines: number;
  digestLinesOmitted: number;
  clampedMessages: number;
  overflow: boolean;
  digest: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  task: string;
  workspace: string | null;
  status: AgentStatus;
  parentRunId: string | null;
  depth: number;
  steps: number;
  toolCalls: number;
  messages: AgentMessage[];
  trace: AgentTraceEntry[];
  result?: AgentResult;
  error?: AgentErrorInfo;
  /** Phase 26. What context this run was given, or absent when context was off. */
  contextSummary?: ContextSummary;
  /** Phase 28. What happened to this run's context. Absent = never over budget. */
  compaction?: CompactionRecord;
  /** Phase 27. The session this run was filed under, if any. */
  sessionId?: string | null;
  createdAt: number;
  updatedAt: number;
}

// --- Context engine (Phase 26) ---
//
// Mirrors `electron/services/agent/types.ts`. The renderer never receives a
// bundle's full text — only bounded previews and exact counts — so these types
// describe everything the panel can show and nothing more.

export type ContextPartKind =
  | "preamble"
  | "instructions"
  | "documentation"
  | "selection"
  | "previousResults"
  | "currentFile"
  | "relevantCode"
  | "diagnostics"
  | "git"
  | "structure"
  | "openFiles";

export interface EditorSelectionSnapshot {
  text: string;
  startLine: number;
  endLine: number;
}

export interface EditorDiagnosticSnapshot {
  file: string;
  line: number;
  severity: string;
  message: string;
}

/**
 * The renderer's view of the editor. Untrusted by the time it reaches the main
 * process, and clamped there before anything reads it.
 */
export interface EditorSnapshot {
  activePath: string | null;
  activeContent: string;
  activeDirty: boolean;
  selection: EditorSelectionSnapshot | null;
  openPaths: string[];
  diagnostics: EditorDiagnosticSnapshot[];
}

export interface ContextFileSummary {
  path: string;
  score: number;
  chars: number;
  included: boolean;
  reason?: string;
}

export interface ContextSummaryPart {
  kind: ContextPartKind;
  label: string;
  chars: number;
  included: boolean;
  truncated: boolean;
  reason?: string;
  preview: string;
  files?: ContextFileSummary[];
}

export interface ContextSummary {
  status: "built" | "cancelled" | "empty";
  totalChars: number;
  budgetChars: number;
  ms: number;
  builtAt: number;
  filesScanned: number;
  filesRanked: number;
  dropped: string[];
  parts: ContextSummaryPart[];
}

// ---------------------------------------------------------------------------
// Phase 27 — persistent AI sessions
//
// Declared here rather than imported, matching how every other contract in this
// file works: the preload bridge is a separate compilation surface, and importing
// a service module into it would drag `fs` and `electron` across the bridge.
// ---------------------------------------------------------------------------

export interface AiSessionTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: number;
}

export interface AiSessionRunRef {
  id: string;
  agentId: string;
  task: string;
  status: AgentStatus;
  steps: number;
  toolCalls: number;
  createdAt: number;
  updatedAt: number;
  parentRunId: string | null;
  depth: number;
  resultText: string;
  error?: string;
  tools: AgentTraceEntry[];
  contextChars?: number;
  contextStatus?: ContextSummary["status"];
}

export interface AiSession {
  version: number;
  id: string;
  name: string;
  workspace: string | null;
  createdAt: number;
  updatedAt: number;
  status: "open" | "closed";
  forkedFrom: string | null;
  turns: AiSessionTurn[];
  runs: AiSessionRunRef[];
  redactions: number;
  truncated: boolean;
}

export interface AiSessionSummary {
  id: string;
  name: string;
  workspace: string | null;
  createdAt: number;
  updatedAt: number;
  status: "open" | "closed";
  forkedFrom: string | null;
  turnCount: number;
  runCount: number;
  toolCallCount: number;
  bytes: number;
  redactions: number;
  truncated: boolean;
  /** The file on disk could not be read. Its bytes are moved aside, not deleted. */
  corrupted: boolean;
  corruptReason?: string;
  corruptFile?: string;
}

/** What a resume replays into the next run's prompt. */
export interface AiSessionHistoryTurn {
  role: "user" | "assistant";
  content: string;
}

// --- Phase 29: persistent AI tasks ---
// Mirrors `electron/services/aiTasks.ts`. The renderer receives full tasks so it
// can render progress and history without re-deriving anything the store owns.

export type TaskStatus = "pending" | "in_progress" | "blocked" | "completed" | "cancelled" | "failed";
export type TaskPriority = "low" | "medium" | "high" | "urgent";

export interface AiTask {
  id: string;
  title: string;
  description: string;
  parentId: string | null;
  dependencies: string[];
  status: TaskStatus;
  priority: TaskPriority;
  progress: number;
  assignee: string | null;
  workspace: string | null;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
  attempts: number;
  lastError: string | null;
  log: string[];
}

export interface AiTaskCreateInput {
  title: string;
  description?: string;
  parentId?: string | null;
  priority?: TaskPriority;
  dependencies?: string[];
  assignee?: string | null;
}

export interface AiTaskUpdateInput {
  title?: string;
  description?: string;
  priority?: TaskPriority;
  status?: TaskStatus;
  progress?: number;
  assignee?: string | null;
  parentId?: string | null;
  dependencies?: string[];
  lastError?: string | null;
}

// --- Phase 30: MCP servers ---
export type McpTransport = "stdio" | "http";
export type McpServerState = "disabled" | "disconnected" | "connecting" | "connected" | "failed";

export interface McpServerView {
  id: string;
  name: string;
  transport: McpTransport;
  enabled: boolean;
  state: McpServerState;
  lastError: string | null;
  server: { name: string; version: string } | null;
  command: string;
  args: string[];
  url: string;
  envKeys: string[];
  headerKeys: string[];
  counts: { tools: number; resources: number; prompts: number };
  createdAt: number;
  updatedAt: number;
}

export interface McpAddInput {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface McpUpdateInput {
  id: string;
  name?: string;
  enabled?: boolean;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnlyHint: boolean;
  destructiveHint: boolean;
}

export interface McpResourceInfo {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface McpPromptInfo {
  name: string;
  description: string;
  arguments: Array<{ name: string; description: string; required: boolean }>;
}

// --- Phase 31: skills & instructions ---
export interface SkillInfo {
  name: string;
  description: string;
  source: "user" | "project";
  allowedTools: string[] | null;
  absolutePath: string;
  chars: number;
}

export interface Skill extends SkillInfo {
  body: string;
}

export interface InstructionFileInfo {
  name: string;
  scope: "user" | "project";
  absolutePath: string;
  chars: number;
  preview: string;
}

// --- Phase 32: web research ---
export type ResearchStatus = "queued" | "running" | "done" | "failed" | "refused";
export type ResearchStepKind = "queries" | "search" | "fetch" | "summarize";

export interface ResearchStepView {
  kind: ResearchStepKind;
  at: number;
  ok: boolean;
  detail: string;
  urls: string[];
  error?: { code: string; message: string };
}

export interface ResearchSourceView {
  url: string;
  title: string;
  kind: "search" | "docs";
  triedAt: number;
  status: "ok" | "failed" | "pending";
  fetchedAt?: number;
  snippet?: string;
  error?: { code: string; message: string };
}

export interface ResearchRecordView {
  id: string;
  question: string;
  focusUrls: string[];
  status: ResearchStatus;
  permission: "ask" | "allow" | "deny";
  awaitingApproval: boolean;
  steps: ResearchStepView[];
  sources: ResearchSourceView[];
  answer: string;
  error?: { code: string; message: string };
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  budget: { queries: number; fetches: number; corpusChars: number; answerChars: number };
}

export interface ResearchStartResult {
  ok: boolean;
  record?: ResearchRecordView;
  awaitingApproval?: boolean;
  refused?: boolean;
  error?: string;
}

// --- Phase 33: natural language command center & autonomous builder ---

export interface CommandCatalogEntry {
  id: string;
  title: string;
  description: string;
  examples: string[];
  keywords: string[];
  agentId: string;
  taskTemplate: string;
  readOnly: boolean;
  categories: string[];
}

export interface CommandRunResult {
  commandId: string;
  title: string;
  agentId: string;
  task: string;
  runId: string;
  readOnly: boolean;
}

export type BuildStatus =
  | "queued"
  | "planning"
  | "awaiting_input"
  | "building"
  | "verifying"
  | "completed"
  | "failed"
  | "refused"
  | "cancelled";

export interface BuildPhaseView {
  kind: "plan" | "question" | "implement" | "verify";
  label: string;
  status: "pending" | "running" | "done" | "failed" | "skipped" | "cancelled";
  at: number;
  endedAt?: number;
  detail: string;
  runId?: string;
}

export interface BuildVerificationEntryView {
  command: string;
  exitCode: number | null;
  ok: boolean;
  output: string;
  skipped: boolean;
  at: number;
}

export interface BuildRecordView {
  id: string;
  request: string;
  note: string;
  workspace: string | null;
  status: BuildStatus;
  plan: string;
  plannerRunId?: string;
  builderRunId?: string;
  phases: BuildPhaseView[];
  verification: BuildVerificationEntryView[];
  changedFiles: string[];
  summary: string;
  runText: string;
  error?: { code: string; message: string };
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface BuildStartResult {
  ok: boolean;
  result?: { id: string; status: BuildStatus };
  error?: string;
}

export interface AgentDefinitionInfo {
  id: string;
  name: string;
  description: string;
  /**
   * Phase 25. `primary` is one a user picks in the selector; `subagent` is a
   * role a parent model delegates to and which cannot be started directly.
   */
  kind?: "primary" | "subagent";
  readOnly?: boolean;
  delegates?: string[];
  /**
   * Phase 25. The role's tool allow-list, when it declares one.
   *
   * Sent by `agent:subagents` so the renderer can show what a role can and
   * cannot do. It is advisory: the runtime enforces the same list, and a
   * renderer that trusted it to *grant* access would be relying on a value the
   * main process is free to ignore.
   */
  tools?: string[];
  maxSteps?: number;
}

export type AgentEvent =
  | { type: "state"; runId: string; status: AgentStatus; previous: AgentStatus; at: number; note?: string }
  | { type: "message"; runId: string; message: AgentMessage }
  | { type: "delta"; runId: string; step: number; delta: string }
  | { type: "status"; runId: string; step: number; level: AgentStatusKind; text: string }
  | {
      type: "tool";
      runId: string;
      step: number;
      tool: string;
      args: Record<string, unknown>;
      result: string;
      granted: boolean;
      ms: number;
    }
  | { type: "approval"; runId: string; id: string; tool: string; category: string; args: Record<string, unknown> }
  | { type: "error"; runId: string; error: AgentErrorInfo }
  | { type: "compaction"; runId: string; step: number; record: CompactionRecord }
  | { type: "result"; runId: string; result: AgentResult };

export interface AgentPendingApproval {
  id: string;
  runId: string;
  category: string;
  args: Record<string, unknown>;
  // Phase 23. What the prompt is actually asking permission for, so the banner
  // can name the operation instead of only the tool.
  tool: string;
  capabilities: string[];
  capabilityLabels: string[];
  destructive: boolean;
  escalation?: { capability: string; mode: "ask" | "deny"; reason: string };
}

export type AgentPermissionScope =
  | { kind: "global" }
  | { kind: "project"; root: string }
  | { kind: "agent"; agentId: string }
  | { kind: "path"; path: string };

/**
 * One row of the permission matrix.
 *
 * `effective` is what the gate will do. `own` is the rule stored in the scope
 * being edited, and they differ whenever a narrower scope is overriding a broader
 * one — which is the situation a user most needs to see spelled out.
 */
export interface AgentPermissionRow {
  capability: string;
  label: string;
  description: string;
  effective: "allow" | "ask" | "deny";
  own: "allow" | "ask" | "deny" | null;
  irreversible: boolean;
  available: boolean;
}

// --- Extensions (Phase 13) ---
export interface ExtensionCommandData {
  id: string;
  title: string;
}

export interface ExtensionInfo {
  id: string;
  name: string;
  displayName: string;
  version: string;
  description: string;
  publisher: string;
  enabled: boolean;
  permissions: string[];
  commands: ExtensionCommandData[];
  main: string | null;
  dir: string;
  loadError: string | null;
  warnings: string[];
  incompatible: boolean;
}

// --- Phase 17: crash/error logging ---
export interface ErrorLogEntry {
  timestamp: number;
  process: "main" | "renderer";
  type: "uncaught" | "unhandled" | "crash" | "render-process-gone"
    | "child-process-gone" | "ipc" | "save" | "other";
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
}

export interface SessionState {
  root: string | null;
  name: string;
  tabs: Array<{ path: string; name: string; size: number; dirty: boolean }>;
  activePath: string | null;
  openedAt: number;
}

const api = {
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke("get-app-info"),
  getSettings: (): Promise<Settings> => ipcRenderer.invoke("get-settings"),
  saveSettings: (settings: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke("save-settings", settings),

  // --- Settings system (Phase 14) ---
  getSettingCategories: (): Promise<{ categories: SettingsCategoryInfo[]; definitions: SettingDefinition[] }> =>
    ipcRenderer.invoke("settings:get-categories"),
  getAllSettings: (): Promise<SettingsSnapshot & { hasWorkspace: boolean }> =>
    ipcRenderer.invoke("settings:get-all"),
  saveUserSetting: (patch: Record<string, unknown>): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }> =>
    ipcRenderer.invoke("settings:save-user", patch ?? {}),
  saveWorkspaceSetting: (patch: Record<string, unknown>): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }> =>
    ipcRenderer.invoke("settings:save-workspace", patch ?? {}),
  resetUserSettings: (): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }> =>
    ipcRenderer.invoke("settings:reset-user"),
  resetWorkspaceSettings: (): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }> =>
    ipcRenderer.invoke("settings:reset-workspace"),
  onSettingsChanged: (callback: () => void): (() => void) => {
    const listener = (): void => callback();
    ipcRenderer.on("settings:changed", listener);
    return () => ipcRenderer.removeListener("settings:changed", listener);
  },

  // --- Themes (Phase 15) ---
  listCustomThemes: (): Promise<CustomThemeMeta[]> => ipcRenderer.invoke("themes:list-custom"),
  readCustomTheme: (file: string): Promise<{ ok: boolean; theme?: unknown; error?: string }> =>
    ipcRenderer.invoke("themes:read", file),

  openFileDialog: (): Promise<{ filePath: string; content: string } | null> =>
    ipcRenderer.invoke("open-file-dialog"),
  getPlatform: (): Promise<string> => ipcRenderer.invoke("get-platform"),

  // --- Workspace ---
  openFolder: (rootPath?: string): Promise<{ ok: boolean; result?: { root: string; name: string } | null; error?: string }> =>
    ipcRenderer.invoke("workspace:open-folders", rootPath),
  getWorkspaceState: (): Promise<{ root: string | null; name: string }> =>
    ipcRenderer.invoke("workspace:get-state"),
  getRecentProjects: (): Promise<RecentProject[]> =>
    ipcRenderer.invoke("workspace:get-recent"),
  removeRecentProject: (p: string): Promise<void> =>
    ipcRenderer.invoke("workspace:remove-recent", p),
  clearRecentProjects: (): Promise<void> =>
    ipcRenderer.invoke("workspace:clear-recent"),

  // --- Phase 17: crash reporting & session ---
  captureError: (entry: Omit<ErrorLogEntry, "timestamp">): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("error:log", entry),
  sessionHeartbeat: (session: SessionState): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("session:save", session),
  sessionLoad: (): Promise<SessionState | null> =>
    ipcRenderer.invoke("session:load"),
  /** Phase 20: wipe the persisted session (used when the workspace is closed, so
   *  the next launch does not restore tabs from a folder that is gone). */
  sessionClear: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("session:clear"),
  sessionRecovery: (): Promise<{ hasRecovery: boolean; root: string | null; tabs: number; activePath: string | null }> =>
    ipcRenderer.invoke("session:recovery"),
  acceptRecovery: (): Promise<{ ok: boolean; session: SessionState | null }> =>
    ipcRenderer.invoke("session:accept-recovery"),
  dismissRecovery: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("session:dismiss-recovery"),
  loadErrors: (since?: number): Promise<ErrorLogEntry[]> =>
    ipcRenderer.invoke("error:load", since),

  // --- Phase 27: persistent AI sessions ---
  // One channel per operation rather than one channel with an action string, so a
  // typo in an action name is a type error instead of a runtime no-op.
  aiSessionsList: (): Promise<{ ok: boolean; sessions?: AiSessionSummary[]; error?: string }> =>
    ipcRenderer.invoke("session:ai:list"),
  /** `name` omitted gets a dated default; `workspace` is recorded, never copied. */
  aiSessionCreate: (
    opts?: { name?: string; workspace?: string | null },
  ): Promise<{ ok: boolean; session?: AiSession; history?: AiSessionHistoryTurn[]; error?: string }> =>
    ipcRenderer.invoke("session:ai:create", opts ?? {}),
  /** No `id` opens whichever session was last active — what a launch wants. */
  aiSessionOpen: (
    opts?: { id?: string; activate?: boolean },
  ): Promise<{ ok: boolean; session?: AiSession; history?: AiSessionHistoryTurn[]; summary?: AiSessionSummary; error?: string }> =>
    ipcRenderer.invoke("session:ai:open", opts ?? {}),
  /** Rename and/or close in one call; send only the field you mean to change. */
  aiSessionUpdate: (
    opts: { id: string; name?: string; status?: "open" | "closed" },
  ): Promise<{ ok: boolean; sessions?: AiSessionSummary[]; error?: string }> =>
    ipcRenderer.invoke("session:ai:update", opts),
  /** Removes the session and its backup. Irreversible — the UI confirms first. */
  aiSessionDelete: (
    opts: { id: string },
  ): Promise<{ ok: boolean; sessions?: AiSessionSummary[]; error?: string }> =>
    ipcRenderer.invoke("session:ai:delete", opts),
  /** Deep, independent copy with its own id. Editing it cannot touch the original. */
  aiSessionFork: (
    opts: { id: string; name?: string },
  ): Promise<{ ok: boolean; session?: AiSession; history?: AiSessionHistoryTurn[]; error?: string }> =>
    ipcRenderer.invoke("session:ai:fork", opts),
  /** Called for every finished chat message so the conversation survives a crash. */
  aiSessionTurn: (
    opts: { id: string; role: string; text: string; turnId?: string },
  ): Promise<{ ok: boolean; name?: string; error?: string }> =>
    ipcRenderer.invoke("session:ai:turn", opts),
  /** Pushed after any session mutation, so both windows stay in step. */
  onAiSessionChanged: (cb: (payload: { activeId: string | null; sessions: AiSessionSummary[] }) => void) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      payload: { activeId: string | null; sessions: AiSessionSummary[] },
    ): void => cb(payload);
    ipcRenderer.on("session:ai:changed", listener);
    return () => ipcRenderer.removeListener("session:ai:changed", listener);
  },

  // --- Phase 29: persistent AI tasks ---
  aiTasksList: (
    workspace: string | null,
  ): Promise<{ ok: boolean; tasks?: AiTask[]; error?: string; corrupted?: boolean; corruptFile?: string }> =>
    ipcRenderer.invoke("task:ai:list", { workspace }),
  aiTaskCreate: (
    opts: { workspace: string | null; input: AiTaskCreateInput },
  ): Promise<{ ok: boolean; task?: AiTask; error?: string }> =>
    ipcRenderer.invoke("task:ai:create", opts),
  aiTaskUpdate: (
    opts: { workspace: string | null; id: string; patch: AiTaskUpdateInput },
  ): Promise<{ ok: boolean; task?: AiTask; error?: string }> =>
    ipcRenderer.invoke("task:ai:update", opts),
  aiTaskDelete: (opts: { workspace: string | null; id: string }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("task:ai:delete", opts),
  aiTaskCancel: (
    opts: { workspace: string | null; id: string; reason?: string },
  ): Promise<{ ok: boolean; task?: AiTask; error?: string }> =>
    ipcRenderer.invoke("task:ai:cancel", opts),
  aiTaskRetry: (opts: { workspace: string | null; id: string }): Promise<{ ok: boolean; task?: AiTask; error?: string }> =>
    ipcRenderer.invoke("task:ai:retry", opts),
  aiTaskAssign: (
    opts: { workspace: string | null; id: string; assignee: string | null },
  ): Promise<{ ok: boolean; task?: AiTask; error?: string }> =>
    ipcRenderer.invoke("task:ai:assign", opts),
  /** Pushed after any task mutation for this workspace, so both windows stay in step. */
  onAiTaskChanged: (cb: (payload: { workspace: string | null; tasks: AiTask[] }) => void) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      payload: { workspace: string | null; tasks: AiTask[] },
    ): void => cb(payload);
    ipcRenderer.on("task:ai:changed", listener);
    return () => ipcRenderer.removeListener("task:ai:changed", listener);
  },

  // --- Phase 30: MCP servers ---
  mcpList: (): Promise<{ ok: boolean; servers?: McpServerView[]; error?: string }> => ipcRenderer.invoke("mcp:list"),
  mcpAdd: (input: McpAddInput): Promise<{ ok: boolean; server?: McpServerView; error?: string }> =>
    ipcRenderer.invoke("mcp:add", input),
  mcpUpdate: (input: McpUpdateInput): Promise<{ ok: boolean; server?: McpServerView; error?: string }> =>
    ipcRenderer.invoke("mcp:update", input),
  mcpRemove: (id: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("mcp:remove", { id }),
  mcpReconnect: (id: string): Promise<{ ok: boolean; server?: McpServerView; error?: string }> =>
    ipcRenderer.invoke("mcp:reconnect", { id }),
  mcpTools: (id: string): Promise<{ ok: boolean; tools?: McpToolInfo[]; error?: string }> =>
    ipcRenderer.invoke("mcp:tools", { id }),
  mcpResources: (id: string): Promise<{ ok: boolean; resources?: McpResourceInfo[]; error?: string }> =>
    ipcRenderer.invoke("mcp:resources", { id }),
  mcpPrompts: (id: string): Promise<{ ok: boolean; prompts?: McpPromptInfo[]; error?: string }> =>
    ipcRenderer.invoke("mcp:prompts", { id }),
  mcpReadResource: (id: string, uri: string): Promise<{ ok: boolean; text?: string; error?: string }> =>
    ipcRenderer.invoke("mcp:read-resource", { id, uri }),
  mcpGetPrompt: (
    id: string,
    name: string,
    args: Record<string, string>,
  ): Promise<{ ok: boolean; messages?: Array<{ role: string; text: string }>; error?: string }> =>
    ipcRenderer.invoke("mcp:get-prompt", { id, name, args }),
  /** Pushed on any MCP state change — config, lifecycle, discovery. */
  onMcpChanged: (cb: (payload: { servers: McpServerView[] }) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: { servers: McpServerView[] }): void => cb(payload);
    ipcRenderer.on("mcp:changed", listener);
    return () => ipcRenderer.removeListener("mcp:changed", listener);
  },

  // --- Phase 31: skills & instructions ---
  skillsList: (workspace: string | null): Promise<{ ok: boolean; skills?: SkillInfo[]; error?: string }> =>
    ipcRenderer.invoke("skills:list", { workspace }),
  skillsRead: (workspace: string | null, name: string): Promise<{ ok: boolean; skill?: Skill; error?: string }> =>
    ipcRenderer.invoke("skills:read", { workspace, name }),
  instructionsList: (workspace: string | null): Promise<{ ok: boolean; files?: InstructionFileInfo[]; error?: string }> =>
    ipcRenderer.invoke("instructions:list", { workspace }),

  // --- Phase 32: web research ---
  researchStart: (input: { question: string; focusUrls?: string[] }): Promise<ResearchStartResult> =>
    ipcRenderer.invoke("research:start", input),
  researchList: (): Promise<{ ok: boolean; records?: ResearchRecordView[]; error?: string }> =>
    ipcRenderer.invoke("research:list"),
  researchGet: (id: string): Promise<{ ok: boolean; record?: ResearchRecordView; error?: string }> =>
    ipcRenderer.invoke("research:get", { id }),
  researchRespond: (id: string, approved: boolean): Promise<{ ok: boolean; record?: ResearchRecordView; error?: string }> =>
    ipcRenderer.invoke("research:respond", { id, approved }),
  /** Pushed on every research record change — start, step, failure, approval. */
  onResearchEvent: (cb: (payload: { type: string; record: ResearchRecordView }) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: { type: string; record: ResearchRecordView }): void => cb(payload);
    ipcRenderer.on("research:event", listener);
    return () => ipcRenderer.removeListener("research:event", listener);
  },

  // --- Phase 33: natural language command center & autonomous builder ---
  commandCatalog: (): Promise<{ ok: boolean; result?: CommandCatalogEntry[]; error?: string }> =>
    ipcRenderer.invoke("command:catalog"),
  commandRun: (input: { request: string; workspace?: string | null; sessionId?: string | null }): Promise<
    { ok: boolean; result?: CommandRunResult; error?: string }
  > => ipcRenderer.invoke("command:run", input),
  buildStart: (input: { request: string; note?: string; workspace?: string | null; sessionId?: string | null }): Promise<
    { ok: boolean; result?: BuildStartResult; error?: string }
  > => ipcRenderer.invoke("build:start", input),
  buildList: (): Promise<{ ok: boolean; records?: BuildRecordView[]; error?: string }> =>
    ipcRenderer.invoke("build:list"),
  buildGet: (id: string): Promise<{ ok: boolean; record?: BuildRecordView; error?: string }> =>
    ipcRenderer.invoke("build:get", { id }),
  buildRespond: (id: string, approved: boolean, note?: string): Promise<
    { ok: boolean; result?: BuildStartResult; error?: string }
  > => ipcRenderer.invoke("build:respond", { id, approved, note }),
  buildCancel: (id: string): Promise<{ ok: boolean; result?: BuildStartResult; error?: string }> =>
    ipcRenderer.invoke("build:cancel", { id }),
  /** Pushed on every build record change — start, plan, approval, verification. */
  onBuildEvent: (cb: (payload: { type: string; record: BuildRecordView }) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: { type: string; record: BuildRecordView }): void => cb(payload);
    ipcRenderer.on("build:event", listener);
    return () => ipcRenderer.removeListener("build:event", listener);
  },

  // --- FS Operations ---
  listDir: (dirPath: string): Promise<{ ok: boolean; result?: DirEntry[]; error?: string }> =>
    ipcRenderer.invoke("fs:list-dir", dirPath),
  createFile: (dirPath: string, name: string): Promise<{ ok: boolean; result?: string; error?: string }> =>
    ipcRenderer.invoke("fs:create-file", dirPath, name),
  createFolder: (dirPath: string, name: string): Promise<{ ok: boolean; result?: string; error?: string }> =>
    ipcRenderer.invoke("fs:create-folder", dirPath, name),
  renameItem: (oldPath: string, newName: string): Promise<{ ok: boolean; result?: string; error?: string }> =>
    ipcRenderer.invoke("fs:rename-item", oldPath, newName),
  deleteItem: (itemPath: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("fs:delete-item", itemPath),
  moveItem: (src: string, destDir: string): Promise<{ ok: boolean; result?: string; error?: string }> =>
    ipcRenderer.invoke("fs:move-item", src, destDir),
  moveDialog: (src: string): Promise<{ ok: boolean; result?: string | null; error?: string }> =>
    ipcRenderer.invoke("fs:move-dialog", src),
  readFile: (filePath: string): Promise<{ ok: boolean; result?: FileContent; error?: string }> =>
    ipcRenderer.invoke("fs:read-file", filePath),
  writeFile: (filePath: string, content: string): Promise<{ error: string | null }> =>
    ipcRenderer.invoke("write-file", filePath, content),

  copyToClipboard: (text: string): void => clipboard.writeText(text),
  readClipboard: (): string => clipboard.readText(),

  saveAsDialog: (suggestedName?: string): Promise<{ path: string | null; error: string | null }> =>
    ipcRenderer.invoke("save-as-dialog", suggestedName),

  // --- Terminal ---
  terminalCreate: (opts: { cwd?: string; cols?: number; rows?: number; shell?: string }): Promise<{ ok: boolean; result?: { id: string; shell: string; cwd: string; cols: number; rows: number; isPty: boolean }; error?: string }> =>
    ipcRenderer.invoke("terminal:create", opts),
  terminalWrite: (id: string, data: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("terminal:write", id, data),
  terminalResize: (id: string, cols: number, rows: number): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("terminal:resize", id, cols, rows),
  terminalKill: (id: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("terminal:kill", id),
  terminalKillAll: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("terminal:kill-all"),
  terminalRestart: (id: string): Promise<{ ok: boolean; result?: { id: string; shell: string; cwd: string; cols: number; rows: number; isPty: boolean }; error?: string }> =>
    ipcRenderer.invoke("terminal:restart", id),
  terminalList: (): Promise<{ ok: boolean; result?: Array<{ id: string; shell: string; cwd: string; cols: number; rows: number; isPty: boolean }>; error?: string }> =>
    ipcRenderer.invoke("terminal:list"),
  terminalClear: (id: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("terminal:clear", id),
  onTerminalData: (callback: (data: { id: string; data: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: { id: string; data: string }): void => callback(payload);
    ipcRenderer.on("terminal:data", handler);
    return () => ipcRenderer.removeListener("terminal:data", handler);
  },
  onTerminalExit: (callback: (data: { id: string; exitCode: number }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: { id: string; exitCode: number }): void => callback(payload);
    ipcRenderer.on("terminal:exit", handler);
    return () => ipcRenderer.removeListener("terminal:exit", handler);
  },
  checkLSP: (command: string): Promise<{ found: boolean }> => ipcRenderer.invoke("lsp:check", command),

  // --- Git ---
  gitIsRepo: (cwd: string): Promise<{ ok: boolean; result?: boolean; error?: string }> => ipcRenderer.invoke("git:isRepo", cwd),
  gitStatus: (cwd: string): Promise<{ ok: boolean; result?: import("../electron/services/git").GitStatus; error?: string }> => ipcRenderer.invoke("git:status", cwd),
  gitStage: (cwd: string, files: string[]): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("git:stage", cwd, files),
  gitUnstage: (cwd: string, files: string[]): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("git:unstage", cwd, files),
  gitStageAll: (cwd: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("git:stageAll", cwd),
  gitCommit: (cwd: string, message: string): Promise<{ ok: boolean; result?: { hash: string }; error?: string }> => ipcRenderer.invoke("git:commit", cwd, message),
  gitBranches: (cwd: string): Promise<{ ok: boolean; result?: import("../electron/services/git").GitBranch[]; error?: string }> => ipcRenderer.invoke("git:branches", cwd),
  gitCreateBranch: (cwd: string, name: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("git:createBranch", cwd, name),
  gitSwitchBranch: (cwd: string, name: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("git:switchBranch", cwd, name),
  gitPull: (cwd: string): Promise<{ ok: boolean; result?: string; error?: string }> => ipcRenderer.invoke("git:pull", cwd),
  gitPush: (cwd: string, setUpstream?: boolean): Promise<{ ok: boolean; result?: string; error?: string }> => ipcRenderer.invoke("git:push", cwd, setUpstream),
  gitFetch: (cwd: string): Promise<{ ok: boolean; result?: string; error?: string }> => ipcRenderer.invoke("git:fetch", cwd),
  gitDiff: (cwd: string, filePath?: string, staged?: boolean): Promise<{ ok: boolean; result?: string; error?: string }> => ipcRenderer.invoke("git:diff", cwd, filePath, staged),
  gitFileHistory: (cwd: string, filePath: string, limit?: number): Promise<{ ok: boolean; result?: import("../electron/services/git").GitLogEntry[]; error?: string }> => ipcRenderer.invoke("git:fileHistory", cwd, filePath, limit),
  gitLog: (cwd: string, limit?: number): Promise<{ ok: boolean; result?: import("../electron/services/git").GitLogEntry[]; error?: string }> => ipcRenderer.invoke("git:log", cwd, limit),
  gitCheckInstalled: (): Promise<{ ok: boolean; result?: boolean; error?: string }> => ipcRenderer.invoke("git:checkInstalled"),

  // --- Phase 34: AI Diff Review + Checkpoints ---
  gitDiffParsed: (cwd: string, filePath?: string, staged?: boolean): Promise<{ ok: boolean; result?: import("../electron/services/aiDiff").FileDiff[]; error?: string }> => ipcRenderer.invoke("git:diffParsed", cwd, filePath, staged),
  gitDiffSummary: (cwd: string, filePath?: string, staged?: boolean): Promise<{ ok: boolean; result?: string; error?: string }> => ipcRenderer.invoke("git:diffSummary", cwd, filePath, staged),
  gitCheckpointCreate: (cwd: string, name: string, type?: "commit" | "tag" | "stash", message?: string): Promise<{ ok: boolean; result?: import("../electron/services/aiDiff").Checkpoint; error?: string }> => ipcRenderer.invoke("git:checkpointCreate", cwd, name, type, message),
  gitCheckpointList: (cwd: string): Promise<{ ok: boolean; result?: import("../electron/services/aiDiff").Checkpoint[]; error?: string }> => ipcRenderer.invoke("git:checkpointList", cwd),
  gitCheckpointGet: (cwd: string, id: string): Promise<{ ok: boolean; result?: import("../electron/services/aiDiff").Checkpoint; error?: string }> => ipcRenderer.invoke("git:checkpointGet", cwd, id),
  gitCheckpointRestore: (cwd: string, id: string, mode?: "hard" | "soft" | "mixed"): Promise<{ ok: boolean; result?: { success: boolean; error?: string }; error?: string }> => ipcRenderer.invoke("git:checkpointRestore", cwd, id, mode),
  gitCheckpointCompare: (cwd: string, id: string): Promise<{ ok: boolean; result?: import("../electron/services/aiDiff").CheckpointCompareResult; error?: string }> => ipcRenderer.invoke("git:checkpointCompare", cwd, id),
  gitAcceptChanges: (cwd: string, files: string[]): Promise<{ ok: boolean; result?: { success: boolean; error?: string }; error?: string }> => ipcRenderer.invoke("git:acceptChanges", cwd, files),
  gitRejectChanges: (cwd: string, files: string[]): Promise<{ ok: boolean; result?: { success: boolean; error?: string }; error?: string }> => ipcRenderer.invoke("git:rejectChanges", cwd, files),

  // --- Debug (Phase 10) ---
  debugStart: (config: DebugConfig): Promise<{ ok: boolean; result?: { state: DebugRuntimeState }; error?: string }> =>
    ipcRenderer.invoke("debug:start", config),
  debugStop: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("debug:stop"),
  debugPause: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("debug:pause"),
  debugContinue: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("debug:continue"),
  debugStepOver: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("debug:stepOver"),
  debugStepInto: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("debug:stepInto"),
  debugStepOut: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("debug:stepOut"),
  debugSetBreakpoint: (file: string, line: number): Promise<{ ok: boolean; result?: DebugBreakpoint; error?: string }> =>
    ipcRenderer.invoke("debug:setBreakpoint", file, line),
  debugRemoveBreakpoint: (id: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("debug:removeBreakpoint", id),
  debugGetBreakpoints: (): Promise<{ ok: boolean; result?: DebugBreakpoint[]; error?: string }> =>
    ipcRenderer.invoke("debug:getBreakpoints"),
  debugGetVariables: (opts: { frameId?: number; objectId?: string }): Promise<{ ok: boolean; result?: { scopes: DebugScope[] }; error?: string }> =>
    ipcRenderer.invoke("debug:getVariables", opts),
  debugEvaluate: (expression: string): Promise<{ ok: boolean; result?: { value: string }; error?: string }> =>
    ipcRenderer.invoke("debug:evaluate", expression),
  debugGetState: (): Promise<{ ok: boolean; result?: { state: DebugRuntimeState }; error?: string }> =>
    ipcRenderer.invoke("debug:getState"),
  onDebugEvent: (callback: (ev: DebugEventPayload) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: DebugEventPayload): void => callback(payload);
    ipcRenderer.on("debug:event", handler);
    return () => ipcRenderer.removeListener("debug:event", handler);
  },

  // --- Search ---
  searchWorkspace: (root: string, query: string, opts: SearchOptions): Promise<{ ok: boolean; result?: SearchResponse; error?: string }> =>
    ipcRenderer.invoke("search:workspace", root, query, opts),
  replaceInFile: (filePath: string, query: string, replacement: string, opts: SearchOptions): Promise<{ ok: boolean; result?: { count: number }; error?: string }> =>
    ipcRenderer.invoke("search:replace-file", filePath, query, replacement, opts),
  replaceAll: (root: string, query: string, replacement: string, opts: SearchOptions): Promise<{ ok: boolean; result?: { replacedCount: number; fileCount: number }; error?: string }> =>
    ipcRenderer.invoke("search:replace-all", root, query, replacement, opts),

  // --- Menu events ---
  onMenuNewFile: (callback: () => void) => {
    const handler = (): void => callback();
    ipcRenderer.on("menu:new-file", handler);
    return () => ipcRenderer.removeListener("menu:new-file", handler);
  },
  onMenuSave: (callback: () => void) => {
    const handler = (): void => callback();
    ipcRenderer.on("menu:save", handler);
    return () => ipcRenderer.removeListener("menu:save", handler);
  },
  onMenuSaveAs: (callback: () => void) => {
    const handler = (): void => callback();
    ipcRenderer.on("menu:save-as", handler);
    return () => ipcRenderer.removeListener("menu:save-as", handler);
  },
  onFileOpened: (callback: (data: { filePath: string; content: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { filePath: string; content: string }): void => callback(data);
    ipcRenderer.on("file:opened", handler);
    return () => ipcRenderer.removeListener("file:opened", handler);
  },
  onWorkspaceOpened: (callback: (data: { root: string; name: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { root: string; name: string }): void => callback(data);
    ipcRenderer.on("workspace:opened", handler);
    return () => ipcRenderer.removeListener("workspace:opened", handler);
  },

  // --- AI (Phase 11/12) ---
  aiGetConfig: (): Promise<{ ok: boolean; result?: { config: AiConfigData; apiKeys: Record<string, boolean> }; error?: string }> =>
    ipcRenderer.invoke("ai:get-config"),
  aiSaveConfig: (patch: Partial<AiConfigData>): Promise<{ ok: boolean; result?: { config: AiConfigData; apiKeys: Record<string, boolean> }; error?: string }> =>
    ipcRenderer.invoke("ai:save-config", patch),
  aiSetApiKey: (provider: string, key: string): Promise<{ ok: boolean; result?: { has: boolean }; error?: string }> =>
    ipcRenderer.invoke("ai:set-api-key", provider, key),
  aiClearApiKey: (provider: string): Promise<{ ok: boolean; result?: { has: boolean }; error?: string }> =>
    ipcRenderer.invoke("ai:clear-api-key", provider),
  aiModels: (): Promise<{ ok: boolean; result?: { models: string[] }; error?: string }> =>
    ipcRenderer.invoke("ai:models"),
  aiDetectLocal: (baseUrl?: string): Promise<{ ok: boolean; result?: { found: boolean; runtimes: AiLocalRuntime[] }; error?: string }> =>
    ipcRenderer.invoke("ai:detect-local", baseUrl),
  aiChat: (req: AiChatRequest): Promise<{ ok: boolean; result?: { text: string; toolSteps: number }; error?: string }> =>
    ipcRenderer.invoke("ai:chat", req),
  aiRespondApproval: (id: string, approved: boolean): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("ai:approval-response", id, approved),
  onAiEvent: (callback: (ev: AiChatEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: AiChatEvent): void => callback(payload);
    ipcRenderer.on("ai:event", handler);
    return () => ipcRenderer.removeListener("ai:event", handler);
  },

  // --- Model Manager (Phase 36) ---
  modelManagerCatalog: (): Promise<{ ok: boolean; result?: ModelManagerCatalogEntry[]; error?: string }> =>
    ipcRenderer.invoke("modelManager:catalog"),
  modelManagerCatalogAll: (): Promise<{ ok: boolean; result?: ModelManagerCatalogEntry[]; error?: string }> =>
    ipcRenderer.invoke("modelManager:catalogAll"),
  modelManagerCatalogEntry: (id: string): Promise<{ ok: boolean; result?: ModelManagerCatalogEntry; error?: string }> =>
    ipcRenderer.invoke("modelManager:catalogEntry", id),
  modelManagerCatalogFree: (): Promise<{ ok: boolean; result?: ModelManagerCatalogEntry[]; error?: string }> =>
    ipcRenderer.invoke("modelManager:catalogFree"),
  modelManagerCatalogLocal: (): Promise<{ ok: boolean; result?: ModelManagerCatalogEntry[]; error?: string }> =>
    ipcRenderer.invoke("modelManager:catalogLocal"),
  modelManagerCatalogRemote: (): Promise<{ ok: boolean; result?: ModelManagerCatalogEntry[]; error?: string }> =>
    ipcRenderer.invoke("modelManager:catalogRemote"),
  modelManagerState: (): Promise<{ ok: boolean; result?: ModelManagerState; error?: string }> =>
    ipcRenderer.invoke("modelManager:state"),
  modelManagerActiveProvider: (): Promise<{ ok: boolean; result?: ModelManagerProviderStatus; error?: string }> =>
    ipcRenderer.invoke("modelManager:activeProvider"),
  modelManagerActiveModel: (): Promise<{ ok: boolean; result?: string; error?: string }> =>
    ipcRenderer.invoke("modelManager:activeModel"),
  modelManagerProvider: (id: string): Promise<{ ok: boolean; result?: ModelManagerProviderStatus; error?: string }> =>
    ipcRenderer.invoke("modelManager:provider", id),
  modelManagerAllProviders: (): Promise<{ ok: boolean; result?: ModelManagerProviderStatus[]; error?: string }> =>
    ipcRenderer.invoke("modelManager:allProviders"),
  modelManagerConfiguredProviders: (): Promise<{ ok: boolean; result?: ModelManagerProviderStatus[]; error?: string }> =>
    ipcRenderer.invoke("modelManager:configuredProviders"),
  modelManagerSetActiveProvider: (providerId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("modelManager:setActiveProvider", providerId),
  modelManagerSetActiveModel: (providerId: string, modelId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("modelManager:setActiveModel", providerId, modelId),
  modelManagerAddProvider: (input: { id: string; name: string; baseUrl: string; apiType: string; model?: string }): Promise<{ ok: boolean; error?: string; provider?: ModelManagerProviderRecord }> =>
    ipcRenderer.invoke("modelManager:addProvider", input),
  modelManagerUpdateProvider: (id: string, patch: { name?: string; baseUrl?: string; model?: string }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("modelManager:updateProvider", id, patch),
  modelManagerDeleteProvider: (id: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("modelManager:deleteProvider", id),
  modelManagerSetApiKey: (providerId: string, key: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("modelManager:setApiKey", providerId, key),
  modelManagerClearApiKey: (providerId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("modelManager:clearApiKey", providerId),
  modelManagerHasApiKey: (providerId: string): Promise<{ ok: boolean; result?: boolean; error?: string }> =>
    ipcRenderer.invoke("modelManager:hasApiKey", providerId),
  modelManagerResolvedEndpoint: (): Promise<{ ok: boolean; result?: ResolvedEndpoint; error?: string }> =>
    ipcRenderer.invoke("modelManager:resolvedEndpoint"),
  modelManagerProviderRecords: (): Promise<{ ok: boolean; result?: ModelManagerProviderRecord[]; error?: string }> =>
    ipcRenderer.invoke("modelManager:providerRecords"),
  modelManagerActiveProviderLegacy: (): Promise<{ ok: boolean; result?: { provider: string; model: string }; error?: string }> =>
    ipcRenderer.invoke("modelManager:activeProviderLegacy"),
  modelManagerHasApiKeyLegacy: (provider: string): Promise<{ ok: boolean; result?: boolean; error?: string }> =>
    ipcRenderer.invoke("modelManager:hasApiKeyLegacy", provider),

  // --- Agent runtime (Phase 21) ---
  agentDefinitions: (): Promise<{ ok: boolean; result?: AgentDefinitionInfo[]; error?: string }> =>
    ipcRenderer.invoke("agent:definitions"),
  // Phase 25. Roles a parent model delegates to. Separate from
  // `agentDefinitions` because these are not user-selectable: the agent picker
  // must keep offering exactly the four primaries.
  agentSubagents: (): Promise<{ ok: boolean; result?: AgentDefinitionInfo[]; error?: string }> =>
    ipcRenderer.invoke("agent:subagents"),
  agentStart: (
    payload: {
      agentId: string;
      task: string;
      context?: string;
      contextEnabled?: boolean;
      snapshot?: EditorSnapshot;
      // Phase 27. `sessionId` files the run against a stored conversation;
      // `history` replays that conversation so the run continues rather than
      // restarts. The main process clamps both before either reaches a prompt.
      sessionId?: string;
      history?: Array<{ role: "user" | "assistant"; content: string }>;
    },
  ): Promise<{ ok: boolean; result?: { runId: string; context: ContextSummary | null }; error?: string }> =>
    ipcRenderer.invoke("agent:start", payload),
  // Phase 26. Assemble or re-assemble context without starting a run. `force`
  // is what Rebuild sends; omitting `task` means "the task you last looked at".
  agentContextBuild: (
    payload: { task?: string; agentId?: string; snapshot?: EditorSnapshot; force?: boolean },
  ): Promise<{ ok: boolean; result?: ContextSummary; error?: string }> =>
    ipcRenderer.invoke("agent:context:build", payload),
  agentContextCancel: (): Promise<{ ok: boolean; result?: { cancelled: boolean }; error?: string }> =>
    ipcRenderer.invoke("agent:context:cancel"),
  agentContextInspect: (): Promise<{ ok: boolean; result?: ContextSummary | null; error?: string }> =>
    ipcRenderer.invoke("agent:context:inspect"),
  // Phase 26. Pushed after every build, including the one `agentStart` performs.
  onAgentContext: (cb: (summary: ContextSummary) => void) => {
    const listener = (_e: unknown, summary: ContextSummary): void => cb(summary);
    ipcRenderer.on("agent:context", listener);
    return () => ipcRenderer.removeListener("agent:context", listener);
  },
  agentCancel: (runId: string): Promise<{ ok: boolean; result?: { cancelled: boolean }; error?: string }> =>
    ipcRenderer.invoke("agent:cancel", runId),
  agentCancelAll: (): Promise<{ ok: boolean; result?: { cancelled: number }; error?: string }> =>
    ipcRenderer.invoke("agent:cancel-all"),
  agentRuns: (): Promise<{ ok: boolean; result?: AgentRun[]; error?: string }> => ipcRenderer.invoke("agent:runs"),
  agentRun: (runId: string): Promise<{ ok: boolean; result?: AgentRun | null; error?: string }> =>
    ipcRenderer.invoke("agent:run", runId),
  agentApprovals: (): Promise<{ ok: boolean; result?: AgentPendingApproval[]; error?: string }> =>
    ipcRenderer.invoke("agent:approvals"),
  agentRespondApproval: (
    id: string,
    approved: boolean,
  ): Promise<{ ok: boolean; result?: { resolved: boolean }; error?: string }> =>
    ipcRenderer.invoke("agent:respond-approval", id, approved),
  agentClear: (): Promise<{ ok: boolean; result?: { removed: number }; error?: string }> =>
    ipcRenderer.invoke("agent:clear"),
  onAgentEvent: (callback: (ev: AgentEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: AgentEvent): void => callback(payload);
    ipcRenderer.on("agent:event", handler);
    return () => ipcRenderer.removeListener("agent:event", handler);
  },

  // --- Agent permissions (Phase 23) ---
  //
  // The renderer never holds a policy of its own. It asks for the effective
  // matrix and sends a single change, so the panel cannot drift from the gate
  // and there is exactly one place a rule is written.
  agentPermissionCatalog: (): Promise<{
    ok: boolean;
    result?: {
      capabilities: Array<{ capability: string; label: string; description: string; irreversible: boolean }>;
      agents: Array<{ id: string; name: string }>;
    };
    error?: string;
  }> => ipcRenderer.invoke("agent:permission-catalog"),
  agentPermissionMatrix: (
    payload: { scope: AgentPermissionScope; agentId?: string; workspace?: string | null },
  ): Promise<{ ok: boolean; result?: { scope: string; configured: boolean; rows: AgentPermissionRow[] }; error?: string }> =>
    ipcRenderer.invoke("agent:permission-matrix", payload),
  agentPermissionSet: (
    payload: { scope: AgentPermissionScope; capability: string; mode: "allow" | "ask" | "deny" | null },
  ): Promise<{ ok: boolean; result?: { capability: string; mode: string | null }; error?: string }> =>
    ipcRenderer.invoke("agent:permission-set", payload),
  agentPermissionClearScope: (
    payload: { scope: AgentPermissionScope },
  ): Promise<{ ok: boolean; result?: { scope: AgentPermissionScope }; error?: string }> =>
    ipcRenderer.invoke("agent:permission-clear-scope", payload),
  agentPermissionScopes: (): Promise<{ ok: boolean; result?: { scopes: string[] }; error?: string }> =>
    ipcRenderer.invoke("agent:permission-scopes"),

  // --- Extensions (Phase 13) ---
  extensionList: (): Promise<ExtensionInfo[]> => ipcRenderer.invoke("extension:list"),
  extensionSetEnabled: (id: string, enabled: boolean): Promise<{ ok: boolean; result?: ExtensionInfo[]; error?: string }> =>
    ipcRenderer.invoke("extension:set-enabled", id, enabled),
  extensionExecCommand: (id: string): Promise<{ ok: boolean; result?: unknown; error?: string }> =>
    ipcRenderer.invoke("extension:exec-command", id),
  extensionReload: (): Promise<{ ok: boolean; result?: ExtensionInfo[]; error?: string }> =>
    ipcRenderer.invoke("extension:reload"),
  onExtensionsChanged: (callback: (data: { extensions: ExtensionInfo[] }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { extensions: ExtensionInfo[] }): void => callback(payload);
    ipcRenderer.on("extension:changed", handler);
    return () => ipcRenderer.removeListener("extension:changed", handler);
  },

  // --- Project Map (Phase 39) ---
  projectMap:build: (options?: { maxDepth?: number }) => ipcRenderer.invoke("projectMap:build", options),
  projectMap:impactAnalysis: (
    nodeId: string,
    options?: { maxDepth?: number; includeTests?: boolean; includeDependencies?: boolean; includeConsumers?: boolean },
  ) => ipcRenderer.invoke("projectMap:impactAnalysis", { nodeId, options }),
  projectHealth:compute: () => ipcRenderer.invoke("projectHealth:compute"),

  // --- Fix Everything (Phase 40) ---
  fixEverything:run: (options?: { maxIterations?: number; timeoutMs?: number; include?: string[]; exclude?: string[] }) =>
    ipcRenderer.invoke("fixEverything:run", options),
  fixEverything:check:ts: () => ipcRenderer.invoke("fixEverything:check:ts"),
  fixEverything:check:build: () => ipcRenderer.invoke("fixEverything:check:build"),
  fixEverything:check:lint: () => ipcRenderer.invoke("fixEverything:check:lint"),
  fixEverything:check:test: () => ipcRenderer.invoke("fixEverything:check:test"),
  fixEverything:check:all: () => ipcRenderer.invoke("fixEverything:check:all"),

  // --- Dependency Doctor (Phase 41) ---
  dependencyDoctor:analyze: () => ipcRenderer.invoke("dependencyDoctor:analyze"),
  dependencyDoctor:check:missing: () => ipcRenderer.invoke("dependencyDoctor:check:missing"),
  dependencyDoctor:check:version-conflicts: () => ipcRenderer.invoke("dependencyDoctor:check:version-conflicts"),
  dependencyDoctor:check:peer-deps: () => ipcRenderer.invoke("dependencyDoctor:check:peer-deps"),
  dependencyDoctor:check:incompatible: () => ipcRenderer.invoke("dependencyDoctor:check:incompatible"),
  dependencyDoctor:check:duplicates: () => ipcRenderer.invoke("dependencyDoctor:check:duplicates"),
  dependencyDoctor:recommendations: () => ipcRenderer.invoke("dependencyDoctor:recommendations"),
  dependencyDoctor:full-scan: () => ipcRenderer.invoke("dependencyDoctor:full-scan"),

  // --- AI Browser Agent (Phase 42) ---
  browserAgent:init: (allowedOps: string[]) => ipcRenderer.invoke("browserAgent:init", allowedOps),
  browserAgent:create-instance: (label: string) => ipcRenderer.invoke("browserAgent:create-instance", label),
  browserAgent:remove-instance: (instanceId: string) => ipcRenderer.invoke("browserAgent:remove-instance", instanceId),
  browserAgent:launch-app: (appPath: string) => ipcRenderer.invoke("browserAgent:launch-app", appPath),
  browserAgent:open-url: (url: string, instanceId: string) => ipcRenderer.invoke("browserAgent:open-url", url, instanceId),
  browserAgent:click: (x: number, y: number, instanceId: string) => ipcRenderer.invoke("browserAgent:click", x, y, instanceId),
  browserAgent:type: (text: string, instanceId: string) => ipcRenderer.invoke("browserAgent:type", text, instanceId),
  browserAgent:screenshot: (instanceId: string) => ipcRenderer.invoke("browserAgent:screenshot", instanceId),
  browserAgent:console-errors: (instanceId: string) => ipcRenderer.invoke("browserAgent:console-errors", instanceId),
  browserAgent:network-errors: (instanceId: string) => ipcRenderer.invoke("browserAgent:network-errors", instanceId),
  browserAgent:reload: (instanceId: string) => ipcRenderer.invoke("browserAgent:reload", instanceId),
  browserAgent:permissions:get: () => ipcRenderer.invoke("browserAgent:permissions:get"),
  browserAgent:permissions:set: (ops: string[]) => ipcRenderer.invoke("browserAgent:permissions:set", ops),

  // --- Visual UI Debugger (Phase 43) ---
  uiDebugger:create-problem: (title: string, description: string, severity?: "low" | "medium" | "high" | "critical") => ipcRenderer.invoke("uiDebugger:create-problem", { title, description, severity }),
  uiDebugger:get-problem: (problemId: string) => ipcRenderer.invoke("uiDebugger:get-problem", problemId),
  uiDebugger:list-problems: (severity?: "low" | "medium" | "high" | "critical") => ipcRenderer.invoke("uiDebugger:list-problems", severity),
  uiDebugger:remove-problem: (problemId: string) => ipcRenderer.invoke("uiDebugger:remove-problem", problemId),
  uiDebugger:capture-screenshot: (browserId: string) => ipcRenderer.invoke("uiDebugger:capture-screenshot", browserId),
  uiDebugger:extract-dom: (browserId: string) => ipcRenderer.invoke("uiDebugger:extract-dom", browserId),
  uiDebugger:map-element: (elementInfo: { x: number; y: number; tag: string; text: string; className: string }) => ipcRenderer.invoke("uiDebugger:map-element", elementInfo),
  uiDebugger:suggest-fix: (problemId: string, analysis: string) => ipcRenderer.invoke("uiDebugger:suggest-fix", { problemId, analysis }),
  uiDebugger:apply-fix: (problemId: string, approved: boolean, comments?: string) => ipcRenderer.invoke("uiDebugger:apply-fix", { problemId, approved, comments }),
  uiDebugger:re-test: (problemId: string) => ipcRenderer.invoke("uiDebugger:re-test", problemId),

  // --- AI Security Guardian (Phase 44) ---
  securityGuardian:scan: (projectRoot?: string) => ipcRenderer.invoke("securityGuardian:scan", projectRoot),
  securityGuardian:check:secrets: (projectRoot?: string) => ipcRenderer.invoke("securityGuardian:check:secrets", projectRoot),
  securityGuardian:check:shell-injection: (projectRoot?: string) => ipcRenderer.invoke("securityGuardian:check:shell-injection", projectRoot),
  securityGuardian:check:injection: (projectRoot?: string) => ipcRenderer.invoke("securityGuardian:check:injection", projectRoot),
  securityGuardian:check:input: (projectRoot?: string) => ipcRenderer.invoke("securityGuardian:check:input", projectRoot),
  securityGuardian:check:exposed: (projectRoot?: string) => ipcRenderer.invoke("securityGuardian:check:exposed", projectRoot),
  securityGuardian:check:all: (projectRoot?: string) => ipcRenderer.invoke("securityGuardian:check:all", projectRoot),
  securityGuardian:approve-finding: (findingId: string, approved: boolean, comments?: string) => ipcRenderer.invoke("securityGuardian:approve-finding", { findingId, approved, comments }),
  securityGuardian:get-finding: (findingId: string) => ipcRenderer.invoke("securityGuardian:get-finding", findingId),

  // --- Smart Test Generator (Phase 45) ---
  testGenerator:detect-framework: (projectRoot?: string) => ipcRenderer.invoke("testGenerator:detect-framework", projectRoot),
  testGenerator:inspect-project: (projectRoot?: string) => ipcRenderer.invoke("testGenerator:inspect-project", projectRoot),
  testGenerator:generate:function-test: (elementId: string, framework: "jest" | "vitest") => ipcRenderer.invoke("testGenerator:generate:function-test", { elementId, framework }),
  testGenerator:generate:describe-block: (title: string, elements: any, framework: "jest" | "vitest") => ipcRenderer.invoke("testGenerator:generate:describe-block", { title, elements, framework }),
  testGenerator:run-tests: (projectRoot?: string) => ipcRenderer.invoke("testGenerator:run-tests", projectRoot),
  testGenerator:analyze-failures: (output: string, errors: string[]) => ipcRenderer.invoke("testGenerator:analyze-failures", { output, errors }),

  // --- Multi-Agent Parallel Workspace (Phase 46) ---
  multiAgent:create-agent: (type: "frontend" | "backend" | "testing" | "security" | "reviewer", name: string) => ipcRenderer.invoke("multiAgent:create-agent", { type, name }),
  multiAgent:remove-agent: (agentId: string) => ipcRenderer.invoke("multiAgent:remove-agent", agentId),
  multiAgent:get-status: (agentId?: string) => ipcRenderer.invoke("multiAgent:get-status", agentId),
  multiAgent:create-task: (agentId: string, description: string, priority?: number) => ipcRenderer.invoke("multiAgent:create-task", { agentId, description, priority }),
  multiAgent:inspect-changes: (agentId: string) => ipcRenderer.invoke("multiAgent:inspect-changes", agentId),
  multiAgent:get-results: (agentId: string) => ipcRenderer.invoke("multiAgent:get-results", agentId),

  // --- AI Verification (Phase 47) ---
  verification:run-before: (projectRoot?: string, checks?: string[]) => ipcRenderer.invoke("verification:run-before", { projectRoot, checks }),
  verification:run-after: (baselineId: string, checks?: string[]) => ipcRenderer.invoke("verification:run-after", { baselineId, checks }),
  verification:compare: (baselineId: string, afterId: string) => ipcRenderer.invoke("verification:compare", { baselineId, afterId }),
  verification:check:single: ({ check, projectRoot }: { check: string; projectRoot?: string }) => ipcRenderer.invoke("verification:check:single", { check, projectRoot }),
  verification:baselines: () => ipcRenderer.invoke("verification:baselines"),
  verification:clear-baseline: (baselineId: string) => ipcRenderer.invoke("verification:clear-baseline", baselineId),

  // --- Auto Update (Phase 50) ---
  autoUpdate:check:now: () => ipcRenderer.invoke("autoUpdate:checkNow"),
  autoUpdate:status: () => ipcRenderer.invoke("autoUpdate:status"),
  autoUpdate:download: () => ipcRenderer.invoke("autoUpdate:download"),
  autoUpdate:install: () => ipcRenderer.invoke("autoUpdate:install"),

  // --- Crash Reporting + Telemetry (Phase 53) ---
  crashReporter:initialize: () => ipcRenderer.invoke("crashReporter:initialize"),
  crashReporter:get-logs: () => ipcRenderer.invoke("crashReporter:get-logs"),
  crashReporter:clear-logs: (baselineId: string) => ipcRenderer.invoke("crashReporter:clear-logs", baselineId),
  crashReporter:export-logs: () => ipcRenderer.invoke("crashReporter:export-logs"),
  telemetry:get-state: () => ipcRenderer.invoke("telemetry:get-state"),
  telemetry:set-state: (enabled: boolean) => ipcRenderer.invoke("telemetry:set-state", enabled),

  // --- App Preview (Phase 55) ---
  appPreview:detect: (projectRoot?: string) => ipcRenderer.invoke("appPreview:detect", projectRoot),
  appPreview:start: (port: number, framework: string) => ipcRenderer.invoke("appPreview:start", { port, framework }),
  appPreview:stop: (port: number) => ipcRenderer.invoke("appPreview:stop", port),
  appPreview:restart: (port: number, framework: string) => ipcRenderer.invoke("appPreview:restart", { port, framework }),
  appPreview:get-url: () => ipcRenderer.invoke("appPreview:get-url"),
  appPreview:open-external: (url: string) => ipcRenderer.invoke("appPreview:open-external", url),
  appPreview:logs: (port: number) => ipcRenderer.invoke("appPreview:logs", port),
  appPreview:errors: (port: number) => ipcRenderer.invoke("appPreview:errors", port),

  // --- Advanced Project Health Data Engine (Phase 56) ---
  health:check:typecheck: (projectRoot?: string) => ipcRenderer.invoke("health:check:typecheck", projectRoot),
  health:check:lint: (projectRoot?: string) => ipcRenderer.invoke("health:check:lint", projectRoot),
  health:check:build: (projectRoot?: string) => ipcRenderer.invoke("health:check:build", projectRoot),
  health:check:tests: (projectRoot?: string) => ipcRenderer.invoke("health:check:tests", projectRoot),
  health:check:dependencies: (projectRoot?: string) => ipcRenderer.invoke("health:check:dependencies", projectRoot),
  health:check:git: (projectRoot?: string) => ipcRenderer.invoke("health:check:git", projectRoot),
  health:check:security: (projectRoot?: string) => ipcRenderer.invoke("health:check:security", projectRoot),
  health:check:configuration: (projectRoot?: string) => ipcRenderer.invoke("health:check:configuration", projectRoot),
  health:check:ai-verification: (projectRoot?: string) => ipcRenderer.invoke("health:check:ai-verification", projectRoot),
  health:scan:full: (projectRoot?: string) => ipcRenderer.invoke("health:scan:full", projectRoot),

  // --- Companion (Phase 60) ---
  companion:connect: (target: "web" | "mobile" | "remote", projectId?: string) => ipcRenderer.invoke("companion:connect", { target, projectId }),
  companion:disconnect: (sessionId: string) => ipcRenderer.invoke("companion:disconnect", sessionId),
  companion:get-state: (sessionId: string) => ipcRenderer.invoke("companion:get-state", sessionId),
  companion:agent-tasks: (sessionId: string) => ipcRenderer.invoke("companion:agent-tasks", sessionId),
  companion:project-status: (sessionId: string) => ipcRenderer.invoke("companion:project-status", sessionId),
  companion:review-ai-change: (sessionId: string, changeId: string) => ipcRenderer.invoke("companion:review-ai-change", { sessionId, changeId }),
  companion:approve-permission: (sessionId: string, permissionId: string) => ipcRenderer.invoke("companion:approve-permission", { sessionId, permissionId }),
  companion:build-status: (sessionId: string) => ipcRenderer.invoke("companion:build-status", sessionId),
  companion:get-notifications: (sessionId: string) => ipcRenderer.invoke("companion:get-notifications", sessionId),
  companion:resume-session: (sessionId: string) => ipcRenderer.invoke("companion:resume-session", sessionId),

  // --- Extensions (Phase 13) ---

contextBridge.exposeInMainWorld("closeCode", api);

export type CloseCodeAPI = typeof api;