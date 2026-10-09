// Close Code — line diff + suggested-code extraction (Phase 11)
// A dependency-free LCS line diff used for AI change previews.

export type DiffOpType = "ctx" | "add" | "del";

export interface DiffOp {
  type: DiffOpType;
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

const HUNK_CONTEXT = 2;

export function diffLines(oldText: string, newText: string): DiffOp[] {
  const a = oldText.split(/\r?\n/);
  const b = newText.split(/\r?\n/);
  const n = a.length;
  const m = b.length;

  if (n * m > 40_000_000) {
    // Pathologically large: report everything as removed + added.
    return [
      ...a.map((text, i) => ({ type: "del" as const, oldLine: i + 1, newLine: null, text })),
      ...b.map((text, j) => ({ type: "add" as const, oldLine: null, newLine: j + 1, text })),
    ];
  }

  // LCS on lines.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "ctx", oldLine: i + 1, newLine: j + 1, text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", oldLine: i + 1, newLine: null, text: a[i] });
      i++;
    } else {
      ops.push({ type: "add", oldLine: null, newLine: j + 1, text: b[j] });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: "del", oldLine: i + 1, newLine: null, text: a[i] });
    i++;
  }
  while (j < m) {
    ops.push({ type: "add", oldLine: null, newLine: j + 1, text: b[j] });
    j++;
  }
  return ops;
}

export function makeUnifiedDiff(oldText: string, newText: string, label = "file"): string {
  const ops = diffLines(oldText, newText);
  if (ops.every((o) => o.type === "ctx")) return "";

  // Cluster change runs into hunks with HUNK_CONTEXT lines of context.
  const hunks: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].type === "ctx") {
      i++;
      continue;
    }
    let j = i;
    while (j < ops.length && ops[j].type !== "ctx") j++;
    const start = Math.max(0, i - HUNK_CONTEXT);
    const end = Math.min(ops.length - 1, j - 1 + HUNK_CONTEXT);
    const prev = hunks[hunks.length - 1];
    if (prev && start - (prev.end + 1) <= 2 * HUNK_CONTEXT) {
      prev.end = end;
    } else {
      hunks.push({ start, end });
    }
    i = j;
  }

  // Line counters to build @@ headers.
  const meta = hunks.map(() => ({ oldStart: 1, newStart: 1, oldCount: 0, newCount: 0 }));
  let oldLine = 1;
  let newLine = 1;
  let h = 0;
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (h < hunks.length && k === hunks[h].start) {
      meta[h].oldStart = oldLine;
      meta[h].newStart = newLine;
    }
    if (op.type !== "add") oldLine++;
    if (op.type !== "del") newLine++;
    if (h < hunks.length && k === hunks[h].end) {
      meta[h].oldCount = oldLine - meta[h].oldStart;
      meta[h].newCount = newLine - meta[h].newStart;
      h++;
    }
  }

  const ld = label.replace(/\\/g, "/");
  let out = `--- ${ld}\n+++ ${ld}\n`;
  h = 0;
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (h < hunks.length && k === hunks[h].start) {
      const mt = meta[h];
      out += `@@ -${mt.oldStart},${mt.oldCount} +${mt.newStart},${mt.newCount} @@\n`;
    }
    if (h < hunks.length && k >= hunks[h].start && k <= hunks[h].end) {
      const prefix = op.type === "add" ? "+" : op.type === "del" ? "-" : " ";
      out += `${prefix}${op.text}\n`;
    }
    if (h < hunks.length && k === hunks[h].end) h++;
  }
  return out.replace(/\n$/, "");
}

export interface CodeBlock {
  lang: string | null;
  content: string;
}

/** Extract every fenced code block from assistant text. */
export function extractCodeBlocks(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const re = /```([a-zA-Z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    blocks.push({ lang: match[1] || null, content: match[2].replace(/\r?\n$/, "") });
  }
  return blocks;
}

/**
 * Best-effort mapping of a fenced block language to a file extension.
 * Used when the assistant emits multiple blocks and we must pick the one
 * that matches the active file.
 */
export function langMatchesFile(lang: string | null, filePath: string | null): boolean {
  if (!lang || !filePath) return true;
  const ext = (filePath.split(".").pop() ?? "").toLowerCase();
  const map: Record<string, string[]> = {
    js: ["js", "mjs", "cjs", "jsx"],
    javascript: ["js", "mjs", "cjs", "jsx"],
    ts: ["ts", "tsx", "mts", "cts"],
    typescript: ["ts", "tsx", "mts", "cts"],
    py: ["py"],
    python: ["py"],
    json: ["json"],
    html: ["html", "htm"],
    css: ["css"],
    md: ["md", "markdown"],
    markdown: ["md", "markdown"],
    sh: ["sh"],
    bash: ["sh"],
    c: ["c", "h"],
    cpp: ["cpp", "cc", "hpp"],
    java: ["java"],
    go: ["go"],
    rs: ["rs"],
    rust: ["rs"],
    rb: ["rb"],
    ruby: ["rb"],
    php: ["php"],
    sql: ["sql"],
    yaml: ["yaml", "yml"],
    toml: ["toml"],
    txt: ["txt"],
  };
  const candidates = map[lang.toLowerCase()] ?? [];
  if (candidates.length === 0) return true;
  return candidates.includes(ext);
}