interface CloseCodeAPI {
  getAppInfo: () => Promise<{
    version: string;
    electron: string;
    chrome: string;
    node: string;
    platform: string;
  }>;
  getSettings: () => Promise<Settings>;
  saveSettings: (settings: Partial<Settings>) => Promise<Settings>;

  // --- Settings system (Phase 14) ---
  getSettingCategories: () => Promise<{ categories: SettingsCategoryInfo[]; definitions: SettingDefinition[] }>;
  getAllSettings: () => Promise<SettingsSnapshot & { hasWorkspace: boolean }>;
  saveUserSetting: (patch: Record<string, unknown>) => Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }>;
  saveWorkspaceSetting: (patch: Record<string, unknown>) => Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }>;
  resetUserSettings: () => Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }>;
  resetWorkspaceSettings: () => Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }>;
  onSettingsChanged: (callback: () => void) => () => void;

  // --- Themes (Phase 15) ---
  listCustomThemes: () => Promise<CustomThemeMeta[]>;
  readCustomTheme: (file: string) => Promise<{ ok: boolean; theme?: unknown; error?: string }>;
  openFileDialog: () => Promise<{ filePath: string; content: string } | null>;
  getPlatform: () => Promise<string>;

  openFolder: (rootPath?: string) => Promise<{ ok: boolean; result?: { root: string; name: string } | null; error?: string }>;
  getWorkspaceState: () => Promise<{ root: string | null; name: string }>;
  getRecentProjects: () => Promise<RecentProject[]>;
  removeRecentProject: (p: string) => Promise<void>;
  clearRecentProjects: () => Promise<void>;

  listDir: (dirPath: string) => Promise<{ ok: boolean; result?: DirEntry[]; error?: string }>;
  createFile: (dirPath: string, name: string) => Promise<{ ok: boolean; result?: string; error?: string }>;
  createFolder: (dirPath: string, name: string) => Promise<{ ok: boolean; result?: string; error?: string }>;
  renameItem: (oldPath: string, newName: string) => Promise<{ ok: boolean; result?: string; error?: string }>;
  deleteItem: (itemPath: string) => Promise<{ ok: boolean; error?: string }>;
  moveItem: (src: string, destDir: string) => Promise<{ ok: boolean; result?: string; error?: string }>;
  moveDialog: (src: string) => Promise<{ ok: boolean; result?: string | null; error?: string }>;
  readFile: (filePath: string) => Promise<{ ok: boolean; result?: { content: string; size: number; binary: boolean }; error?: string }>;
  writeFile: (filePath: string, content: string) => Promise<{ error: string | null }>;
  copyToClipboard: (text: string) => void;
  saveAsDialog: (suggestedName?: string) => Promise<{ path: string | null; error: string | null }>;

  searchWorkspace: (root: string, query: string, opts: SearchOptions) => Promise<{ ok: boolean; result?: SearchResponse; error?: string }>;
  replaceInFile: (filePath: string, query: string, replacement: string, opts: SearchOptions) => Promise<{ ok: boolean; result?: { count: number }; error?: string }>;
  replaceAll: (root: string, query: string, replacement: string, opts: SearchOptions) => Promise<{ ok: boolean; result?: { replacedCount: number; fileCount: number }; error?: string }>;

  // Phase 17: crash recovery & error logging
  captureError: (entry: { process: "main" | "renderer"; type: string; message: string; stack?: string; context?: Record<string, unknown> }) => Promise<{ ok: boolean }>;
  sessionHeartbeat: (session: { root: string | null; name: string; tabs: Array<{ path: string; name: string; size: number; dirty: boolean }>; activePath: string | null; openedAt: number }) => Promise<{ ok: boolean }>;
  sessionLoad: () => Promise<{ root: string | null; name: string; tabs: Array<{ path: string; name: string; size: number; dirty: boolean }>; activePath: string | null; openedAt: number } | null>;
  /** Phase 20: wipe the persisted session when the workspace is closed. */
  sessionClear: () => Promise<{ ok: boolean }>;
  sessionRecovery: () => Promise<{ hasRecovery: boolean; root: string | null; tabs: number; activePath: string | null }>;
  acceptRecovery: () => Promise<{ ok: boolean; session: { root: string | null; name: string; tabs: Array<{ path: string; name: string; size: number; dirty: boolean }>; activePath: string | null; openedAt: number } | null }>;
  dismissRecovery: () => Promise<{ ok: boolean }>;
  loadErrors: (since?: number) => Promise<Array<{ timestamp: number; process: "main" | "renderer"; type: string; message: string; stack?: string; context?: Record<string, unknown> }>>;

  // Phase 27: persistent AI sessions.
  aiSessionsList: () => Promise<{ ok: boolean; sessions?: AiSessionSummary[]; error?: string }>;
  aiSessionCreate: (opts?: { name?: string; workspace?: string | null }) => Promise<{ ok: boolean; session?: AiSession; history?: AiSessionHistoryTurn[]; error?: string }>;
  aiSessionOpen: (opts?: { id?: string; activate?: boolean }) => Promise<{ ok: boolean; session?: AiSession; history?: AiSessionHistoryTurn[]; summary?: AiSessionSummary; error?: string }>;
  aiSessionUpdate: (opts: { id: string; name?: string; status?: "open" | "closed" }) => Promise<{ ok: boolean; sessions?: AiSessionSummary[]; error?: string }>;
  aiSessionDelete: (opts: { id: string }) => Promise<{ ok: boolean; sessions?: AiSessionSummary[]; error?: string }>;
  aiSessionFork: (opts: { id: string; name?: string }) => Promise<{ ok: boolean; session?: AiSession; history?: AiSessionHistoryTurn[]; error?: string }>;
  aiSessionTurn: (opts: { id: string; role: string; text: string; turnId?: string }) => Promise<{ ok: boolean; name?: string; error?: string }>;
  onAiSessionChanged: (cb: (payload: { activeId: string | null; sessions: AiSessionSummary[] }) => void) => () => void;

  // Phase 29: persistent AI tasks.
  aiTasksList: (workspace: string | null) => Promise<{ ok: boolean; tasks?: AiTask[]; error?: string; corrupted?: boolean; corruptFile?: string }>;
  aiTaskCreate: (opts: { workspace: string | null; input: AiTaskCreateInput }) => Promise<{ ok: boolean; task?: AiTask; error?: string }>;
  aiTaskUpdate: (opts: { workspace: string | null; id: string; patch: AiTaskUpdateInput }) => Promise<{ ok: boolean; task?: AiTask; error?: string }>;
  aiTaskDelete: (opts: { workspace: string | null; id: string }) => Promise<{ ok: boolean; error?: string }>;
  aiTaskCancel: (opts: { workspace: string | null; id: string; reason?: string }) => Promise<{ ok: boolean; task?: AiTask; error?: string }>;
  aiTaskRetry: (opts: { workspace: string | null; id: string }) => Promise<{ ok: boolean; task?: AiTask; error?: string }>;
  aiTaskAssign: (opts: { workspace: string | null; id: string; assignee: string | null }) => Promise<{ ok: boolean; task?: AiTask; error?: string }>;
  onAiTaskChanged: (cb: (payload: { workspace: string | null; tasks: AiTask[] }) => void) => () => void;

  // Phase 30: MCP servers.
  mcpList: () => Promise<{ ok: boolean; servers?: McpServerView[]; error?: string }>;
  mcpAdd: (input: McpAddInput) => Promise<{ ok: boolean; server?: McpServerView; error?: string }>;
  mcpUpdate: (input: McpUpdateInput) => Promise<{ ok: boolean; server?: McpServerView; error?: string }>;
  mcpRemove: (id: string) => Promise<{ ok: boolean; error?: string }>;
  mcpReconnect: (id: string) => Promise<{ ok: boolean; server?: McpServerView; error?: string }>;
  mcpTools: (id: string) => Promise<{ ok: boolean; tools?: McpToolInfo[]; error?: string }>;
  mcpResources: (id: string) => Promise<{ ok: boolean; resources?: McpResourceInfo[]; error?: string }>;
  mcpPrompts: (id: string) => Promise<{ ok: boolean; prompts?: McpPromptInfo[]; error?: string }>;
  mcpReadResource: (id: string, uri: string) => Promise<{ ok: boolean; text?: string; error?: string }>;
  mcpGetPrompt: (id: string, name: string, args: Record<string, string>) => Promise<{ ok: boolean; messages?: Array<{ role: string; text: string }>; error?: string }>;
  onMcpChanged: (cb: (payload: { servers: McpServerView[] }) => void) => () => void;

  // Phase 31: skills & instructions.
  skillsList: (workspace: string | null) => Promise<{ ok: boolean; skills?: SkillInfo[]; error?: string }>;
  skillsRead: (workspace: string | null, name: string) => Promise<{ ok: boolean; skill?: Skill; error?: string }>;
  instructionsList: (workspace: string | null) => Promise<{ ok: boolean; files?: InstructionFileInfo[]; error?: string }>;

  // Phase 32: web research.
  researchStart: (input: { question: string; focusUrls?: string[] }) => Promise<ResearchStartResult>;
  researchList: () => Promise<{ ok: boolean; records?: ResearchRecordView[]; error?: string }>;
  researchGet: (id: string) => Promise<{ ok: boolean; record?: ResearchRecordView; error?: string }>;
  researchRespond: (id: string, approved: boolean) => Promise<{ ok: boolean; record?: ResearchRecordView; error?: string }>;
  onResearchEvent: (cb: (payload: { type: string; record: ResearchRecordView }) => void) => () => void;

  // Phase 33: natural language command center & autonomous builder.
  commandCatalog: () => Promise<{ ok: boolean; result?: CommandCatalogEntry[]; error?: string }>;
  commandRun: (input: { request: string; workspace?: string | null; sessionId?: string | null }) => Promise<{ ok: boolean; result?: CommandRunResult; error?: string }>;
  buildStart: (input: { request: string; note?: string; workspace?: string | null; sessionId?: string | null }) => Promise<{ ok: boolean; result?: BuildStartResult; error?: string }>;
  buildList: () => Promise<{ ok: boolean; records?: BuildRecordView[]; error?: string }>;
  buildGet: (id: string) => Promise<{ ok: boolean; record?: BuildRecordView; error?: string }>;
  buildRespond: (id: string, approved: boolean, note?: string) => Promise<{ ok: boolean; result?: BuildStartResult; error?: string }>;
  buildCancel: (id: string) => Promise<{ ok: boolean; result?: BuildStartResult; error?: string }>;
  onBuildEvent: (cb: (payload: { type: string; record: BuildRecordView }) => void) => () => void;

  replaceAll: (root: string, query: string, replacement: string, opts: SearchOptions) => Promise<{ ok: boolean; result?: { replacedCount: number; fileCount: number }; error?: string }>;

  terminalCreate: (opts: { cwd?: string; cols?: number; rows?: number; shell?: string }) => Promise<{ ok: boolean; result?: { id: string; shell: string; cwd: string; cols: number; rows: number; isPty: boolean }; error?: string }>;
  terminalWrite: (id: string, data: string) => Promise<{ ok: boolean; error?: string }>;
  terminalResize: (id: string, cols: number, rows: number) => Promise<{ ok: boolean; error?: string }>;
  terminalKill: (id: string) => Promise<{ ok: boolean; error?: string }>;
  terminalKillAll: () => Promise<{ ok: boolean; error?: string }>;
  terminalRestart: (id: string) => Promise<{ ok: boolean; result?: { id: string; shell: string; cwd: string; cols: number; rows: number; isPty: boolean }; error?: string }>;
  terminalList: () => Promise<{ ok: boolean; result?: Array<{ id: string; shell: string; cwd: string; cols: number; rows: number; isPty: boolean }>; error?: string }>;
  terminalClear: (id: string) => Promise<{ ok: boolean; error?: string }>;
  onTerminalData: (callback: (data: { id: string; data: string }) => void) => () => void;
  onTerminalExit: (callback: (data: { id: string; exitCode: number }) => void) => () => void;
  readClipboard: () => string;
  checkLSP: (command: string) => Promise<{ found: boolean }>;

  gitIsRepo: (cwd: string) => Promise<{ ok: boolean; result?: boolean; error?: string }>;
  gitStatus: (cwd: string) => Promise<{ ok: boolean; result?: GitStatus; error?: string }>;
  gitStage: (cwd: string, files: string[]) => Promise<{ ok: boolean; error?: string }>;
  gitUnstage: (cwd: string, files: string[]) => Promise<{ ok: boolean; error?: string }>;
  gitStageAll: (cwd: string) => Promise<{ ok: boolean; error?: string }>;
  gitCommit: (cwd: string, message: string) => Promise<{ ok: boolean; result?: { hash: string }; error?: string }>;
  gitBranches: (cwd: string) => Promise<{ ok: boolean; result?: GitBranch[]; error?: string }>;
  gitCreateBranch: (cwd: string, name: string) => Promise<{ ok: boolean; error?: string }>;
  gitSwitchBranch: (cwd: string, name: string) => Promise<{ ok: boolean; error?: string }>;
  gitPull: (cwd: string) => Promise<{ ok: boolean; result?: string; error?: string }>;
  gitPush: (cwd: string, setUpstream?: boolean) => Promise<{ ok: boolean; result?: string; error?: string }>;
  gitFetch: (cwd: string) => Promise<{ ok: boolean; result?: string; error?: string }>;
  gitDiff: (cwd: string, filePath?: string, staged?: boolean) => Promise<{ ok: boolean; result?: string; error?: string }>;
  gitFileHistory: (cwd: string, filePath: string, limit?: number) => Promise<{ ok: boolean; result?: GitLogEntry[]; error?: string }>;
  gitLog: (cwd: string, limit?: number) => Promise<{ ok: boolean; result?: GitLogEntry[]; error?: string }>;
  gitCheckInstalled: () => Promise<{ ok: boolean; result?: boolean; error?: string }>;

  // --- Phase 34: AI Diff Review + Checkpoints ---
  gitDiffParsed: (cwd: string, filePath?: string, staged?: boolean) => Promise<{ ok: boolean; result?: FileDiff[]; error?: string }>;
  gitDiffSummary: (cwd: string, filePath?: string, staged?: boolean) => Promise<{ ok: boolean; result?: string; error?: string }>;
  gitCheckpointCreate: (cwd: string, name: string, type?: "commit" | "tag" | "stash", message?: string) => Promise<{ ok: boolean; result?: Checkpoint; error?: string }>;
  gitCheckpointList: (cwd: string) => Promise<{ ok: boolean; result?: Checkpoint[]; error?: string }>;
  gitCheckpointGet: (cwd: string, id: string) => Promise<{ ok: boolean; result?: Checkpoint; error?: string }>;
  gitCheckpointRestore: (cwd: string, id: string, mode?: "hard" | "soft" | "mixed") => Promise<{ ok: boolean; result?: { success: boolean; error?: string }; error?: string }>;
  gitCheckpointCompare: (cwd: string, id: string) => Promise<{ ok: boolean; result?: CheckpointCompareResult; error?: string }>;
  gitAcceptChanges: (cwd: string, files: string[]) => Promise<{ ok: boolean; result?: { success: boolean; error?: string }; error?: string }>;
  gitRejectChanges: (cwd: string, files: string[]) => Promise<{ ok: boolean; result?: { success: boolean; error?: string }; error?: string }>;

  // --- Debug (Phase 10) ---
  debugStart: (config: DebugConfig) => Promise<{ ok: boolean; result?: { state: DebugRuntimeState }; error?: string }>;
  debugStop: () => Promise<{ ok: boolean; error?: string }>;
  debugPause: () => Promise<{ ok: boolean; error?: string }>;
  debugContinue: () => Promise<{ ok: boolean; error?: string }>;
  debugStepOver: () => Promise<{ ok: boolean; error?: string }>;
  debugStepInto: () => Promise<{ ok: boolean; error?: string }>;
  debugStepOut: () => Promise<{ ok: boolean; error?: string }>;
  debugSetBreakpoint: (file: string, line: number) => Promise<{ ok: boolean; result?: DebugBreakpoint; error?: string }>;
  debugRemoveBreakpoint: (id: string) => Promise<{ ok: boolean; error?: string }>;
  debugGetBreakpoints: () => Promise<{ ok: boolean; result?: DebugBreakpoint[]; error?: string }>;
  debugGetVariables: (opts: { frameId?: number; objectId?: string }) => Promise<{ ok: boolean; result?: { scopes: DebugScope[] }; error?: string }>;
  debugEvaluate: (expression: string) => Promise<{ ok: boolean; result?: { value: string }; error?: string }>;
  debugGetState: () => Promise<{ ok: boolean; result?: { state: DebugRuntimeState }; error?: string }>;
  onDebugEvent: (callback: (ev: DebugEventPayload) => void) => () => void;

  onMenuNewFile: (callback: () => void) => () => void;
  onMenuSave: (callback: () => void) => () => void;
  onMenuSaveAs: (callback: () => void) => () => void;
  onFileOpened: (callback: (data: { filePath: string; content: string }) => void) => () => void;
  onWorkspaceOpened: (callback: (data: { root: string; name: string }) => void) => () => void;

  // --- AI (Phase 11/12) ---
  aiGetConfig: () => Promise<{ ok: boolean; result?: { config: AiConfigData; apiKeys: Record<string, boolean> }; error?: string }>;
  aiSaveConfig: (patch: Partial<AiConfigData>) => Promise<{ ok: boolean; result?: { config: AiConfigData; apiKeys: Record<string, boolean> }; error?: string }>;
  aiSetApiKey: (provider: string, key: string) => Promise<{ ok: boolean; result?: { has: boolean }; error?: string }>;
  aiClearApiKey: (provider: string) => Promise<{ ok: boolean; result?: { has: boolean }; error?: string }>;
  aiModels: () => Promise<{ ok: boolean; result?: { models: string[] }; error?: string }>;
  aiDetectLocal: (baseUrl?: string) => Promise<{ ok: boolean; result?: { found: boolean; runtimes: AiLocalRuntime[] }; error?: string }>;
  aiChat: (req: AiChatRequest) => Promise<{ ok: boolean; result?: { text: string; toolSteps: number }; error?: string }>;
  aiRespondApproval: (id: string, approved: boolean) => Promise<{ ok: boolean }>;
  onAiEvent: (callback: (ev: AiChatEvent) => void) => () => void;

  // --- Agent runtime (Phase 21) ---
  agentDefinitions: () => Promise<{ ok: boolean; result?: AgentDefinitionInfo[]; error?: string }>;
  /** Phase 25. Roles a parent model delegates to. Not user-selectable. */
  agentSubagents: () => Promise<{ ok: boolean; result?: AgentDefinitionInfo[]; error?: string }>;
  agentStart: (payload: { agentId: string; task: string; context?: string; contextEnabled?: boolean; snapshot?: EditorSnapshot }) => Promise<{ ok: boolean; result?: { runId: string; context: ContextSummary | null }; error?: string }>;
  // Phase 26. One channel for build and rebuild: a rebuild is a build of the
  // same request with `force`, and omitting `task` reuses the last one.
  agentContextBuild: (payload: { task?: string; agentId?: string; snapshot?: EditorSnapshot; force?: boolean }) => Promise<{ ok: boolean; result?: ContextSummary; error?: string }>;
  agentContextCancel: () => Promise<{ ok: boolean; result?: { cancelled: boolean }; error?: string }>;
  agentContextInspect: () => Promise<{ ok: boolean; result?: ContextSummary | null; error?: string }>;
  onAgentContext: (callback: (summary: ContextSummary) => void) => () => void;
  agentCancel: (runId: string) => Promise<{ ok: boolean; result?: { cancelled: boolean }; error?: string }>;
  agentCancelAll: () => Promise<{ ok: boolean; result?: { cancelled: number }; error?: string }>;
  agentRuns: () => Promise<{ ok: boolean; result?: AgentRun[]; error?: string }>;
  agentRun: (runId: string) => Promise<{ ok: boolean; result?: AgentRun | null; error?: string }>;
  agentApprovals: () => Promise<{ ok: boolean; result?: AgentPendingApproval[]; error?: string }>;
  agentRespondApproval: (id: string, approved: boolean) => Promise<{ ok: boolean; result?: { resolved: boolean }; error?: string }>;
  agentClear: () => Promise<{ ok: boolean; result?: { removed: number }; error?: string }>;

  // --- Agent permissions (Phase 23) ---
  // The renderer holds no policy. It asks for the effective matrix and sends one
  // change at a time, so there is exactly one place a rule is written and the
  // panel cannot drift from the gate.
  agentPermissionCatalog: () => Promise<{
    ok: boolean;
    result?: {
      capabilities: Array<{ capability: string; label: string; description: string; irreversible: boolean }>;
      agents: Array<{ id: string; name: string }>;
    };
    error?: string;
  }>;
  agentPermissionMatrix: (payload: {
    scope: AgentPermissionScope;
    agentId?: string;
    workspace?: string | null;
  }) => Promise<{ ok: boolean; result?: { scope: string; configured: boolean; rows: AgentPermissionRow[] }; error?: string }>;
  agentPermissionSet: (payload: {
    scope: AgentPermissionScope;
    capability: string;
    mode: "allow" | "ask" | "deny" | null;
  }) => Promise<{ ok: boolean; result?: { capability: string; mode: string | null }; error?: string }>;
  agentPermissionClearScope: (payload: {
    scope: AgentPermissionScope;
  }) => Promise<{ ok: boolean; result?: { scope: AgentPermissionScope }; error?: string }>;
  agentPermissionScopes: () => Promise<{ ok: boolean; result?: { scopes: string[] }; error?: string }>;
  onAgentEvent: (callback: (ev: AgentEvent) => void) => () => void;

  // --- Extensions (Phase 13) ---
  extensionList: () => Promise<ExtensionInfo[]>;
  extensionSetEnabled: (id: string, enabled: boolean) => Promise<{ ok: boolean; result?: ExtensionInfo[]; error?: string }>;
  extensionExecCommand: (id: string) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
  extensionReload: () => Promise<{ ok: boolean; result?: ExtensionInfo[]; error?: string }>;
  onExtensionsChanged: (callback: (data: { extensions: ExtensionInfo[] }) => void) => () => void;
}

interface Settings {
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
  formatOnSave: boolean;
  defaultFormatter: string;
  // Phase 14 additions (flat ids, existing keys preserved)
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

type SettingValue = string | number | boolean | string[];
type SettingType = "boolean" | "number" | "enum" | "string" | "stringArray";

interface SettingDefinition {
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

interface SettingsCategoryInfo {
  id: string;
  label: string;
  description: string;
}

interface SettingsSnapshot {
  defaults: Record<string, SettingValue>;
  user: Record<string, SettingValue>;
  workspace: Record<string, SettingValue>;
  effective: Record<string, SettingValue>;
}

interface CustomThemeMeta {
  name: string;
  type: "dark" | "light";
  scope: "user" | "workspace";
  file: string;
}

interface SearchOptions {
  isRegex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  include: string;
  exclude: string;
}

interface SearchResult {
  file: string;
  line: number;
  column: number;
  preview: string;
  lineText: string;
  matchText: string;
  matchLength: number;
}

interface SearchResponse {
  results: SearchResult[];
  totalFiles: number;
  searchedFiles: number;
  truncated: boolean;
  /** Phase 16: "hit" = served from the main-process result cache, "miss" = files were read. */
  cache?: "hit" | "miss";
}

interface GitStatusFile {
  path: string;
  absPath: string;
  status: string;
  staged: boolean;
  unstaged: boolean;
  isUntracked: boolean;
  isStaged: boolean;
  isModified: boolean;
}

interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  detached: boolean;
  files: GitStatusFile[];
  staged: GitStatusFile[];
  unstaged: GitStatusFile[];
  untracked: GitStatusFile[];
  isClean: boolean;
}

interface GitBranch {
  name: string;
  current: boolean;
  isRemote: boolean;
  remote?: string;
}

interface GitLogEntry {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  email: string;
  date: string;
  relativeDate: string;
}

// --- Phase 34: AI Diff Review + Checkpoints ---

interface DiffLine {
  type: "context" | "add" | "remove";
  content: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

interface FileDiff {
  filePath: string;
  oldPath?: string;
  newPath?: string;
  isNew: boolean;
  isDeleted: boolean;
  isRenamed: boolean;
  hunks: DiffHunk[];
  summary: string;
  aiSummary?: string;
  lineSummary?: string;
}

interface Checkpoint {
  id: string;
  name: string;
  type: "commit" | "tag" | "stash";
  hash: string;
  timestamp: number;
  message: string;
  filesChanged: string[];
  metadata?: Record<string, unknown>;
}

interface CheckpointCompareResult {
  checkpoint: Checkpoint;
  currentHash: string;
  filesChanged: string[];
  diffSummary: string;
  canRestore: boolean;
}

type DebugRuntimeState = "inactive" | "starting" | "running" | "paused";

interface DebugBreakpoint {
  id: string;
  file: string;
  line: number;
  resolved: boolean;
}

interface DebugVariable {
  name: string;
  value: string;
  type: string;
  objectId?: string;
  expandable: boolean;
}

interface DebugScope {
  name: string;
  variables: DebugVariable[];
}

interface DebugFrame {
  frameId: number;
  functionName: string;
  url: string;
  line: number;
  column: number;
}

interface DebugConfig {
  file: string;
  cwd?: string;
  args?: string[];
  env?: Record<string, string>;
}

type AiProviderType = "local" | "openai" | "custom";
type AiPermissionMode = "ask" | "allow" | "deny";

interface AiConfigData {
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

interface AiLocalRuntime {
  name: string;
  baseUrl: string;
  models: string[];
}

interface AiApprovalRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  /** Phase 22. True when approving changes files, the repo or the machine state. */
  destructive: boolean;
  /**
   * Phase 23. The operations this call needs, and their display names.
   *
   * This is the Phase 11 legacy projection of the agent approval event, so it
   * carries the same fields — a chat-mode approval and an agent-mode approval
   * are the same event wearing different clothes, and the banner should not need
   * to know which one it is looking at.
   */
  capabilities: string[];
  capabilityLabels: string[];
  /** Phase 23. Set when an allowed capability was escalated to ask anyway. */
  escalation?: { capability: string; mode: "ask" | "deny"; reason: string };
}

interface AiChatRequest {
  id: string;
  messages: Array<{ role: string; content: string }>;
  context: string;
  workspace: string | null;
}

type AiChatEvent =
  | { type: "stream"; payload: { id: string; delta: string } }
  | { type: "done"; payload: { id: string; text: string; toolSteps: number } }
  | { type: "agent"; payload: { id: string; note: string } }
  | {
      type: "tool";
      payload: {
        id: string;
        tool: string;
        args: Record<string, unknown>;
        result: string;
        granted: boolean;
        /** Phase 22. Lets the UI label a call without parsing the result text. */
        status: "ok" | "error" | "denied";
        /** Phase 22. True when this call changed files, the repo or the machine. */
        destructive: boolean;
      };
    }
  | { type: "approval"; payload: AiApprovalRequest }
  | {
      /**
       * Phase 28. The plain (non-agent) chat path sent a compressed payload.
       * The agent path reports the same fact through `agent:event` instead.
       */
      type: "compaction";
      payload: { id: string; record: CompactionRecord };
    }
  | { type: "error"; payload: { id: string; message: string } };

// --- Agent runtime (Phase 21) ---

type AgentStatus =
  | "idle"
  | "starting"
  | "running"
  | "awaiting_approval"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "failed";

type AgentErrorKind =
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

type AgentStatusKind = "starting" | "thinking" | "acting" | "observing" | "waiting";

interface AgentErrorInfo {
  kind: AgentErrorKind;
  message: string;
  code?: string | number;
  tool?: string;
  recoverable: boolean;
  at: number;
}

interface AgentToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: AgentToolCall[];
}

interface AgentTraceEntry {
  at: number;
  kind: "status" | "tool" | "error" | "compaction";
  step: number;
  level?: AgentStatusKind;
  text?: string;
  tool?: string;
  granted?: boolean;
  ms?: number;
}

interface AgentResult {
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
 * Phase 28. What one context compaction did.
 *
 * Mirrors `electron/services/agent/compaction.ts`. `digest` is the block that
 * replaced the earlier conversation, kept verbatim so the panel can show what
 * was sent instead rather than only that something was.
 */
interface PreservedCounts {
  decisions: number;
  issues: number;
  toolResults: number;
}

interface CompactionRecord {
  at: number;
  passes: number;
  /** Step of the latest pass. Absent outside an agent run's step loop. */
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
  /** True when system + task alone are still over budget. */
  overflow: boolean;
  digest: string;
}

interface AgentRun {
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
  /** Phase 26. What context this run received. Absent means context was off. */
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
// Mirrors `electron/services/agent/types.ts` and `electron/preload.ts`. The
// renderer never receives a bundle's full text — only bounded previews and exact
// counts — so these types describe everything the panel can show and nothing
// more. That is the privacy property as much as a convenience: the panel can be
// shown the whole truth about what was sent without being handed the whole truth
// of it.

type ContextPartKind =
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

interface EditorSelectionSnapshot {
  text: string;
  startLine: number;
  endLine: number;
}

interface EditorDiagnosticSnapshot {
  file: string;
  line: number;
  severity: string;
  message: string;
}

/**
 * The renderer's view of the editor, sent with a run request.
 *
 * Untrusted by the time the main process reads it, and clamped there before
 * anything uses it. `activeContent` is the live buffer, not the file on disk, so
 * the engine can tell the model (and the panel) whether it is looking at
 * unsaved work. Other tabs travel as paths; their bodies are read in main.
 */
interface EditorSnapshot {
  activePath: string | null;
  activeContent: string;
  activeDirty: boolean;
  selection: EditorSelectionSnapshot | null;
  openPaths: string[];
  diagnostics: EditorDiagnosticSnapshot[];
}

interface ContextFileSummary {
  path: string;
  score: number;
  chars: number;
  included: boolean;
  reason?: string;
}

interface ContextSummaryPart {
  kind: ContextPartKind;
  label: string;
  /** Serialised length, heading included — i.e. what actually ships. */
  chars: number;
  included: boolean;
  truncated: boolean;
  reason?: string;
  /** First 600 characters. Enough to judge a part without shipping it. */
  preview: string;
  files?: ContextFileSummary[];
}

interface ContextSummary {
  status: "built" | "cancelled" | "empty";
  totalChars: number;
  budgetChars: number;
  ms: number;
  builtAt: number;
  filesScanned: number;
  filesRanked: number;
  /** One line per part that did not make it, and why. */
  dropped: string[];
  parts: ContextSummaryPart[];
}

// Phase 27: persistent AI sessions.
interface AiSessionTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: number;
}

interface AiSessionRunRef {
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
  /** Tool history for this run, oldest first. */
  tools: AgentTraceEntry[];
  contextChars?: number;
  contextStatus?: ContextSummary["status"];
}

interface AiSession {
  version: number;
  id: string;
  name: string;
  workspace: string | null;
  createdAt: number;
  updatedAt: number;
  status: "open" | "closed";
  /** Set when this session is a fork of another. */
  forkedFrom: string | null;
  /** The AI chat conversation. */
  turns: AiSessionTurn[];
  /** Agent runs, newest first. */
  runs: AiSessionRunRef[];
  /** Secret-shaped strings that were redacted before this was written to disk. */
  redactions: number;
  /** True when a bound forced something to be dropped. Never set silently. */
  truncated: boolean;
}

interface AiSessionSummary {
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
  /** The file could not be read. Its bytes are moved aside, not deleted. */
  corrupted: boolean;
  corruptReason?: string;
  corruptFile?: string;
}

/** What a resume replays into the next run's prompt. */
interface AiSessionHistoryTurn {
  role: "user" | "assistant";
  content: string;
}

// Phase 29: persistent AI tasks (mirrors `electron/services/aiTasks.ts`).
type TaskStatus = "pending" | "in_progress" | "blocked" | "completed" | "cancelled" | "failed";
type TaskPriority = "low" | "medium" | "high" | "urgent";

interface AiTask {
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

interface AiTaskCreateInput {
  title: string;
  description?: string;
  parentId?: string | null;
  priority?: TaskPriority;
  dependencies?: string[];
  assignee?: string | null;
}

interface AiTaskUpdateInput {
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

type McpTransport = "stdio" | "http";

type McpServerState = "disabled" | "disconnected" | "connecting" | "connected" | "failed";

interface McpServerView {
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

interface McpAddInput {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

interface McpUpdateInput {
  id: string;
  name?: string;
  enabled?: boolean;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnlyHint: boolean;
  destructiveHint: boolean;
}

interface McpResourceInfo {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

interface McpPromptInfo {
  name: string;
  description: string;
  arguments: Array<{ name: string; description: string; required: boolean }>;
}

// --- Phase 31: skills & instructions ---

interface SkillInfo {
  name: string;
  description: string;
  source: "user" | "project";
  allowedTools: string[] | null;
  absolutePath: string;
  chars: number;
}

interface Skill extends SkillInfo {
  body: string;
}

interface InstructionFileInfo {
  name: string;
  scope: "user" | "project";
  absolutePath: string;
  chars: number;
  preview: string;
}

// --- Phase 32: web research ---

type ResearchStatus = "queued" | "running" | "done" | "failed" | "refused";
type ResearchStepKind = "queries" | "search" | "fetch" | "summarize";

interface ResearchStepView {
  kind: ResearchStepKind;
  at: number;
  ok: boolean;
  detail: string;
  urls: string[];
  error?: { code: string; message: string };
}

interface ResearchSourceView {
  url: string;
  title: string;
  kind: "search" | "docs";
  triedAt: number;
  status: "ok" | "failed" | "pending";
  fetchedAt?: number;
  snippet?: string;
  error?: { code: string; message: string };
}

interface ResearchRecordView {
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

interface ResearchStartResult {
  ok: boolean;
  record?: ResearchRecordView;
  awaitingApproval?: boolean;
  refused?: boolean;
  error?: string;
}

// --- Phase 33: natural language command center & autonomous builder ---

interface CommandCatalogEntry {
  id: string;
  title: string;
  description: string;
  examples: string[];
  /** Keyword phrases that signal this command, matched case-insensitively. */
  keywords: string[];
  /** The real primary agent the command dispatches to. */
  agentId: string;
  /** Task handed to that agent; `{target}` is filled from the utterance. */
  taskTemplate: string;
  /** True when every agent this command can reach is read-only. */
  readOnly: boolean;
  /** Permission categories the command will realistically touch. */
  categories: string[];
}

interface CommandRunResult {
  commandId: string;
  title: string;
  agentId: string;
  task: string;
  runId: string;
  readOnly: boolean;
}

type BuildStatus =
  | "queued"
  | "planning"
  | "awaiting_input"
  | "building"
  | "verifying"
  | "completed"
  | "failed"
  | "refused"
  | "cancelled";

type BuildPhaseView = {
  kind: "plan" | "question" | "implement" | "verify";
  label: string;
  status: "pending" | "running" | "done" | "failed" | "skipped" | "cancelled";
  at: number;
  endedAt?: number;
  detail: string;
  runId?: string;
};

interface BuildVerificationEntryView {
  command: string;
  exitCode: number | null;
  ok: boolean;
  output: string;
  skipped: boolean;
  at: number;
}

interface BuildRecordView {
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

interface BuildStartResult {
  ok: boolean;
  result?: { id: string; status: BuildStatus };
  error?: string;
}

interface AgentDefinitionInfo {
  id: string;
  name: string;
  description: string;
  /** Phase 25. `primary` = user-selectable; `subagent` = delegate-only. */
  kind?: "primary" | "subagent";
  readOnly?: boolean;
  delegates?: string[];
  /** Phase 25. Advisory tool allow-list; the main process enforces the real one. */
  tools?: string[];
  maxSteps?: number;
}

type AgentEvent =
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
      /** Phase 22. Lets the UI label a call without parsing `result`. */
      status: "ok" | "error" | "denied";
      error?: { code: string; message: string; recoverable: boolean; hint?: string };
      destructive: boolean;
    }
  | {
      type: "approval";
      runId: string;
      id: string;
      /** The tool's name (Phase 22 — Phase 11 sent the category in this field). */
      tool: string;
      category: string;
      args: Record<string, unknown>;
      /** Phase 22. True when approving this changes files, the repo or the machine. */
      destructive: boolean;
      /**
       * Phase 23. The operations this call needs, and their display names. The
       * names come from the same table the gate reads, so the prompt and the
       * settings panel cannot describe the same permission differently.
       */
      capabilities: string[];
      capabilityLabels: string[];
      /** Phase 23. Set when an allowed capability was escalated to ask. */
      escalation?: { capability: string; mode: "ask" | "deny"; reason: string };
    }
  | { type: "error"; runId: string; error: AgentErrorInfo }
  | {
      /**
       * Phase 28. A payload was compressed before it was sent. Emitted on every
       * compacted pass; `run.compaction` carries the latest numbers.
       */
      type: "compaction";
      runId: string;
      step: number;
      record: CompactionRecord;
    }
  | { type: "result"; runId: string; result: AgentResult }

  /** Phase 37. New centralized event types for observability. */

  /** Agent lifecycle events */
  | { type: "agent:started"; runId: string; agentId: string; task: string; at: number }
  | { type: "agent:stopped"; runId: string; agentId: string; at: number; reason?: string }
  | { type: "task:started"; runId: string; task: string; at: number }
  | { type: "task:completed"; runId: string; result: AgentResult; at: number }

  /** Tool lifecycle events */
  | { type: "tool:started"; runId: string; step: number; tool: string; at: number }
  | { type: "tool:completed"; runId: string; step: number; tool: string; result: string; granted: boolean; ms: number; at: number }
  | { type: "tool:failed"; runId: string; step: number; tool: string; error: { code: string; message: string; recoverable: boolean }; at: number }

  /** Permission events */
  | { type: "permission:requested"; runId: string; step: number; tool: string; capabilities: string[]; capabilityLabels: string[]; at: number }
  | { type: "permission:approved"; runId: string; step: number; tool: string; at: number }
  | { type: "permission:denied"; runId: string; step: number; tool: string; reason: string; at: number }

  /** Model events */
  | { type: "model:response"; runId: string; step: number; model: string; content: string; tokens: { input: number; output: number } | null; at: number }
  | { type: "verification:result"; runId: string; passed: boolean; details: string; at: number }
  | { type: "agent:started"; runId: string; agentId: string; task: string; at: number }
  | { type: "agent:stopped"; runId: string; agentId: string; at: number; reason?: string }
}

interface AgentPendingApproval {

// --- Agent permissions (Phase 23) ---

type AgentPermissionScope =
  | { kind: "global" }
  | { kind: "project"; root: string }
  | { kind: "agent"; agentId: string }
  | { kind: "path"; path: string };

/**
 * One row of the permission matrix.
 *
 * `effective` is what the gate will actually do; `own` is the rule stored in the
 * scope being edited. They differ when a narrower scope overrides a broader one,
 * which is the case a user most needs to see spelled out.
 */
interface AgentPermissionRow {
  capability: string;
  label: string;
  description: string;
  effective: "allow" | "ask" | "deny";
  own: "allow" | "ask" | "deny" | null;
  irreversible: boolean;
  /** False for a capability with no tool behind it yet. */
  available: boolean;
}

interface ExtensionCommandData {
  id: string;
  title: string;
}

interface ExtensionInfo {
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

type DebugOutputCategory = "stdout" | "stderr" | "console";

type DebugEventPayload =
  | { type: "state"; payload: { state: DebugRuntimeState } }
  | { type: "paused"; payload: { frames: DebugFrame[]; reason: string } }
  | { type: "resumed"; payload: Record<string, never> }
  | { type: "exited"; payload: { exitCode: number | null } }
  | { type: "output"; payload: { text: string; category: DebugOutputCategory } }
  | { type: "error"; payload: { message: string } }
  | { type: "breakpointSet"; payload: DebugBreakpoint }
  | { type: "breakpointRemoved"; payload: { id: string } };

interface RecentProject {
  path: string;
  name: string;
  lastOpened: number;
}

interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

// --- Model Manager (Phase 36) ---
type ProviderApiType = "openai-compatible" | "anthropic" | "google" | "local" | "custom";
type ProviderPricingTier = "free" | "freemium" | "paid" | "unknown";

interface ProviderQuotaInfo {
  rpm?: number;
  tpm?: number;
  rpd?: number;
  summary?: string;
}

interface ProviderModelInfo {
  id: string;
  name: string;
  contextWindow?: number;
  supportsTools?: boolean;
  supportsVision?: boolean;
  pricingTier?: ProviderPricingTier;
  inputCostPer1M?: number;
  outputCostPer1M?: number;
}

interface ProviderCatalogEntry {
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

interface ProviderRecord {
  id: string;
  name: string;
  baseUrl: string;
  kind: "local" | "remote";
  model: string;
  builtin: boolean;
  hasKey: boolean;
}

interface ProviderStatus {
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

interface ModelManagerState {
  activeProviderId: string;
  activeModelId: string;
  providers: ProviderStatus[];
}

interface ResolvedEndpoint {
  url: string;
  model: string;
  key: string | null;
}

declare global {
  interface Window {
    closeCode: CloseCodeAPI;
  }
}

export type { Settings, RecentProject, DirEntry, SearchOptions, SearchResult, SearchResponse, GitStatus, GitStatusFile, GitBranch, GitLogEntry, DebugBreakpoint, DebugVariable, DebugScope, DebugFrame, DebugConfig, DebugOutputCategory, DebugRuntimeState, DebugEventPayload, AiConfigData, AiPermissionMode, AiProviderType, AiLocalRuntime, AiApprovalRequest, AiChatRequest, AiChatEvent, AgentStatus, AgentErrorKind, AgentStatusKind, AgentErrorInfo, AgentToolCall, AgentMessage, AgentTraceEntry, AgentResult, AgentRun, AgentDefinitionInfo, CompactionRecord, PreservedCounts, AgentEvent, AgentPendingApproval, AgentPermissionScope, AgentPermissionRow, ExtensionInfo, ExtensionCommandData, SettingDefinition, SettingsCategoryInfo, SettingsSnapshot, SettingValue, SettingType, CustomThemeMeta, ContextPartKind, EditorSelectionSnapshot, EditorDiagnosticSnapshot, EditorSnapshot, ContextFileSummary, ContextSummaryPart, ContextSummary, AiSessionTurn, AiSessionRunRef, AiSession, AiSessionSummary, AiSessionHistoryTurn, TaskStatus, TaskPriority, AiTask, AiTaskCreateInput, AiTaskUpdateInput, McpTransport, McpServerState, McpServerView, McpAddInput, McpUpdateInput, McpToolInfo, McpResourceInfo, McpPromptInfo, SkillInfo, Skill, InstructionFileInfo, ResearchStatus, ResearchStepKind, ResearchStepView, ResearchSourceView, ResearchRecordView, ResearchStartResult, CommandCatalogEntry, CommandRunResult, BuildStatus, BuildPhaseView, BuildVerificationEntryView, BuildRecordView, BuildStartResult, FileDiff, DiffHunk, DiffLine, Checkpoint, CheckpointCompareResult, ProviderApiType, ProviderPricingTier, ProviderQuotaInfo, ProviderModelInfo, ProviderCatalogEntry, ProviderRecord, ProviderStatus, ModelManagerState, ResolvedEndpoint };