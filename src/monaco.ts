import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import { registerBuiltinThemes } from "./theme/themes";

import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

interface MonacoEnvironmentLike {
  MonacoEnvironment?: {
    getWorker: (workerId: string, label: string) => Worker;
  };
}

const env = self as unknown as MonacoEnvironmentLike;

env.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") {
      return new cssWorker();
    }
    if (label === "html" || label === "handlebars" || label === "razor") {
      return new htmlWorker();
    }
    if (label === "typescript" || label === "javascript") {
      return new tsWorker();
    }
    return new editorWorker();
  },
};

loader.config({ monaco });

// Register the built-in editor themes (Phase 15 theme engine).
registerBuiltinThemes();

// Monaco exposes setTheme() but not a public getter for the active standalone
// theme. Keep a tiny compatibility getter for the theme picker/CDP contract.
type EditorApiWithTheme = typeof monaco.editor & { getTheme?: () => string };
const editorApi = monaco.editor as EditorApiWithTheme;
let activeEditorTheme = "cc-dark";
const setTheme = editorApi.setTheme.bind(monaco.editor);
editorApi.setTheme = ((themeName: string): void => {
  activeEditorTheme = themeName;
  setTheme(themeName);
}) as typeof monaco.editor.setTheme;
editorApi.getTheme = (): string => activeEditorTheme;

// Expose for tests / theme picker
(window as unknown as Record<string, unknown>).__monaco = monaco;

export default monaco;