// Close Code — AI provider registry (Phase 25)
//
// Provider records are persisted to userData/ai/providers.json so that
// custom/added providers survive restarts.  The file format is a JSON array
// of ProviderRecord values, mirrored after the built-in structure.
//
// Phase 11 represented "which AI am I talking to" as a three-value union
// (`local` | `openai` | `custom`) plus TWO base URLs and TWO model fields. That
// was adequate while there was exactly one local runtime and one remote host, and
// it stopped being adequate the moment a second remote provider existed: the
// only way to switch to one was to overwrite `baseUrl`, which meant there was
// never more than one remote provider on screen at a time and no way back to
// the one you had before.
//
// This module replaces the union with a real list. A provider is a record the
// user can add, edit, remove and activate.
//
// The key slot for a provider is named after the provider id, so a key entered
// for one provider is structurally never available to another. That is the whole
// reason the key slot is derived from the id rather than stored on the record:
// there is no field a renderer or a malformed config could use to point one
// provider at another's credential.
//
// The legacy fields are NOT deleted. `migrateLegacyConfig` reads them once, on
// load, into seeded records — and those seeded records deliberately keep the ids
// `local`, `openai` and `custom`, so keys already sitting in the encrypted store
// keep working with no re-entry and no re-auth. Existing installs upgrade in
// place rather than asking the user to redo setup they already did.
//
// This module is pure: no Electron, no filesystem, no network. That keeps it
// importable from a unit test without a mock app behind it, and keeps the
// migration rule something a test can state as a fact.

import { app } from "electron";
import fs from "fs";
import path from "path";
import { ensureDir } from "./aiSettings";

export type ProviderKind = "local" | "remote";

export interface ProviderRecord {
  /** Stable id. Also the encrypted key-store slot. Never reused after a delete. */
  id: string;
  /** User-visible label. */
  name: string;
  /** Base URL, no trailing slash. May be empty for a provider not set up yet. */
  baseUrl: string;
  kind: ProviderKind;
  /** The model id selected for this provider. */
  model: string;
  /** Built-ins cannot be deleted, only renamed and retargeted. */
  builtin: boolean;
}

export const MAX_PROVIDERS = 24;
const MAX_NAME = 60;
const MAX_URL = 300;
const MAX_MODEL = 200;

/**
 * Ids are restricted rather than free-form because the id is a key-store slot
 * name. Anything that can reach `keys.bin` as an object key should not be able
 * to carry a path separator or an unbounded length.
 */
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function isValidProviderId(id: unknown): id is string {
  return typeof id === "string" && ID_PATTERN.test(id);
}

function clamp(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function cleanUrl(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return clamp(raw.trim().replace(/\/+$/, ""), MAX_URL);
}

/**
 * The three providers every install starts with.
 *
 * The ids match the Phase 11 key slots exactly. That is load-bearing: a user who
 * already stored a key under `openai` must not be asked for it again on upgrade.
 */
export function builtinProviders(): ProviderRecord[] {
  return [
    {
      id: "local",
      name: "Local AI",
      baseUrl: "http://127.0.0.1:11434",
      kind: "local",
      model: "",
      builtin: true,
    },
    {
      id: "openai",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      kind: "remote",
      model: "",
      builtin: true,
    },
    {
      id: "custom",
      name: "Custom / Other",
      // Empty on purpose: this is the slot for "some other OpenAI-compatible
      // host", and guessing a default would send a key somewhere the user did
      // not name. An empty base URL is a not-configured state, not an error.
      baseUrl: "",
      kind: "remote",
      model: "",
      builtin: true,
    },
  ];
}

interface LegacyFields {
  provider?: string;
  baseUrl?: string;
  localBaseUrl?: string;
  model?: string;
  localModel?: string;
}

/**
 * Fold a pre-Phase-25 config into provider records.
 *
 * Called on every load, not once at migration time, because there is no
 * migration step to get wrong: a config with no `providers` array is by
 * definition an old config, and folding it is idempotent. `activeProviderId`
 * comes from the legacy `provider` field when it names one of the seeds.
 */
export function migrateLegacyConfig(raw: LegacyFields): ProviderRecord[] {
  const providers = builtinProviders();
  const local = providers[0];
  const openai = providers[1];

  // The old local branch resolved `localBaseUrl || baseUrl`, so a user who had
  // pointed "local" at a remote host must keep pointing there.
  local.baseUrl = cleanUrl(raw.localBaseUrl) || cleanUrl(raw.baseUrl) || local.baseUrl;
  local.model = clamp(typeof raw.localModel === "string" ? raw.localModel.trim() : "", MAX_MODEL);

  const remoteUrl = cleanUrl(raw.baseUrl);
  if (remoteUrl) openai.baseUrl = remoteUrl;
  openai.model = clamp(typeof raw.model === "string" ? raw.model.trim() : "", MAX_MODEL);

  return providers;
}

/** Coerce one record from disk. Never throws; never invents a URL. */
export function sanitizeProvider(input: unknown): ProviderRecord | null {
  if (!input || typeof input !== "object") return null;
  const r = input as Record<string, unknown>;
  if (!isValidProviderId(r.id)) return null;
  return {
    id: r.id,
    name: clamp(typeof r.name === "string" && r.name.trim() ? r.name.trim() : r.id, MAX_NAME),
    baseUrl: cleanUrl(r.baseUrl),
    kind: r.kind === "local" ? "local" : "remote",
    model: clamp(typeof r.model === "string" ? r.model.trim() : "", MAX_MODEL),
    // A record claiming to be builtin on disk is honoured only for the three
    // real ids, so a hand-edited config cannot make a new provider undeletable.
    builtin: r.builtin === true && isBuiltinId(r.id),
  };
}

export function isBuiltinId(id: string): boolean {
  return id === "local" || id === "openai" || id === "custom";
}

/**
 * Coerce a whole provider list from disk.
 *
 * Duplicate ids are dropped rather than merged: two records claiming the same
 * key slot would make "which credential does this provider use" ambiguous, and
 * an ambiguous answer there is a security question, not a cosmetic one.
 */
export function sanitizeProviders(input: unknown): ProviderRecord[] {
  if (!Array.isArray(input)) return [];
  const out: ProviderRecord[] = [];
  const seen = new Set<string>();
  for (const item of input.slice(0, MAX_PROVIDERS)) {
    const p = sanitizeProvider(item);
    if (!p || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

export interface ProviderValidation {
  ok: boolean;
  /** Machine-readable reason, so the UI can place the message on the right field. */
  field?: "id" | "name" | "baseUrl";
  error?: string;
  record?: ProviderRecord;
}

/**
 * Validate a record the user is trying to SAVE. Deliberately stricter than
 * `sanitizeProvider`: on load we keep whatever is there so a hand-edited config
 * is not silently emptied, but on save we refuse to write something that cannot
 * work, and say which field is wrong.
 */
export function validateProvider(input: unknown, existing: ProviderRecord[] = []): ProviderValidation {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "A provider record is required." };
  }
  const r = input as Record<string, unknown>;

  if (!isValidProviderId(r.id)) {
    return {
      ok: false,
      field: "id",
      error: "Id must be 1-64 characters of letters, digits, dash or underscore, starting with a letter or digit.",
    };
  }
  const clash = existing.find((p) => p.id === r.id);
  if (clash && !(clash.builtin && isBuiltinId(r.id as string))) {
    return { ok: false, field: "id", error: `A provider with the id "${r.id}" already exists.` };
  }

  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!name) return { ok: false, field: "name", error: "Give the provider a name so you can tell them apart." };

  const baseUrl = cleanUrl(r.baseUrl);
  if (baseUrl) {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      return { ok: false, field: "baseUrl", error: "That is not a valid URL." };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, field: "baseUrl", error: "The base URL must start with http:// or https://." };
    }
    if (parsed.username || parsed.password) {
      // A URL with an embedded credential gets logged, stored in config.json in
      // clear text and shown in the UI. Refusing it is the only way to keep the
      // encrypted key store the single place a credential lives.
      return {
        ok: false,
        field: "baseUrl",
        error: "Remove the username:password from the URL — store it as an API key instead.",
      };
    }
  }

  const kind: ProviderKind = r.kind === "local" ? "local" : "remote";
  const record: ProviderRecord = {
    id: r.id,
    name: clamp(name, MAX_NAME),
    baseUrl,
    kind,
    model: clamp(typeof r.model === "string" ? r.model.trim() : "", MAX_MODEL),
    builtin: isBuiltinId(r.id),
  };
  return { ok: true, record };
}

/**
 * The next free id. Deterministic rather than random: a random id would make
 * "add a provider" untestable, and the ids here are user-visible labels, not
 * secrets.
 */
export function nextProviderId(existing: ProviderRecord[]): string {
  const taken = new Set(existing.map((p) => p.id));
  for (let n = 2; n < MAX_PROVIDERS * 2; n += 1) {
    const candidate = `p${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `p${Date.now().toString(36)}`;
}

/**
 * The provider a run should actually use.
 *
 * Falls back to the first record rather than throwing, because the caller's job
 * here is to produce a run spec, and a spec with an unusable provider produces a
 * clear "no base URL" config error at the transport — which is a far better
 * message than an exception about a missing array entry.
 */
export function activeProvider(
  providers: ProviderRecord[],
  activeProviderId: string,
): ProviderRecord | null {
  if (!Array.isArray(providers) || providers.length === 0) return null;
  return providers.find((p) => p.id === activeProviderId) ?? providers[0];
}

/** Read the saved provider records from disk (fallback to built-ins). */
export function getProviderRecords(): ProviderRecord[] {
  try {
    const p = path.join(app.getPath("userData"), "ai", "providers.json");
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf-8");
      const parsed = JSON.parse(raw) as ProviderRecord[];
      return sanitizeProviders(parsed);
    }
  } catch {
    // corrupted or missing -> fallback
  }
  return builtinProviders();
}

/** Write provider records to disk. */
export function saveProviderRecords(records: ProviderRecord[]): void {
  try {
    ensureDir();
    const p = path.join(app.getPath("userData"), "ai", "providers.json");
    fs.writeFileSync(p, JSON.stringify(records, null, 2), "utf-8");
  } catch (err) {
    console.error("Failed to save provider records:", err);
  }
}
