import crypto from "crypto";
import os from "node:os";
import zcodeConfig from "./config.js";

const sessionIdByConnection = new Map();
const deviceMid = process.env.ZCODE_DEVICE_MID || randomUuid();

function randomUuid() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function sessionKey(credentials) {
  return (
    credentials?.providerSpecificData?.sessionId ||
    credentials?.connectionId ||
    credentials?.providerSpecificData?.zcodeUserId ||
    credentials?.providerSpecificData?.zcodeJwtToken?.slice(-24) ||
    "default"
  );
}

/** Stable session ID per connection, matching ZCode session affinity. */
export function getZcodeSessionId(credentials) {
  if (credentials?.providerSpecificData?.sessionId) {
    return credentials.providerSpecificData.sessionId;
  }
  const key = sessionKey(credentials);
  if (!sessionIdByConnection.has(key)) {
    sessionIdByConnection.set(key, randomUuid());
  }
  return sessionIdByConnection.get(key);
}

const INCOMPATIBLE_ANTHROPIC_HEADER_KEYS = [
  "Anthropic-Beta",
  "anthropic-beta",
  "Anthropic-Dangerous-Direct-Browser-Access",
  "anthropic-dangerous-direct-browser-access",
  "x-api-key",
];

export function stripAnthropicHeadersForZcodePlan(headers) {
  if (!headers || typeof headers !== "object") return headers;
  for (const key of INCOMPATIBLE_ANTHROPIC_HEADER_KEYS) {
    delete headers[key];
  }
  return headers;
}

function getOsCategory() {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}

function getClientLanguage() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || "unknown";
  } catch {
    return "unknown";
  }
}

function getClientTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
  } catch {
    return "unknown";
  }
}

/** Build ZCode 3.11.2 source headers shared by same-origin ZCode API requests. */
export function buildZcodeSourceHeaders() {
  return {
    "User-Agent": zcodeConfig.userAgent,
    "X-ZCode-App-Version": zcodeConfig.appVersion,
    "X-Title": "Z Code@electron",
    "HTTP-Referer": "https://zcode.z.ai",
    "X-Platform": `${process.platform}-${process.arch}`,
    "X-Release-Channel": process.env.ZCODE_RELEASE_CHANNEL || "stable",
    "X-Client-Language": getClientLanguage(),
    "X-Client-Timezone": getClientTimezone(),
    "X-Os-Category": getOsCategory(),
    "X-Os-Version": os.release(),
    "X-Device-Mid": deviceMid,
  };
}

/** Match NodeApiClient same-origin source-header and request-ID injection. */
export function buildZcodeOAuthHeaders(endpoint, requestHeaders = {}) {
  const headers = {
    ...buildZcodeSourceHeaders(),
    ...requestHeaders,
  };

  try {
    if (headers["HTTP-Referer"] === "https://zcode.z.ai") {
      headers["HTTP-Referer"] = new URL(endpoint).origin;
    }
  } catch {
    // Keep the official default origin; fetch will report an invalid endpoint.
  }

  const hasRequestId = Object.keys(headers).some(
    (key) => key.toLowerCase() === "x-request-id",
  );
  if (!hasRequestId) headers["x-request-id"] = randomUuid();
  return headers;
}

/** Build unsigned Start Plan bearer headers. OAuth JWTs must not use API-key signing v4. */
export function buildZcodeStartPlanHeaders(credentials, options = {}) {
  const jwt =
    credentials?.providerSpecificData?.zcodeJwtToken || credentials?.accessToken;
  const verifyParam =
    options.verifyParam ?? credentials?.providerSpecificData?._captchaVerifyParam;

  const headers = {
    ...buildZcodeSourceHeaders(),
    "X-ZCode-Agent": "glm",
    "anthropic-version": "2023-06-01",
    "x-request-id": options.requestId || randomUuid(),
    "x-zcode-trace-id": options.traceId || randomUuid(),
    "x-zcode-session-type": options.sessionType || "other",
    "x-query-id": options.queryId || randomUuid(),
  };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;

  if (verifyParam) {
    headers["X-Aliyun-Captcha-Verify-Param"] = verifyParam;
    headers["X-Aliyun-Captcha-Verify-Region"] = "sgp";
  }

  return headers;
}

/** Merge Start Plan headers into an existing bag and remove incompatible Anthropic headers. */
export function applyZcodeStartPlanHeaders(headers, credentials, options = {}) {
  stripAnthropicHeadersForZcodePlan(headers);
  Object.assign(headers, buildZcodeStartPlanHeaders(credentials, options));
  return headers;
}

/**
 * Official 3.11.2 Anthropic body metadata.user_id (UIo/E2e/zhr builders).
 * Binds the Start Plan JWT to the same device fingerprint sent via X-Device-Mid.
 * Treat as a secret: never log the returned value.
 */
export function buildZcodeAnthropicMetadataUserId(credentials = {}) {
  const sessionId = getZcodeSessionId(credentials);
  // Official bnt() strips "sess_" / "subagent_agent_" prefixes before sending.
  const stripped = sessionId
    ? sessionId.replace(/^(sess_|subagent_agent_)/, "")
    : "";
  return JSON.stringify({ device_id: deviceMid, account_uuid: "", session_id: stripped });
}

// Backward-compatible names for callers predating Start Plan terminology.
export const buildZcodeCodingPlanHeaders = buildZcodeStartPlanHeaders;
export const applyZcodeCodingPlanHeaders = applyZcodeStartPlanHeaders;

export const __test__ = {
  randomUuid,
  sessionKey,
  sessionIdByConnection,
};
