import crypto from "node:crypto";
import { API_KEY_HASH_VERSION, API_KEY_SECRET_PREFIX } from "./constants.js";

const HMAC_CONTEXT = "9router-api-key:v1:";
const SECRET_BYTES = 32;

function apiSecret() {
  return process.env.API_KEY_SECRET || "endpoint-proxy-api-key-secret";
}

/** Generate a fresh opaque secret: sk-9r-<base64url(32 random bytes)>. */
export function generateApiKeySecret() {
  return API_KEY_SECRET_PREFIX + crypto.randomBytes(SECRET_BYTES).toString("base64url");
}

/** Fixed-hex HMAC-SHA256 digest of the full secret (non-recoverable). */
export function computeApiKeyDigest(secret) {
  return crypto.createHmac("sha256", apiSecret()).update(HMAC_CONTEXT + secret).digest("hex");
}

/** Prefix + last 4 chars for display (never the full secret). */
export function buildApiKeyHint(secret) {
  if (!secret || secret.length < 8) return "sk-***";
  return `${API_KEY_SECRET_PREFIX}***${secret.slice(-4)}`;
}

/**
 * Plausible API-key secret: new `sk-9r-…` (32 random bytes) OR legacy
 * `sk-{machineId}-{keyId}-{crc}`. Migrated keys keep their original secret
 * material — only the digest is stored — so both prefixes must be accepted.
 * Conservative: non-empty, 16..512 chars, no whitespace.
 */
export function looksLikeApiKeySecret(secret) {
  if (typeof secret !== "string") return false;
  if (secret.length < 16 || secret.length > 512) return false;
  if (/\s/.test(secret)) return false;
  return secret.startsWith("sk-");
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

/**
 * Resolve a presented secret to an active key row (metadata + digest only).
 * Returns null for missing/invalid/inactive. Never returns the secret.
 */
export async function resolveApiKeyBySecret(secret, { getApiKeyByHash } = {}) {
  if (!looksLikeApiKeySecret(secret)) return null;
  const digest = computeApiKeyDigest(secret);
  let loader = getApiKeyByHash;
  if (!loader) {
    const { getApiKeyByHash: repoLoader } = await import("@/lib/db/repos/apiKeysRepo.js");
    loader = repoLoader;
  }
  const row = await loader(digest);
  if (!row) return null;
  if (!timingSafeEqualHex(row.keyHash, digest)) return null;
  const isActive = row.isActive === true || row.isActive === 1;
  if (!isActive) return null;
  return row;
}

export { timingSafeEqualHex, API_KEY_HASH_VERSION };
