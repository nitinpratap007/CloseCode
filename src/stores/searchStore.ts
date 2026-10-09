import { create } from "zustand";

export interface SearchOptions {
  isRegex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  include: string;
  exclude: string;
}

export interface SearchResult {
  file: string;
  line: number;
  column: number;
  preview: string;
  lineText: string;
  matchText: string;
  matchLength: number;
}

interface SearchState {
  query: string;
  replacement: string;
  options: SearchOptions;
  results: SearchResult[];
  grouped: Map<string, SearchResult[]>;
  totalFiles: number;
  searchedFiles: number;
  truncated: boolean;
  /** Phase 16: whether the last search was served by the main-process result cache. */
  lastCache: "hit" | "miss" | null;
  isSearching: boolean;
  error: string | null;
  activeResult: SearchResult | null;
  setQuery: (q: string) => void;
  setReplacement: (r: string) => void;
  setOptions: (patch: Partial<SearchOptions>) => void;
  search: (root: string | null) => Promise<void>;
  replaceAll: (root: string | null) => Promise<{ replacedCount: number; fileCount: number } | null>;
  replaceOne: (file: string, result: SearchResult, replacement: string) => Promise<number | null>;
  navigateTo: (result: SearchResult) => void;
  clear: () => void;
}

export const useSearchStore = create<SearchState>((set, get) => ({
  query: "",
  replacement: "",
  options: {
    isRegex: false,
    caseSensitive: false,
    wholeWord: false,
    include: "",
    exclude: "",
  },
  results: [],
  grouped: new Map(),
  totalFiles: 0,
  searchedFiles: 0,
  truncated: false,
  lastCache: null,
  isSearching: false,
  error: null,
  activeResult: null,

  setQuery: (q) => set({ query: q }),
  setReplacement: (r) => set({ replacement: r }),
  setOptions: (patch) => set({ options: { ...get().options, ...patch } }),

  search: async (root) => {
    const { query, options } = get();
    if (!query.trim()) {
      set({ results: [], grouped: new Map(), totalFiles: 0, searchedFiles: 0, truncated: false, error: null });
      return;
    }
    if (!root) {
      set({ error: "No workspace folder is open." });
      return;
    }
    set({ isSearching: true, error: null });
    try {
      const resp = await window.closeCode.searchWorkspace(root, query, options);
      if (!resp.ok || !resp.result) {
        set({ error: resp.error ?? "Search failed", isSearching: false, results: [], grouped: new Map() });
        return;
      }
      const grouped = new Map<string, SearchResult[]>();
      for (const r of resp.result.results) {
        const arr = grouped.get(r.file) ?? [];
        arr.push(r);
        grouped.set(r.file, arr);
      }
      set({
        results: resp.result.results,
        grouped,
        totalFiles: resp.result.totalFiles,
        searchedFiles: resp.result.searchedFiles,
        truncated: resp.result.truncated,
        // Phase 16: "hit" means the main process served the result cache instead of
        // re-reading every file. Surfaced for the profiler; the UI ignores it.
        lastCache: resp.result.cache ?? "miss",
        isSearching: false,
        error: null,
      });
    } catch (err) {
      set({ error: String(err), isSearching: false });
    }
  },

  replaceAll: async (root) => {
    const { query, replacement, options } = get();
    if (!query || !root) return null;
    try {
      const resp = await window.closeCode.replaceAll(root, query, replacement, options);
      if (!resp.ok || !resp.result) {
        set({ error: resp.error ?? "Replace failed" });
        return null;
      }
      // Re-search to update results
      await get().search(root);
      return resp.result;
    } catch (err) {
      set({ error: String(err) });
      return null;
    }
  },

  replaceOne: async (file, result, replacement) => {
    const { query, options } = get();
    try {
      const resp = await window.closeCode.replaceInFile(file, query, replacement, options);
      if (!resp.ok || !resp.result) {
        set({ error: resp.error ?? "Replace failed" });
        return null;
      }
      // Update results: remove this match, but for simplicity re-search would be better
      // We'll just filter out this result
      const newResults = get().results.filter((r) => !(r.file === result.file && r.line === result.line && r.column === result.column));
      const grouped = new Map<string, SearchResult[]>();
      for (const r of newResults) {
        const arr = grouped.get(r.file) ?? [];
        arr.push(r);
        grouped.set(r.file, arr);
      }
      set({ results: newResults, grouped });
      return resp.result.count;
    } catch (err) {
      set({ error: String(err) });
      return null;
    }
  },

  navigateTo: (result) => {
    set({ activeResult: result });
    // Use editorStore to open file
    const w = window as unknown as Record<string, unknown>;
    const editorStore = w.__editorStore as typeof import("./editorStore").useEditorStore | undefined;
    if (editorStore) {
      const p = result.file;
      void editorStore.getState().openFileInWorkspace(p).then(() => {
        // After file opened, reveal line
        setTimeout(() => {
          const e = (w.__monacoEditor as import("monaco-editor").editor.IStandaloneCodeEditor | undefined);
          if (e) {
            e.revealLineInCenter(result.line);
            e.setPosition({ lineNumber: result.line, column: result.column });
            e.focus();
          }
        }, 100);
      });
    }
    // Also set activeResult for highlighting
  },

  clear: () => set({ query: "", results: [], grouped: new Map(), totalFiles: 0, searchedFiles: 0, truncated: false, error: null, activeResult: null }),
}));
