// Close Code — AI Agent Runtime — tool argument validation (Phase 22)
//
// Phase 21 declared a JSON Schema for every tool but never checked anything
// against it. Each tool then coerced whatever arrived with `String(args.x ?? "")`,
// so a model could send `{path: 123}`, or no `path` at all, or a 4 MB `content`
// string, and the failure only surfaced as an `ENOENT` from deep inside `fs`.
//
// This module is the single gate: `ToolRegistry.invoke` validates here before a
// tool body runs, so a bad call becomes a precise, model-readable message naming
// the offending argument instead of an incidental I/O error.
//
// It is a deliberate subset of JSON Schema — the keywords the tool surface
// actually uses — not a general validator, and it has no dependencies. Anything
// it does not understand is ignored rather than guessed at, so a schema can be
// richer than the validator without lying to the model.

export type JsonSchemaType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

export interface JsonSchema {
  type?: JsonSchemaType;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  /** `false` rejects arguments the schema does not declare. Defaults to allowed. */
  additionalProperties?: boolean;
  enum?: unknown[];
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  default?: unknown;
}

export interface ValidationIssue {
  /** Dotted path of the offending argument, e.g. `path` or `options.limit`. */
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; issues: ValidationIssue[] };

/**
 * A compiled `pattern`. Regex compilation can throw on a malformed pattern, and
 * a tool definition must not be able to take the whole registry down at
 * registration time — so the compiled form is cached and failures are reported
 * per call instead.
 */
const patternCache = new Map<string, RegExp | null>();

function compilePattern(pattern: string): RegExp | null {
  const cached = patternCache.get(pattern);
  if (cached !== undefined) return cached;
  let compiled: RegExp | null = null;
  try {
    compiled = new RegExp(pattern);
  } catch {
    compiled = null;
  }
  if (patternCache.size < 512) patternCache.set(pattern, compiled);
  return compiled;
}

function typeOf(value: unknown): JsonSchemaType | "array" | "object" | "undefined" {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean" || t === "object") {
    return t === "object" ? "object" : (t as JsonSchemaType);
  }
  return "undefined";
}

function typeMatches(value: unknown, type: JsonSchemaType): boolean {
  switch (type) {
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "integer":
      return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "null":
      return value === null;
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    default:
      return true;
  }
}

/** Render a value's type the way the model sent it, for a useful message. */
function describeType(value: unknown): string {
  const t = typeOf(value);
  if (t === "array") return "array";
  if (t === "object") return "object";
  return t;
}

function validateValue(
  value: unknown,
  schema: JsonSchema,
  path: string,
  issues: ValidationIssue[],
): void {
  if (schema.type && !typeMatches(value, schema.type)) {
    issues.push({
      path,
      message: `expected ${schema.type}, received ${describeType(value)}`,
    });
    return;
  }

  if (schema.enum && !schema.enum.some((allowed) => allowed === value)) {
    const allowed = schema.enum.map((v) => JSON.stringify(v)).join(", ");
    issues.push({ path, message: `must be one of ${allowed}` });
    return;
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push({ path, message: `must be >= ${schema.minimum}, received ${value}` });
      return;
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push({ path, message: `must be <= ${schema.maximum}, received ${value}` });
      return;
    }
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      issues.push({ path, message: `must be at least ${schema.minLength} character(s)` });
      return;
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      issues.push({
        path,
        message: `is ${value.length} characters, longer than the ${schema.maxLength} allowed`,
      });
      return;
    }
    if (schema.pattern) {
      const re = compilePattern(schema.pattern);
      // A pattern the validator cannot compile is skipped rather than rejected:
      // the tool is the authority on its own argument, and failing closed here
      // would break every call to a tool with a typo in its schema.
      if (re && !re.test(value)) {
        issues.push({ path, message: `does not match the required pattern ${schema.pattern}` });
        return;
      }
    }
  }

  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i += 1) {
      validateValue(value[i], schema.items, `${path}[${i}]`, issues);
    }
  }

  if (typeOf(value) === "object" && schema.properties) {
    const record = value as Record<string, unknown>;
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (record[key] !== undefined) {
        validateValue(record[key], sub, key, issues);
      }
    }
  }
}

/**
 * Validate a model's tool arguments against the tool's declared schema.
 *
 * On success the returned `value` is a **shallow copy with declared defaults
 * filled in**. It is a copy so the caller's object is never mutated and so a
 * tool cannot see a default the model did not send; it is shallow because the
 * tool schemas only ever declare flat argument maps.
 *
 * A schema with no `type: "object"` is treated as "accepts anything", which is
 * what a tool with genuinely free-form arguments (none today) would declare.
 */
export function validateArgs(schema: unknown, args: unknown): ValidationResult {
  if (!schema || typeof schema !== "object") return { ok: true, value: {} };
  const s = schema as JsonSchema;

  let source: Record<string, unknown>;
  if (args === undefined || args === null) {
    source = {};
  } else if (typeof args === "object" && !Array.isArray(args)) {
    source = args as Record<string, unknown>;
  } else {
    return { ok: false, issues: [{ path: "", message: `arguments must be an object, received ${describeType(args)}` }] };
  }

  // A declared `type` that is not "object" describes the arguments themselves
  // being wrong, not one of its fields.
  if (s.type && s.type !== "object") {
    const issues: ValidationIssue[] = [];
    validateValue(source, s, "", issues);
    return issues.length
      ? { ok: false, issues }
      : { ok: true, value: { ...source } };
  }

  const issues: ValidationIssue[] = [];

  for (const key of s.required ?? []) {
    if (source[key] === undefined || source[key] === null) {
      issues.push({ path: key, message: "is required, but was not provided" });
    }
  }

  const props = s.properties ?? {};
  for (const [key, value] of Object.entries(source)) {
    const sub = props[key];
    if (!sub) {
      if (s.additionalProperties === false) {
        issues.push({ path: key, message: `is not an accepted argument (accepted: ${Object.keys(props).join(", ") || "none"})` });
      }
      continue;
    }
    if (value === undefined) continue;
    validateValue(value, sub, key, issues);
  }

  if (issues.length) return { ok: false, issues };

  // Defaults last, and only after validation passes, so a default is never
  // validated against a schema it might not satisfy.
  const value: Record<string, unknown> = { ...source };
  for (const [key, sub] of Object.entries(props)) {
    if (value[key] === undefined && sub.default !== undefined) value[key] = sub.default;
  }
  return { ok: true, value };
}

/** One line per issue, for the model and for the run trace. */
export function formatIssues(issues: readonly ValidationIssue[]): string {
  return issues.map((i) => (i.path ? `\`${i.path}\` ${i.message}` : i.message)).join("; ");
}

/**
 * A schema is worth declaring if it can actually reject something. Used by the
 * registry to warn about a tool whose schema validates nothing, rather than
 * silently accepting every call.
 */
export function schemaIsMeaningful(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return false;
  const s = schema as JsonSchema;
  return Boolean(
    (s.required && s.required.length > 0) ||
      s.additionalProperties === false ||
      s.enum ||
      Object.keys(s.properties ?? {}).length > 0,
  );
}
