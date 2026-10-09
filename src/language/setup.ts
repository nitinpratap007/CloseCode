import * as monaco from "monaco-editor";
import { registerLanguage } from "./registry";

export function setupLanguages(): void {
  // TypeScript / JavaScript
  const tsDefaults = monaco.languages.typescript.typescriptDefaults;
  const jsDefaults = monaco.languages.typescript.javascriptDefaults;

  const tsCompilerOptions: monaco.languages.typescript.CompilerOptions = {
    target: monaco.languages.typescript.ScriptTarget.ESNext,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    allowNonTsExtensions: true,
    allowJs: true,
    checkJs: true,
    noEmit: true,
    strict: false,
    jsx: monaco.languages.typescript.JsxEmit.React,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    skipLibCheck: true,
    forceConsistentCasingInFileNames: true,
  };

  const tsDiagnosticsOptions: monaco.languages.typescript.DiagnosticsOptions = {
    noSemanticValidation: false,
    noSyntaxValidation: false,
    onlyVisible: false,
  };

  tsDefaults.setCompilerOptions(tsCompilerOptions);
  tsDefaults.setDiagnosticsOptions(tsDiagnosticsOptions);
  jsDefaults.setCompilerOptions(tsCompilerOptions);
  jsDefaults.setDiagnosticsOptions(tsDiagnosticsOptions);

  // Eager model sync for better diagnostics
  tsDefaults.setEagerModelSync(true);
  jsDefaults.setEagerModelSync(true);

  // JSON
  monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    allowComments: false,
    schemas: [],
    enableSchemaRequest: false,
  });

  // HTML
  // Monaco's html worker handles diagnostics, completion, hover automatically

  // CSS
  // Similarly, css worker handles diagnostics

  // Markdown - no built-in diagnostics, but we can provide basic

  // Register 6 initial languages + extensible others
  registerLanguage({
    id: "html",
    extensions: [".html", ".htm"],
    displayName: "HTML",
    isBuiltIn: true,
    configureMonaco: () => {
      // HTML already configured via worker
    },
  });

  registerLanguage({
    id: "css",
    extensions: [".css", ".scss", ".less"],
    displayName: "CSS",
    isBuiltIn: true,
  });

  registerLanguage({
    id: "javascript",
    extensions: [".js", ".mjs", ".cjs", ".jsx"],
    displayName: "JavaScript",
    isBuiltIn: true,
  });

  registerLanguage({
    id: "typescript",
    extensions: [".ts", ".tsx"],
    displayName: "TypeScript",
    isBuiltIn: true,
  });

  registerLanguage({
    id: "json",
    extensions: [".json"],
    displayName: "JSON",
    isBuiltIn: true,
  });

  registerLanguage({
    id: "markdown",
    extensions: [".md", ".markdown"],
    displayName: "Markdown",
    isBuiltIn: true,
  });

  // Extensible: Python, Java, C/C++, PHP, Rust, Go, etc. — via LSP
  // These are not built-in, require external server. We register them as disabled by default,
  // and lspManager will discover if the server is available.
  const extensible: Array<{ id: string; exts: string[]; name: string; lspCommand: string }> = [
    { id: "python", exts: [".py"], name: "Python", lspCommand: "pylsp" },
    { id: "java", exts: [".java"], name: "Java", lspCommand: "jdtls" },
    { id: "cpp", exts: [".cpp", ".hpp", ".c", ".h"], name: "C/C++", lspCommand: "clangd" },
    { id: "php", exts: [".php"], name: "PHP", lspCommand: "intelephense --stdio" },
    { id: "rust", exts: [".rs"], name: "Rust", lspCommand: "rust-analyzer" },
    { id: "go", exts: [".go"], name: "Go", lspCommand: "gopls" },
  ];

  for (const lang of extensible) {
    registerLanguage({
      id: lang.id,
      extensions: lang.exts,
      displayName: lang.name,
      isBuiltIn: false,
      lsp: {
        command: lang.lspCommand,
        enabled: false, // disabled by default, user can enable via settings
      },
    });
  }

  console.info(`[Language] Registered ${extensible.length + 6} languages (6 built-in + ${extensible.length} LSP)`);
}
