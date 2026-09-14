// API-key policy constants shared across DB, auth, and routes.
export const API_KEY_ACCESS_MODE = Object.freeze({
  ALL: "all",
  RESTRICTED: "restricted",
});

export const API_KEY_TARGET_TYPE = Object.freeze({
  MODEL: "model",
  COMBO: "combo",
});

export const API_KEY_HASH_VERSION = 1;

// Per-key total token limit windows. "forever" = lifetime of the key.
export const API_KEY_TOKEN_LIMIT_PERIODS = Object.freeze({
  DAILY: "daily",
  MONTHLY: "monthly",
  FOREVER: "forever",
});

/**
 * Normalize a tokenLimit input. Returns { tokenLimit, tokenLimitPeriod } with
 * nulls meaning "no limit", or { error } for a 400 response.
 */
export function parseTokenLimitInput(body = {}) {
  const out = {};
  if (body.tokenLimit !== undefined) {
    if (body.tokenLimit === null || body.tokenLimit === "") {
      out.tokenLimit = null;
    } else {
      const n = Number(body.tokenLimit);
      if (!Number.isInteger(n) || n <= 0) {
        return { error: "Invalid tokenLimit: must be a positive integer (or null to remove the limit)" };
      }
      out.tokenLimit = n;
    }
  }
  if (body.tokenLimitPeriod !== undefined) {
    const p = body.tokenLimitPeriod;
    if (p !== null && p !== "" && !Object.values(API_KEY_TOKEN_LIMIT_PERIODS).includes(p)) {
      return { error: `Invalid tokenLimitPeriod: use "daily", "monthly", or "forever"` };
    }
    out.tokenLimitPeriod = p === "" ? null : p;
  }
  return out;
}

export const API_KEY_SECRET_PREFIX = "sk-9r-";
