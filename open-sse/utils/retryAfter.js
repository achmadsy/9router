/**
 * Self-Aware cooldown — upstream wait-header parsing.
 * Reads Retry-After family headers from provider error responses and
 * produces a validated expiry for the self-aware cooldown board.
 *
 * Naming: never call this "rate limit" in user-facing strings — "cooldown"/"wait".
 */
import { ERROR_RULES } from "../config/errorConfig.js";

/** Cap: 30 days. Longer upstream asks are rejected (treated as absent). */
export const MAX_SELF_AWARE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

/** Header probe order. First valid wins. */
export const SELF_AWARE_HEADER_ORDER = [
  "Retry-After",
  "x-retry-after",
  "x-ratelimit-reset-after",
  "x-ratelimit-reset",
];

const HTTP_DATE_RE = /^[A-Za-z]{3},\s*\d{1,2}\s+[A-Za-z]{3}\s+\d{4}|^[A-Za-z]{3}\s+\d{1,2}\s+\d{4}/;

/**
 * Statuses already treated as quota/wait by existing classification.
 * - 429: ERROR_RULES backoff status.
 * - 409: provider-specific quota exhaustion (antigravity) handled as wait elsewhere.
 * Unrelated 5xx / 401 / etc. stay false — headers are ignored for them.
 *
 * @param {number} status
 * @param {string} [errorText]
 * @returns {boolean}
 */
export function isQuotaLikeStatus(status, errorText = "") {
  if (status === 429 || status === 409) return true;
  const lower = errorText ? String(errorText).toLowerCase() : "";
  if (!lower) return false;
  for (const rule of ERROR_RULES) {
    if (rule.backoff && rule.text && lower.includes(rule.text)) return true;
  }
  return false;
}

function classifyAndCompute(raw, nowMs) {
  const s = String(raw).trim();
  if (!s) return null;

  // HTTP-date
  if (HTTP_DATE_RE.test(s) || /[A-Za-z]{3}/.test(s)) {
    const t = Date.parse(s);
    if (!Number.isFinite(t)) return null;
    const durationMs = t - nowMs;
    if (durationMs <= 0 || durationMs > MAX_SELF_AWARE_COOLDOWN_MS) return null;
    return { format: "http-date", expiresAtMs: t, durationMs };
  }

  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;

  // Heuristic: values > 1e12 are unambiguously unix-milliseconds.
  // Values > 1e9 (year 2001 in seconds, far future for delta-seconds) on
  // absolute-reset headers are unix-seconds. delta-seconds stay small.
  if (n > 1e12) {
    // unix milliseconds
    const durationMs = n - nowMs;
    if (durationMs <= 0 || durationMs > MAX_SELF_AWARE_COOLDOWN_MS) return null;
    return { format: "unix-milliseconds", expiresAtMs: Math.round(n), durationMs };
  }

  if (n > 1e9) {
    // unix seconds
    const expiresAtMs = Math.round(n * 1000);
    const durationMs = expiresAtMs - nowMs;
    if (durationMs <= 0 || durationMs > MAX_SELF_AWARE_COOLDOWN_MS) return null;
    return { format: "unix-seconds", expiresAtMs, durationMs };
  }

  // delta-seconds (int or decimal)
  const durationMs = Math.round(n * 1000);
  if (durationMs <= 0 || durationMs > MAX_SELF_AWARE_COOLDOWN_MS) return null;
  return { format: "delta-seconds", expiresAtMs: nowMs + durationMs, durationMs };
}

/**
 * Parse a wait duration from upstream error headers.
 * Applies to statuses that existing classification already treats as
 * quota/wait (429, provider-specific 409, quota-like error text) via
 * {@link isQuotaLikeStatus}. Unrelated 5xx fall through to the fallback path.
 *
 * @param {Headers|Map<string,string>|{get(k:string):string|null}|null} headers
 * @param {{ status?: number, errorText?: string, nowMs?: number, maxDurationMs?: number }} [opts]
 * @returns {null|{ source: "upstream-header", headerName: string, expiresAtMs: number, durationMs: number, format: string }}
 */
export function parseWaitHeaderCooldown(headers, opts = {}) {
  const status = opts.status;
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const cap = Number.isFinite(opts.maxDurationMs) && opts.maxDurationMs > 0
    ? Math.min(opts.maxDurationMs, MAX_SELF_AWARE_COOLDOWN_MS)
    : MAX_SELF_AWARE_COOLDOWN_MS;

  if (!isQuotaLikeStatus(status, opts.errorText)) return null;
  if (!headers || typeof headers.get !== "function") return null;

  for (const name of SELF_AWARE_HEADER_ORDER) {
    let raw = null;
    try {
      raw = headers.get(name);
    } catch {
      raw = null;
    }
    if (raw == null || String(raw).trim() === "") continue;

    const parsed = classifyAndCompute(raw, nowMs);
    if (!parsed) continue;
    if (parsed.durationMs > cap) continue;

    return {
      source: "upstream-header",
      headerName: name,
      expiresAtMs: parsed.expiresAtMs,
      durationMs: parsed.durationMs,
      format: parsed.format,
    };
  }

  return null;
}

// Back-compat alias — older imports used the reserved rateLimit wording.
// Keep a thin re-export; prefer parseWaitHeaderCooldown in new code.
export const parseRateLimitCooldown = parseWaitHeaderCooldown;
