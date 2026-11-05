// Shared by the dashboard, its API trust boundary, and executor overlays.
export const PROVIDER_HEADER_NAME_RE = /^[A-Za-z0-9-]+$/;
const MAX_HEADERS = 20;
const MAX_HEADER_VALUE_LENGTH = 8192;
const BLOCKED_HEADERS = new Set([
  "host", "content-length", "content-type", "connection", "transfer-encoding",
  "authorization", "proxy-authorization", "x-api-key", "x-goog-api-key", "api-key", "cookie",
]);

export function isBlockedProviderHeader(name) {
  return BLOCKED_HEADERS.has(name.toLowerCase());
}

/** null is an explicit deletion; absence means inherit the current default. */
export function applyProviderHeaderOverrides(target, overrides = {}) {
  for (const [name, value] of Object.entries(overrides || {})) {
    for (const existing of Object.keys(target)) {
      if (existing.toLowerCase() === name.toLowerCase()) delete target[existing];
    }
    if (value !== null) target[name] = value;
  }
  return target;
}

export function mergeProviderHeaders(defaults = {}, overrides = {}) {
  return applyProviderHeaderOverrides({ ...defaults }, overrides);
}

function validateHeaderEntry(name, value) {
  if (!PROVIDER_HEADER_NAME_RE.test(name)) return `Invalid header name: ${name}`;
  if (isBlockedProviderHeader(name)) return `Header ${name} cannot be overridden`;
  if (value !== null && (typeof value !== "string" || /[\r\n]/.test(value))) {
    return `Invalid value for header ${name}`;
  }
  if (typeof value === "string" && value.length > MAX_HEADER_VALUE_LENGTH) {
    return `Header ${name} value too long (max ${MAX_HEADER_VALUE_LENGTH})`;
  }
  return null;
}

/** Validate additions AND deletions so null cannot bypass protected-header rules. */
export function normalizeProviderHeaderOverride(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { error: "Override must be an object" };
  }
  const { headers } = payload;
  if (headers === undefined || headers === null) return { override: null };
  if (typeof headers !== "object" || Array.isArray(headers)) {
    return { error: "headers must be an object" };
  }
  // Preserve the legacy empty-string behavior (inherit), but retain null deletions.
  const entries = Object.entries(headers).filter(([, value]) => value !== "");
  if (entries.length > MAX_HEADERS) return { error: `Too many headers (max ${MAX_HEADERS})` };
  const clean = {};
  const seen = new Set();
  for (const [name, value] of entries) {
    const error = validateHeaderEntry(name, value);
    if (error) return { error };
    if (seen.has(name.toLowerCase())) return { error: `Duplicate header name: ${name}` };
    seen.add(name.toLowerCase());
    clean[name] = value;
  }
  return { override: entries.length ? { headers: clean } : null };
}

/** UI diff: unchanged rows inherit updates; missing default rows stay deleted. */
export function diffProviderHeaderRows(defaults, rows) {
  const builtin = new Map(Object.entries(defaults).map(([name, value]) => [name.toLowerCase(), value]));
  const headers = {};
  const seen = new Set();
  const present = new Set();
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) continue;
    const error = validateHeaderEntry(name, row.value);
    if (error) return { error };
    const key = name.toLowerCase();
    if (seen.has(key)) return { error: `Duplicate header name: ${name}` };
    seen.add(key);
    if (row.value === "" || row.value === null) continue;
    present.add(key);
    if (!builtin.has(key) || builtin.get(key) !== row.value) headers[name] = row.value;
  }
  for (const name of Object.keys(defaults)) {
    if (!present.has(name.toLowerCase())) headers[name] = null;
  }
  // Limit saved edits, not untouched built-ins (some providers have >20 defaults).
  return normalizeProviderHeaderOverride({ headers });
}
