// Close Code — Extension manifest schema & validation (Phase 13)
// Manifest may live in `extension.json` or in a `package.json` field `closeCode`.

export interface ManifestCommand {
  id: string;
  title: string;
}

export interface ExtensionManifest {
  id: string;
  displayName: string;
  version: string;
  description: string;
  publisher: string;
  name: string;
  engines?: { closecode?: string };
  permissions: string[];
  contributes?: {
    commands?: ManifestCommand[];
    themes?: Array<{ id: string; label: string; path: string }>;
  };
  main?: string;
}

export const ALLOWED_EXTENSION_PERMISSIONS = ["commands", "files", "terminal", "git", "search", "themes"];

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const COMMAND_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9-_.]*$/;

/** Very small semver check: supports >=, >, and bare version. Used for engines.closecode. */
export function satisfiesVersion(installed: string, range: string | undefined): boolean {
  if (!range) return true;
  const parse = (v: string): [number, number, number] => {
    const m = v.trim().replace(/^[<>=^~]+/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  };
  const cmp = (a: [number, number, number], b: [number, number, number]): number =>
    a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const inst = parse(installed);
  for (const part of range.split("||").map((s) => s.trim())) {
    const p = parse(part);
    if (part.startsWith(">=") || part.startsWith(">")) {
      if (cmp(inst, p) >= 0) return true;
    } else if (part.startsWith("<")) {
      if (cmp(inst, p) < 0) return true;
    } else if (part.startsWith("~")) {
      const [M, m] = p;
      if (inst[0] === M && inst[1] === m) return true;
    } else if (part.startsWith("^")) {
      const [M] = p;
      if (inst[0] === M) return true;
    } else if (part) {
      if (cmp(inst, p) === 0) return true;
    }
  }
  return false;
}

export interface ParseResult {
  manifest?: ExtensionManifest;
  warnings?: string[];
  error?: string;
}

export function parseManifest(json: unknown, sourceDir: string): ParseResult {
  const warnings: string[] = [];
  if (!json || typeof json !== "object") return { error: "Manifest is not an object." };

  const root = json as Record<string, unknown>;
  const cc = root.closeCode && typeof root.closeCode === "object" ? (root.closeCode as Record<string, unknown>) : root;

  const name = typeof cc.name === "string" ? cc.name : "";
  const displayName = typeof cc.displayName === "string" ? cc.displayName : "";
  const version = typeof cc.version === "string" ? cc.version : "";
  const description = typeof cc.description === "string" ? cc.description : "";
  const publisher = typeof cc.publisher === "string" ? cc.publisher || "local" : "local";
  const main = typeof cc.main === "string" ? cc.main : "";

  if (!name) return { error: 'Missing "name" (e.g. "my-extension").' };
  if (!NAME_RE.test(name)) return { error: `Invalid name "${name}". Use lowercase letters, digits and dashes.` };
  if (!displayName) return { error: 'Missing "displayName".' };
  if (!version) return { error: 'Missing "version".' };
  if (!VERSION_RE.test(version)) return { error: `Invalid version "${version}". Use semver like 1.2.3.` };
  if (!main) return { warnings: [...warnings, "No main entry — nothing will be activated."] };

  let permissions: string[] = [];
  if (Array.isArray(cc.permissions)) {
    permissions = (cc.permissions as unknown[])
      .filter((p): p is string => typeof p === "string")
      .map((p) => p.toLowerCase());
    for (const p of permissions) {
      if (!ALLOWED_EXTENSION_PERMISSIONS.includes(p)) warnings.push(`Permission "${p}" is not recognized and was ignored.`);
    }
    permissions = permissions.filter((p) => ALLOWED_EXTENSION_PERMISSIONS.includes(p));
  }

  let commands: ManifestCommand[] = [];
  const contributes = cc.contributes && typeof cc.contributes === "object" ? (cc.contributes as Record<string, unknown>) : undefined;
  if (contributes && Array.isArray(contributes.commands)) {
    const seen = new Set<string>();
    for (const c of contributes.commands as unknown[]) {
      const cmd = c as Record<string, unknown>;
      const id = typeof cmd.id === "string" ? cmd.id : "";
      const title = typeof cmd.title === "string" ? cmd.title : "";
      if (!id || !title) {
        warnings.push("A contributed command is missing id/title and was skipped.");
        continue;
      }
      if (!COMMAND_ID_RE.test(id)) {
        warnings.push(`Command id "${id}" is invalid and was skipped.`);
        continue;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      commands.push({ id, title });
    }
  }

  const id = `${publisher}.${name}`;

  let engines: ExtensionManifest["engines"] = undefined;
  if (cc.engines && typeof cc.engines === "object") {
    const closecode = (cc.engines as Record<string, unknown>).closecode;
    if (typeof closecode === "string") engines = { closecode };
  }

  let contrib: ExtensionManifest["contributes"] | undefined;
  if (contributes && (Array.isArray(contributes.commands) || Array.isArray(contributes.themes))) {
    contrib = { commands };
    if (Array.isArray(contributes.themes)) {
      contrib.themes = (contributes.themes as unknown[]).filter(
        (t): t is { id: string; label: string; path: string } =>
          !!t && typeof t === "object" && typeof (t as Record<string, unknown>).id === "string",
      ).map((t) => ({
        id: t.id,
        label: typeof t.label === "string" ? t.label : t.id,
        path: typeof t.path === "string" ? t.path : t.id,
      }));
    }
  }

  const manifest: ExtensionManifest = {
    id,
    name,
    displayName,
    version,
    description,
    publisher,
    permissions,
    contributes: contrib,
    main: main || undefined,
    engines,
  };
  return { manifest, warnings };
}

export function versionSatisfiesAppManifest(manifest: ExtensionManifest, appVersion: string): boolean {
  return satisfiesVersion(appVersion, manifest.engines?.closecode);
}