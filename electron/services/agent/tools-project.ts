// Close Code — AI Agent Runtime — project, task and diagnostics tools (Phase 22)
//
// Four capabilities the model needs before it can act sensibly on a codebase it
// has not seen, and four that would otherwise have to be improvised by the model
// through `run_terminal` — which is a category permission the user thinks of as
// "run shell commands", not "understand and verify this project".
//
//   * `project_inspection` — what this project *is*: manifest, dependencies,
//     entry points, tooling. Read-only, bounded, no guessing.
//   * `run_tests` / `run_build` — the project's *own* npm scripts, by name.
//     These resolve the script out of `package.json` and refuse anything not in
//     it, so they cannot become a second, unrestricted `run_terminal`.
//   * `type_diagnostics` — real compiler output from the project's own
//     TypeScript, which is the only source of diagnostics on this machine.
//
// A note on `type_diagnostics`, because the obvious alternative is a fake: the
// editor's live diagnostics live in the renderer, in Monaco's TypeScript worker,
// and the main process has no way to read them. Rather than invent a "here are
// your diagnostics" tool that returns nothing, this runs `tsc --noEmit` — the
// same compiler, the same project, real errors with real file and line numbers.

import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { deniedResult, errorResult, okResult } from "./result";
import { confinedOrRefusal } from "./paths";
import type { AgentTool, AgentToolOutcome } from "./types";

/** Read a JSON file inside the workspace, tolerating a parse failure. */
function readJson<T>(file: string): { ok: true; value: T } | { ok: false; reason: string } {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, "utf-8")) as T };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e?.code === "ENOENT") return { ok: false, reason: "not found" };
    return { ok: false, reason: e?.message ?? String(err) };
  }
}

/** Everything below needs a workspace; this is the shared refusal. */
function needWorkspace(ctx: { workspace: string | null }): { root: string } | { failure: AgentToolOutcome } {
  if (!ctx.workspace) {
    return {
      failure: errorResult("no_workspace", "No workspace folder is open.", {
        text: "Error: no workspace folder is open, so the project cannot be inspected.",
        hint: "Open a folder first.",
      }),
    };
  }
  return { root: ctx.workspace };
}

/** How a package.json script block looks, without pulling in the full type. */
interface PackageManifest {
  name?: string;
  version?: string;
  description?: string;
  private?: boolean;
  type?: string;
  main?: string;
  module?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  workspaces?: unknown;
}

function findManifest(root: string): string | null {
  const direct = path.join(root, "package.json");
  if (fs.existsSync(direct)) return direct;
  // A workspace root is one level up from a package, which is the single most
  // common reason `package.json` is "missing" from the folder the user opened.
  const parent = path.dirname(root);
  if (parent && parent !== root && fs.existsSync(path.join(parent, "package.json"))) return path.join(parent, "package.json");
  return null;
}

/**
 * `project_inspection` — a factual, bounded summary of the workspace.
 *
 * Reports only what it reads from disk. It deliberately does not infer a
 * language, a framework or an entry point from file extensions: a wrong guess
 * here is worse than an omission, because the model will then act on it.
 */
export const projectInspectionTool: AgentTool = {
  name: "project_inspection",
  description:
    "Describe this project: its package manifest, dependencies, available npm scripts, config files and top-level structure. " +
    "Run this before proposing changes, instead of guessing what the project is.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Subdirectory to describe. Defaults to the workspace root.", default: "" },
      depth: {
        type: "integer",
        description: "How many directory levels of structure to list.",
        minimum: 1,
        maximum: 3,
        default: 2,
      },
    },
    required: [],
    additionalProperties: false,
  },
  category: "search",
  capabilities: ["search.read"],
  readOnly: true,
  destructive: false,
  async execute(ctx, args): Promise<AgentToolOutcome> {
    if (!(await ctx.authorize("search", args))) return deniedResult();
    const ws = needWorkspace(ctx);
    if ("failure" in ws) return ws.failure;

    const raw = String(args.path ?? "").trim();
    let root = ws.root;
    if (raw) {
      const located = confinedOrRefusal(ctx, raw);
      if ("refusal" in located) {
        return errorResult("outside_workspace", located.refusal, { text: located.refusal });
      }
      root = located.path;
    }

    const depth = typeof args.depth === "number" ? args.depth : 2;
    const lines: string[] = [];

    const manifestPath = findManifest(root);
    const manifestRead = manifestPath ? readJson<PackageManifest>(manifestPath) : null;

    if (manifestPath && manifestRead?.ok) {
      const m = manifestRead.value;
      const where = manifestPath === path.join(ws.root, "package.json") ? "package.json" : path.relative(ws.root, manifestPath);
      lines.push(`# Project (${where})`);
      lines.push(`name: ${m.name ?? "(unnamed)"}`);
      if (m.version) lines.push(`version: ${m.version}`);
      if (m.description) lines.push(`description: ${m.description}`);
      if (m.type) lines.push(`module type: ${m.type}`);
      if (m.main) lines.push(`main: ${m.main}`);
      if (m.module) lines.push(`module: ${m.module}`);
      if (m.engines) lines.push(`engines: ${JSON.stringify(m.engines)}`);
      if (m.workspaces) lines.push(`workspaces: present (monorepo)`);

      const deps = Object.keys(m.dependencies ?? {});
      const devDeps = Object.keys(m.devDependencies ?? {});
      lines.push(`runtime dependencies (${deps.length}): ${deps.join(", ") || "none"}`);
      lines.push(`dev dependencies (${devDeps.length}): ${devDeps.join(", ") || "none"}`);

      const scripts = m.scripts ?? {};
      const names = Object.keys(scripts);
      lines.push(`npm scripts (${names.length}): ${names.join(", ") || "none"}`);
    } else if (manifestRead && !manifestRead.ok) {
      // The manifest is on disk but unreadable — say so rather than silently
      // reporting a project with no dependencies.
      lines.push(`# Project\n${manifestPath} exists but could not be parsed: ${manifestRead.reason}`);
    } else {
      lines.push("# Project\nNo package.json found in this folder or its parent. This is not an npm project.");
    }

    // Config files worth knowing about, checked by name because that is what
    // actually determines how the project is built.
    const configs = [
      "tsconfig.json", "vite.config.ts", "vite.config.js", "electron-builder.yml",
      "tailwind.config.js", "postcss.config.js", "vitest.config.ts", "index.html",
      "Cargo.toml", "pyproject.toml", "requirements.txt", "go.mod", "pom.xml", "build.gradle",
      "Makefile", "Dockerfile", ".eslintrc.json", ".prettierrc",
    ];
    const present = configs.filter((f) => fs.existsSync(path.join(root, f)));
    lines.push(`config files present: ${present.join(", ") || "none"}`);

    // Structure, bounded by `depth` and by a hard entry cap: this runs on the
    // main process and must not become a second unbounded walk.
    const structure = describeTree(root, depth);
    lines.push("", "# Structure");
    lines.push(...structure);

    const body = lines.join("\n");
    return okResult(body.slice(0, ctx.maxOutputChars), {
      data: {
        hasManifest: Boolean(manifestPath),
        scripts: manifestPath && manifestRead?.ok ? Object.keys(manifestRead.value.scripts ?? {}) : [],
        configs: present,
        entries: structure.length,
      },
      meta: {
        path: root,
        count: structure.length,
        bytes: body.length,
        truncated: body.length > ctx.maxOutputChars,
      },
    });
  },
};

const MAX_TREE_ENTRIES = 200;

/** Top-of-tree listing, depth-limited and entry-capped. Symlinks are not followed. */
function describeTree(root: string, depth: number): string[] {
  const out: string[] = [];
  let seen = 0;
  const walk = (dir: string, level: number, prefix: string): void => {
    if (level > depth || seen >= MAX_TREE_ENTRIES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (seen >= MAX_TREE_ENTRIES) {
        out.push(`${prefix}… (listing truncated)`);
        return;
      }
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      if (entry.isSymbolicLink()) continue;
      seen += 1;
      out.push(`${prefix}${entry.name}${entry.isDirectory() ? "/" : ""}`);
      if (entry.isDirectory()) walk(path.join(dir, entry.name), level + 1, `${prefix}  `);
    }
  };
  walk(root, 1, "");
  return out;
}

/**
 * The npm executable to spawn.
 *
 * On Windows, `npm` is a batch shim (`npm.cmd`) and Node's `execFile` will not
 * spawn it without a shell — and since Node 18.20/20.12 it does not even try:
 * spawning a `.cmd` through `execFile` throws `EINVAL` synchronously. So the
 * `.cmd` name alone is not enough on the platform this app ships on first; the
 * `shell` flag below is what actually makes it work, and the argument check
 * after it is what makes using a shell safe here.
 */
const NPM_EXECUTABLE = process.platform === "win32" ? "npm.cmd" : "npm";

/**
 * Whether spawning goes through a shell.
 *
 * Only Windows needs one, and only because npm is a `.cmd` there. On POSIX,
 * `execFile` passes arguments straight to `execve`, so a script name is never
 * re-parsed and nothing below is bypassable.
 */
const NPM_NEEDS_SHELL = process.platform === "win32";

/**
 * Characters that mean something to `cmd.exe`.
 *
 * With `shell: true`, Node builds the command line as
 * `cmd.exe /d /s /c "npm.cmd run <name>"` and hands it over verbatim. A script
 * name containing a quote, an ampersand or a pipe would therefore end the
 * quoted command and run something else — from a `package.json` the user may
 * have cloned rather than written.
 *
 * This is defence in depth, not the primary control: `run_terminal` already
 * runs arbitrary commands in this same workspace under the same `terminal`
 * permission, so nothing is gained here that the user has not already granted.
 * But `run_tests` advertises itself as *not* a terminal, and it should not
 * quietly become one because of how it spells a name.
 */
const SHELL_UNSAFE = /["&|<>^%!$`(){}\[\];\r\n*?,]/;

/**
 * Run one of the project's *declared* npm scripts.
 *
 * The script name is resolved against `package.json` and its command is run
 * verbatim by npm — the tool never accepts a raw command. That is the whole
 * design: `run_terminal` already exists for arbitrary commands, and giving this
 * tool an `args` parameter would quietly turn it into a second one with a
 * friendlier name.
 */
function npmScriptTool(
  name: string,
  description: string,
  scriptName: string,
  fallbackScripts: string[],
  timeoutMs: number,
): AgentTool {
  return {
    name,
    description,
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    category: "terminal",
    // Running a project's own test or build script. `shell.dangerous` is not
    // claimed: the script name is validated against the manifest, and the gate
    // still inspects anything that reaches a shell, so a project with a
    // `posttest` script that runs `rm -rf` is caught by detection rather than by
    // a blanket claim on every `npm test`.
    capabilities: ["shell.exec"],
    readOnly: false,
    destructive: true,
    execute(ctx, _args): Promise<AgentToolOutcome> {
      return Promise.resolve()
        .then(() => ctx.authorize("terminal", {}))
        .then((allowed) => {
          if (!allowed) return deniedResult();
          const ws = needWorkspace(ctx);
          if ("failure" in ws) return ws.failure;

          const manifestPath = path.join(ws.root, "package.json");
          const manifest = readJson<PackageManifest>(manifestPath);
          if (!manifest.ok) {
            return errorResult("not_found", "This folder has no readable package.json.", {
              text: "Error: no package.json in the workspace, so there are no npm scripts to run.",
              hint: "Run the command directly with run_terminal instead.",
            });
          }
          const scripts = manifest.value.scripts ?? {};
          const actual = Object.keys(scripts).find((s) => s === scriptName) ?? fallbackScripts.find((s) => s in scripts);
          if (!actual) {
            const available = Object.keys(scripts).join(", ") || "none";
            return errorResult("not_found", `No "${scriptName}" script in package.json.`, {
              text: `Error: package.json has no "${scriptName}" script. Available scripts: ${available}.`,
              hint: "Run one of the available scripts by name, or use run_terminal for anything else.",
              data: { available: Object.keys(scripts) },
            });
          }
          if (NPM_NEEDS_SHELL && SHELL_UNSAFE.test(actual)) {
            return errorResult("invalid_input", `"${actual}" cannot be passed to a Windows shell.`, {
              text: `Error: the npm script name "${actual}" contains characters that cannot be run safely on Windows.`,
              hint: "Rename the script in package.json to letters, digits, `-`, `_`, `.` or `:`, or run_terminal directly.",
            });
          }

          return new Promise<AgentToolOutcome>((resolve) => {
            const finish = (outcome: AgentToolOutcome): void => resolve(outcome);
            const done = (
              err: (Error & { code?: number | string }) | null,
              stdout: string,
              stderr: string,
            ): void => {
              const output = (stdout + (stderr ? `\n${stderr}` : "")).trim();
              const clipped = output.slice(0, ctx.maxOutputChars) || "(no output)";
              const code = err?.code;
              if (err) {
                // A non-zero exit is a *result*, not a tool failure: `npm test`
                // exiting 1 because a test failed is the single most important
                // thing this tool can tell the model, so it is reported as ok
                // with the exit code attached rather than as an error.
                finish(
                  okResult(`${actual} exited with code ${code ?? "?"}.\n${clipped}`, {
                    data: { script: actual, exitCode: code ?? null, output: clipped },
                    meta: { path: ws.root, count: 1, bytes: clipped.length },
                  }),
                );
                return;
              }
              finish(
                okResult(`${actual} completed.\n${clipped}`, {
                  data: { script: actual, exitCode: 0, output: clipped },
                  meta: { path: ws.root, count: 1, bytes: clipped.length },
                }),
              );
            };

            try {
              execFile(
                NPM_EXECUTABLE,
                ["run", actual],
                {
                  cwd: ws.root,
                  timeout: timeoutMs,
                  maxBuffer: 8 * 1024 * 1024,
                  signal: ctx.signal,
                  windowsHide: true,
                  shell: NPM_NEEDS_SHELL,
                },
                done,
              );
            } catch (spawnErr) {
              // `execFile` can throw *synchronously* — that is exactly what an
              // unspawnable executable on Windows does. Left unhandled it would
              // escape the tool and take the run with it, so it becomes a
              // structured outcome like any other.
              const message = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
              finish(
                errorResult("not_supported", `npm could not be started: ${message}`, {
                  text: `Error: npm could not be started — ${message}`,
                  hint: "Make sure Node.js and npm are installed and on PATH, then restart the app.",
                }),
              );
            }
          });
        });
    },
  };
}

export const runTestsTool = npmScriptTool(
  "run_tests",
  "Run this project's own test script (`npm test`, or `npm run test`/`check`). Use this instead of inventing a test command.",
  "test",
  ["test", "check", "unit", "test:unit", "typecheck"],
  10 * 60_000,
);

export const runBuildTool = npmScriptTool(
  "run_build",
  "Run this project's own build script (`npm run build`). Use this to verify a change compiles and bundles.",
  "build",
  ["build", "build:prod", "compile", "dist"],
  10 * 60_000,
);

const DIAGNOSTIC_LINE = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/;

/**
 * `type_diagnostics` — real TypeScript compiler diagnostics.
 *
 * Runs the project's own `tsc --noEmit` with the project's own tsconfig, so the
 * output is authoritative for the project as configured. It reports *what the
 * compiler said*; it does not interpret, group or second-guess it.
 */
export const typeDiagnosticsTool: AgentTool = {
  name: "type_diagnostics",
  description:
    "Run the project's TypeScript compiler in no-emit mode and report its real errors. " +
    "Use this to verify a change type-checks, and to find the file and line of an error.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Unused today; present so the tool can be narrowed to a directory later.", default: "" },
    },
    required: [],
    additionalProperties: false,
  },
  category: "terminal",
  // `tsc --noEmit` only reads. It is `readOnly` for the `readOnly` agent
  // restriction, but it still runs a compiler from the workspace, so it keeps
  // `shell.exec` rather than being waved through as a file read — the binary
  // comes from the project's own `node_modules`, which is the user's code.
  capabilities: ["shell.exec"],
  readOnly: true,
  destructive: false,
  async execute(ctx, args): Promise<AgentToolOutcome> {
    if (!(await ctx.authorize("terminal", args))) return deniedResult();
    const ws = needWorkspace(ctx);
    if ("failure" in ws) return ws.failure;

    // Checked *before* the compiler's presence, and deliberately. A project with
    // no tsconfig would have `tsc` compile nothing and exit 0, which reads as
    // "no errors" — the most dangerous possible lie this tool could tell. A
    // missing compiler is merely inconvenient, so it is reported second.
    if (!fs.existsSync(path.join(ws.root, "tsconfig.json"))) {
      return errorResult("not_found", "This project has no tsconfig.json.", {
        text:
          "Error: no tsconfig.json in the workspace. Without one, tsc would check nothing and exit successfully, " +
          "which would read as 'no errors', so no diagnostics were run.",
        hint: "Use run_terminal to run whatever type check this project defines.",
      });
    }
    const tsc = path.join(ws.root, "node_modules", "typescript", "bin", "tsc");
    if (!fs.existsSync(tsc)) {
      return errorResult("not_supported", "TypeScript is not installed in this project.", {
        text: "Error: node_modules/typescript is not present, so there is no compiler to run.",
        hint: "Run `npm install` in the workspace, or use run_terminal to invoke whatever check the project defines.",
      });
    }

    return new Promise<AgentToolOutcome>((resolve) => {
      try {
        execFile(
          process.execPath,
          [tsc, "--noEmit", "--pretty", "false"],
          { cwd: ws.root, timeout: 5 * 60_000, maxBuffer: 8 * 1024 * 1024, signal: ctx.signal, windowsHide: true },
          (err, stdout, stderr) => {
            const raw = `${stdout ?? ""}${stderr ?? ""}`.trim();
            const exitCode = (err as { code?: number | string } | null)?.code ?? (err ? null : 0);
            const diagnostics: Array<{ file: string; line: number; column: number; code: string; message: string }> = [];
            for (const line of raw.split("\n")) {
              const m = DIAGNOSTIC_LINE.exec(line.trim());
              if (m) {
                diagnostics.push({ file: m[1], line: Number(m[2]), column: Number(m[3]), code: m[4], message: m[5] });
              }
            }

            if (!diagnostics.length) {
              // Silence plus a non-zero exit is not "no errors" — it is a compiler
              // that died before it could speak (a broken install, an OOM, a
              // killed process). Reporting that as `ok` would be the same class
              // of lie as the missing-tsconfig case above, one step further down.
              if (!raw && exitCode !== 0) {
                resolve(
                  errorResult("tool_failed", `The TypeScript compiler exited with code ${exitCode} and said nothing.`, {
                    text: `Error: tsc exited with code ${exitCode} without producing any output, so no diagnostics could be read.`,
                    hint: "Run `npx tsc --noEmit` with run_terminal to see why.",
                    data: { exitCode },
                  }),
                );
                return;
              }

              const clean = /Found 0 errors/i.test(raw) || raw === "";
              resolve(
                okResult(
                  clean
                    ? "No TypeScript errors."
                    : `The compiler produced output that could not be parsed as diagnostics:\n${raw.slice(0, ctx.maxOutputChars)}`,
                  {
                    // `parsed: false` plus the real exit code, so a caller — and
                    // the model — can tell "this tool understands its input" from
                    // "this compiler said something nobody here can read".
                    data: { diagnostics: [], parsed: clean, exitCode },
                    meta: { path: ws.root, count: 0 },
                  },
                ),
              );
              return;
            }

            const grouped = new Map<string, number>();
            for (const d of diagnostics) grouped.set(d.code, (grouped.get(d.code) ?? 0) + 1);
            const summary =
              `${diagnostics.length} TypeScript error(s): ` +
              [...grouped.entries()].sort((a, b) => b[1] - a[1]).map(([code, n]) => `${code} ×${n}`).join(", ");
            const listed = diagnostics
              .slice(0, 60)
              .map((d) => `${d.file}(${d.line},${d.column}) ${d.code}: ${d.message}`)
              .join("\n");
            const more = diagnostics.length > 60 ? `\n… and ${diagnostics.length - 60} more.` : "";

            resolve(
              okResult(`${summary}\n${listed}${more}`, {
                data: { diagnostics, exitCode },
                meta: { path: ws.root, count: diagnostics.length, truncated: diagnostics.length > 60 },
              }),
            );
          },
        );
      } catch (spawnErr) {
        // Same reasoning as `npmScriptTool`: a compiler that cannot be started
        // at all throws synchronously, and that is not a diagnostics result.
        const message = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
        resolve(
          errorResult("tool_failed", `The TypeScript compiler could not be started: ${message}`, {
            text: `Error: tsc could not be started — ${message}`,
            hint: "Reinstall the project's dependencies, or use run_terminal to invoke whatever check the project defines.",
          }),
        );
      }
    });
  },
};

export const PROJECT_TOOLS: readonly AgentTool[] = Object.freeze([
  projectInspectionTool,
  runTestsTool,
  runBuildTool,
  typeDiagnosticsTool,
]);
