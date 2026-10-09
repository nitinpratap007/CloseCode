import { useEffect, useMemo } from "react";
import TreeNode from "./TreeNode";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu";
import FileIcon from "./FileIcon";
import { useWorkspaceStore, dirname } from "../../stores/workspaceStore";
import type { RecentProject } from "../../types/settings";

interface ExplorerPanelProps {
  onOpenFolder: () => void | Promise<void>;
}

export default function ExplorerPanel({
  onOpenFolder,
}: ExplorerPanelProps): React.JSX.Element {
  const root = useWorkspaceStore((s) => s.root);
  const rootName = useWorkspaceStore((s) => s.rootName);
  const rootChildren = useWorkspaceStore((s) => (root ? s.children[root] : undefined));
  const contextMenu = useWorkspaceStore((s) => s.contextMenu);
  const inlineInput = useWorkspaceStore((s) => s.inlineInput);
  const recent = useWorkspaceStore((s) => s.recentProjects);
  const setContextMenu = useWorkspaceStore((s) => s.setContextMenu);
  const setInlineInput = useWorkspaceStore((s) => s.setInlineInput);
  const refreshAll = useWorkspaceStore((s) => s.refreshAll);
  const collapseAll = useWorkspaceStore((s) => s.collapseAll);
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);
  const loadRecent = useWorkspaceStore((s) => s.loadRecent);
  const removeRecent = useWorkspaceStore((s) => s.removeRecent);
  const clearRecent = useWorkspaceStore((s) => s.clearRecent);

  useEffect(() => {
    if (!root) void loadRecent();
  }, [root, loadRecent]);

  const openFolderPath = async (p: string): Promise<void> => {
    const resp = await window.closeCode.openFolder(p);
    if (resp.ok && resp.result) {
      await openWorkspace(resp.result.root, resp.result.name);
    }
  };

  const createIn = (dir: string, mode: "create-file" | "create-folder"): void => {
    setInlineInput({ mode, targetPath: dir });
  };

  const renameTarget = (path: string): void => {
    setInlineInput({ mode: "rename", targetPath: path });
  };

  const removeAsync = async (p: string, name: string, isDir: boolean): Promise<void> => {
    const ok = window.confirm(
      `Delete ${isDir ? "folder" : "file"} "${name}"?\n\nThis permanently removes it from disk.`
    );
    if (!ok) return;
    const { removeTarget } = useWorkspaceStore.getState();
    await removeTarget(p);
  };

  const moveAsync = async (src: string): Promise<void> => {
    const resp = await window.closeCode.moveDialog(src);
    if (resp.ok && resp.result) {
      const { refreshDir, expanded } = useWorkspaceStore.getState();
      await refreshDir(dirname(src));
      if (expanded[dirname(resp.result)]) {
        await refreshDir(dirname(resp.result));
      }
    }
  };

  const copyPath = (p: string): void => {
    window.closeCode.copyToClipboard(p);
  };

  const contextItems: ContextMenuItem[] = useMemo(() => {
    if (!contextMenu) return [];
    return buildContextItems(contextMenu.targetPath, contextMenu.isDir, {
      createFileIn: (dir) => createIn(dir, "create-file"),
      createFolderIn: (dir) => createIn(dir, "create-folder"),
      refreshTarget: () => void refreshDirFor(contextMenu.targetPath),
      renameTarget,
      removeTarget: () => void removeAsync(contextMenu.targetPath, contextMenu.targetName, contextMenu.isDir),
      moveTarget: () => void moveAsync(contextMenu.targetPath),
      copyPath,
      collapseAll,
    });
  }, [contextMenu, createIn, renameTarget, copyPath, collapseAll]);

  async function refreshDirFor(p: string): Promise<void> {
    const { refreshDir } = useWorkspaceStore.getState();
    await refreshDir(p);
  }

  const onEmptyContextMenu = (e: React.MouseEvent): void => {
    if (!root) return;
    e.preventDefault();
    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      targetPath: root,
      targetName: rootName,
      isDir: true,
    });
  };

  return (
    <section
      className="h-full flex flex-col bg-cc-sidebar border-r border-cc-border shrink-0"
      onContextMenu={onEmptyContextMenu}
    >
      <header className="h-9 flex items-center gap-1 px-2 border-b border-cc-border shrink-0">
        <span className="font-semibold text-[12px] uppercase tracking-wide text-cc-muted px-1">
          Explorer
        </span>
        {root && (
          <span className="ml-auto flex items-center gap-0.5">
            <IconButton
              title="New File"
              onClick={() => setInlineInput({ mode: "create-file", targetPath: root })}
            >
              +
            </IconButton>
            <IconButton
              title="New Folder"
              onClick={() => setInlineInput({ mode: "create-folder", targetPath: root })}
            >
              ▣
            </IconButton>
            <IconButton title="Refresh" onClick={() => void refreshAll()}>
              ⟳
            </IconButton>
            <IconButton title="Collapse All" onClick={collapseAll}>
              ◱
            </IconButton>
          </span>
        )}
      </header>

      <div className="flex-1 overflow-y-auto overflow-x-hidden" role="tree" aria-label="File explorer tree">
        {root ? (
          <div className="py-1">
            <div className="flex items-center gap-1.5 px-2 h-[28px] text-[11px] font-semibold uppercase tracking-wide text-cc-muted">
              <FileIcon name={rootName} isDirectory expanded={false} />
              <span className="truncate">{rootName}</span>
            </div>
            <div className="ml-1.5 border-l border-cc-border/60">
              {!rootChildren && (
                <div className="text-cc-muted text-[12px] pl-8 h-[24px] leading-[24px] animate-pulse">
                  Loading…
                </div>
              )}
              {rootChildren?.map((entry) => (
                <TreeNode key={entry.path} entry={entry} depth={0} />
              ))}
              {inlineInput &&
                (inlineInput.mode === "create-file" || inlineInput.mode === "create-folder") &&
                inlineInput.targetPath === root && (
                  <RootInput
                    mode={inlineInput.mode}
                    onCommit={(name) => {
                      if (inlineInput.mode === "create-file") {
                        void useWorkspaceStore.getState().createFile(root, name);
                      }
                      if (inlineInput.mode === "create-folder") {
                        void useWorkspaceStore.getState().createFolder(root, name);
                      }
                      setInlineInput(null);
                    }}
                    onCancel={() => setInlineInput(null)}
                  />
                )}
            </div>
          </div>
        ) : (
          <RecentList
            recent={recent}
            onOpen={(p) => void openFolderPath(p)}
            onRemove={(p) => void removeRecent(p)}
            onClear={() => void clearRecent()}
            onOpenFolder={() => void onOpenFolder()}
          />
        )}
      </div>

      {contextMenu?.visible && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextItems}
          onClose={() => setContextMenu(null)}
        />
      )}

      <footer className="h-6 px-2 flex items-center text-[11px] text-cc-muted border-t border-cc-border shrink-0">
        {root ? (
          <span className="truncate" title={root}>
            {root}
          </span>
        ) : (
          <span>No folder open</span>
        )}
      </footer>
    </section>
  );
}

function buildContextItems(
  targetPath: string,
  isDir: boolean,
  actions: {
    createFileIn: (dir: string) => void;
    createFolderIn: (dir: string) => void;
    refreshTarget: () => void;
    renameTarget: (path: string) => void;
    removeTarget: () => void;
    moveTarget: () => void;
    copyPath: (p: string) => void;
    collapseAll: () => void;
  }
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (isDir) {
    items.push({ label: "New File", onClick: () => actions.createFileIn(targetPath) });
    items.push({ label: "New Folder", onClick: () => actions.createFolderIn(targetPath) });
    items.push({ label: "Refresh", onClick: () => actions.refreshTarget() });
    items.push({ label: "Collapse All", onClick: () => actions.collapseAll() });
  }
  items.push({ label: "Rename", onClick: () => actions.renameTarget(targetPath) });
  items.push({ label: "Copy Path", onClick: () => actions.copyPath(targetPath) });
  items.push({ label: "Move to Folder…", onClick: () => actions.moveTarget() });
  items.push({ label: "Delete", danger: true, onClick: () => actions.removeTarget() });
  return items;
}

function IconButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="w-6 h-6 flex items-center justify-center rounded hover:bg-cc-surface text-cc-muted hover:text-cc-accent text-[13px]"
    >
      {children}
    </button>
  );
}

function RootInput({
  mode,
  onCommit,
  onCancel,
}: {
  mode: "create-file" | "create-folder";
  onCommit: (name: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5 h-[26px] text-[13px] pl-2">
      <FileIcon name="" isDirectory={mode === "create-folder"} expanded={false} />
      <input
        autoFocus
        placeholder={mode === "create-file" ? "file.ts" : "folder-name"}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const v = (e.target as HTMLInputElement).value.trim();
            if (v) onCommit(v);
          }
          if (e.key === "Escape") onCancel();
        }}
        onBlur={onCancel}
        className="flex-1 bg-cc-bg border border-cc-accent rounded px-1 text-[13px] text-cc-text focus:outline-none"
      />
    </div>
  );
}

function RecentList({
  recent,
  onOpen,
  onRemove,
  onClear,
  onOpenFolder,
}: {
  recent: RecentProject[];
  onOpen: (p: string) => void;
  onRemove: (p: string) => void;
  onClear: () => void;
  onOpenFolder: () => void;
}): React.JSX.Element {
  if (recent.length === 0) {
    return (
      <div className="px-3 py-4 flex flex-col gap-3">
        <div className="text-[12px] text-cc-muted leading-relaxed px-1">
          No folder is open. Open a project folder to browse and edit its files.
        </div>
        <button
          type="button"
          onClick={onOpenFolder}
          className="px-3 py-2 rounded bg-cc-accent/15 text-cc-accent text-[13px] font-medium hover:bg-cc-accent/25 transition-colors"
        >
          Open Folder…
        </button>
      </div>
    );
  }

  return (
    <div className="px-2 py-2">
      <div className="flex items-center justify-between px-1 mb-1">
        <span className="text-[12px] uppercase tracking-wide text-cc-muted font-semibold">
          Recent Projects
        </span>
        <button
          type="button"
          onClick={onClear}
          className="text-[11px] text-cc-muted hover:text-cc-error"
          title="Clear recent list"
        >
          Clear
        </button>
      </div>
      {recent.map((p) => (
        <div
          key={p.path}
          className="group flex items-center gap-1.5 px-1.5 py-1.5 rounded hover:bg-cc-surface cursor-pointer"
          title={p.path}
        >
          <button
            type="button"
            className="flex items-center gap-2 flex-1 min-w-0 text-left"
            onClick={() => onOpen(p.path)}
          >
            <FileIcon name={p.name} isDirectory expanded={false} />
            <span className="truncate text-[13px] text-cc-text">{p.name}</span>
          </button>
          <button
            type="button"
            onClick={() => onRemove(p.path)}
            className="hidden group-hover:block text-cc-muted hover:text-cc-error px-1 text-[12px]"
            title="Remove from recent"
            aria-label={`Remove ${p.name} from recent`}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}