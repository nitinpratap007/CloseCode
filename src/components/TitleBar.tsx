interface TitleBarProps {
  fileName: string;
  hasUnsaved: boolean;
  onToggleExplorer: () => void;
  onOpenFile: () => void;
  onOpenFolder: () => void;
  onSettings: () => void;
  onPalette?: () => void;
}

export default function TitleBar({
  fileName,
  hasUnsaved,
  onToggleExplorer,
  onOpenFile,
  onOpenFolder,
  onSettings,
  onPalette,
}: TitleBarProps): React.JSX.Element {
  return (
    <header className="h-10 flex items-center justify-between px-3 bg-cc-sidebar border-b border-cc-border shrink-0">
      <div className="flex items-center gap-2 min-w-0">
        <button
          type="button"
          onClick={onToggleExplorer}
          className="w-7 h-7 flex items-center justify-center rounded hover:bg-cc-surface text-cc-muted hover:text-cc-text transition-colors text-[14px]"
          title="Toggle Explorer"
          aria-label="Toggle Explorer"
        >
          ☰
        </button>
        <span className="w-2.5 h-2.5 rounded-full bg-cc-accent" aria-hidden="true" />
        <span className="font-semibold text-sm text-cc-text shrink-0">CloseCode</span>
        <span className="text-cc-border" aria-hidden="true">
          |
        </span>
        <span className="text-sm text-cc-muted truncate select-text" title={fileName}>
          {fileName}
          {hasUnsaved && (
            <span className="text-cc-warning ml-0.5" title="Unsaved changes">
              ●
            </span>
          )}
        </span>
      </div>

      <div className="flex items-center gap-1">
        {onPalette && (
          <button
            type="button"
            onClick={onPalette}
            className="px-2 py-1 text-xs rounded hover:bg-cc-surface text-cc-text transition-colors"
            title="Command Palette (Ctrl+Shift+P)"
            aria-label="Command Palette"
          >
            ⌘
          </button>
        )}
        <button
          type="button"
          onClick={onOpenFile}
          className="px-2 py-1 text-xs rounded hover:bg-cc-surface text-cc-text transition-colors"
          title="Open File (Ctrl+O)"
        >
          Open File
        </button>
        <button
          type="button"
          onClick={onOpenFolder}
          className="px-2 py-1 text-xs rounded hover:bg-cc-surface text-cc-text transition-colors"
          title="Open Folder (Ctrl+K Ctrl+O)"
        >
          Open Folder
        </button>
        <button
          type="button"
          onClick={onSettings}
          className="px-2 py-1 text-sm rounded hover:bg-cc-surface text-cc-text transition-colors"
          title="Settings (Ctrl+,)"
          aria-label="Settings"
        >
          ⚙
        </button>
      </div>
    </header>
  );
}