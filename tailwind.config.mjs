/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // All cc-* colors read CSS variables (see src/index.css) so themes can
        // restyle the entire workbench at runtime (Phase 15).
        "cc-bg": "rgb(var(--cc-bg) / <alpha-value>)",
        "cc-surface": "rgb(var(--cc-surface) / <alpha-value>)",
        "cc-border": "rgb(var(--cc-border) / <alpha-value>)",
        "cc-text": "rgb(var(--cc-text) / <alpha-value>)",
        "cc-muted": "rgb(var(--cc-muted) / <alpha-value>)",
        "cc-accent": "rgb(var(--cc-accent) / <alpha-value>)",
        "cc-accent-hover": "rgb(var(--cc-accent-hover) / <alpha-value>)",
        "cc-success": "rgb(var(--cc-success) / <alpha-value>)",
        "cc-warning": "rgb(var(--cc-warning) / <alpha-value>)",
        "cc-error": "rgb(var(--cc-error) / <alpha-value>)",
        "cc-sidebar": "rgb(var(--cc-sidebar) / <alpha-value>)",
        "cc-statusbar": "rgb(var(--cc-statusbar) / <alpha-value>)",
      },
      fontFamily: {
        mono: [
          "Cascadia Code",
          "Fira Code",
          "JetBrains Mono",
          "Consolas",
          "monospace",
        ],
      },
    },
  },
  plugins: [],
};
