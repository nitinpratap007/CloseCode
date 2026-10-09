// Close Code — AI Agent Runtime — workspace path confinement (Phase 21, shared in Phase 22)
//
// Every tool that touches a path goes through `confineToWorkspace`. Phase 22
// moved these helpers into their own module so the new tool modules can refuse a
// path and *say why* without importing the registry — a tool needs to explain a
// refusal as much as it needs to perform one.
//
// Two checks, and the second is the one that matters:
//
//   1. **Lexical** — `path.resolve` the path against the workspace root and
//      require the result to be under it. `path.resolve` does *not* follow
//      symlinks, so this on its own is trivially bypassed by a link inside the
//      workspace that points outside it.
//   2. **Real** — resolve the true on-disk path of both the root and the target,
//      and require the same relationship there. For a file that does not exist
//      yet (`write_file`, `edit_file` creating a new file) the nearest existing
//      ancestor is checked instead, with the remainder re-appended, so a new file
//      is only allowed when the directory that will hold it is inside too.
//
// Relative paths are resolved against the workspace root rather than the process
// cwd, so the tools do not silently depend on wherever the app was launched.

import fs from "fs";
import path from "path";

/**
 * Resolve `p` and refuse anything that escapes the workspace root.
 * Returns the absolute path, or `null` when the path is not acceptable.
 */
export function confineToWorkspace(p: string, workspace: string | null): string | null {
  if (!workspace) return null;
  const root = path.resolve(workspace);
  const resolved = resolveInsideWorkspace(p, root);
  if (!resolved) return null;
  const realRoot = safeRealpath(root);
  if (!realRoot) return null;
  const real = realpathOfNearestExistingAncestor(resolved);
  if (!real) return null;
  const rn = real.toLowerCase();
  const rr = realRoot.toLowerCase();
  if (rn !== rr && !rn.startsWith(rr + path.sep) && !rn.startsWith(rr + "/")) return null;
  return resolved;
}

export function safeRealpath(p: string): string | null {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Real path of `p`, or of its closest existing ancestor, with the remainder
 * re-appended. This is what keeps a not-yet-created file inside the workspace
 * as long as the directory that will hold it is inside too.
 */
export function realpathOfNearestExistingAncestor(p: string): string | null {
  let current = p;
  const tail: string[] = [];
  // Bounded so a pathological path cannot spin: 64 levels is far beyond any
  // real path on a supported platform.
  for (let i = 0; i < 64; i += 1) {
    const real = safeRealpath(current);
    if (real) return tail.length ? path.join(real, ...tail.reverse()) : real;
    const parent = path.dirname(current);
    if (parent === current) return null;
    tail.push(path.basename(current));
    current = parent;
  }
  return null;
}

/** Resolve `p` against `root` and require the result to be under `root`. */
export function resolveInsideWorkspace(p: string, root: string): string | null {
  const resolved = path.resolve(root, p);
  const norm = resolved.toLowerCase();
  const r = root.toLowerCase();
  if (norm === r || norm.startsWith(r + path.sep) || norm.startsWith(r + "/")) return resolved;
  return null;
}

/**
 * Why a path was refused.
 *
 * Confinement fails in three genuinely different ways, and a single "outside the
 * workspace" message would be wrong in two of them: there may be no workspace
 * open at all, or the workspace folder may have been deleted or renamed since it
 * was opened. Naming the real cause stops the model retrying the identical call
 * and stops the user being told their own folder does not exist.
 */
export function confineError(p: string, workspace: string | null): string {
  if (!workspace) return "Error: no workspace folder is open, so files cannot be read or written.";
  if (!safeRealpath(path.resolve(workspace))) {
    return `Error: the workspace folder ${workspace} is no longer reachable on disk.`;
  }
  return `Error: path is outside the workspace (${p || "(empty)"}). Paths must resolve inside ${workspace}, including through links.`;
}

/**
 * Resolve `p` inside the workspace, or return the refusal to hand straight back
 * to the model. Saves every tool the same four lines and, more importantly,
 * guarantees every tool refuses in the same words.
 */
export function confinedOrRefusal(
  ctx: { workspace: string | null; confine(p: string): string | null },
  raw: string,
): { path: string } | { refusal: string } {
  const target = raw.trim() ? ctx.confine(raw.trim()) : ctx.workspace;
  if (!target) return { refusal: confineError(raw, ctx.workspace) };
  return { path: target };
}
