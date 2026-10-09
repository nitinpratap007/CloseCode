// Close Code — AI Assistant panel (Phase 11/12)
// Provider selection, model config, context pickers with live char counters,
// quick actions, streaming chat, suggested-change diff previews with apply,
// and agent tool-approval banners.

import { useEffect, useRef } from "react";
import { useAiStore } from "../../stores/aiStore";
import { useAgentStore } from "../../stores/agentStore";
import AgentSection from "./AgentSection";
import TaskSection from "./TaskSection";
import McpSection from "./McpSection";
import SkillsSection from "./SkillsSection";
import ResearchSection from "./ResearchSection";
import CommandCenterSection from "./CommandCenterSection";
import BuildSection from "./BuildSection";
import PermissionMatrix from "./PermissionMatrix";
import { getProviders } from "../../ai/providers";
import { QUICK_ACTIONS } from "../../ai/prompts";
import type { QuickActionKind } from "../../ai/types";
import { useWorkspaceStore } from "../../stores/workspaceStore";

function fmtChars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k chars` : `${n} chars`;
}

/**
 * Phase 22. The key-store slot the `web_search` tool reads.
 *
 * Mirrors `WEB_SEARCH_KEY_ID` in `electron/services/aiSettings.ts`. The renderer
 * cannot import from the main process, so this is a deliberate copy — and
 * `scripts/phase21-test.cjs` asserts the two files agree, so a rename on one
 * side fails the suite instead of silently leaving the user with a field that
 * writes a key nothing reads.
 */
const WEB_SEARCH_KEY_ID = "web-search";

/**
 * Human-readable names for the permission categories.
 *
 * `web` and `browser` are Phase 22 additions and are the only two that put
 * something on the wire, so their labels say so — a user granting "allow" to
 * something they read as "search" should be able to see that it is not.
 *
 * Mirrors `AI_PERMISSION_LABELS` in `electron/services/aiSettings.ts`, with the
 * same enforcement. An unknown category falls back to its raw key rather than
 * rendering blank, so a future category is visible the moment it is added.
 */
const AI_PERMISSION_LABELS: Record<string, string> = {
  files: "Read & write files",
  terminal: "Run terminal commands",
  search: "Search the workspace",
  git: "Git operations",
  agent: "Delegate to sub-agents",
  web: "Send requests to the internet",
  browser: "Open & control a browser",
  tasks: "Maintain the task list",
  mcp: "Call MCP servers",
  skills: "Invoke skills",
};

export default function AiPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const store = useAiStore();
  const agentState = useAgentStore();
  const {
    config,
    apiKeys,
    localDetected,
    models,
    messages,
    toolLog,
    suggestedChanges,
    approvalRequests,
    contextSel,
    contextChars,
    busy,
    error,
    input,
    configOpen,
  } = store;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, suggestedChanges.length, store.messages[store.messages.length - 1]?.text, busy]);

  const providers = getProviders();
  const providerName = providers.find((p) => p.id === config?.provider)?.name ?? "AI Assistant";
  const isLocal = config?.provider === "local";

  // Subscribed, not read with `getState()`. The permission matrix offers a
  // per-project scope, and a root read non-reactively would leave that scope
  // bound to whatever folder was open when the panel first rendered.
  const workspaceRoot = useWorkspaceStore((s) => s.root) ?? null;

  const modelValue = isLocal ? (config?.localModel ?? "") : (config?.model ?? "");

  const changeModel = (value: string): void => {
    void store.saveConfig(isLocal ? { localModel: value } : { model: value });
  };

  const sendEnabled = !busy && input.trim().length > 0;

  const ctxToggle = (key: "selectedCode" | "currentFile" | "diagnostics" | "moreFiles"): void => {
    store.setContextSel({ [key]: !contextSel[key] });
  };

  const quick = (kind: QuickActionKind): void => {
    void store.quickAction(kind);
  };

  return (
    <div className="w-[380px] h-full flex flex-col bg-cc-bg border-l border-cc-border" data-ai-panel data-testid="ai-panel">
      {/* Header */}
      <div className="px-3 py-2 border-b border-cc-border flex items-center gap-2 shrink-0">
        <span className="text-cc-accent text-base">✦</span>
        <span className="text-sm font-semibold text-cc-text flex-1">AI Assistant</span>
        <button
          type="button"
          onClick={() => void store.detectLocal()}
          className="text-xs px-2 py-1 rounded border border-cc-border hover:bg-cc-surface text-cc-muted hover:text-cc-text"
          title="Detect local AI"
          data-ai-detect
        >
          Detect local
        </button>
        <button
          type="button"
          onClick={store.toggleConfig}
          className="text-xs px-2 py-1 rounded border border-cc-border hover:bg-cc-surface text-cc-muted hover:text-cc-text"
          title={configOpen ? "Hide settings" : "Show settings"}
          data-ai-config-toggle
        >
          ⚙
        </button>
        <button
          type="button"
          onClick={onClose}
          className="w-6 h-6 rounded hover:bg-cc-surface text-cc-muted hover:text-cc-text"
          aria-label="Close AI panel"
        >
          ✕
        </button>
      </div>

      {/* Provider + model row */}
      <div className="px-3 py-2 border-b border-cc-border shrink-0">
        <div className="flex items-center gap-2">
          <select
            className="flex-1 min-w-0 bg-cc-surface border border-cc-border rounded px-2 py-1 text-xs text-cc-text outline-none"
            value={config?.provider ?? "local"}
            onChange={(e) => void store.saveConfig({ provider: e.target.value as never })}
            data-ai-provider-select
            aria-label="AI provider"
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input
            className="flex-1 min-w-0 bg-cc-surface border border-cc-border rounded px-2 py-1 text-xs text-cc-text outline-none"
            placeholder={isLocal ? "Model id (e.g. llama3.2)" : "Model id (e.g. gpt-4o-mini)"}
            value={modelValue}
            onChange={(e) => changeModel(e.target.value)}
            data-ai-model-input
            aria-label="Model id"
          />
        </div>
        <div className="mt-1.5 flex items-center gap-2 text-[11px] text-cc-muted">
          <span data-ai-key-status>
            {config?.provider === "local"
              ? "Local runtime — no API key required"
              : apiKeys[config?.provider ?? ""]
                ? "API key: set ✓"
                : "API key: not set"}
          </span>
          {!isLocal && (
            <button
              type="button"
              className="ml-auto text-cc-accent hover:underline"
              onClick={() => void store.clearApiKey(config?.provider ?? "openai")}
              title="Remove stored API key"
            >
              clear
            </button>
          )}
          <button type="button" className="text-cc-accent hover:underline" onClick={() => void store.refreshModels()} data-ai-fetch-models>
            fetch models
          </button>
        </div>
        {localDetected && localDetected.length > 0 && (
          <div className="mt-1 text-[11px] text-green-500" data-ai-local-status>
            Local AI detected: {localDetected.map((r) => `${r.name} (${r.models.length} models)`).join(", ")}
          </div>
        )}
        {localDetected && localDetected.length === 0 && isLocal && (
          <div className="mt-1 text-[11px] text-amber-500/90" data-ai-local-status>
            No local runtime found. Install Ollama, LM Studio or Jan, then configure its base URL in settings.
          </div>
        )}
      </div>

      {/* Config panel */}
      {configOpen && config && (
        <div className="px-3 py-2 border-b border-cc-border overflow-y-auto max-h-64 shrink-0" data-ai-config>
          <div className="grid grid-cols-1 gap-2 text-xs">
            <label className="flex flex-col gap-1">
              <span className="text-cc-muted">Base URL (remote)</span>
              <input
                className="bg-cc-surface border border-cc-border rounded px-2 py-1 text-cc-text outline-none"
                value={config.baseUrl}
                onChange={(e) => void store.saveConfig({ baseUrl: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-cc-muted">Local base URL</span>
              <input
                className="bg-cc-surface border border-cc-border rounded px-2 py-1 text-cc-text outline-none"
                value={config.localBaseUrl}
                onChange={(e) => void store.saveConfig({ localBaseUrl: e.target.value })}
              />
            </label>
            {!isLocal && (
              <label className="flex flex-col gap-1">
                <span className="text-cc-muted">{apiKeys[config.provider] ? "Replace API key" : "API key"} (stored encrypted in the main process — never shown again)</span>
                <input
                  type="password"
                  className="bg-cc-surface border border-cc-border rounded px-2 py-1 text-cc-text outline-none"
                  placeholder={apiKeys[config.provider] ? "••••••••" : "sk-..."}
                  onBlur={(e) => { if (e.target.value.trim()) void store.setApiKey(config.provider, e.target.value.trim()); e.target.value = ""; }}
                  data-ai-key-input
                />
              </label>
            )}
            <div className="flex gap-2">
              <label className="flex flex-col gap-1 flex-1">
                <span className="text-cc-muted">Temperature ({config.temperature.toFixed(1)})</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.1}
                  value={config.temperature}
                  onChange={(e) => void store.saveConfig({ temperature: Number(e.target.value) })}
                />
              </label>
              <label className="flex flex-col gap-1 flex-1">
                <span className="text-cc-muted">Timeout (s)</span>
                <input
                  type="number"
                  min={5}
                  max={600}
                  value={Math.round(config.timeoutMs / 1000)}
                  onChange={(e) => void store.saveConfig({ timeoutMs: Math.max(1000, Number(e.target.value)) * 1000 })}
                />
              </label>
            </div>
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-cc-muted">
                <input type="checkbox" checked={config.stream} onChange={(e) => void store.saveConfig({ stream: e.target.checked })} />
                Stream tokens
              </label>
              <label className="flex items-center gap-2 text-cc-muted">
                <input type="checkbox" checked={config.toolMode === "agent"} onChange={(e) => void store.saveConfig({ toolMode: e.target.checked ? "agent" : "chat" })} data-ai-toolmode-toggle />
                {/* Derived, not written out: this string listed the five Phase 21
                    categories by hand and went quietly wrong the moment `web` and
                    `browser` were added, because nothing renders it in a test. */}
                <span data-ai-toolmode-label>
                  Agent tools ({Object.keys(AI_PERMISSION_LABELS).join("/")})
                </span>
              </label>
            </div>
            {config.toolMode === "agent" && (
              <label className="flex flex-col gap-1" data-ai-websearch-key>
                <span className="text-cc-muted">
                  Web search API key ({WEB_SEARCH_KEY_ID}) — required by the `web_search` tool, optional otherwise
                  (stored encrypted in the main process — never shown again)
                </span>
                <input
                  type="password"
                  className="bg-cc-surface border border-cc-border rounded px-2 py-1 text-cc-text outline-none"
                  placeholder={apiKeys[WEB_SEARCH_KEY_ID] ? "••••••••" : "not set — web_search will refuse"}
                  onBlur={(e) => {
                    if (e.target.value.trim()) void store.setApiKey(WEB_SEARCH_KEY_ID, e.target.value.trim());
                    e.target.value = "";
                  }}
                  data-ai-key-input
                />
              </label>
            )}
            {config.toolMode === "agent" && (
              <div className="grid grid-cols-2 gap-1" data-ai-permissions>
                {Object.entries(config.permissions).map(([cat, mode]) => (
                  <label key={cat} className="flex items-center justify-between text-cc-muted" data-ai-permission={cat}>
                    <span title={cat}>{AI_PERMISSION_LABELS[cat] ?? cat}</span>
                    <select
                      className="bg-cc-surface border border-cc-border rounded px-1 py-0.5 outline-none"
                      value={mode}
                      onChange={(e) =>
                        void store.saveConfig({ permissions: { ...config.permissions, [cat]: e.target.value as never } })
                      }
                    >
                      <option value="ask">ask</option>
                      <option value="allow">allow</option>
                      <option value="deny">deny</option>
                    </select>
                  </label>
                ))}
              </div>
            )}
            {/* Phase 23. The per-operation matrix, immediately below the coarse
                category switches it refines — placed adjacently on purpose, since
                the two interact and a user reading one without the other would
                misread what a category of "allow" does. */}
            {config.toolMode === "agent" && <PermissionMatrix workspace={workspaceRoot} />}
            {models.length > 0 && (
              <label className="flex flex-col gap-1">
                <span className="text-cc-muted">Available models</span>
                <select
                  className="bg-cc-surface border border-cc-border rounded px-1 py-0.5 outline-none"
                  value={modelValue}
                  onChange={(e) => changeModel(e.target.value)}
                >
                  {models.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </div>
      )}

      {/* Context */}
      <div className="px-3 py-2 border-b border-cc-border shrink-0">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[11px] font-semibold text-cc-muted uppercase tracking-wide">Context sent to AI</span>
          <span className="text-[11px] text-cc-accent ml-auto" data-ai-context-chars>{fmtChars(contextChars)}</span>
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-cc-text">
          {([
            ["selectedCode", "Selected code"],
            ["currentFile", "Current file"],
            ["diagnostics", "Diagnostics"],
            ["moreFiles", "Open files"],
          ] as const).map(([key, label]) => (
            <label key={key} className="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={contextSel[key]} onChange={() => ctxToggle(key)} />
              {label}
            </label>
          ))}
        </div>
        <textarea
          className="mt-1.5 w-full bg-cc-surface border border-cc-border rounded px-2 py-1 text-xs text-cc-text outline-none resize-none"
          rows={2}
          placeholder="Extra notes to send… (private — only sent if you type here)"
          value={contextSel.customText}
          onChange={(e) => store.setContextSel({ customText: e.target.value })}
        />
        <div className="mt-1 text-[11px] text-cc-muted leading-snug">
          {contextChars === 0
            ? "Nothing will be sent to the AI service."
            : `Exactly ${fmtChars(contextChars)} of editor context will be sent. Nothing else leaves your machine.`}
        </div>
      </div>

      {/* Agent runtime (Phase 21) */}
      <AgentSection state={agentState} />

      {/* Persistent task list (Phase 29) */}
      <TaskSection />

      {/* MCP servers (Phase 30) */}
      <McpSection />

      {/* Skills & instructions (Phase 31) */}
      <SkillsSection />

      {/* Web research (Phase 32) */}
      <ResearchSection />

      {/* Command Center (Phase 33) */}
      <CommandCenterSection />

      {/* Autonomous Builder (Phase 33) */}
      <BuildSection />

      {/* Quick actions */}
      <div className="px-3 py-1.5 border-b border-cc-border flex flex-wrap gap-1.5 shrink-0">
        {QUICK_ACTIONS.map((qa) => (
          <button
            key={qa.kind}
            type="button"
            disabled={busy}
            onClick={() => quick(qa.kind)}
            className="text-[11px] px-2 py-1 rounded border border-cc-border hover:bg-cc-surface text-cc-muted hover:text-cc-text disabled:opacity-50"
            title={qa.title}
            data-ai-quick={qa.kind}
          >
            {qa.label}
          </button>
        ))}
      </div>

      {/* Error banner */}
      {error && (
        <div className="px-3 py-1.5 border-b border-cc-border bg-red-500/10 text-xs text-red-400 flex items-center gap-2" data-ai-error>
          <span className="flex-1 break-words">{error}</span>
          <button type="button" className="hover:text-red-200" onClick={() => useAiStore.getState().clearError()}>
            ✕
          </button>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-3" ref={scrollRef} data-ai-messages>
        {messages.length === 0 && !busy && (
          <div className="text-xs text-cc-muted leading-relaxed">
            Ask me to explain code, write tests, fix errors, generate docs or refactor files.
            <br />
            <br />
            Suggestions appear here with a diff preview — you decide whether to apply them.
          </div>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`text-xs leading-relaxed whitespace-pre-wrap ${m.streaming ? "opacity-80" : ""}`}
            data-ai-message={m.role}
          >
            <div className={`font-semibold mb-0.5 ${m.role === "user" ? "text-cc-accent" : "text-cc-muted"}`}>
              {m.role === "user" ? "You" : "Assistant"}
            </div>
            <div className="text-cc-text">{m.text || (m.streaming ? "…" : "")}</div>
          </div>
        ))}
        {busy && <div className="text-xs text-cc-muted">Working…</div>}
        {/* Phase 28. A compacted payload is visible, not silent: the user can
            see that a long conversation was over budget and was compressed —
            never deleted — before it was sent. The wording comes from the ONE
            renderer helper, the same one the agent panel uses for its chips. */}
        {store.compactionNote && (
          <div className="text-[10px] text-amber-500/90 leading-snug" data-ai-compaction>
            {store.compactionNote}
          </div>
        )}
        {toolLog.length > 0 && (
          <div className="text-[10px] text-cc-muted border-t border-cc-border pt-2">
            <div className="font-semibold mb-1">Agent tool calls</div>
            {toolLog.map((t) => (
              <div key={t.id} className="flex items-start gap-1" data-ai-tool-log>
                {/* Phase 22. `granted` alone could not distinguish "the user said
                    no" from "it failed", because the Phase 11 event carries only
                    the boolean. `status` is what makes the two visually
                    different — amber for a refused call, red for a failed one. */}
                <span
                  className={
                    t.status === "denied" || !t.granted
                      ? "text-red-400"
                      : t.status === "error"
                        ? "text-amber-500"
                        : "text-green-500"
                  }
                  data-ai-tool-status={t.status ?? (t.granted ? "ok" : "denied")}
                >
                  ▸ {t.tool}
                  {t.status === "denied" || !t.granted ? " (denied)" : t.status === "error" ? " (failed)" : ""}
                  {t.destructive ? " ⚠" : ""}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Suggested changes */}
      {suggestedChanges.length > 0 && (
        <div className="border-t border-cc-border max-h-56 overflow-y-auto shrink-0 bg-cc-surface/30 px-3 py-2 space-y-3" data-ai-changes>
          {suggestedChanges.map((c) => (
            <div key={c.id} className="border border-cc-border rounded" data-ai-change={c.id}>
              <div className="flex items-center gap-2 px-2 py-1.5 border-b border-cc-border bg-cc-bg">
                <span className="text-[11px] font-semibold text-cc-text truncate flex-1">{c.file.split(/[\\/]/).pop()}</span>
                {c.applied ? (
                  <span className="text-[11px] text-green-500">Applied ✓</span>
                ) : (
                  <>
                    <button
                      type="button"
                      className="text-[11px] px-2 py-0.5 rounded bg-cc-accent text-white hover:bg-cc-accent/90"
                      onClick={() => void useAiStore.getState().applyChange(c.id)}
                      data-ai-change-apply
                    >
                      Apply
                    </button>
                    <button
                      type="button"
                      className="text-[11px] px-2 py-0.5 rounded border border-cc-border hover:bg-cc-surface text-cc-muted hover:text-cc-text"
                      onClick={() => useAiStore.getState().discardChange(c.id)}
                      data-ai-change-discard
                    >
                      Discard
                    </button>
                  </>
                )}
              </div>
              <pre className="px-2 py-1.5 text-[11px] leading-snug overflow-x-auto max-h-40" data-ai-change-diff>
                {c.diff.split("\n").map((line, i) => (
                  <div
                    key={i}
                    className={line.startsWith("+") && !line.startsWith("+++") ? "text-green-500" : line.startsWith("-") && !line.startsWith("---") ? "text-red-400" : "text-cc-muted"}
                  >
                    {line || " "}
                  </div>
                ))}
              </pre>
            </div>
          ))}
        </div>
      )}

      {/* Approval requests */}
      {approvalRequests.map((a) => {
        // Straight off the event. The renderer keeps no copy of the label table,
        // so the words on the prompt cannot drift from the words the gate and the
        // settings panel use for the same permission.
        const capabilityLabels = a.capabilityLabels ?? [];
        return (
        <div key={a.id} className="border-t border-cc-border px-3 py-2 bg-amber-500/10 shrink-0" data-ai-approval={a.id}>
          <div className="text-xs text-cc-text mb-1">
            The assistant wants to use <span className="font-semibold text-amber-400">{a.tool}</span>
            {/* Phase 22. A destructive tool gets a plain statement of the fact
                before the arguments, not a colour change the user has to notice
                on their own. "Approve" for `write_file` and "Approve" for
                `grep_files` should not look like the same decision. */}
            {a.destructive && (
              <div
                className="mt-1 text-[11px] text-red-400"
                data-ai-approval-destructive
              >
                This can overwrite files, change git history, or run commands on your machine.
              </div>
            )}
            {/* Phase 23. What is being permitted, in the user's own terms.
                A tool name is not a permission: "Approve write_file" and "Approve
                delete_file" are different decisions that would look identical
                without the operation named. The capability ids are the same
                strings the gate checks, so what is displayed is what is enforced. */}
            {capabilityLabels.length > 0 && (
              <div className="mt-1 text-[11px] text-cc-muted" data-ai-approval-capabilities>
                Permission needed:{" "}
                <span className="text-cc-text">{capabilityLabels.join(", ")}</span>
              </div>
            )}
            {/* The one case where the prompt appears even though the user
                allowed the capability. Said out loud, because a prompt that
                contradicts a setting the user just made is the fastest way to
                teach them that the setting does not work. */}
            {a.escalation && (
              <div className="mt-1 text-[11px] text-amber-400" data-ai-approval-escalation>
                {a.escalation.reason} This one always asks, even when allowed.
              </div>
            )}
            {a.args && Object.keys(a.args).length > 0 && (
              <pre className="mt-1 text-[10px] bg-cc-bg rounded px-2 py-1 overflow-x-auto text-cc-muted">
                {JSON.stringify(a.args, null, 2)}
              </pre>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="text-[11px] px-2 py-1 rounded bg-cc-accent text-white hover:bg-cc-accent/90"
              onClick={() => useAiStore.getState().respondApproval(a.id, true)}
              data-ai-approve
            >
              Approve
            </button>
            <button
              type="button"
              className="text-[11px] px-2 py-1 rounded border border-cc-border hover:bg-cc-surface text-cc-muted"
              onClick={() => useAiStore.getState().respondApproval(a.id, false)}
              data-ai-deny
            >
              Deny
            </button>
          </div>
        </div>
        );
      })}

      {/* Input */}
      <div className="px-3 py-2 border-t border-cc-border shrink-0">
        <div className="flex items-end gap-2">
          <textarea
            className="flex-1 bg-cc-surface border border-cc-border rounded px-2 py-1.5 text-xs text-cc-text outline-none resize-none min-h-[44px]"
            rows={2}
            placeholder={`Message ${providerName}…`}
            value={input}
            onChange={(e) => store.setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (sendEnabled) void store.send();
              }
            }}
            data-ai-input
          />
          <button
            type="button"
            disabled={!sendEnabled}
            onClick={() => void store.send()}
            className="px-3 py-2 rounded bg-cc-accent text-white hover:bg-cc-accent/90 disabled:opacity-50 shrink-0 text-xs"
            data-ai-send
          >
            Send
          </button>
        </div>
        <div className="mt-1 text-[10px] text-cc-muted">
          Workspace: {useWorkspaceStore.getState().root ?? "none"} — agent tool access is confined to it.
        </div>
      </div>
    </div>
  );
}