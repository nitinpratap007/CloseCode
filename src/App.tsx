import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorBoundary } from "./components/editor/ErrorBoundary";
import StatusBar from "./components/StatusBar";
import TitleBar from "./components/TitleBar";
import SettingsPanel from "./components/SettingsPanel";
import ExplorerPanel from "./components/explorer/ExplorerPanel";
import TabBar from "./components/Tabs/TabBar";
import MonacoPane from "./components/editor/MonacoPane";
import CommandPalette from "./components/CommandPalette";
import ActivityBar, { type ActivityView } from "./components/ActivityBar";
import SearchPanel from "./components/search/SearchPanel";
import GitPanel from "./components/git/GitPanel";
import DebugPanel from "./components/debug/DebugPanel";
import AiPanel from "./components/ai/AiPanel";
import ExtensionsPanel from "./components/extensions/ExtensionsPanel";
import BottomPanel from "./components/BottomPanel";
import { useWorkspaceStore } from "./stores/workspaceStore";
import { useEditorStore, getCachedContent, overrideContent } from "./stores/editorStore";
import { useSearchStore } from "./stores/searchStore";
import { useGitStore } from "./stores/gitStore";
import { useTerminalStore } from "./stores/terminalStore";
import { useDebugStore } from "./stores/debugStore";
import { useAiStore } from "./stores/aiStore";
import { useAgentStore } from "./stores/agentStore";
import { useSessionStore } from "./stores/sessionStore";
import { useTaskStore } from "./stores/taskStore";
import { useMcpStore } from "./stores/mcpStore";
import { useSkillsStore } from "./stores/skillsStore";
import { useWebResearchStore } from "./stores/webResearchStore";
import { useCommandStore } from "./stores/commandStore";
import { useBuildStore } from "./stores/buildStore";
import { useExtensionStore } from "./stores/extensionStore";
import { usePermissionStore } from "./stores/permissionStore";
import { useSettingsStore } from "./stores/settingsStore";
import { useThemeStore } from "./stores/themeStore";
import ThemePicker from "./components/themes/ThemePicker";
import monaco from "./monaco";
import { applyAccent, resolveEditorTheme } from "./theme/themes";
import { setupLanguages } from "./language/setup";
import { setupDiagnosticsListener } from "./language/diagnostics";
import { getAllLanguages } from "./language/registry";
import { getAllFormatters, registerFormatter, unregisterFormatter } from "./formatter/registry";
import { setupFormatters, setFormatterConfig } from "./formatter";
import { formatViaMonaco } from "./formatter/manager";
import {
  DEFAULT_EDITOR_SETTINGS,
  type EditorSettings,
} from "./types/settings";
import { registerAppCommands } from "./commands/appCommands";
import { createShortcutManager } from "./commands/shortcutManager";
import { executeCommand, getAllCommands, searchCommands, registerCommand, getCommandByShortcut } from "./commands/registry";

export default function App(): React.JSX.Element {
  const [settings, setSettings] = useState<EditorSettings>(DEFAULT_EDITOR_SETTINGS);
  const effectiveSettings = useSettingsStore((s) => s.effective);
  const [showSettings, setShowSettings] = useState(false);
  const [explorerVisible, setExplorerVisible] = useState(true);
  const [explorerWidth, setExplorerWidth] = useState(260);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const themePickerOpen = useThemeStore((s) => s.pickerOpen);
  const customThemes = useThemeStore((s) => s.customThemes);
  const [activeView, setActiveView] = useState<ActivityView>("explorer");
  const [aiOpen, setAiOpen] = useState(false);
  const [bottomVisible, setBottomVisible] = useState(false);
  const [bottomHeight, setBottomHeight] = useState(260);
  const [bottomView, setBottomView] = useState<"terminal" | "problems" | "debug">("terminal");
  const [appInfo, setAppInfo] = useState<{
    version: string;
    electron: string;
    chrome: string;
    node: string;
    platform: string;
  } | null>(null);

  // Phase 17: crash recovery — if the renderer crashed with dirty tabs,
  // offer to restore the previous session on launch.
  const [recoverySession, setRecoverySession] = useState<{
    root: string | null; name: string; tabs: Array<{ path: string; name: string; size: number; dirty: boolean }>; activePath: string | null;
  } | null>(null);
  const [recoverySeen, setRecoverySeen] = useState(false);

  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);
  const root = useWorkspaceStore((s) => s.root);
  const activePath = useEditorStore((s) => s.activePath);
  const tabs = useEditorStore((s) => s.tabs);
  const openFileInWorkspace = useEditorStore((s) => s.openFileInWorkspace);
  const newUntitled = useEditorStore((s) => s.newUntitled);
  const saveActive = useEditorStore((s) => s.saveActive);
  const saveAs = useEditorStore((s) => s.saveAs);
  const saveAll = useEditorStore((s) => s.saveAll);
  const closeTab = useEditorStore((s) => s.closeTab);
  const closeAllTabs = useEditorStore((s) => s.closeAllTabs);
  const markChanged = useEditorStore((s) => s.markChanged);

  const handleOpenFileByDialog = useCallback(async (): Promise<void> => {
    const data = await window.closeCode.openFileDialog();
    if (data) {
      await openFileInWorkspace(data.filePath, {
        content: data.content,
        size: data.content.length,
      });
    }
  }, [openFileInWorkspace]);

  const handleOpenFolder = useCallback(async (): Promise<void> => {
    const resp = await window.closeCode.openFolder();
    if (resp.ok && resp.result) {
      await openWorkspace(resp.result.root, resp.result.name);
    }
  }, [openWorkspace]);

  // Phase 20: Close Folder. Refuses outright when any tab holds unsaved edits,
  // for the same reason closeTab does — closing the folder underneath a dirty
  // tab would throw the buffer away with no way back.
  const handleCloseFolder = useCallback(async (): Promise<void> => {
    const s = useEditorStore.getState();
    const dirty = s.tabs.filter((t) => t.dirty);
    if (dirty.length > 0) {
      // window.alert matches how closeTab/saveTab already surface this class of
      // problem (see editorStore) — there is no toast system to hook into.
      window.alert(
        `Cannot close the folder: ${dirty.length} unsaved file${dirty.length > 1 ? "s" : ""}. ` +
          `Save or discard ${dirty.length > 1 ? "them" : "it"} first.`
      );
      return;
    }
    s.closeAllTabs();
    // Phase 21: an agent holding a workspace root must not keep writing into
    // it after the folder is closed.
    await window.closeCode.agentCancelAll();
    await useWorkspaceStore.getState().closeWorkspace();
  }, []);

  // Refs so command registry always calls latest handlers without re-register
  const handlersRef = useRef({ handleOpenFileByDialog, handleOpenFolder, handleCloseFolder, saveActive, saveAs, saveAll, closeTab, closeAllTabs, newUntitled });
  useEffect(() => {
    handlersRef.current = { handleOpenFileByDialog, handleOpenFolder, handleCloseFolder, saveActive, saveAs, saveAll, closeTab, closeAllTabs, newUntitled };
  }, [handleOpenFileByDialog, handleOpenFolder, handleCloseFolder, saveActive, saveAs, saveAll, closeTab, closeAllTabs, newUntitled]);

  const settingsRef = useRef(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  const explorerVisibleRef = useRef(explorerVisible);
  useEffect(() => { explorerVisibleRef.current = explorerVisible; }, [explorerVisible]);
  const activeViewRef = useRef(activeView);
  useEffect(() => { activeViewRef.current = activeView; }, [activeView]);

  // Phase 17: on mount, check whether the renderer crashed last time
  // with dirty tabs. If so, surface the restore offer once.
  useEffect(() => {
    void (async () => {
      try {
        const rec = await window.closeCode.sessionRecovery();
        if (rec.hasRecovery) {
          const session = await window.closeCode.acceptRecovery();
          if (session.ok && session.session) {
            setRecoverySession(session.session);
          } else {
            await window.closeCode.dismissRecovery();
          }
        }
      } catch {}
      setRecoverySeen(true);
    })();
  }, []);

  // Phase 17: heartbeat — persist the open session every 15 s so that
  // a crash leaves a recent enough state to recover from.
  useEffect(() => {
    const tick = async () => {
      try {
        const tabs = useEditorStore.getState().tabs;
        const session = {
          root: useWorkspaceStore.getState().root,
          name: useWorkspaceStore.getState().root ? (useWorkspaceStore.getState().root!.split(/[\\/]/).pop() ?? "") : "",
          tabs: tabs.map((t) => ({ path: t.path, name: t.name, size: t.size ?? 0, dirty: t.dirty })),
          activePath: useEditorStore.getState().activePath,
          openedAt: Date.now(),
        };
        await window.closeCode.sessionHeartbeat(session);
      } catch {}
    };
    tick();
    heartbeatRef.current = setInterval(tick, 15_000);
    return () => { if (heartbeatRef.current) clearInterval(heartbeatRef.current); };
  }, []);

  // Settings system (Phase 14): init the settings store (schema + 3 scopes),
  // then fold the merged effective values into local state so every consumer
  // (Monaco, auto-save, formatter, status bar…) picks up user/workspace overrides.
  useEffect(() => {
    void useSettingsStore.getState().init();
    void useThemeStore.getState().init();
    // Phase 21: subscribe to the agent runtime's event stream.
    useAgentStore.getState().startListening();
    // Phase 27: re-open whichever session was last active, so a restart lands
    // back where the user left off instead of on an empty conversation.
    useSessionStore.getState().startListening();
  }, []);

  useEffect(() => {
    if (!effectiveSettings || Object.keys(effectiveSettings).length === 0) return;
    setSettings({ ...DEFAULT_EDITOR_SETTINGS, ...effectiveSettings } as EditorSettings);
  }, [effectiveSettings]);

  // A custom theme can finish registering after the editor's first settings
  // pass. Re-resolve once the registry changes so a persisted custom theme is
  // restored even when no file is open in the editor yet.
  useEffect(() => {
    if (!effectiveSettings || Object.keys(effectiveSettings).length === 0) return;
    monaco.editor.setTheme(resolveEditorTheme(effectiveSettings));
  }, [effectiveSettings.editorTheme, effectiveSettings.theme, customThemes]);

  // Custom themes are discovered from both the global userData directory and
  // the active workspace. A folder can be opened through the IPC API directly,
  // so refresh whenever the workspace root changes as well as on the event.
  useEffect(() => {
    if (root) void useThemeStore.getState().refreshCustom();
  }, [root]);

  // Auto-save afterDelay
  useEffect(() => {
    if (settings.autoSave !== "afterDelay") return;
    const dirtyTabs = tabs.filter((t) => t.dirty && !t.path.startsWith("untitled:"));
    if (dirtyTabs.length === 0) return;
    const id = window.setTimeout(() => {
      void saveAll();
    }, Math.max(300, settings.autoSaveDelay));
    return () => window.clearTimeout(id);
  }, [tabs, settings.autoSave, settings.autoSaveDelay, saveAll]);

  // beforeunload guard — never silently lose code
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent): string | void => {
      const hasDirty = useEditorStore.getState().tabs.some((t) => t.dirty);
      if (hasDirty) {
        e.preventDefault();
        e.returnValue = "";
        return "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  // Expose stores for CDP integration tests (phase 3/4/5) — also expose language helpers
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__editorStore = useEditorStore;
    w.__workspaceStore = useWorkspaceStore;
    w.__searchStore = useSearchStore;
    w.__cacheContent = overrideContent;
    w.__getCachedContent = getCachedContent;
    w.__debugStore = useDebugStore;
    w.__gitStore = useGitStore;
    w.__terminalStore = useTerminalStore;
  }, []);

  // Start listening for debug events from the main process (Phase 10)
  useEffect(() => {
    useDebugStore.getState().startListening();
  }, []);

  // AI + extension stores (Phase 11/12/13)
  useEffect(() => {
    useAiStore.getState().startListening();
    useExtensionStore.getState().startListening();
  }, []);

  useEffect(() => {
    (window as unknown as Record<string, unknown>).__paletteOpen = paletteOpen;
  }, [paletteOpen]);

  useEffect(() => {
    (window as unknown as Record<string, unknown>).__activeView = activeView;
  }, [activeView]);

  useEffect(() => {
    (window as unknown as Record<string, unknown>).__bottomView = bottomView;
  }, [bottomView]);

  useEffect(() => {
    (window as unknown as Record<string, unknown>).__bottomVisible = bottomVisible;
  }, [bottomVisible]);

  // Sync Git cwd with workspace root (Phase 9)
  const gitSetCwd = useGitStore((s) => s.setCwd);
  const gitCheckIsRepo = useGitStore((s) => s.checkIsRepo);
  const gitRefreshStatus = useGitStore((s) => s.refreshStatus);
  const gitRefreshBranches = useGitStore((s) => s.refreshBranches);
  const gitGetLog = useGitStore((s) => s.getLog);
  useEffect(() => {
    gitSetCwd(root);
    if (root) {
      void gitCheckIsRepo();
      void gitRefreshStatus();
      void gitRefreshBranches();
      void gitGetLog();
    }
  }, [root, gitSetCwd, gitCheckIsRepo, gitRefreshStatus, gitRefreshBranches, gitGetLog]);

  // Language support: setup Monaco languages + diagnostics listener (Phase 7)
  useEffect(() => {
    setupLanguages();
    const cleanup = setupDiagnosticsListener();
    return cleanup;
  }, []);

  // Formatter: setup + sync config from settings (Phase 8)
  useEffect(() => {
    setupFormatters({ defaultFormatter: settings.defaultFormatter, formatOnSave: settings.formatOnSave });
  }, []);
  useEffect(() => {
    setFormatterConfig({ defaultFormatter: settings.defaultFormatter, formatOnSave: settings.formatOnSave });
  }, [settings.defaultFormatter, settings.formatOnSave]);

  // Register all commands programmatically — single source of truth (Phase 4/5/6/7/8)
  useEffect(() => {
    const unregister = registerAppCommands({
      openFile: () => handlersRef.current.handleOpenFileByDialog(),
      openFolder: () => handlersRef.current.handleOpenFolder(),
      closeFolder: () => handlersRef.current.handleCloseFolder(),
      save: async () => {
        if (settingsRef.current.formatOnSave) {
          await formatViaMonaco();
          // Give Monaco a tick to update model before saving
          await new Promise((r) => setTimeout(r, 60));
        }
        await handlersRef.current.saveActive();
      },
      saveAs: () => handlersRef.current.saveAs(),
      saveAll: async () => {
        if (settingsRef.current.formatOnSave) {
          await formatViaMonaco();
          await new Promise((r) => setTimeout(r, 60));
        }
        await handlersRef.current.saveAll();
      },
      closeTab: () => {
        const cur = useEditorStore.getState().activePath;
        if (!cur) return;
        const tab = useEditorStore.getState().tabs.find((t) => t.path === cur);
        if (tab?.dirty) {
          const ok = window.confirm(`"${tab.name}" has unsaved changes. Close anyway?`);
          if (!ok) return;
        }
        handlersRef.current.closeTab(cur);
      },
      closeAllTabs: () => {
        const dirty = useEditorStore.getState().tabs.filter((t) => t.dirty);
        if (dirty.length > 0) {
          const ok = window.confirm(`${dirty.length} tab(s) have unsaved changes. Close all anyway?`);
          if (!ok) return;
        }
        handlersRef.current.closeAllTabs();
      },
      toggleExplorer: () => {
        if (activeViewRef.current === "explorer" && explorerVisibleRef.current) setExplorerVisible(false);
        else { setActiveView("explorer"); setExplorerVisible(true); }
      },
      toggleSidebar: () => setExplorerVisible((v) => !v),
      toggleSearch: () => {
        if (activeViewRef.current === "search" && explorerVisibleRef.current) setExplorerVisible(false);
        else { setActiveView("search"); setExplorerVisible(true); }
      },
      toggleTerminal: () => {
        setBottomView("terminal");
        setBottomVisible((v) => !v);
      },
      viewProblems: () => {
        setBottomView("problems");
        setBottomVisible(true);
      },
      showGit: () => {
        setActiveView("git");
        setExplorerVisible(true);
      },
      showDebug: () => {
        setActiveView("debug");
        setExplorerVisible(true);
      },
      debugContinue: () => {
        const st = useDebugStore.getState();
        if (st.state === "inactive") {
          void st.start(useEditorStore.getState().activePath ?? "");
        } else {
          void st.continue();
        }
      },
      debugStop: () => {
        void useDebugStore.getState().stop();
      },
      debugPause: () => {
        void useDebugStore.getState().pause();
      },
      debugStepOver: () => {
        void useDebugStore.getState().stepOver();
      },
      debugStepInto: () => {
        void useDebugStore.getState().stepInto();
      },
      debugStepOut: () => {
        void useDebugStore.getState().stepOut();
      },
      toggleBreakpoint: () => {
        const file = useEditorStore.getState().activePath;
        if (!file) return;
        const ed = (window as unknown as Record<string, unknown>).__monacoEditor as { getPosition?: () => { lineNumber: number } } | undefined;
        const line = ed?.getPosition?.().lineNumber ?? 1;
        void useDebugStore.getState().toggleBreakpoint(file, line);
      },
      showDebugConsole: () => {
        setBottomView("debug");
        setBottomVisible(true);
      },
      showAi: () => setAiOpen((v) => !v),
      showExtensions: () => {
        setActiveView("extensions");
        setExplorerVisible(true);
      },
      openSettings: () => setShowSettings((v) => !v),
      togglePalette: () => setPaletteOpen((v) => !v),
      openThemePicker: () => useThemeStore.getState().openPicker(),
      cycleTheme: () => useThemeStore.getState().cycle(),
    });
    // Expose registry for tests / palette
    const w = window as unknown as Record<string, unknown>;
    w.__commandRegistry = { execute: (id: string) => executeCommand(id as never) };
    w.__getAllCommands = getAllCommands;
    w.__searchCommands = searchCommands;
    w.__registerCommand = registerCommand;
    w.__getCommandByShortcut = getCommandByShortcut;
    w.__getAllLanguages = getAllLanguages;
    w.__getAllFormatters = getAllFormatters;
    w.__registerFormatter = registerFormatter;
    w.__unregisterFormatter = unregisterFormatter;
    w.__aiStore = useAiStore;
    w.__agentStore = useAgentStore;
    w.__extensionStore = useExtensionStore;
    // Phase 23. Exposed for the integration suite, which drives the permission
    // panel through the same store action its buttons call. Going through the
    // action rather than the raw IPC is deliberate: a test that invoked the
    // channel directly would pass even if the button were wired to nothing.
    w.__permissionStore = usePermissionStore;
    // Phase 27. Same reasoning: the suite must drive session controls through the
    // store actions the buttons call, or a passing test would not prove the
    // buttons do anything.
    w.__sessionStore = useSessionStore;
    // Phase 29. The suite drives task controls through the store actions the
    // buttons call, never through the IPC channels directly.
    w.__taskStore = useTaskStore;
    // Phase 30. Same reasoning for the MCP panel.
    w.__mcpStore = useMcpStore;
    // Phase 31. And for skills & instructions.
    w.__skillsStore = useSkillsStore;
    // Phase 32. And for web research.
    w.__researchStore = useWebResearchStore;
    // Phase 33. Command center & autonomous builder.
    w.__commandStore = useCommandStore;
    w.__buildStore = useBuildStore;
    return unregister;
  }, []);

  useEffect(() => {
    let mounted = true;
    void window.closeCode.getAppInfo().then((info) => mounted && setAppInfo(info));

    const unsubWorkspaceOpened = window.closeCode.onWorkspaceOpened(({ root, name }) => {
      void openWorkspace(root, name);
      void useThemeStore.getState().refreshCustom();
    });
    const unsubFileOpened = window.closeCode.onFileOpened((data) => {
      void openFileInWorkspace(data.filePath, {
        content: data.content,
        size: data.content.length,
      });
    });
    const unsubNewFile = window.closeCode.onMenuNewFile(() => newUntitled());
    const unsubSave = window.closeCode.onMenuSave(() => void saveActive());
    const unsubSaveAs = window.closeCode.onMenuSaveAs(() => void saveAs());

    return () => {
      mounted = false;
      unsubWorkspaceOpened();
      unsubFileOpened();
      unsubNewFile();
      unsubSave();
      unsubSaveAs();
    };
  }, [openWorkspace, openFileInWorkspace, newUntitled, saveActive, saveAs]);

  // Keyboard shortcut manager — dispatches via registry, conflict-aware (Phase 4)
  useEffect(() => {
    const cleanup = createShortcutManager({ onPaletteToggle: () => setPaletteOpen((v) => !v) });
    return cleanup;
  }, []);

  const applyTheme = (theme: EditorSettings["theme"]): void => {
    const isDark = theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : theme === "dark";
    document.documentElement.classList.toggle("dark", isDark);
    document.documentElement.dataset.theme = isDark ? "dark" : "light";
  };

  useEffect(() => {
    applyTheme(settings.theme);
  }, [settings.theme]);

  // Phase 15: user accent color overrides the workbench accent (via CSS vars).
  useEffect(() => {
    applyAccent(settings.accentColor ?? "");
  }, [settings.accentColor]);

  const activeTab = tabs.find((t) => t.path === activePath) ?? null;

  // Phase 17: restore session offered by a crashed renderer.
  const handleRestoreSession = useCallback(async () => {
    if (!recoverySession) return;
    try {
      if (recoverySession.root) {
        await openWorkspace(recoverySession.root, recoverySession.name);
        for (const t of recoverySession.tabs) {
          if (t.dirty) {
            await useEditorStore.getState().openFileInWorkspace(t.path, { content: getCachedContent(t.path), size: t.size });
            useEditorStore.getState().markChanged(t.path);
          } else {
            await useEditorStore.getState().openFileInWorkspace(t.path);
          }
        }
      }
    } catch {}
    setRecoverySession(null);
  }, [recoverySession, openWorkspace]);

  const startResize = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = explorerWidth;
    const onMove = (ev: MouseEvent): void => {
      const w = startWidth + (ev.clientX - startX);
      setExplorerWidth(Math.max(180, Math.min(600, w)));
    };
    const onUp = (): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [explorerWidth]);

  const handleViewChange = useCallback((view: ActivityView): void => {
    setActiveView(view);
    setExplorerVisible(true);
  }, []);

  const startBottomResize = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = bottomHeight;
    const onMove = (ev: MouseEvent): void => {
      const dy = startY - ev.clientY;
      const h = startHeight + dy;
      setBottomHeight(Math.max(120, Math.min(600, h)));
    };
    const onUp = (): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "row-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [bottomHeight]);

  return (
    <div className="flex flex-col h-screen w-screen bg-cc-bg text-cc-text select-none [&_input]:select-text [&_textarea]:select-text">
      {/* Skip-to-content link for keyboard users */}
      <a href="#main-editor" className="skip-link">Skip to main content</a>
      <TitleBar
        fileName={activeTab?.name ?? (tabs.length > 0 ? `${tabs[0].name} +${tabs.length - 1}` : "Untitled")}
        hasUnsaved={activeTab?.dirty ?? false}
        onToggleExplorer={() => void executeCommand("toggle-explorer")}
        onOpenFile={() => void executeCommand("open-file")}
        onOpenFolder={() => void executeCommand("open-folder")}
        onSettings={() => void executeCommand("settings")}
        onPalette={() => setPaletteOpen(true)}
      />

      <div className="flex-1 flex overflow-hidden" role="main" id="main-editor" aria-label="Main editor workspace">
        <ActivityBar
          activeView={activeView}
          aiOpen={aiOpen}
          onChange={handleViewChange}
          onToggleAi={() => setAiOpen((v) => !v)}
        />
        {explorerVisible && (
          <div className="h-full flex shrink-0" style={{ width: explorerWidth }}>
            <div className="w-full h-full">
              {activeView === "explorer" ? (
                <ExplorerPanel onOpenFolder={() => void executeCommand("open-folder")} />
              ) : activeView === "search" ? (
                <SearchPanel />
              ) : activeView === "git" ? (
                <GitPanel />
              ) : activeView === "extensions" ? (
                <ExtensionsPanel />
              ) : (
                <DebugPanel />
              )}
            </div>
            <div
              className="w-1 cursor-col-resize bg-cc-border/50 hover:bg-cc-accent transition-colors shrink-0"
              onMouseDown={startResize}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize explorer"
            />
          </div>
        )}

        <div className="flex-1 flex flex-col min-w-0" role="tabpanel" aria-label="Editor panel" aria-roledescription="code editor">
          <TabBar onSaveActive={() => void executeCommand("save")} />
          <div className="flex-1 min-h-0 relative">
            {/* Phase 17: isolate editor crashes from the rest of the UI. */}
            <ErrorBoundary label="Editor">
              <div role="textbox" aria-label="Code editor" tabIndex={0} data-monaco-editor>
                <MonacoPane
                  activePath={activePath}
                  hasTabs={tabs.length > 0}
                  settings={settings}
                  onChange={(path) => {
                    markChanged(path);
                  }}
                />
              </div>
            </ErrorBoundary>
          </div>
          {/* aria-live region for screen reader announcements */}
          <div aria-live="polite" aria-atomic="true" className="sr-only" id="a11y-announcer" />
          {bottomVisible && (
            <div style={{ height: bottomHeight }} className="shrink-0 flex flex-col border-t border-cc-border bg-cc-bg">
              <div
                className="h-1 cursor-row-resize bg-cc-border/30 hover:bg-cc-accent transition-colors shrink-0"
                onMouseDown={startBottomResize}
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize panel"
              />
              <div className="flex-1 min-h-0">
                <BottomPanel activeView={bottomView} onViewChange={setBottomView} onClose={() => setBottomVisible(false)} />
              </div>
            </div>
          )}
        </div>

        {showSettings && (
          <SettingsPanel onClose={() => setShowSettings(false)} />
        )}

        {aiOpen && <AiPanel onClose={() => setAiOpen(false)} />}
      </div>

      {settings.showStatusBar !== false && (
        <StatusBar
          theme={settings.theme}
          fontSize={settings.fontSize}
          appInfo={appInfo}
        />
      )}

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />

      {/* Phase 17: crash-recovery offer. Shown once when the renderer
        recovered with dirty tabs from the previous session. */}
      {recoverySeen && recoverySession && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, zIndex: 9999,
          background: "#1a1a2e", borderBottom: "2px solid #f66",
          color: "#fbb", padding: 12, display: "flex", gap: 12, alignItems: "center",
        }}>
          <span>The editor crashed last time. Restore {recoverySession.tabs.filter((t) => t.dirty).length} unsaved tab(s)?</span>
          <button onClick={handleRestoreSession}>Restore</button>
          <button onClick={() => setRecoverySession(null)}>Dismiss</button>
        </div>
      )}

      {themePickerOpen && <ThemePicker />}
    </div>
  );
}