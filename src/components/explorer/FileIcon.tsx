interface FileIconProps {
  name: string;
  isDirectory: boolean;
  expanded?: boolean;
}

interface Category {
  color: string;
  label?: string;
}

const EXT_COLORS: Record<string, Category> = {
  ts: { color: "#3178c6", label: "TS" },
  tsx: { color: "#3178c6", label: "TSX" },
  js: { color: "#f7df1e", label: "JS" },
  mjs: { color: "#f7df1e" },
  cjs: { color: "#f7df1e" },
  jsx: { color: "#f7df1e" },
  json: { color: "#8bc34a", label: "{}" },
  html: { color: "#e34c26", label: "<>" },
  htm: { color: "#e34c26" },
  vue: { color: "#42b883" },
  svelte: { color: "#ff3e00" },
  css: { color: "#264de4" },
  scss: { color: "#cd6799" },
  less: { color: "#1d365d" },
  md: { color: "#cdd6f4", label: "M↓" },
  markdown: { color: "#cdd6f4" },
  py: { color: "#306998", label: "PY" },
  rb: { color: "#cc342d" },
  go: { color: "#00add8" },
  rs: { color: "#dea584" },
  java: { color: "#b07219" },
  c: { color: "#555555" },
  h: { color: "#8da5d3" },
  cpp: { color: "#f34b7d" },
  cs: { color: "#68217a" },
  php: { color: "#777bb4" },
  sh: { color: "#4eaa25", label: "sh" },
  bat: { color: "#bbbbbb" },
  ps1: { color: "#012456" },
  yml: { color: "#cb171e" },
  yaml: { color: "#cb171e" },
  toml: { color: "#758384" },
  ini: { color: "#758384" },
  env: { color: "#e8b339" },
  xml: { color: "#787878" },
  svg: { color: "#ff9800" },
  sql: { color: "#a65b00" },
  png: { color: "#9c3bd6" },
  jpg: { color: "#9c3bd6" },
  jpeg: { color: "#9c3bd6" },
  gif: { color: "#9c3bd6" },
  webp: { color: "#9c3bd6" },
  pdf: { color: "#e53935" },
  txt: { color: "#9ca0b0" },
  lock: { color: "#cdd6f4" },
  log: { color: "#9ca0b0" },
};

const FILE_NAMES: Record<string, Category> = {
  "package.json": { color: "#8bc34a", label: "{}" },
  "tsconfig.json": { color: "#3178c6", label: "{}" },
  "vite.config.ts": { color: "#3178c6" },
  "README.md": { color: "#cdd6f4", label: "◫" },
  "LICENSE": { color: "#b9883d" },
  "LICENSE.md": { color: "#b9883d" },
  ".gitignore": { color: "#f14e32" },
  "Dockerfile": { color: "#2496ed", label: "D" },
};

export default function FileIcon({
  name,
  isDirectory,
  expanded,
}: FileIconProps): React.JSX.Element {
  if (isDirectory) {
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        className="shrink-0"
        aria-hidden="true"
      >
        {expanded ? (
          <path
            d="M1.5 3.5A1.5 1.5 0 0 1 3 2h2.297a1.5 1.5 0 0 1 1.367.885l.434.868A1.5 1.5 0 0 0 8.465 4.5H12.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-8Z"
            fill="#89b4fa"
          />
        ) : (
          <path
            d="M1.5 3.5A1.5 1.5 0 0 1 3 2h2.297a1.5 1.5 0 0 1 1.367.885l.434.868A1.5 1.5 0 0 0 8.465 4.5H12.5A1.5 1.5 0 0 1 14 6v.5H2V3.5Z"
            fill="#89b4fa"
            opacity="0.85"
          />
        )}
      </svg>
    );
  }

  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const cat = FILE_NAMES[name] ?? EXT_COLORS[ext] ?? { color: "#9ca0b0" };
  const label = cat.label ?? (ext ? ext.slice(0, 2) : "·");

  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      className="shrink-0"
      aria-hidden="true"
    >
      <rect x="1" y="1" width="14" height="14" rx="2" fill={cat.color} opacity="0.12" />
      <rect x="1" y="1" width="14" height="14" rx="2" fill="none" stroke={cat.color} strokeWidth="1" opacity="0.7" />
      <text
        x="8"
        y="11"
        textAnchor="middle"
        fontSize="7"
        fontWeight="600"
        fill={cat.color}
        fontFamily="monospace"
      >
        {label.toUpperCase()}
      </text>
    </svg>
  );
}