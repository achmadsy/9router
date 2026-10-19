import crypto from "node:crypto";

const HMAC_CONTEXT = "9router-api-key:v1:";

function apiSecret() {
  return process.env.API_KEY_SECRET || "endpoint-proxy-api-key-secret";
}

function getDerivedKey() {
  return crypto.createHash("sha256").update(HMAC_CONTEXT + "enc:" + apiSecret()).digest();
}

/**
 * Encrypt sensitive credentials (apiKey, custom headers, etc.) at rest using AES-256-GCM.
 * Format: v1:<iv b64url>:<ciphertext b64url>:<tag b64url>
 */
export function encryptProfileSecret(payload) {
  if (payload == null) return null;
  const plaintext = typeof payload === "string" ? payload : JSON.stringify(payload);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getDerivedKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64url")}:${enc.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}`;
}

/**
 * Decrypt recoverable AES-256-GCM ciphertext. Returns null on missing/corrupt/wrong key.
 */
export function decryptProfileSecret(encryptedString) {
  if (!encryptedString || typeof encryptedString !== "string") return null;
  const parts = encryptedString.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  try {
    const iv = Buffer.from(parts[1], "base64url");
    const data = Buffer.from(parts[2], "base64url");
    const tag = Buffer.from(parts[3], "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", getDerivedKey(), iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    try {
      return JSON.parse(decrypted);
    } catch {
      return decrypted;
    }
  } catch {
    return null;
  }
}
