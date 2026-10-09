// Close Code — MCP servers panel section (Phase 30)
//
// The user's half of MCP: add a server, see whether it actually connected (and
// why not, when not), inspect what it offers, enable/disable/reconnect/remove
// it. Every row is a projection of the manager's state; every button maps onto
// one IPC call; a server that failed says so with the server's own error text
// rather than a generic shrug.
//
// The agent's half of the same servers lives in the run trace: a tool the
// model calls shows up there as `mcp__<server>__<tool>`, gated by the `mcp`
// permission category — which is why this panel links to it rather than
// re-explaining it.

import { useEffect, useState } from "react";
import { useMcpStore } from "../../stores/mcpStore";
import { useAiStore } from "../../stores/aiStore";
import type { McpPromptInfo, McpServerState, McpServerView, McpTransport } from "../../types/electron";

const STATE_STYLE: Record<McpServerState, string> = {
  connected: "text-green-500",
  connecting: "text-cc-accent",
  disconnected: "text-cc-muted",
  disabled: "text-cc-muted line-through",
  failed: "text-red-400",
};

const STATE_TEXT: Record<McpServerState, string> = {
  connected: "connected",
  connecting: "connecting…",
  disconnected: "disconnected",
  disabled: "disabled",
  failed: "failed",
};

function parseKvLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
  }
  return out;
}

/** Add form — one per section, collapsed by default. */
function AddServerForm(): React.JSX.Element {
  const store = useMcpStore();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<McpTransport>("stdio");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [url, setUrl] = useState("");
  const [envText, setEnvText] = useState("");
  const [headerText, setHeaderText] = useState("");

  const reset = (): void => {
    setName("");
    setCommand("");
    setArgsText("");
    setUrl("");
    setEnvText("");
    setHeaderText("");
  };

  const submit = (): void => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const input = {
      name: trimmed,
      transport,
      ...(transport === "stdio"
        ? { command: command.trim(), args: argsText.trim() ? argsText.trim().split(/\s+/) : [] }
        : { url: url.trim(), headers: parseKvLines(headerText) }),
      ...(envText.trim() && transport === "stdio" ? { env: parseKvLines(envText) } : {}),
    };
    void store.add(input).then((server) => {
      if (server) {
        reset();
        setOpen(false);
      }
    });
  };

  if (!open) {
    return (
      <button
        type="button"
        className="mb-2 text-[11px] px-2 py-1 rounded border border-cc-border hover:bg-cc-surface text-cc-muted hover:text-cc-text"
        onClick={() => setOpen(true)}
        data-mcp-add-open
      >
        + Add MCP server
      </button>
    );
  }

  return (
    <div className="mb-2 flex flex-col gap-1 rounded border border-cc-border bg-cc-surface/40 px-2 py-1.5" data-mcp-add-form>
      <div className="flex items-center gap-1.5">
        <input
          className="flex-1 min-w-0 bg-cc-surface border border-cc-border rounded px-2 py-1 text-xs text-cc-text outline-none"
          placeholder="Server name (e.g. filesystem, github)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-mcp-add-name
        />
        <select
          className="bg-cc-surface border border-cc-border rounded px-1 py-1 text-[11px] text-cc-muted outline-none"
          value={transport}
          onChange={(e) => setTransport(e.target.value as McpTransport)}
          data-mcp-add-transport
        >
          <option value="stdio">stdio (local)</option>
          <option value="http">http (remote)</option>
        </select>
      </div>
      {transport === "stdio" ? (
        <>
          <div className="flex items-center gap-1.5">
            <input
              className="flex-1 min-w-0 bg-cc-surface border border-cc-border rounded px-2 py-1 text-[11px] text-cc-text outline-none"
              placeholder="Command (e.g. npx, node, uvx)"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              data-mcp-add-command
            />
            <input
              className="flex-1 min-w-0 bg-cc-surface border border-cc-border rounded px-2 py-1 text-[11px] text-cc-text outline-none"
              placeholder="Args, space-separated"
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              data-mcp-add-args
            />
          </div>
          <textarea
            className="w-full bg-cc-surface border border-cc-border rounded px-2 py-1 text-[11px] text-cc-text outline-none resize-none"
            rows={2}
            placeholder="Env (optional): KEY=value, one per line — stored encrypted, never shown back"
            value={envText}
            onChange={(e) => setEnvText(e.target.value)}
            data-mcp-add-env
          />
        </>
      ) : (
        <>
          <input
            className="w-full bg-cc-surface border border-cc-border rounded px-2 py-1 text-[11px] text-cc-text outline-none"
            placeholder="URL (e.g. http://127.0.0.1:3001/mcp)"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            data-mcp-add-url
          />
          <textarea
            className="w-full bg-cc-surface border border-cc-border rounded px-2 py-1 text-[11px] text-cc-text outline-none resize-none"
            rows={2}
            placeholder="Headers (optional): KEY=value, one per line — stored encrypted, never shown back"
            value={headerText}
            onChange={(e) => setHeaderText(e.target.value)}
            data-mcp-add-headers
          />
        </>
      )}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className="text-[11px] px-2 py-1 rounded border border-cc-border hover:bg-cc-surface text-cc-text disabled:opacity-50"
          onClick={submit}
          disabled={!name.trim() || (transport === "stdio" ? !command.trim() : !url.trim()) || store.busy}
          data-mcp-add-submit
        >
          Add &amp; connect
        </button>
        <button
          type="button"
          className="text-[11px] px-2 py-1 rounded border border-cc-border hover:bg-cc-surface text-cc-muted hover:text-cc-text"
          onClick={() => {
            reset();
            setOpen(false);
          }}
        >
          Cancel
        </button>
        <span className="text-[10px] text-cc-muted">Adding grants nothing — the mcp permission still gates every call.</span>
      </div>
    </div>
  );
}

function PromptRow({ serverId, prompt }: { serverId: string; prompt: McpPromptInfo }): React.JSX.Element {
  const setInput = useAiStore((s) => s.setInput);
  const [args, setArgs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const use = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const res = await window.closeCode.mcpGetPrompt(serverId, prompt.name, args);
      if (!res.ok || !res.messages) {
        setErr(res.error ?? "The prompt could not be fetched.");
        return;
      }
      const text = res.messages.map((m) => m.text).filter(Boolean).join("\n\n");
      setInput(text);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1" data-mcp-prompt={prompt.name}>
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] text-cc-text truncate" title={prompt.description || prompt.name}>
          💬 {prompt.name}
        </span>
        <button
          type="button"
          className="ml-auto text-[10px] px-1.5 py-0.5 rounded border border-cc-border hover:bg-cc-surface text-cc-muted hover:text-cc-text disabled:opacity-50"
          onClick={() => void use()}
          disabled={busy}
          title="Fetch this prompt and put it in the chat input"
          data-mcp-prompt-use={prompt.name}
        >
          use in chat
        </button>
      </div>
      {prompt.arguments.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {prompt.arguments.map((a) => (
            <input
              key={a.name}
              className="flex-1 min-w-20 bg-cc-surface border border-cc-border rounded px-1.5 py-0.5 text-[10px] text-cc-text outline-none"
              placeholder={`${a.name}${a.required ? " *" : ""}`}
              title={a.description || a.name}
              value={args[a.name] ?? ""}
              onChange={(e) => setArgs((prev) => ({ ...prev, [a.name]: e.target.value }))}
              data-mcp-prompt-arg={`${prompt.name}:${a.name}`}
            />
          ))}
        </div>
      )}
      {err && <div className="text-[10px] text-red-400">{err}</div>}
    </div>
  );
}

function ServerDetails({ server }: { server: McpServerView }): React.JSX.Element {
  const store = useMcpStore();
  const tools = store.tools[server.id] ?? [];
  const resources = store.resources[server.id] ?? [];
  const prompts = store.prompts[server.id] ?? [];
  const [readUri, setReadUri] = useState<string | null>(null);
  const [readText, setReadText] = useState<string | null>(null);

  const read = async (uri: string): Promise<void> => {
    setReadUri(uri);
    setReadText(null);
    const res = await window.closeCode.mcpReadResource(server.id, uri);
    setReadText(res.ok && typeof res.text === "string" ? res.text : `Error: ${res.error ?? "could not read"}`);
  };

  return (
    <div className="mt-1 flex flex-col gap-1.5 border-t border-cc-border/60 pt-1.5" data-mcp-detail-body={server.id}>
      {tools.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold text-cc-muted uppercase tracking-wide mb-0.5">Tools ({tools.length})</div>
          {tools.map((t) => (
            <div key={t.name} className="flex items-center gap-1.5 text-[11px]" title={t.description || t.name} data-mcp-tool={`${server.id}:${t.name}`}>
              <span className="text-cc-text truncate">🔧 mcp__…__{t.name}</span>
              {t.readOnlyHint && <span className="text-[9px] text-green-500 shrink-0">read-only</span>}
              {t.destructiveHint && <span className="text-[9px] text-red-400 shrink-0">destructive</span>}
            </div>
          ))}
        </div>
      )}
      {resources.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold text-cc-muted uppercase tracking-wide mb-0.5">Resources ({resources.length})</div>
          {resources.map((r) => (
            <div key={r.uri} className="flex items-center gap-1.5 text-[11px]" title={r.description || r.uri} data-mcp-resource={`${server.id}:${r.uri}`}>
              <span className="text-cc-text truncate">📄 {r.name}</span>
              <button
                type="button"
                className="ml-auto text-[10px] px-1.5 py-0.5 rounded border border-cc-border hover:bg-cc-surface text-cc-muted hover:text-cc-text"
                onClick={() => void read(r.uri)}
                data-mcp-resource-read={r.uri}
              >
                read
              </button>
            </div>
          ))}
          {readUri && (
            <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded border border-cc-border/60 bg-cc-surface/60 p-1.5 text-[10px] text-cc-text" data-mcp-resource-text>
              {readText ?? "reading…"}
            </pre>
          )}
        </div>
      )}
      {prompts.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold text-cc-muted uppercase tracking-wide mb-0.5">Prompts ({prompts.length})</div>
          {prompts.map((p) => (
            <PromptRow key={p.name} serverId={server.id} prompt={p} />
          ))}
        </div>
      )}
      {tools.length === 0 && resources.length === 0 && prompts.length === 0 && (
        <div className="text-[10px] text-cc-muted" data-mcp-detail-empty={server.id}>
          This server offers no tools, resources or prompts.
        </div>
      )}
    </div>
  );
}

function ServerRow({ server }: { server: McpServerView }): React.JSX.Element {
  const store = useMcpStore();
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col rounded border border-cc-border/60 bg-cc-surface/40 px-2 py-1.5" data-mcp-server={server.id}>
      <div className="flex items-center gap-1.5 min-w-0">
        <span className={`text-[11px] shrink-0 ${STATE_STYLE[server.state]}`} data-mcp-state={server.id}>
          {STATE_TEXT[server.state]}
        </span>
        <span className="text-[11px] font-medium text-cc-text truncate" title={server.transport === "stdio" ? `${server.command} ${server.args.join(" ")}`.trim() : server.url} data-mcp-name={server.id}>
          {server.name}
        </span>
        <span className="text-[10px] text-cc-muted shrink-0" data-mcp-transport={server.id}>
          {server.transport}
        </span>
        {server.counts.tools > 0 && (
          <span className="text-[10px] text-cc-muted shrink-0" data-mcp-tool-count={server.id}>
            {server.counts.tools}🔧
          </span>
        )}
        <div className="ml-auto flex items-center gap-1 shrink-0">
          {server.state === "connected" && (
            <button
              type="button"
              className="text-[10px] px-1.5 py-0.5 rounded border border-cc-border hover:bg-cc-surface text-cc-muted hover:text-cc-text"
              onClick={() => {
                const next = !open;
                setOpen(next);
                if (next) void store.loadDetails(server.id);
              }}
              data-mcp-details={server.id}
            >
              {open ? "hide" : "details"}
            </button>
          )}
          {(server.state === "failed" || server.state === "disconnected") && server.enabled && (
            <button
              type="button"
              className="text-[10px] px-1.5 py-0.5 rounded border border-cc-border hover:bg-cc-surface text-cc-muted hover:text-cc-text"
              onClick={() => void store.reconnect(server.id)}
              data-mcp-reconnect={server.id}
            >
              reconnect
            </button>
          )}
          <button
            type="button"
            className="text-[10px] px-1.5 py-0.5 rounded border border-cc-border hover:bg-cc-surface text-cc-muted hover:text-cc-text"
            onClick={() => void store.update({ id: server.id, enabled: !server.enabled })}
            title={server.enabled ? "Disable (closes the connection, keeps the config)" : "Enable"}
            data-mcp-toggle={server.id}
          >
            {server.enabled ? "disable" : "enable"}
          </button>
          <button
            type="button"
            className="text-[10px] px-1.5 py-0.5 rounded border border-cc-border hover:bg-red-500/10 text-cc-muted hover:text-red-400"
            onClick={() => void store.remove(server.id)}
            data-mcp-remove={server.id}
          >
            remove
          </button>
        </div>
      </div>
      {server.state === "failed" && server.lastError && (
        <div className="mt-1 text-[10px] text-red-400 break-words" data-mcp-error={server.id}>
          {server.lastError}
        </div>
      )}
      {server.state === "connected" && server.server && (
        <div className="mt-0.5 text-[10px] text-cc-muted" data-mcp-serverinfo={server.id}>
          {server.server.name} {server.server.version}
          {server.counts.resources > 0 ? ` · ${server.counts.resources} resources` : ""}
          {server.counts.prompts > 0 ? ` · ${server.counts.prompts} prompts` : ""}
        </div>
      )}
      {open && server.state === "connected" && <ServerDetails server={server} />}
    </div>
  );
}

export default function McpSection(): React.JSX.Element {
  const store = useMcpStore();

  useEffect(() => {
    store.startListening();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="px-3 py-2 border-b border-cc-border shrink-0 max-h-64 overflow-y-auto" data-ai-mcp>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[11px] font-semibold text-cc-muted uppercase tracking-wide">
          MCP Servers{store.servers.length > 0 ? ` (${store.servers.length})` : ""}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {store.busy && <span className="text-[11px] text-cc-muted">working…</span>}
        </div>
      </div>

      {store.error && (
        <div className="mb-1.5 text-[11px] text-red-400 bg-red-500/10 border border-red-500/30 rounded px-2 py-1" data-ai-mcp-error>
          {store.error}
        </div>
      )}
      {store.notice && (
        <div className="mb-1.5 text-[11px] text-cc-muted bg-cc-surface border border-cc-border rounded px-2 py-1" data-ai-mcp-notice>
          {store.notice}
        </div>
      )}

      <AddServerForm />

      {store.servers.length === 0 ? (
        <div className="text-[11px] text-cc-muted" data-mcp-empty>
          No MCP servers configured. Added servers connect here and offer their tools to the agent behind the mcp permission.
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {store.servers.map((s) => (
            <ServerRow key={s.id} server={s} />
          ))}
        </div>
      )}
    </div>
  );
}
