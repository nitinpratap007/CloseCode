// Close Code — Theme picker modal (Phase 15)
// Workbench theme (dark/light/system) + editor themes (built-in + custom
// theme.json files) + accent color presets. Applies instantly, persisted via
// the Phase 14 settings system (user scope).

import { useEffect, useRef, useState } from "react";
import { getRegisteredThemes } from "../../theme/themes";
import { useThemeStore } from "../../stores/themeStore";
import { useSettingsStore } from "../../stores/settingsStore";

const ACCENT_PRESETS = [
  "#89b4fa", // blue
  "#cba6f7", // mauve
  "#a6e3a1", // green
  "#94e2d5", // teal
  "#fab387", // peach
  "#f38ba8", // pink
  "#f9e2af", // yellow
  "#1e66f5", // light blue
  "#8839ef", // light mauve
  "#fe640b", // light orange
];

const WORKBENCH_THEMES: Array<{ id: "dark" | "light" | "system"; label: string }> = [
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
  { id: "system", label: "System" },
];

export default function ThemePicker(): React.JSX.Element | null {
  const pickerOpen = useThemeStore((s) => s.pickerOpen);
  const closePicker = useThemeStore((s) => s.closePicker);
  const applyEditorTheme = useThemeStore((s) => s.applyEditorTheme);
  const applyWorkbench = useThemeStore((s) => s.applyWorkbench);
  const customThemes = useThemeStore((s) => s.customThemes);

  const theme = useSettingsStore((s) => s.effective.theme) as "dark" | "light" | "system" | undefined;
  const editorTheme = useSettingsStore((s) => s.effective.editorTheme) as string | undefined;
  const accentColor = useSettingsStore((s) => s.effective.accentColor) as string | undefined;

  const [activeAccent, setActiveAccent] = useState<string>("");
  const listRef = useRef<HTMLDivElement | null>(null);

  // Reset accent highlight when the picker opens / the accent changes
  useEffect(() => {
    setActiveAccent(accentColor ?? "");
  }, [accentColor, pickerOpen]);

  useEffect(() => {
    if (!pickerOpen) return;
    const h = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        closePicker();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [pickerOpen, closePicker]);

  if (!pickerOpen) return null;

  const editorThemes = getRegisteredThemes();
  const BUILTIN_NAMES = ["cc-dark", "cc-light", "cc-catppuccin", "cc-aurora"];
  const builtinVisible = editorThemes.filter((d) => BUILTIN_NAMES.includes(d.name));
  const customVisible = editorThemes.filter((d) => !BUILTIN_NAMES.includes(d.name));

  const swatchOf = (name: string): { bg: string; accent: string } => {
    const def = editorThemes.find((d) => d.name === name);
    const kind = def?.kind ?? "dark";
    const base = kind === "light" ? "#ffffff" : (def?.monaco.colors?.["editor.background"] as string | undefined) ?? "#1e1e2e";
    const accent = def?.workbench?.accent ?? (kind === "light" ? "#1e66f5" : "#89b4fa");
    return { bg: base, accent };
  };

  const cardClass = (isActive: boolean): string =>
    `flex items-center gap-2 px-3 py-2 rounded-md border cursor-pointer transition-colors ${
      isActive
        ? "bg-cc-accent/15 border-cc-accent"
        : "bg-cc-surface border-cc-border hover:border-cc-accent/60"
    }`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-black/40 backdrop-blur-[1px]"
      data-theme-picker
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closePicker();
      }}
    >
      <div className="w-[560px] max-h-[70vh] flex flex-col bg-cc-surface border border-cc-border rounded-lg shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-cc-border bg-cc-bg">
          <div>
            <div className="text-sm font-bold text-cc-text">Themes &amp; Accent</div>
            <div className="text-[10px] text-cc-muted mt-0.5">Choose a workbench + editor theme. Changes save instantly.</div>
          </div>
          <button
            type="button"
            data-theme-close
            className="text-cc-muted hover:text-cc-text text-sm px-2"
            onClick={closePicker}
            aria-label="Close theme picker"
          >
            ✕
          </button>
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          {/* Workbench */}
          <section data-theme-group="workbench">
            <div className="text-[10px] uppercase tracking-wider text-cc-muted mb-1.5">Workbench</div>
            <div className="grid grid-cols-3 gap-2">
              {WORKBENCH_THEMES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  data-scheme-btn
                  data-scope-id={t.id}
                  className={cardClass(theme === t.id)}
                  onClick={() => {
                    void applyWorkbench(t.id);
                    closePicker();
                  }}
                >
                  <span
                    className={`inline-block w-3 h-3 rounded-full border border-cc-border ${
                      t.id === "light" ? "bg-[#f5f5f5]" : t.id === "system" ? "bg-gradient-to-br from-[#1e1e2e] to-[#f5f5f5]" : "bg-[#1e1e2e]"
                    }`}
                  />
                  <span className="text-xs text-cc-text">{t.label}</span>
                </button>
              ))}
            </div>
          </section>

          {/* Editor — built-in */}
          <section data-theme-group="editor-builtin">
            <div className="text-[10px] uppercase tracking-wider text-cc-muted mb-1.5">Editor Theme</div>
            <div className="grid grid-cols-2 gap-2">
              {builtinVisible.map((d) => {
                const sw = swatchOf(d.name);
                const active = (editorTheme === d.name) || (editorTheme === "auto" && d.name === (theme === "dark" || theme === "system" ? "cc-dark" : "cc-light"));
                const autoActive = editorTheme === "auto";
                return (
                  <button
                    key={d.name}
                    type="button"
                    data-editor-card
                    data-editor-name={d.name}
                    className={cardClass(active || (autoActive && isAutoTarget(d.name, theme)))}
                    onClick={() => {
                      void applyEditorTheme(d.name);
                      closePicker();
                    }}
                  >
                    <span
                      className="inline-block w-8 h-5 rounded border border-cc-border"
                      style={{ backgroundColor: sw.bg }}
                    />
                    <span className="text-xs text-cc-text capitalize">{d.name.replace(/^cc-/, "")}</span>
                    <span className="ml-auto text-[9px] text-cc-muted">{d.kind}</span>
                  </button>
                );
              })}
            </div>
            {editorTheme === "auto" && (
              <div className="text-[10px] text-cc-muted mt-1" data-editor-auto-badge>
                Auto — follows the workbench theme ({theme === "light" ? "cc-light" : "cc-dark"}). Pick one above to override.
              </div>
            )}
          </section>

          {/* Editor — custom theme.json */}
          {customVisible.length > 0 && (
            <section data-theme-group="custom">
              <div className="text-[10px] uppercase tracking-wider text-cc-muted mb-1.5">
                Custom Themes{" "}
                <span className="normal-case tracking-normal">
                  ({customThemes.filter((m) => m.scope === "user").length} user · {customThemes.filter((m) => m.scope === "workspace").length} workspace)
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {customVisible.map((d) => {
                  const sw = swatchOf(d.name);
                  const meta = customThemes.find((m) => m.name === d.name);
                  return (
                    <button
                      key={d.name}
                      type="button"
                      data-editor-card
                      data-editor-name={d.name}
                      data-theme-custom
                      data-theme-name={d.name}
                      className={cardClass(editorTheme === d.name)}
                      onClick={() => {
                        void applyEditorTheme(d.name);
                        closePicker();
                      }}
                    >
                      <span className="inline-block w-8 h-5 rounded border border-cc-border" style={{ backgroundColor: sw.bg }} />
                      <span className="text-xs text-cc-text truncate">{d.name}</span>
                      <span className="ml-auto text-[9px] text-cc-muted">{meta?.scope === "workspace" ? "ws" : "user"}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {/* Accent */}
          <section data-theme-group="accent">
            <div className="text-[10px] uppercase tracking-wider text-cc-muted mb-1.5">Accent Color</div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-accent-default
                className={`text-[10px] px-2 py-1 rounded border ${
                  !activeAccent ? "border-cc-accent bg-cc-accent/15 text-cc-text" : "border-cc-border text-cc-muted hover:text-cc-text"
                }`}
                onClick={() => {
                  void window.closeCode.saveUserSetting({ accentColor: "" });
                  closePicker();
                }}
              >
                Default
              </button>
              {ACCENT_PRESETS.map((hex) => (
                <button
                  key={hex}
                  type="button"
                  data-accent-swatch
                  data-accent-hex={hex}
                  className={`w-6 h-6 rounded-full border-2 transition-transform ${activeAccent === hex ? "border-cc-text scale-110" : "border-transparent hover:scale-110"}`}
                  style={{ backgroundColor: hex }}
                  aria-label={`Accent ${hex}`}
                  onClick={() => {
                    void window.closeCode.saveUserSetting({ accentColor: hex });
                    closePicker();
                  }}
                />
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function isAutoTarget(name: string, theme: "dark" | "light" | "system" | undefined): boolean {
  return name === (theme === "light" ? "cc-light" : "cc-dark");
}