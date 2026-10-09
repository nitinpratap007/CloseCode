import { useEffect, useRef, useState } from "react";
import { useSearchStore } from "../../stores/searchStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useSettingsStore } from "../../stores/settingsStore";
import FileIcon from "../explorer/FileIcon";

function highlightMatch(text: string, query: string, isRegex: boolean, caseSensitive: boolean, wholeWord: boolean): React.JSX.Element {
  if (!query) return <>{text}</>;
  try {
    let pat = isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (wholeWord) pat = `\\b${pat}\\b`;
    const flags = caseSensitive ? "g" : "gi";
    const re = new RegExp(pat, flags);
    const parts: React.JSX.Element[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    let idx = 0;
    // eslint-disable-next-line no-cond-assign
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      const start = m.index ?? 0;
      if (start > last) parts.push(<span key={`t-${idx++}`}>{text.slice(last, start)}</span>);
      parts.push(<span key={`m-${idx++}`} className="bg-cc-accent text-white rounded px-0.5">{m[0]}</span>);
      last = start + m[0].length;
      if (parts.length > 20) break;
    }
    if (last < text.length) parts.push(<span key={`t-${idx++}`}>{text.slice(last)}</span>);
    return <>{parts}</>;
  } catch {
    return <>{text}</>;
  }
}

export default function SearchPanel(): React.JSX.Element {
  const root = useWorkspaceStore((s) => s.root);
  const query = useSearchStore((s) => s.query);
  const replacement = useSearchStore((s) => s.replacement);
  const options = useSearchStore((s) => s.options);
  const results = useSearchStore((s) => s.results);
  const grouped = useSearchStore((s) => s.grouped);
  const isSearching = useSearchStore((s) => s.isSearching);
  const error = useSearchStore((s) => s.error);
  const truncated = useSearchStore((s) => s.truncated);
  const searchedFiles = useSearchStore((s) => s.searchedFiles);
  const setQuery = useSearchStore((s) => s.setQuery);
  const setReplacement = useSearchStore((s) => s.setReplacement);
  const setOptions = useSearchStore((s) => s.setOptions);
  const search = useSearchStore((s) => s.search);
  const replaceAll = useSearchStore((s) => s.replaceAll);
  const navigateTo = useSearchStore((s) => s.navigateTo);

  const [showReplace, setShowReplace] = useState(false);
  const [localQuery, setLocalQuery] = useState(query);
  const [localReplace, setLocalReplace] = useState(replacement);
  const debounceRef = useRef<number | null>(null);
  const searchDebounceMs = useSettingsStore((s) => s.effective.searchDebounceMs);
  const debounceMs = Number(searchDebounceMs) > 0 ? Number(searchDebounceMs) : 300;

  // Sync from store
  useEffect(() => setLocalQuery(query), [query]);
  useEffect(() => setLocalReplace(replacement), [replacement]);

  // Debounced search: searchDebounceMs (Phase 14 setting)
  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      setQuery(localQuery);
      // search will be triggered by query effect below
    }, debounceMs);
    return () => { if (debounceRef.current) window.clearTimeout(debounceRef.current); };
  }, [localQuery, setQuery, debounceMs]);

  // Also debounced for options? Trigger immediately when options change
  useEffect(() => {
    void search(root);
  }, [query, options, root, search]);

  const handleReplaceAll = async (): Promise<void> => {
    if (!root || !query) return;
    const res = await replaceAll(root);
    if (res) {
      // Show feedback via console, could be toast
      console.info(`Replaced ${res.replacedCount} occurrences in ${res.fileCount} files`);
    }
  };

  const expandedDefault = true;
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());

  useEffect(() => {
    // Expand all by default when results change
    if (expandedDefault && grouped.size > 0) {
      setExpandedFiles(new Set([...grouped.keys()]));
    }
  }, [grouped]);

  const toggleFile = (file: string): void => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  };

  return (
    <section className="h-full flex flex-col bg-cc-sidebar border-r border-cc-border shrink-0" data-search-panel="true">
      <header className="h-9 flex items-center gap-1 px-2 border-b border-cc-border shrink-0">
        <span className="font-semibold text-[12px] uppercase tracking-wide text-cc-muted px-1">Search</span>
        <span className="ml-auto text-[11px] text-cc-muted">{isSearching ? "Searching…" : `${results.length} results`}</span>
      </header>

      <div className="p-2 space-y-2 border-b border-cc-border">
        <div className="flex items-center gap-1">
          <input
            value={localQuery}
            onChange={(e) => setLocalQuery(e.target.value)}
            placeholder="Search"
            className="flex-1 bg-cc-bg border border-cc-border rounded px-2 py-1.5 text-sm text-cc-text placeholder:text-cc-muted focus:outline-none focus:border-cc-accent"
            aria-label="Search"
          />
          <button
            type="button"
            onClick={() => setShowReplace((v) => !v)}
            className={`w-7 h-7 flex items-center justify-center rounded border text-xs ${showReplace ? "bg-cc-accent text-white border-cc-accent" : "bg-cc-bg border-cc-border text-cc-muted hover:text-cc-text"}`}
            title="Toggle Replace"
            aria-label="Toggle Replace"
          >
            ⇄
          </button>
        </div>

        {showReplace && (
          <div className="flex items-center gap-1">
            <input
              value={localReplace}
              onChange={(e) => { setLocalReplace(e.target.value); setReplacement(e.target.value); }}
              placeholder="Replace"
              className="flex-1 bg-cc-bg border border-cc-border rounded px-2 py-1.5 text-sm text-cc-text placeholder:text-cc-muted focus:outline-none focus:border-cc-accent"
              aria-label="Replace"
            />
            <button
              type="button"
              onClick={() => void handleReplaceAll()}
              disabled={!query || !root}
              className="px-2 py-1 text-xs rounded bg-cc-accent text-white hover:bg-cc-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
              title="Replace All (across workspace)"
            >
              All
            </button>
          </div>
        )}

        <div className="flex flex-wrap gap-1">
          <ToggleBtn active={options.isRegex} onClick={() => setOptions({ isRegex: !options.isRegex })} title="Use Regular Expression (Ctrl+Shift+R)" label=".*"/>
          <ToggleBtn active={options.caseSensitive} onClick={() => setOptions({ caseSensitive: !options.caseSensitive })} title="Match Case (Ctrl+Shift+C)" label="Aa"/>
          <ToggleBtn active={options.wholeWord} onClick={() => setOptions({ wholeWord: !options.wholeWord })} title="Match Whole Word (Ctrl+Shift+W)" label='" "'/>
        </div>

        <div className="space-y-1">
          <input
            value={options.include}
            onChange={(e) => setOptions({ include: e.target.value })}
            placeholder="Include (e.g. *.ts, src/**)"
            className="w-full bg-cc-bg border border-cc-border rounded px-2 py-1 text-xs text-cc-text placeholder:text-cc-muted focus:outline-none focus:border-cc-accent"
            aria-label="Include pattern"
          />
          <input
            value={options.exclude}
            onChange={(e) => setOptions({ exclude: e.target.value })}
            placeholder="Exclude (e.g. *.min.js, dist/**)"
            className="w-full bg-cc-bg border border-cc-border rounded px-2 py-1 text-xs text-cc-text placeholder:text-cc-muted focus:outline-none focus:border-cc-accent"
            aria-label="Exclude pattern"
          />
        </div>

        {error && <div className="text-xs text-red-400 px-1">{error}</div>}
        {truncated && <div className="text-xs text-cc-warning px-1">Results truncated at 5000</div>}
        <div className="text-xs text-cc-muted px-1">{searchedFiles > 0 ? `${searchedFiles} files searched` : root ? "Type to search" : "No folder open"}</div>
      </div>

      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        {results.length === 0 && !isSearching && query && (
          <div className="px-3 py-4 text-sm text-cc-muted">No results for “{query}”</div>
        )}
        {[...grouped.entries()].map(([file, fileResults]) => {
          const isExpanded = expandedFiles.has(file);
          const rel = root ? file.slice(root.length + 1) : file;
          const fileName = file.split(/[\\/]/).pop() ?? file;
          return (
            <div key={file} className="border-b border-cc-border/30">
              <button
                type="button"
                onClick={() => toggleFile(file)}
                className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left hover:bg-cc-surface transition-colors"
              >
                <span className="text-cc-muted text-xs">{isExpanded ? "▼" : "▶"}</span>
                <FileIcon name={fileName} isDirectory={false} expanded={false} />
                <span className="flex-1 truncate text-xs font-medium text-cc-text" title={file}>{rel}</span>
                <span className="text-xs text-cc-muted">{fileResults.length}</span>
              </button>
              {isExpanded && (
                <div className="pb-1">
                  {fileResults.map((r, idx) => (
                    <button
                      key={`${r.line}-${r.column}-${idx}`}
                      type="button"
                      onClick={() => navigateTo(r)}
                      className="w-full text-left px-2 py-1 hover:bg-cc-bg flex flex-col gap-0.5 border-l-2 border-transparent hover:border-cc-accent ml-2"
                      title={`${file}:${r.line}:${r.column}`}
                    >
                      <span className="text-[11px] text-cc-muted">{r.line}:{r.column}</span>
                      <span className="text-xs text-cc-text truncate font-mono">
                        {highlightMatch(r.preview, query, options.isRegex, options.caseSensitive, options.wholeWord)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <footer className="h-6 px-2 flex items-center text-[11px] text-cc-muted border-t border-cc-border shrink-0">
        {root ? <span className="truncate" title={root}>{root}</span> : <span>No folder open</span>}
      </footer>
    </section>
  );
}

function ToggleBtn({ active, onClick, label, title }: { active: boolean; onClick: () => void; label: string; title: string }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={`px-1.5 py-1 text-xs rounded border font-mono ${active ? "bg-cc-accent text-white border-cc-accent" : "bg-cc-bg border-cc-border text-cc-muted hover:text-cc-text"}`}
    >
      {label}
    </button>
  );
}
