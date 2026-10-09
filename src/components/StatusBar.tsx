import type { AppInfo } from "../types/settings";
import {
  useWorkspaceStore,
} from "../stores/workspaceStore";
import { useEditorStore } from "../stores/editorStore";

interface StatusBarProps {
  theme: string;
  fontSize: number;
  appInfo: AppInfo | null;
}

export default function StatusBar({
  theme,
  fontSize,
  appInfo,
}: StatusBarProps): React.JSX.Element {
  const rootName = useWorkspaceStore((s) => s.rootName);
  const root = useWorkspaceStore((s) => s.root);
  const activeTab = useEditorStore((s) =>
    s.tabs.find((t) => t.path === s.activePath)
  );

  return (
    <footer className="h-6 flex items-center justify-between px-3 bg-cc-statusbar text-cc-muted text-xs border-t border-cc-border shrink-0 select-none" role="status" aria-live="polite" aria-label="Status bar">
      <div className="flex items-center gap-4 min-w-0">
        <span className="text-cc-success flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-cc-success inline-block" />
          {root ? rootName : "No Folder"}
        </span>
        {activeTab ? (
          <span className="truncate select-text" title={activeTab.path}>
            {activeTab.name}
            {activeTab.dirty && (
              <span className="text-cc-warning ml-1" title="Unsaved changes">●</span>
            )}
          </span>
        ) : (
          <span>No file open</span>
        )}
      </div>

      <div className="flex items-center gap-3 shrink-0">
        <span title="Editor theme">{theme}</span>
        <span title="Font size">{fontSize}px</span>
        {appInfo && (
          <>
            <span className="cursor-default hover:text-cc-text transition-colors" title="Platform">
              {appInfo.platform}
            </span>
            <span className="text-cc-accent" title="App version">
              v{appInfo.version}
            </span>
          </>
        )}
      </div>
    </footer>
  );
}