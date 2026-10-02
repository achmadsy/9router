/**
 * Resolves the API key to write into a CLI tool config.
 *
 * CLI tool cards send an empty string when no key is explicitly selected
 * (e.g. the existing config already has a provider block but the frontend
 * can't read the stored Authorization header back). The routes previously
 * fell back to the literal placeholder "sk_9router", which causes 401
 * "Invalid API key" for any deployment with requireApiKey=true (#4399).
 *
 * Resolution order:
 *   1. The key supplied by the caller (non-empty string).
 *   2. The first active unrestricted key whose encrypted secret can be recovered.
 *   3. Empty string — no recoverable unrestricted key exists; callers must supply one
 *      when requireApiKey=true.
 *
 * The placeholder "sk_9router" is NEVER written; it was never a real key.
 */

import { getApiKeys, getRecoverableApiKeySecret } from "@/lib/db";
import { API_KEY_ACCESS_MODE } from "@/lib/apiKeys/constants.js";

/**
 * @param {string|null|undefined} callerKey  Key sent by the frontend.
 * @returns {Promise<string>}
 */
export async function resolveCliApiKey(callerKey) {
  if (callerKey && callerKey.trim() && callerKey.trim() !== "sk_9router") {
    return callerKey.trim();
  }
  try {
    const keys = await getApiKeys();
    for (const key of keys) {
      if (!key.isActive || key.accessMode === API_KEY_ACCESS_MODE.RESTRICTED) continue;
      const secret = await getRecoverableApiKeySecret(key.id);
      if (secret) return secret;
    }
    return "";
  } catch {
    return "";
  }
}