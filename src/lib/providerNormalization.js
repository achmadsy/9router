import { AI_PROVIDERS } from "../shared/constants/providers.js";

/**
 * Detect xAI Grok models by id pattern (grok-*, Grok_*, etc).
 * @param {string} modelId
 * @returns {boolean}
 */
export function isXaiModel(modelId) {
  return typeof modelId === "string" && /^grok[-_]/i.test(modelId.trim());
}

export function normalizeProviderId(provider) {
  if (typeof provider !== "string") return provider;

  const trimmed = provider.trim();
  if (AI_PROVIDERS[trimmed]) return trimmed;

  const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (AI_PROVIDERS[slug]) return slug;

  const providerByName = Object.values(AI_PROVIDERS).find(
    (entry) => entry.name?.toLowerCase() === trimmed.toLowerCase()
  );
  return providerByName?.id || trimmed;
}

export function normalizeProviderSpecificData(provider, body = {}, providerSpecificData = null) {
  const next = providerSpecificData && typeof providerSpecificData === "object"
    ? { ...providerSpecificData }
    : {};

  if (provider === "ollama-local") {
    const baseUrl = (
      next.baseUrl ||
      body.baseUrl ||
      body.baseURL ||
      body.ollamaHostUrl ||
      ""
    ).trim();

    if (baseUrl) next.baseUrl = baseUrl;
  }

  return Object.keys(next).length > 0 ? next : null;
}

const SENSITIVE_SPECIFIC_KEYS = new Set([
  "clientSecret",
  "client_secret",
  "idToken",
  "id_token",
  "zaiAccessToken",
  "zcodeJwtToken",
  "sessionToken",
  "session_token",
  "cookie",
  "cookies",
  "authorization",
  "secret",
]);

/**
 * Strips sensitive top-level authentication secrets and nested
 * credentials in `providerSpecificData` for public/dashboard responses.
 *
 * @param {object} connection
 * @returns {object}
 */
export function sanitizeConnectionForResponse(connection) {
  if (!connection || typeof connection !== "object") return connection;

  const result = { ...connection };
  delete result.apiKey;
  delete result.accessToken;
  delete result.refreshToken;
  delete result.idToken;

  if (result.providerSpecificData && typeof result.providerSpecificData === "object") {
    const sanitizedSpecific = { ...result.providerSpecificData };
    for (const key of Object.keys(sanitizedSpecific)) {
      if (SENSITIVE_SPECIFIC_KEYS.has(key) || /(secret|token|password)$/i.test(key)) {
        delete sanitizedSpecific[key];
      }
    }
    result.providerSpecificData = sanitizedSpecific;
  }

  return result;
}

