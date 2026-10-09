// Close Code — Extensions panel (Phase 13)
// Lists discovered extensions with their manifest info and enable/disable.

import { useExtensionStore } from "../../stores/extensionStore";
import { useSettingsStore } from "../../stores/settingsStore";

export default function ExtensionsPanel(): React.JSX.Element {
  const store = useExtensionStore();
  const { extensions, error } = store;
  // Phase 14: developer mode hides invalid/incompatible rows from the panel
  const developerMode = useSettingsStore((s) => s.effective.extensionsDeveloperMode) !== false;
  const visible = developerMode
    ? extensions
    : extensions.filter((e) => !e.loadError && !e.incompatible);

  return (
    <div className="w-full h-full flex flex-col" data-extensions-panel>
      <div className="px-3 py-2 border-b border-cc-border flex items-center gap-2">
        <span className="text-sm font-semibold text-cc-text flex-1">Extensions</span>
        <button
          type="button"
          onClick={() => void store.reload()}
          className="text-xs px-2 py-1 rounded border border-cc-border hover:bg-cc-surface text-cc-muted hover:text-cc-text"
          data-extensions-reload
        >
          Reload
        </button>
      </div>

      {error && (
        <div className="px-3 py-1.5 border-b border-cc-border bg-red-500/10 text-xs text-red-400">{error}</div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto">
        {extensions.length === 0 && (
          <div className="px-3 py-4 text-xs text-cc-muted leading-relaxed">
            No extensions found.
            <br />
            <br />
            CloseCode discovers extensions from:
            <br />• <code className="bg-cc-surface px-1 rounded">userData/extensions</code>
            <br />• <code className="bg-cc-surface px-1 rounded">.closecode/extensions</code> inside the workspace
            <br />• the <code className="bg-cc-surface px-1 rounded">CC_EXTENSIONS</code> environment variable
          </div>
        )}
        {visible.length === 0 && !developerMode && extensions.length > 0 && (
          <div className="px-3 py-4 text-xs text-cc-muted leading-relaxed">
            Missing/incompatible extensions are hidden. Enable Developer Mode in Settings → Extensions to see them.
          </div>
        )}
        {visible.map((ext) => (
          <div key={ext.id} className="px-3 py-2.5 border-b border-cc-border" data-extension={ext.id} data-extension-enabled={ext.enabled ? "true" : "false"}>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={ext.enabled}
                onChange={(e) => void store.setEnabled(ext.id, e.target.checked)}
                title={ext.enabled ? "Disable" : "Enable"}
                aria-label={`Toggle ${ext.displayName}`}
                data-extension-toggle
                disabled={!!ext.loadError || ext.incompatible}
              />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold text-cc-text truncate">{ext.displayName}</div>
                <div className="text-[11px] text-cc-muted">
                  {ext.id} · v{ext.version}
                  {ext.incompatible && <span className="text-red-400"> · incompatible</span>}
                </div>
              </div>
            </div>
            <div className="mt-1 text-[11px] text-cc-muted leading-snug">{ext.description || "No description."}</div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {ext.permissions.map((p) => (
                <span key={p} className="text-[10px] px-1.5 py-0.5 rounded bg-cc-surface text-cc-muted border border-cc-border" data-extension-permission={p}>
                  {p}
                </span>
              ))}
              {ext.commands.map((c) => (
                <span key={c.id} className="text-[10px] px-1.5 py-0.5 rounded bg-cc-accent/10 text-cc-accent border border-cc-accent/20" data-extension-command={c.id}>
                  {c.id}
                </span>
              ))}
            </div>
            {ext.loadError && (
              <div className="mt-1.5 text-[11px] text-red-400 bg-red-500/10 rounded px-2 py-1" data-extension-error>
                {ext.loadError}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}