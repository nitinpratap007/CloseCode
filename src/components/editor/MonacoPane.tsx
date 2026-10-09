import { useEffect, useRef } from "react";
import monaco from "../../monaco";
import type { EditorSettings } from "../../types/settings";
import { cacheContent, clearContentOverride, getCachedContent, setContentProvider, useEditorStore } from "../../stores/editorStore";
import { useDebugStore } from "../../stores/debugStore";
import { detectLanguage } from "../../lib/language";
import { resolveEditorTheme } from "../../theme/themes";

interface MonacoPaneProps {
  activePath: string | null;
  hasTabs: boolean;
  settings: EditorSettings;
  onChange: (path: string) => void;
}

const MAX_MODELS = 20;
// Phase 16: above this size the editor stops language features and heavy decorations.
// Matches the `largeFileThreshold` setting used by the editor store.
const LARGE_MODEL_BYTES = 5 * 1024 * 1024;

function samePath(a: string, b: string): boolean {
  if (!a || !b) return false;
  const na = a.split("\\").join("/").toLowerCase().replace(/^\/+/, "");
  const nb = b.split("\\").join("/").toLowerCase().replace(/^\/+/, "");
  return na === nb;
}

export default function MonacoPane({
  activePath,
  hasTabs,
  settings,
  onChange,
}: MonacoPaneProps): React.JSX.Element {
  const largeFileWarning = useEditorStore((s) => s.largeFileWarning);
  const setLargeFileWarning = useEditorStore((s) => s.setLargeFileWarning);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelCacheRef = useRef<Map<string, monaco.editor.ITextModel>>(new Map());
  const modelOrderRef = useRef<string[]>([]);
  const decoIdsRef = useRef<string[]>([]);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const activeRef = useRef<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const editor = monaco.editor.create(container, {
      value: "",
      language: "plaintext",
      automaticLayout: true,
      theme: resolveEditorTheme(settings),
      scrollBeyondLastLine: false,
      glyphMargin: true,
    });
    editorRef.current = editor;
    (window as unknown as Record<string, unknown>).__monacoEditor = editor;
    // Phase 16: serve the live model as the content source for the attached file so
    // `getCachedContent` never needs a per-keystroke `editor.getValue()` copy.
    setContentProvider((p) => {
      const model = editor.getModel();
      if (!model) return undefined;
      const uri = model.uri;
      const fsPath = uri?.fsPath || uri?.path || "";
      if (!samePath(fsPath, p)) return undefined;
      return model.getValue();
    });
    const sub = editor.onDidChangeModelContent(() => {
      const active = activeRef.current;
      if (!active) return;
      // Phase 16: no full-document copy here — only the dirty flag flips per keystroke.
      onChangeRef.current(active);
    });
    // Toggle breakpoints on glyph-margin click (Phase 10)
    const gutterDisposable = editor.onMouseDown((e) => {
      if (e.target?.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && e.target.position) {
        const file = activeRef.current;
        if (file) void useDebugStore.getState().toggleBreakpoint(file, e.target.position.lineNumber);
      }
    });
    return () => {
      sub.dispose();
      gutterDisposable.dispose();
      setContentProvider(null);
      editor.dispose();
      for (const m of modelCacheRef.current.values()) m.dispose();
      modelCacheRef.current.clear();
      if ((window as unknown as Record<string, unknown>).__monacoEditor === editor) {
        delete (window as unknown as Record<string, unknown>).__monacoEditor;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    monaco.editor.setTheme(resolveEditorTheme(settings));
    const isLarge = activeRef.current ? largeFileWarning === activeRef.current : false;
    editor.updateOptions({
      fontSize: settings.fontSize,
      fontFamily: settings.fontFamily,
      fontLigatures: settings.fontLigatures !== false,
      tabSize: settings.tabSize,
      insertSpaces: true,
      wordWrap: settings.wordWrap,
      // Phase 16: minimap/bracket guides are the dominant cost on very large files.
      minimap: { enabled: settings.minimap && !isLarge },
      lineNumbers: settings.lineNumbers ? "on" : "off",
      renderWhitespace: "selection",
      smoothScrolling: settings.smoothScrolling === true,
      cursorBlinking: settings.cursorBlinking ?? "blink",
      padding: { top: 12, bottom: 12 },
      bracketPairColorization: { enabled: settings.bracketPairColorization !== false && !isLarge },
      guides: { bracketPairs: !isLarge, indentation: !isLarge },
      folding: !isLarge,
      foldingStrategy: "indentation",
      showFoldingControls: isLarge ? "never" : "always",
      matchBrackets: isLarge ? "never" : "always",
      autoClosingBrackets: settings.autoClosingBrackets ?? "languageDefined",
      autoClosingQuotes: settings.autoClosingBrackets === "never" ? "never" : "always",
      autoSurround: "languageDefined",
      formatOnPaste: settings.formatOnPaste === true,
      mouseWheelZoom: settings.mouseWheelZoom === true,
      readOnly: isLarge,
      domReadOnly: isLarge,
      quickSuggestions: !isLarge,
      occurrencesHighlight: isLarge ? "off" : "singleFile",
      stickyScroll: { enabled: !isLarge },
    });
  }, [settings, largeFileWarning]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !activePath) return;

    // Phase 16: snapshot the outgoing model into the string cache before swapping, so
    // background tabs keep a correct copy without a per-keystroke `getValue()`.
    const previous = editor.getModel();
    const previousPath = activeRef.current;
    if (previous && previousPath && !samePath(previous.uri?.fsPath || previous.uri?.path || "", previousPath)) {
      cacheContent(previousPath, previous.getValue());
    }
    activeRef.current = activePath;

    let model = modelCacheRef.current.get(activePath);
    if (!model) {
      const content = getCachedContent(activePath);
      const uri = activePath.startsWith("untitled:")
        ? monaco.Uri.parse(activePath)
        : monaco.Uri.file(activePath);
      const existing = monaco.editor.getModel(uri);
      if (existing) {
        model = existing;
      } else {
        // Phase 16: profiling a 8.4 MB / 150,076 line file showed the renderer going
        // unresponsive for minutes (requestAnimationFrame starved > 180 s) once the
        // model was attached. Tokenising and decorating that many lines is what caused
        // it, so large files are opened as plain text with the expensive visual
        // features disabled — the same degradation VS Code applies to huge files.
        const tabSize = useEditorStore.getState().tabs.find((t) => t.path === activePath)?.size ?? 0;
        const isLarge = tabSize > LARGE_MODEL_BYTES;
        const lang = isLarge
          ? "plaintext"
          : settings.languageAutoDetect !== false
            ? detectLanguage(activePath)
            : settings.defaultLanguage || "plaintext";
        model = monaco.editor.createModel(content, lang, uri);
      }
      modelCacheRef.current.set(activePath, model);
      modelOrderRef.current = modelOrderRef.current.filter((p) => p !== activePath);
      modelOrderRef.current.push(activePath);
      evictModels();
    }

    if (editor.getModel() !== model) {
      editor.setModel(model);
    }
    // The attached model is the live source of truth for this path again.
    clearContentOverride(activePath);

    const cached = getCachedContent(activePath);
    if (cached && model.getValue() !== cached) {
      const pos = editor.getPosition();
      model.setValue(cached);
      if (pos) {
        editor.setPosition(pos);
        editor.revealPositionInCenterIfOutsideViewport(pos);
      }
    }
  }, [activePath]);

  // Debug decorations: breakpoint glyphs + current paused line (Phase 10)
  const breakpoints = useDebugStore((s) => s.breakpoints);
  const callFrames = useDebugStore((s) => s.callFrames);
  useEffect(() => {
    const editor = editorRef.current;
    const file = activeRef.current;
    if (!editor || !file) return;
    const decorations: monaco.editor.IModelDeltaDecoration[] = [];
    for (const bp of breakpoints) {
      if (samePath(bp.file, file)) {
        decorations.push({
          range: new monaco.Range(bp.line, 1, bp.line, 1),
          options: { isWholeLine: true, glyphMarginClassName: "cc-breakpoint-glyph" },
        });
      }
    }
    const paused = callFrames[0];
    if (paused && samePath(paused.url, file)) {
      decorations.push({
        range: new monaco.Range(Math.max(1, paused.line), 1, Math.max(1, paused.line), 1),
        options: { isWholeLine: true, className: "cc-paused-line" },
      });
    }
    decoIdsRef.current = editor.deltaDecorations(decoIdsRef.current, decorations);
  }, [breakpoints, callFrames, activePath]);

  function evictModels(): void {
    const cache = modelCacheRef.current;
    const order = modelOrderRef.current;
    while (cache.size > MAX_MODELS && order.length > 0) {
      const oldest = order.shift();
      if (!oldest) break;
      if (oldest === activeRef.current) {
        order.push(oldest);
        break;
      }
      const m = cache.get(oldest);
      if (m) {
        // Phase 16: keep a correct string snapshot before the model is disposed,
        // since the content cache is no longer updated on every keystroke.
        if (oldest !== activeRef.current) cacheContent(oldest, m.getValue());
        m.dispose();
        cache.delete(oldest);
      }
    }
  }

  return (
    <div className="w-full h-full relative" role="region" aria-label="Code editor workspace">
      <div
        className="w-full h-full"
        ref={containerRef}
        role="textbox"
        aria-label="Code editor — press Ctrl+Shift+P for commands"
        aria-multiline="true"
        tabIndex={0}
        data-monaco-editor
      />

      {(!hasTabs || !activePath) && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-cc-bg text-cc-muted select-none">
          <div className="w-14 h-14 rounded-xl bg-cc-accent/10 flex items-center justify-center text-2xl text-cc-accent">
            {"</>"}
          </div>
          <div className="text-sm font-medium text-cc-text">Close Code</div>
          <div className="text-xs max-w-sm text-center leading-relaxed">
            Open a folder or file to start editing. Use the explorer on the
            left, or press {navigator.platform.includes("Mac") ? "Cmd" : "Ctrl"} + O
            to open a file.
          </div>
        </div>
      )}

      {largeFileWarning && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-20 flex items-center gap-3 px-4 py-2 rounded-lg bg-cc-surface border border-cc-warning/50 text-cc-text text-[12px] shadow-lg">
          <span>
            Large file ({Math.round(
              (useEditorStore.getState().tabs.find((t) => t.path === largeFileWarning)?.size ?? 0) /
                1024 /
                1024
            )} MB) — editing may be slow.
          </span>
          <button
            type="button"
            onClick={() => setLargeFileWarning(null)}
            className="text-cc-muted hover:text-cc-text"
            aria-label="Dismiss large file warning"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}