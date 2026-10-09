import { useEffect, useState } from "react";
import { useGitStore } from "../../stores/gitStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useSettingsStore } from "../../stores/settingsStore";
import FileIcon from "../explorer/FileIcon";

function useCwd(): string | null {
  return useWorkspaceStore((s) => s.root);
}

export default function GitPanel(): React.JSX.Element {
  const cwd = useCwd();
  const isRepo = useGitStore((s) => s.isRepo);
  const gitInstalled = useGitStore((s) => s.gitInstalled);
  const status = useGitStore((s) => s.status);
  const branches = useGitStore((s) => s.branches);
  const diff = useGitStore((s) => s.diff);
  const diffFile = useGitStore((s) => s.diffFile);
  const fileHistory = useGitStore((s) => s.fileHistory);
  const log = useGitStore((s) => s.log);
  const isLoading = useGitStore((s) => s.isLoading);
  const error = useGitStore((s) => s.error);
  const commitMessage = useGitStore((s) => s.commitMessage);
  const setCommitMessage = useGitStore((s) => s.setCommitMessage);
  const checkGitInstalled = useGitStore((s) => s.checkGitInstalled);
  const checkIsRepo = useGitStore((s) => s.checkIsRepo);
  const refreshStatus = useGitStore((s) => s.refreshStatus);
  const refreshBranches = useGitStore((s) => s.refreshBranches);
  const stage = useGitStore((s) => s.stage);
  const unstage = useGitStore((s) => s.unstage);
  const stageAll = useGitStore((s) => s.stageAll);
  const commit = useGitStore((s) => s.commit);
  const createBranch = useGitStore((s) => s.createBranch);
  const switchBranch = useGitStore((s) => s.switchBranch);
  const pull = useGitStore((s) => s.pull);
  const push = useGitStore((s) => s.push);
  const fetch = useGitStore((s) => s.fetch);
  const getDiff = useGitStore((s) => s.getDiff);
  const getFileHistory = useGitStore((s) => s.getFileHistory);
  const getLog = useGitStore((s) => s.getLog);
  const setCwd = useGitStore((s) => s.setCwd);

  const [newBranchName, setNewBranchName] = useState("");
  const [showDiff, setShowDiff] = useState(false);
  const [activeTab, setActiveTab] = useState<"status" | "branches" | "history">("status");

  // Phase 14: git.enabled / git.autoRefresh settings
  const gitEnabled = useSettingsStore((s) => s.effective.gitEnabled) !== false;
  const gitAutoRefresh = useSettingsStore((s) => s.effective.gitAutoRefresh) !== false;

  // Sync cwd from workspace
  useEffect(() => {
    setCwd(cwd);
  }, [cwd, setCwd]);

  // Initial checks
  useEffect(() => {
    void checkGitInstalled();
  }, [checkGitInstalled]);

  useEffect(() => {
    if (cwd) {
      void checkIsRepo();
      void refreshStatus();
      void refreshBranches();
      void getLog();
    }
  }, [cwd, checkIsRepo, refreshStatus, refreshBranches, getLog]);

  // Phase 14: auto-refresh status while the panel is mounted
  useEffect(() => {
    if (!gitEnabled || !gitAutoRefresh) return;
    const id = window.setInterval(() => {
      void refreshStatus();
    }, 5000);
    return () => window.clearInterval(id);
  }, [gitEnabled, gitAutoRefresh, refreshStatus]);

  if (!gitEnabled) {
    return (
      <div className="h-full flex flex-col bg-cc-sidebar" data-git-panel="true">
        <header className="h-9 flex items-center px-3 border-b border-cc-border">
          <span className="text-xs font-semibold text-cc-muted uppercase">Source Control</span>
        </header>
        <div className="flex-1 flex flex-col items-center justify-center p-4 gap-3 text-center">
          <div className="text-sm text-cc-text">Git integration is disabled</div>
          <div className="text-xs text-cc-muted">Enable it in Settings → Git to use Source Control.</div>
          <button
            type="button"
            onClick={() => void useSettingsStore.getState().save({ gitEnabled: true })}
            className="px-3 py-1.5 text-xs rounded bg-cc-accent text-white hover:bg-cc-accent/90"
          >
            Enable Git
          </button>
        </div>
      </div>
    );
  }

  // Expose for tests
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__gitStore = useGitStore;
  }, []);

  if (gitInstalled === false) {
    return (
      <div className="h-full flex flex-col bg-cc-sidebar" data-git-panel="true">
        <header className="h-9 flex items-center px-3 border-b border-cc-border">
          <span className="text-xs font-semibold text-cc-muted uppercase">Source Control</span>
        </header>
        <div className="flex-1 flex flex-col items-center justify-center p-4 gap-3 text-center">
          <div className="text-sm text-cc-text">Git not found</div>
          <div className="text-xs text-cc-muted">Install Git and ensure it is in your PATH to use Source Control.</div>
          <button
            type="button"
            onClick={() => void checkGitInstalled()}
            className="px-3 py-1.5 text-xs rounded bg-cc-accent text-white hover:bg-cc-accent/90"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!cwd) {
    return (
      <div className="h-full flex flex-col bg-cc-sidebar" data-git-panel="true">
        <header className="h-9 flex items-center px-3 border-b border-cc-border">
          <span className="text-xs font-semibold text-cc-muted uppercase">Source Control</span>
        </header>
        <div className="flex-1 flex items-center justify-center p-4 text-sm text-cc-muted">No folder open</div>
      </div>
    );
  }

  if (isRepo === false) {
    return (
      <div className="h-full flex flex-col bg-cc-sidebar" data-git-panel="true">
        <header className="h-9 flex items-center px-3 border-b border-cc-border">
          <span className="text-xs font-semibold text-cc-muted uppercase">Source Control</span>
        </header>
        <div className="flex-1 flex flex-col items-center justify-center p-4 gap-3 text-center">
          <div className="text-sm text-cc-text">Not a git repository</div>
          <div className="text-xs text-cc-muted">The current folder is not a git repository. Initialize one to use Source Control.</div>
          <div className="text-xs text-cc-muted">Run <code className="bg-cc-surface px-1 rounded">git init</code> in the terminal.</div>
          <button
            type="button"
            onClick={() => { void checkIsRepo(); void refreshStatus(); }}
            className="px-3 py-1.5 text-xs rounded bg-cc-accent text-white hover:bg-cc-accent/90"
          >
            Refresh
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-cc-sidebar" data-git-panel="true">
      <header className="h-9 flex items-center gap-1 px-2 border-b border-cc-border shrink-0">
        <span className="font-semibold text-[12px] uppercase tracking-wide text-cc-muted px-1">Source Control</span>
        <span className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => { void refreshStatus(); void refreshBranches(); void getLog(); }}
            disabled={isLoading}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-cc-surface text-cc-muted hover:text-cc-text disabled:opacity-50"
            title="Refresh"
          >
            ⟳
          </button>
        </span>
      </header>

      {/* Branch bar */}
      <div className="px-2 py-2 border-b border-cc-border bg-cc-surface/30">
        <div className="flex items-center gap-2">
          <span className="text-xs text-cc-muted">Branch:</span>
          <span className="text-xs font-medium text-cc-text flex-1 truncate" title={status?.branch}>
            {status?.branch ?? "—"} {status?.detached ? "(detached)" : ""} {status?.ahead ? `↑${status.ahead}` : ""} {status?.behind ? `↓${status.behind}` : ""}
          </span>
        </div>
        <div className="flex items-center gap-1 mt-1.5">
          <button type="button" onClick={() => void fetch()} disabled={isLoading} className="flex-1 px-2 py-1 text-xs rounded bg-cc-bg border border-cc-border hover:bg-cc-surface text-cc-text disabled:opacity-50" title="Fetch">
            Fetch
          </button>
          <button type="button" onClick={() => void pull()} disabled={isLoading} className="flex-1 px-2 py-1 text-xs rounded bg-cc-bg border border-cc-border hover:bg-cc-surface text-cc-text disabled:opacity-50" title="Pull">
            Pull
          </button>
          <button type="button" onClick={() => void push()} disabled={isLoading} className="flex-1 px-2 py-1 text-xs rounded bg-cc-bg border border-cc-border hover:bg-cc-surface text-cc-text disabled:opacity-50" title="Push">
            Push
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-cc-border bg-cc-bg">
        {(["status", "branches", "history"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`px-2 py-1 text-xs rounded capitalize ${activeTab === tab ? "bg-cc-accent text-white" : "text-cc-muted hover:text-cc-text hover:bg-cc-surface"}`}
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        {activeTab === "status" && (
          <div className="p-2 space-y-3">
            {error && <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded px-2 py-1">{error}</div>}

            {/* Staged */}
            <Section
              title={`Staged Changes (${status?.staged.length ?? 0})`}
              count={status?.staged.length ?? 0}
              actions={
                (status?.staged.length ?? 0) > 0 ? (
                  <button type="button" onClick={() => { const files = status?.staged.map((f) => f.path) ?? []; if (files.length) void unstage(files); }} className="text-xs text-cc-muted hover:text-cc-text">
                    Unstage All
                  </button>
                ) : null
              }
            >
              {(status?.staged.length ?? 0) === 0 ? (
                <div className="text-xs text-cc-muted px-1 py-1">No staged changes</div>
              ) : (
                status?.staged.map((f) => (
                  <FileRow
                    key={f.path}
                    file={f}
                    actions={
                      <>
                        <button type="button" onClick={() => void unstage([f.path])} className="px-1.5 py-0.5 text-xs rounded hover:bg-cc-bg text-cc-muted hover:text-cc-text" title="Unstage">
                          −
                        </button>
                        <button type="button" onClick={() => { void getDiff(f.absPath, true); setShowDiff(true); }} className="px-1.5 py-0.5 text-xs rounded hover:bg-cc-bg text-cc-muted hover:text-cc-text" title="Diff (staged)">
                          D
                        </button>
                      </>
                    }
                  />
                ))
              )}
            </Section>

            {/* Unstaged / Changes */}
            <Section
              title={`Changes (${(status?.unstaged.length ?? 0) - (status?.untracked.length ?? 0)})`}
              count={(status?.unstaged.length ?? 0) - (status?.untracked.length ?? 0)}
              actions={
                (status?.unstaged.length ?? 0) > 0 ? (
                  <button type="button" onClick={() => void stageAll()} className="text-xs text-cc-muted hover:text-cc-text">
                    Stage All
                  </button>
                ) : null
              }
            >
              {status?.unstaged.filter((f) => !f.isUntracked).length === 0 ? (
                <div className="text-xs text-cc-muted px-1 py-1">No changes</div>
              ) : (
                status?.unstaged
                  .filter((f) => !f.isUntracked)
                  .map((f) => (
                    <FileRow
                      key={f.path}
                      file={f}
                      actions={
                        <>
                          <button type="button" onClick={() => void stage([f.path])} className="px-1.5 py-0.5 text-xs rounded hover:bg-cc-bg text-cc-muted hover:text-cc-text" title="Stage">
                            +
                          </button>
                          <button type="button" onClick={() => { void getDiff(f.absPath, false); setShowDiff(true); }} className="px-1.5 py-0.5 text-xs rounded hover:bg-cc-bg text-cc-muted hover:text-cc-text" title="Diff">
                            D
                          </button>
                        </>
                      }
                    />
                  ))
              )}
            </Section>

            {/* Untracked */}
            <Section title={`Untracked (${status?.untracked.length ?? 0})`} count={status?.untracked.length ?? 0}>
              {(status?.untracked.length ?? 0) === 0 ? (
                <div className="text-xs text-cc-muted px-1 py-1">No untracked files</div>
              ) : (
                status?.untracked.map((f) => (
                  <FileRow
                    key={f.path}
                    file={f}
                    actions={
                      <>
                        <button type="button" onClick={() => void stage([f.path])} className="px-1.5 py-0.5 text-xs rounded hover:bg-cc-bg text-cc-muted hover:text-cc-text" title="Stage">
                          +
                        </button>
                      </>
                    }
                  />
                ))
              )}
            </Section>

            {/* Commit */}
            <div className="pt-2 border-t border-cc-border">
              <textarea
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                placeholder="Commit message"
                rows={3}
                className="w-full bg-cc-bg border border-cc-border rounded px-2 py-1.5 text-sm text-cc-text placeholder:text-cc-muted focus:outline-none focus:border-cc-accent resize-none"
              />
              <button
                type="button"
                onClick={() => void commit()}
                disabled={isLoading || !commitMessage.trim() || (status?.staged.length ?? 0) === 0}
                className="mt-2 w-full px-3 py-1.5 text-sm rounded bg-cc-accent text-white hover:bg-cc-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
                title={(status?.staged.length ?? 0) === 0 ? "No staged changes to commit" : "Commit staged changes"}
              >
                Commit {status?.staged.length ? `(${status.staged.length})` : ""}
              </button>
            </div>

            {/* Diff viewer */}
            {showDiff && diff !== null && (
              <div className="pt-2 border-t border-cc-border">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-cc-text">Diff {diffFile ? `— ${diffFile.split(/[\\/]/).pop()}` : ""}</span>
                  <button type="button" onClick={() => setShowDiff(false)} className="text-xs text-cc-muted hover:text-cc-text">
                    Close
                  </button>
                </div>
                <pre className="mt-1 max-h-64 overflow-auto bg-cc-bg border border-cc-border rounded p-2 text-xs font-mono whitespace-pre-wrap break-words">
                  {diff || "(no diff)"}
                </pre>
                <div className="flex gap-1 mt-1">
                  <button type="button" onClick={() => { if (diffFile) void getFileHistory(diffFile); }} className="flex-1 px-2 py-1 text-xs rounded bg-cc-bg border border-cc-border hover:bg-cc-surface">
                    History
                  </button>
                </div>
                {fileHistory.length > 0 && (
                  <div className="mt-2 space-y-1 max-h-32 overflow-auto border border-cc-border rounded p-1 bg-cc-bg">
                    {fileHistory.map((h) => (
                      <div key={h.hash} className="text-xs">
                        <div className="font-mono text-cc-accent truncate" title={h.hash}>
                          {h.shortHash}
                        </div>
                        <div className="text-cc-text truncate">{h.message}</div>
                        <div className="text-cc-muted">
                          {h.author} · {h.relativeDate}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {activeTab === "branches" && (
          <div className="p-2 space-y-3">
            <div className="flex gap-1">
              <input
                value={newBranchName}
                onChange={(e) => setNewBranchName(e.target.value)}
                placeholder="New branch name"
                className="flex-1 bg-cc-bg border border-cc-border rounded px-2 py-1 text-xs text-cc-text placeholder:text-cc-muted focus:outline-none focus:border-cc-accent"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newBranchName.trim()) {
                    void createBranch(newBranchName.trim());
                    setNewBranchName("");
                  }
                }}
              />
              <button
                type="button"
                onClick={() => {
                  if (newBranchName.trim()) {
                    void createBranch(newBranchName.trim());
                    setNewBranchName("");
                  }
                }}
                disabled={!newBranchName.trim() || isLoading}
                className="px-2 py-1 text-xs rounded bg-cc-accent text-white hover:bg-cc-accent/90 disabled:opacity-50"
              >
                Create
              </button>
            </div>
            <div className="space-y-1">
              {branches.map((b) => (
                <button
                  key={`${b.name}-${b.isRemote ? "remote" : "local"}`}
                  type="button"
                  onClick={() => !b.isRemote && void switchBranch(b.name)}
                  disabled={b.isRemote}
                  className={`w-full text-left px-2 py-1.5 rounded flex items-center gap-2 text-xs ${b.current ? "bg-cc-accent text-white" : b.isRemote ? "text-cc-muted" : "hover:bg-cc-surface text-cc-text"}`}
                  title={b.isRemote ? "Remote branch (cannot switch directly)" : `Switch to ${b.name}`}
                >
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: b.current ? "#a6e3a1" : b.isRemote ? "#6c7086" : "#89b4fa" }} />
                  <span className="flex-1 truncate font-mono">{b.name}</span>
                  {b.current && <span className="text-[10px] bg-white/20 rounded px-1">current</span>}
                  {b.isRemote && <span className="text-[10px] text-cc-muted">remote</span>}
                </button>
              ))}
              {branches.length === 0 && <div className="text-xs text-cc-muted px-1">No branches</div>}
            </div>
          </div>
        )}

        {activeTab === "history" && (
          <div className="p-2 space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-cc-text">Recent Commits</span>
              <button type="button" onClick={() => void getLog()} className="text-xs text-cc-muted hover:text-cc-text">
                Refresh
              </button>
            </div>
            {log.length === 0 ? (
              <div className="text-xs text-cc-muted">No commits yet</div>
            ) : (
              log.map((entry) => (
                <div key={entry.hash} className="border border-cc-border rounded p-2 bg-cc-bg">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-cc-accent">{entry.shortHash}</span>
                    <span className="text-xs text-cc-muted truncate flex-1">{entry.relativeDate}</span>
                  </div>
                  <div className="text-xs text-cc-text mt-1 line-clamp-2">{entry.message}</div>
                  <div className="text-xs text-cc-muted">
                    {entry.author} &lt;{entry.email}&gt;
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      <footer className="h-6 px-2 flex items-center text-[11px] text-cc-muted border-t border-cc-border shrink-0">
        {status?.isClean ? <span>Clean</span> : <span>{status?.files.length ?? 0} changed</span>}
        <span className="ml-auto">{isLoading ? "Loading…" : error ? "Error" : "Ready"}</span>
      </footer>
    </div>
  );
}

function Section({
  title,
  actions,
  children,
}: {
  title: string;
  count?: number;
  actions?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div>
      <div className="flex items-center gap-2 px-1 py-1">
        <span className="text-xs font-semibold text-cc-muted uppercase tracking-wide flex-1">{title}</span>
        {actions}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function FileRow({ file, actions }: { file: { path: string; status: string }; actions?: React.ReactNode }): React.JSX.Element {
  const name = file.path.split(/[\\/]/).pop() ?? file.path;
  return (
    <div className="flex items-center gap-1 px-1 py-1 rounded hover:bg-cc-surface group">
      <FileIcon name={name} isDirectory={false} expanded={false} />
      <span className="flex-1 truncate text-xs text-cc-text" title={file.path}>
        {name}
      </span>
      <span className="text-[11px] font-mono text-amber-400 w-6 text-center" title={file.status}>
        {file.status}
      </span>
      <span className="flex items-center gap-0.5 opacity-60 group-hover:opacity-100">{actions}</span>
    </div>
  );
}
