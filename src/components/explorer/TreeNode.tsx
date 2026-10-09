import { useRef } from "react";
import FileIcon from "./FileIcon";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useEditorStore } from "../../stores/editorStore";
import type { DirEntry } from "../../types/settings";

interface TreeNodeProps {
  entry: DirEntry;
  depth: number;
}

export default function TreeNode({ entry, depth }: TreeNodeProps): React.JSX.Element {
  const expanded = useWorkspaceStore((s) => !!s.expanded[entry.path]);
  const children = useWorkspaceStore((s) => s.children[entry.path]);
  const loading = useWorkspaceStore((s) => !!s.loading[entry.path]);
  const error = useWorkspaceStore((s) => s.errors[entry.path]);
  const contextMenu = useWorkspaceStore((s) => s.contextMenu);
  const inlineInput = useWorkspaceStore((s) => s.inlineInput);
  const toggleDir = useWorkspaceStore((s) => s.toggleDir);
  const setContextMenu = useWorkspaceStore((s) => s.setContextMenu);
  const setInlineInput = useWorkspaceStore((s) => s.setInlineInput);
  const refreshDir = useWorkspaceStore((s) => s.refreshDir);
  const createFile = useWorkspaceStore((s) => s.createFile);
  const createFolder = useWorkspaceStore((s) => s.createFolder);
  const rename = useWorkspaceStore((s) => s.rename);
  const openFileInWorkspace = useEditorStore((s) => s.openFileInWorkspace);

  const renameInputRef = useRef<HTMLInputElement | null>(null);

  const isSelected = contextMenu?.targetPath === entry.path && contextMenu.visible;
  const isRenaming = inlineInput?.mode === "rename" && inlineInput.targetPath === entry.path;

  const indent = { paddingLeft: `${Math.min(depth, 20) * 14 + 8}px` };

  const handleClick = (): void => {
    if (entry.isDirectory) {
      void toggleDir(entry.path);
    }
  };

  const handleDoubleClick = (): void => {
    if (!entry.isDirectory) {
      void openFileInWorkspace(entry.path);
    }
  };

  const onContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      targetPath: entry.path,
      targetName: entry.name,
      isDir: entry.isDirectory,
    });
  };

  const handleCreateCommit = async (e: React.KeyboardEvent<HTMLInputElement>): Promise<void> => {
    if (e.key === "Escape") {
      setInlineInput(null);
      return;
    }
    if (e.key === "Enter") {
      const name = (e.target as HTMLInputElement).value.trim();
      if (name) {
        if (inlineInput?.mode === "create-file") await createFile(entry.path, name);
        if (inlineInput?.mode === "create-folder") await createFolder(entry.path, name);
      }
      setInlineInput(null);
    }
  };

  const handleRenameCommit = async (e: React.KeyboardEvent<HTMLInputElement>): Promise<void> => {
    if (e.key === "Escape") {
      setInlineInput(null);
      return;
    }
    if (e.key === "Enter") {
      const name = (e.target as HTMLInputElement).value.trim();
      if (name && name !== entry.name) {
        await rename(entry.path, name);
      }
      setInlineInput(null);
    }
  };

  const showCreateInput = inlineInput && (inlineInput.mode === "create-file" || inlineInput.mode === "create-folder") && inlineInput.targetPath === entry.path;

  return (
    <>
      <div
        className={`group flex items-center gap-1.5 cursor-pointer hover:bg-cc-surface h-[26px] text-[13px] ${isSelected ? "bg-cc-surface" : ""}`}
        style={indent}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={onContextMenu}
        role="treeitem"
        aria-expanded={entry.isDirectory ? expanded : undefined}
      >
        {entry.isDirectory ? (
          <span className="w-3 h-3 flex items-center justify-center text-cc-muted">
            {expanded ? "▼" : "▶"}
          </span>
        ) : (
          <span className="w-3" />
        )}
        <FileIcon name={entry.name} isDirectory={entry.isDirectory} expanded={expanded} />

        {isRenaming ? (
          <input
            ref={renameInputRef}
            autoFocus
            defaultValue={entry.name}
            onKeyDown={(e) => void handleRenameCommit(e)}
            onBlur={() => setInlineInput(null)}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 bg-cc-bg border border-cc-accent rounded px-1 text-[13px] text-cc-text focus:outline-none"
          />
        ) : (
          <span className={`truncate ${entry.isDirectory ? "text-cc-text" : "text-cc-text/90"}`}>
            {entry.name}
          </span>
        )}

        {entry.isDirectory && (
          <span className="ml-auto hidden group-hover:flex items-center gap-0.5 pr-1">
            <button
              type="button"
              className="px-1 text-[11px] text-cc-muted hover:text-cc-accent"
              title="New file"
              onClick={(e) => {
                e.stopPropagation();
                setInlineInput({ mode: "create-file", targetPath: entry.path });
              }}
            >
              +
            </button>
            <button
              type="button"
              className="px-1 text-[11px] text-cc-muted hover:text-cc-accent"
              title="New folder"
              onClick={(e) => {
                e.stopPropagation();
                setInlineInput({ mode: "create-folder", targetPath: entry.path });
              }}
            >
              ▣
            </button>
            <button
              type="button"
              className="px-1 text-[11px] text-cc-muted hover:text-cc-accent"
              title="Refresh"
              onClick={(e) => {
                e.stopPropagation();
                void refreshDir(entry.path);
              }}
            >
              ⟳
            </button>
          </span>
        )}
      </div>

      {showCreateInput && (
        <div className="flex items-center gap-1.5 h-[26px] text-[13px]" style={{ paddingLeft: `${Math.min(depth, 20) * 14 + 26}px` }}>
          <FileIcon name="" isDirectory={inlineInput.mode === "create-folder"} expanded={false} />
          <input
            autoFocus
            placeholder={inlineInput.mode === "create-file" ? "file.ts" : "folder-name"}
            onKeyDown={(e) => void handleCreateCommit(e)}
            onBlur={() => setInlineInput(null)}
            className="flex-1 bg-cc-bg border border-cc-accent rounded px-1 text-[13px] text-cc-text focus:outline-none"
          />
        </div>
      )}

      {entry.isDirectory && expanded && (
        <NodeChildren dirPath={entry.path} depth={depth + 1} loading={loading} error={error} hasChildren={!!children} />
      )}
    </>
  );
}

interface NodeChildrenProps {
  dirPath: string;
  depth: number;
  loading: boolean;
  error: string;
  hasChildren: boolean;
}

function NodeChildren({ dirPath, depth, loading, error, hasChildren }: NodeChildrenProps): React.JSX.Element {
  const children = useWorkspaceStore((s) => s.children[dirPath]);
  const loadChildren = useWorkspaceStore((s) => s.loadChildren);

  if (loading && !hasChildren) {
    return (
      <div className="text-cc-muted text-[12px] pl-14 h-[24px] leading-[24px] animate-pulse">
        Loading…
      </div>
    );
  }

  if (error) {
    return (
      <button
        type="button"
        className="text-cc-error text-[12px] pl-14 leading-[24px] hover:underline"
        onClick={() => void loadChildren(dirPath)}
      >
        {error} — retry
      </button>
    );
  }

  if (!children) return <></>;

  return (
    <>
      {children.map((child) => (
        <TreeNode key={child.path} entry={child} depth={depth} />
      ))}
    </>
  );
}