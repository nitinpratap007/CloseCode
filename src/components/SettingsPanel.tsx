// Close Code — Settings panel (Phase 14)
// Category-based, searchable, three-scope (defaults / user / workspace).
// Regular settings render from the settings schema; the AI category renders
// from the AI store (external subsystem, keys stay masked in main).

import { useMemo } from "react";
import {
  useSettingsStore,
  selectVisibleDefinitions,
  settingOwner,
} from "../stores/settingsStore";
import { useAiStore } from "../stores/aiStore";
import type { SettingDefinition, SettingValue } from "../types/electron";

interface SettingsPanelProps {
  onClose: () => void;
}

const CATEGORY_META: Record<string, string> = {
  editor: "⌨️",
  appearance: "🎨",
  files: "📁",
  terminal: "▸_",
  git: "⑂",
  language: "🌐",
  formatting: "✏️",
  ai: "✦",
  extensions: "🧩",
  privacy: "🛡",
  performance: "⚡",
};

export default function SettingsPanel({ onClose }: SettingsPanelProps): React.JSX.Element {
  const categories = useSettingsStore((s) => s.categories);
  const definitions = useSettingsStore((s) => s.definitions);
  const query = useSettingsStore((s) => s.query);
  const selectedCategory = useSettingsStore((s) => s.selectedCategory);
  const targetScope = useSettingsStore((s) => s.targetScope);
  const hasWorkspace = useSettingsStore((s) => s.hasWorkspace);
  const effective = useSettingsStore((s) => s.effective);
  const user = useSettingsStore((s) => s.user);
  const workspace = useSettingsStore((s) => s.workspace);
  const setQuery = useSettingsStore((s) => s.setQuery);
  const setCategory = useSettingsStore((s) => s.setCategory);
  const setScope = useSettingsStore((s) => s.setScope);

  // selectVisibleDefinitions returns a fresh array every call, so it must be
  // memoized over stable slices — zustand v5 (useSyncExternalStore) would
  // otherwise see an "always different" snapshot and loop (React error 185).
  const groups = useMemo(
    () => selectVisibleDefinitions({ categories, definitions, query, selectedCategory } as Parameters<typeof selectVisibleDefinitions>[0]),
    [categories, definitions, query, selectedCategory]
  );
  const visibleCount = groups.reduce((n, g) => n + g.definitions.length, 0);
  const searching = query.trim().length > 0;

  const activeCat = searching
    ? null
    : categories.find((c) => c.id === selectedCategory) ?? null;

  const valueOf = (id: string): SettingValue | undefined => effective[id];

  const save = async (id: string, value: unknown): Promise<void> => {
    await useSettingsStore.getState().save({ [id]: value });
  };

  const reset = (id: string): void => {
    void useSettingsStore.getState().resetSetting(id);
  };

  return (
    <aside
      data-settings-panel
      className="w-[600px] max-w-full bg-cc-surface border-l border-cc-border flex flex-col shrink-0 select-text"
    >
      {/* Header + search */}
      <div className="px-4 py-3 border-b border-cc-border">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-cc-text">Settings</h2>
          <button
            type="button"
            onClick={onClose}
            className="px-1.5 rounded hover:bg-cc-bg text-cc-muted hover:text-cc-text transition-colors"
            aria-label="Close settings"
          >
            ✕
          </button>
        </div>
        <input
          data-settings-search
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search settings… (e.g. font, auto save, ai)"
          className="w-full bg-cc-bg border border-cc-border rounded px-2 py-1.5 text-sm text-cc-text focus:outline-none focus:border-cc-accent placeholder:text-cc-muted"
        />
      </div>

      {/* Scope selector */}
      <div className="px-4 pt-3 flex gap-1" data-settings-scope-row>
        <ScopeButton active={targetScope === "user"} onClick={() => setScope("user")} label="User" id="user" />
        <ScopeButton
          active={targetScope === "workspace"}
          onClick={() => hasWorkspace && setScope("workspace")}
          label="Workspace"
          id="workspace"
          disabled={!hasWorkspace}
        />
        <span className="ml-auto self-center text-[11px] text-cc-muted">
          {targetScope === "workspace" ? "Saved to .closecode/settings.json" : "Saved to user settings"}
        </span>
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* Category rail */}
        <nav className="w-40 shrink-0 border-r border-cc-border overflow-y-auto py-2">
          <button
            type="button"
            data-settings-category="all"
            onClick={() => setCategory(null)}
            className={`w-full text-left px-3 py-1.5 text-[12px] transition-colors truncate ${
              selectedCategory === null ? "bg-cc-accent/10 text-cc-accent font-medium" : "text-cc-muted hover:text-cc-text"
            }`}
          >
            {searching ? "Results" : "All"}
            {searching && <span className="ml-1 text-cc-muted">({visibleCount})</span>}
          </button>
          {categories.map((cat) => (
            <button
              type="button"
              key={cat.id}
              data-settings-category={cat.id}
              onClick={() => setCategory(cat.id)}
              title={cat.description}
              className={`w-full text-left px-3 py-1.5 text-[12px] transition-colors truncate ${
                selectedCategory === cat.id && !searching
                  ? "bg-cc-accent/10 text-cc-accent font-medium"
                  : "text-cc-muted hover:text-cc-text"
              }`}
            >
              <span className="mr-1.5">{CATEGORY_META[cat.id] ?? "•"}</span>
              {cat.label}
            </button>
          ))}
        </nav>

        {/* Content */}
        <div className="flex-1 min-w-0 overflow-y-auto">
          {searching && (
            <div className="px-4 pt-3 text-[11px] text-cc-muted" data-settings-results-count>
              {visibleCount} setting{visibleCount === 1 ? "" : "s"} match “{query.trim()}”
            </div>
          )}
          {!searching && activeCat && (
            <div className="px-4 pt-3">
              <h3 className="text-sm font-semibold text-cc-text">{activeCat.label}</h3>
              <p className="text-[11px] text-cc-muted mt-0.5">{activeCat.description}</p>
            </div>
          )}
          {groups.length === 0 && (
            <div className="px-4 py-8 text-sm text-cc-muted">
              No settings match “{query}”.
            </div>
          )}
          {groups.map((group) => (
            <div key={group.category.id} className="px-4 py-2">
              {searching || groups.length > 1 ? (
                <h4 className="text-[11px] uppercase tracking-wide text-cc-muted pt-2 pb-1">
                  {group.category.label}
                </h4>
              ) : null}
              {group.category.id === "ai" ? (
                <AiSettingsSection />
              ) : (
                group.definitions.map((def) => (
                  <SettingRow
                    key={def.id}
                    def={def}
                    value={valueOf(def.id)}
                    owner={settingOwner({ user, workspace }, def.id)}
                    targetScope={targetScope}
                    onSave={save}
                    onReset={reset}
                  />
                ))
              )}
            </div>
          ))}

          {/* Footer: reset scope */}
          <div className="px-4 py-4 border-t border-cc-border mt-2">
            <button
              type="button"
              data-settings-reset-scope
              onClick={() => void useSettingsStore.getState().resetScope()}
              className="w-full text-left text-[12px] text-cc-muted hover:text-cc-text transition-colors"
            >
              Reset {targetScope === "workspace" ? "workspace" : "user"} settings to defaults
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}

function ScopeButton({
  active,
  onClick,
  label,
  id,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  id: string;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-settings-scope={id}
      disabled={disabled}
      onClick={onClick}
      className={`px-3 py-1 rounded text-[12px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        active ? "bg-cc-accent text-white font-medium" : "bg-cc-bg text-cc-muted hover:text-cc-text"
      }`}
    >
      {label}
    </button>
  );
}

function SettingRow({
  def,
  value,
  owner,
  targetScope,
  onSave,
  onReset,
}: {
  def: SettingDefinition;
  value: SettingValue | undefined;
  owner: "user" | "workspace" | "default";
  targetScope: "user" | "workspace";
  onSave: (id: string, value: unknown) => Promise<void>;
  onReset: (id: string) => void;
}): React.JSX.Element {
  const overriddenInTarget = owner === targetScope;
  return (
    <div data-setting={def.id} data-setting-type={def.type} className="py-2 border-b border-cc-border/50">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-cc-text">{def.label}</span>
            <span data-setting-owner={owner} className="text-[10px] px-1.5 rounded bg-cc-bg text-cc-muted border border-cc-border capitalize">
              {owner}
            </span>
            {overriddenInTarget && (
              <button
                type="button"
                data-setting-reset
                title={`Reset "${def.id}" (currently overridden in ${targetScope} scope)`}
                onClick={() => onReset(def.id)}
                className="text-[10px] px-1.5 rounded hover:bg-cc-bg text-cc-muted hover:text-cc-accent transition-colors"
              >
                reset
              </button>
            )}
          </div>
          <p className="text-[11px] text-cc-muted mt-0.5">{def.description}</p>
        </div>
        <div className="shrink-0 w-40 flex justify-end">
          <SettingControl def={def} value={value} onSave={onSave} />
        </div>
      </div>
    </div>
  );
}

function SettingControl({
  def,
  value,
  onSave,
}: {
  def: SettingDefinition;
  value: SettingValue | undefined;
  onSave: (id: string, value: unknown) => Promise<void>;
}): React.JSX.Element {
  const id = def.id;
  switch (def.type) {
    case "boolean":
      return (
        <button
          type="button"
          data-setting-toggle
          role="switch"
          aria-checked={value === true}
          onClick={() => void onSave(id, value !== true)}
          className={`w-9 h-5 rounded-full p-0.5 transition-colors ${value === true ? "bg-cc-accent" : "bg-cc-border"}`}
        >
          <span
            className={`block w-4 h-4 rounded-full bg-white transition-transform ${value === true ? "translate-x-4" : ""}`}
          />
        </button>
      );
    case "number":
      return (
        <input
          type="number"
          data-setting-number
          min={def.min}
          max={def.max}
          step={def.step ?? 1}
          value={typeof value === "number" ? value : Number(def.default ?? 0)}
          onChange={(e) => void onSave(id, e.target.valueAsNumber)}
          className="w-full bg-cc-bg border border-cc-border rounded px-2 py-1 text-xs text-cc-text focus:outline-none focus:border-cc-accent"
        />
      );
    case "enum":
      return (
        <select
          data-setting-select
          value={typeof value === "string" ? value : String(def.default ?? "")}
          onChange={(e) => void onSave(id, e.target.value)}
          className="w-full bg-cc-bg border border-cc-border rounded px-2 py-1 text-xs text-cc-text focus:outline-none focus:border-cc-accent"
        >
          {(def.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case "stringArray":
      return (
        <textarea
          data-setting-textarea
          rows={2}
          value={Array.isArray(value) ? value.join(", ") : ""}
          placeholder="a, b, c"
          onChange={(e) =>
            void onSave(
              id,
              e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter((s) => s.length > 0)
            )
          }
          className="w-full bg-cc-bg border border-cc-border rounded px-2 py-1 text-xs text-cc-text focus:outline-none focus:border-cc-accent resize-none"
        />
      );
    default:
      return (
        <input
          type="text"
          data-setting-text
          value={typeof value === "string" ? value : String(def.default ?? "")}
          placeholder={def.placeholder ?? ""}
          onChange={(e) => void onSave(id, e.target.value)}
          className="w-full bg-cc-bg border border-cc-border rounded px-2 py-1 text-xs text-cc-text focus:outline-none focus:border-cc-accent"
        />
      );
  }
}

// ---------------------------------------------------------------------------
// AI category — values owned by the AI config service (keys never leave main)
// ---------------------------------------------------------------------------
function AiSettingsSection(): React.JSX.Element {
  const config = useAiStore((s) => s.config);
  const apiKeys = useAiStore((s) => s.apiKeys);
  const busy = useAiStore((s) => s.busy);
  const error = useAiStore((s) => s.error);

  const save = async (patch: Record<string, unknown>): Promise<void> => {
    await useAiStore.getState().saveConfig(patch);
  };

  const cfg = config ?? {
    provider: "local",
    model: "",
    baseUrl: "https://api.openai.com/v1",
    localBaseUrl: "http://127.0.0.1:11434",
    localModel: "",
    stream: true,
    toolMode: "chat" as "chat",
    temperature: 0.2,
  };

  return (
    <div>
      <p className="text-[11px] text-cc-muted py-2 leading-relaxed">
        AI configuration is stored separately and encrypted in the main process. API keys are never shown here.
      </p>
      {error && (
        <p className="text-[11px] text-cc-warn py-1" data-ai-setting-error>
          {error}
        </p>
      )}
      <AiField id="ai.provider" label="Provider">
        <select
          data-ai-setting="provider"
          value={cfg.provider}
          disabled={busy}
          onChange={(e) => void save({ provider: e.target.value })}
          className="w-full bg-cc-bg border border-cc-border rounded px-2 py-1 text-xs text-cc-text focus:outline-none focus:border-cc-accent"
        >
          <option value="local">Local AI</option>
          <option value="openai">OpenAI-compatible</option>
          <option value="custom">Custom</option>
        </select>
      </AiField>
      {cfg.provider !== "local" && (
        <>
          <AiField id="ai.model" label="Model">
            <input
              data-ai-setting="model"
              type="text"
              value={cfg.model}
              onChange={(e) => void save({ model: e.target.value })}
              className="w-full bg-cc-bg border border-cc-border rounded px-2 py-1 text-xs text-cc-text focus:outline-none focus:border-cc-accent"
            />
          </AiField>
          <AiField id="ai.baseUrl" label="Base URL">
            <input
              data-ai-setting="baseUrl"
              type="text"
              value={cfg.baseUrl}
              onChange={(e) => void save({ baseUrl: e.target.value })}
              className="w-full bg-cc-bg border border-cc-border rounded px-2 py-1 text-xs text-cc-text focus:outline-none focus:border-cc-accent"
            />
          </AiField>
        </>
      )}
      <AiField id="ai.localBaseUrl" label="Local Base URL">
        <input
          data-ai-setting="localBaseUrl"
          type="text"
          value={cfg.localBaseUrl}
          onChange={(e) => void save({ localBaseUrl: e.target.value })}
          className="w-full bg-cc-bg border border-cc-border rounded px-2 py-1 text-xs text-cc-text focus:outline-none focus:border-cc-accent"
        />
      </AiField>
      <AiField id="ai.localModel" label="Local Model">
        <input
          data-ai-setting="localModel"
          type="text"
          value={cfg.localModel}
          onChange={(e) => void save({ localModel: e.target.value })}
          className="w-full bg-cc-bg border border-cc-border rounded px-2 py-1 text-xs text-cc-text focus:outline-none focus:border-cc-accent"
        />
      </AiField>
      <AiField id="ai.stream" label="Stream Responses">
        <button
          type="button"
          data-ai-setting="stream"
          role="switch"
          aria-checked={cfg.stream}
          onClick={() => void save({ stream: !cfg.stream })}
          className={`w-9 h-5 rounded-full p-0.5 transition-colors ${cfg.stream ? "bg-cc-accent" : "bg-cc-border"}`}
        >
          <span
            className={`block w-4 h-4 rounded-full bg-white transition-transform ${cfg.stream ? "translate-x-4" : ""}`}
          />
        </button>
      </AiField>
      <AiField id="ai.toolMode" label="Tool Mode">
        <select
          data-ai-setting="toolMode"
          value={cfg.toolMode}
          disabled={busy}
          onChange={(e) => void save({ toolMode: e.target.value })}
          className="w-full bg-cc-bg border border-cc-border rounded px-2 py-1 text-xs text-cc-text focus:outline-none focus:border-cc-accent"
        >
          <option value="chat">Chat</option>
          <option value="agent">Agent</option>
        </select>
      </AiField>
      <AiField id="ai.temperature" label="Temperature">
        <input
          data-ai-setting="temperature"
          type="number"
          min={0}
          max={2}
          step={0.1}
          value={cfg.temperature}
          onChange={(e) => void save({ temperature: e.target.valueAsNumber })}
          className="w-full bg-cc-bg border border-cc-border rounded px-2 py-1 text-xs text-cc-text focus:outline-none focus:border-cc-accent"
        />
      </AiField>
      <AiField id="ai.apiKey" label="API Key">
        <div className="flex items-center gap-2">
          <span
            data-ai-setting="keyStatus"
            className={`text-[11px] px-1.5 rounded border ${apiKeys[cfg.provider] ? "bg-cc-bg text-cc-text border-cc-accent" : "text-cc-muted border-cc-border"}`}
          >
            {apiKeys[cfg.provider] ? "✓ key set" : "no key"}
          </span>
          <input
            data-ai-setting="keyInput"
            type="password"
            placeholder={apiKeys[cfg.provider] ? "Type a new key to replace…" : "Paste API key (stored encrypted)…"}
            onChange={(e) => {
              const v = e.target.value.trim();
              if (v.length > 0) void useAiStore.getState().setApiKey(cfg.provider, v);
            }}
            className="flex-1 min-w-0 bg-cc-bg border border-cc-border rounded px-2 py-1 text-xs text-cc-text focus:outline-none focus:border-cc-accent"
          />
        </div>
      </AiField>
    </div>
  );
}

function AiField({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div data-ai-setting-row={id} className="py-2 border-b border-cc-border/50">
      <div className="text-[13px] text-cc-text mb-1">{label}</div>
      {children}
    </div>
  );
}