import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import zcodeConfig from "./config.js";

const sessionIdByConnection = new Map();

function randomUuid() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function clientSessionId(credentials) {
  return (
    credentials?._clientSessionId ||
    credentials?.rawHeaders?.["x-session-id"] ||
    credentials?.rawHeaders?.["X-Session-Id"]
  );
}

function sessionKey(credentials) {
  return (
    credentials?.connectionId ||
    credentials?.providerSpecificData?.zcodeUserId ||
    credentials?.providerSpecificData?.zcodeJwtToken?.slice(-24) ||
    "default"
  );
}

/** Stable x-session-id per connection (matches ZCode app session affinity). */
function normalizeZcodeAttributionId(value, prefixes = []) {
  if (!value) return undefined;
  let normalized = String(value);
  for (const prefix of prefixes) {
    if (normalized.startsWith(prefix) && normalized.length > prefix.length) {
      normalized = normalized.slice(prefix.length);
    }
  }
  return normalized || String(value);
}

export function getZcodeSessionId(credentials) {
  const provided = normalizeZcodeAttributionId(clientSessionId(credentials), [
    "sess_",
    "subagent_agent_",
  ]);
  if (provided) return provided;

  const key = sessionKey(credentials);
  if (!sessionIdByConnection.has(key)) {
    sessionIdByConnection.set(key, randomUuid());
  }
  return sessionIdByConnection.get(key);
}

/**
 * Native ensureDeviceMid: read ~/.zcode/v2/telemetry-state.json; if deviceMid
 * missing, crypto.randomUUID() once and persist (tmp+rename). Subsequent calls reuse.
 * Omit X-Device-Mid when unresolved (native does).
 */
let _deviceMidCache;

function telemetryStateFile() {
  const baseDir = process.env.ZCODE_DATA_BASE_DIR?.trim() || os.homedir();
  return path.join(baseDir, ".zcode", "v2", "telemetry-state.json");
}

function readTelemetryDeviceMid(file) {
  try {
    const mid = JSON.parse(fs.readFileSync(file, "utf8"))?.deviceMid;
    if (typeof mid === "string" && mid.trim() && /^[\x20-\x7e]+$/.test(mid.trim())) {
      return mid.trim();
    }
  } catch {}
  return undefined;
}

function writeTelemetryDeviceMid(file, mid) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUuid()}.tmp`;
  fs.writeFileSync(
    tmp,
    JSON.stringify({ ...(safeReadJson(file) || {}), deviceMid: mid }, null, 2),
    { mode: 0o600 }
  );
  fs.renameSync(tmp, file);
}

function safeReadJson(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

export function readZcodeDeviceMid() {
  if (_deviceMidCache !== undefined) return _deviceMidCache;
  _deviceMidCache = readTelemetryDeviceMid(telemetryStateFile());
  return _deviceMidCache;
}

export function ensureZcodeDeviceMid() {
  const existing = readZcodeDeviceMid();
  if (existing) return existing;

  const mid = randomUuid();
  try {
    writeTelemetryDeviceMid(telemetryStateFile(), mid);
    _deviceMidCache = mid;
  } catch {
    _deviceMidCache = undefined;
  }
  return _deviceMidCache;
}

/** Native createAnthropicRequestMetadataUserId payload. */
export function buildZcodeAnthropicMetadataUserId(credentials) {
  const deviceMid = ensureZcodeDeviceMid();
  if (!deviceMid) return undefined;
  return JSON.stringify({
    device_id: deviceMid,
    account_uuid: "",
    session_id: getZcodeSessionId(credentials),
  });
}

function normalizePrintableHeaderValue(value) {
  const normalized = value?.trim();
  return normalized && /^[\x20-\x7e]+$/.test(normalized) ? normalized : undefined;
}

function osCategory(platform = process.platform) {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}

function osLocale() {
  return normalizePrintableHeaderValue(
    Intl.DateTimeFormat().resolvedOptions().locale
  ) || "unknown";
}

function osTimezone() {
  return normalizePrintableHeaderValue(
    Intl.DateTimeFormat().resolvedOptions().timeZone
  ) || "unknown";
}

function endpointOrigin(endpoint = zcodeConfig.apiBaseUrl) {
  try {
    return new URL(endpoint).origin;
  } catch {
    return "https://zcode.z.ai";
  }
}

function setHeaders(target, source = {}) {
  for (const [key, value] of Object.entries(source)) {
    const existing = Object.keys(target).find(
      (candidate) => candidate.toLowerCase() === key.toLowerCase()
    );
    if (existing && existing !== key) delete target[existing];
    target[key] = value;
  }
  return target;
}

export function buildZcodeSourceHeadersFromContext(context = {}) {
  const appVersion = normalizePrintableHeaderValue(context.appVersion);
  const arch = normalizePrintableHeaderValue(context.arch);
  const language = normalizePrintableHeaderValue(context.clientLanguage) || "unknown";
  const timezone = normalizePrintableHeaderValue(context.clientTimezone) || "unknown";
  const deviceMid = normalizePrintableHeaderValue(context.deviceMid);
  const referer = normalizePrintableHeaderValue(context.endpointOrigin) || "https://zcode.z.ai";
  const osVersion = normalizePrintableHeaderValue(context.osVersion);
  const platform = normalizePrintableHeaderValue(context.platform);
  const releaseChannel = normalizePrintableHeaderValue(context.releaseChannel);
  const sourceTitle = normalizePrintableHeaderValue(context.sourceTitle) || "electron";

  return {
    "HTTP-Referer": referer,
    "User-Agent": `ZCode/${appVersion || "unknown"}`,
    ...(appVersion ? { "X-ZCode-App-Version": appVersion } : {}),
    "X-Title": `Z Code@${sourceTitle}`,
    ...(platform && arch ? { "X-Platform": `${platform}-${arch}` } : {}),
    ...(releaseChannel ? { "X-Release-Channel": releaseChannel } : {}),
    "X-Client-Language": language,
    "X-Client-Timezone": timezone,
    ...(platform ? { "X-Os-Category": osCategory(platform) } : {}),
    ...(osVersion ? { "X-Os-Version": osVersion } : {}),
    ...(deviceMid ? { "X-Device-Mid": deviceMid } : {}),
  };
}

function buildZcodeAppSourceHeaders(endpoint, { includeDeviceMid = false } = {}) {
  const headers = buildZcodeSourceHeadersFromContext({
    appVersion: zcodeConfig.appVersion,
    arch: process.arch,
    clientLanguage: osLocale(),
    clientTimezone: osTimezone(),
    ...(includeDeviceMid ? { deviceMid: ensureZcodeDeviceMid() } : {}),
    endpointOrigin: endpointOrigin(endpoint),
    osVersion: os.release(),
    platform: process.platform,
    releaseChannel: "production",
    sourceTitle: "electron",
  });
  const userAgent = normalizePrintableHeaderValue(zcodeConfig.userAgent);
  if (userAgent) headers["User-Agent"] = userAgent;
  return headers;
}

/** GUI NodeApiClient headers applied to every configured ZCode-origin request. */
export function buildZcodeGuiRequestHeaders(extraHeaders = {}, endpoint) {
  const headers = setHeaders(
    buildZcodeAppSourceHeaders(endpoint, { includeDeviceMid: true }),
    extraHeaders
  );
  if (!Object.keys(headers).some((key) => key.toLowerCase() === "x-request-id")) {
    headers["x-request-id"] = randomUuid();
  }
  return headers;
}

/** Native Start Plan billing requests: GUI headers plus the ZCode JWT. */
export function buildZcodeBillingHeaders(jwt, endpoint = zcodeConfig.startPlanBalanceUrl) {
  return buildZcodeGuiRequestHeaders(
    { Authorization: `Bearer ${jwt}` },
    endpoint
  );
}

export function buildZcodeBalanceHeaders(jwt) {
  return buildZcodeBillingHeaders(jwt);
}

const ANTHROPIC_HEADER_KEYS = [
  "Anthropic-Version",
  "anthropic-version",
  "Anthropic-Beta",
  "anthropic-beta",
  "Anthropic-Dangerous-Direct-Browser-Access",
  "anthropic-dangerous-direct-browser-access",
];

export function stripAnthropicHeadersForZcodePlan(headers) {
  if (!headers || typeof headers !== "object") return headers;
  for (const key of ANTHROPIC_HEADER_KEYS) {
    delete headers[key];
  }
  return headers;
}

const ZCODE_CODING_PLAN_HEADER_KEYS = [
  "Authorization",
  "anthropic-version",
  "User-Agent",
  "X-ZCode-App-Version",
  "X-ZCode-Agent",
  "X-Title",
  "HTTP-Referer",
  "X-Release-Channel",
  "X-Client-Language",
  "X-Client-Timezone",
  "X-Platform",
  "X-Os-Category",
  "X-Os-Version",
  "x-zcode-session-type",
  "X-Device-Mid",
  "X-Aliyun-Captcha-Verify-Param",
  "X-Aliyun-Captcha-Verify-Region",
  "x-request-id",
  "x-zcode-trace-id",
  "x-query-id",
  "x-session-id",
];

export function clearZcodeCodingPlanHeaders(headers) {
  if (!headers || typeof headers !== "object") return headers;
  for (const key of ZCODE_CODING_PLAN_HEADER_KEYS) {
    delete headers[key];
  }
  return headers;
}

/**
 * Build ZCode Coding Plan upstream headers (zcode-plan URL fingerprint).
 * @param {object} credentials
 * @param {{ verifyParam?: string }} [options]
 */
export function buildZcodeCodingPlanHeaders(credentials, options = {}) {
  const jwt =
    credentials?.providerSpecificData?.zcodeJwtToken || credentials?.accessToken;
  const verifyParam =
    options.verifyParam ?? credentials?.providerSpecificData?._captchaVerifyParam;
  const sessionType = options.sessionType || "main";
  const queryId = normalizeZcodeAttributionId(options.queryId, ["query_"]);

  const headers = {
    ...buildZcodeAppSourceHeaders(zcodeConfig.codingPlanUrl),
    Authorization: `Bearer ${jwt}`,
    "anthropic-version": "2023-06-01",
    "X-ZCode-Agent": "glm",
    "x-zcode-session-type": sessionType,
    "x-request-id": options.requestId || randomUuid(),
    "x-zcode-trace-id": options.traceId || randomUuid(),
    ...(queryId ? { "x-query-id": queryId } : {}),
    "x-session-id": getZcodeSessionId(credentials),
  };

  if (verifyParam) {
    headers["X-Aliyun-Captcha-Verify-Param"] = verifyParam;
    headers["X-Aliyun-Captcha-Verify-Region"] = "sgp";
  }

  return headers;
}

/** Merge ZCode Coding Plan headers into an existing header bag; strips Anthropic CLI headers. */
export function applyZcodeCodingPlanHeaders(headers, credentials, options = {}) {
  stripAnthropicHeadersForZcodePlan(headers);
  delete headers["x-api-key"];
  Object.assign(headers, buildZcodeCodingPlanHeaders(credentials, options));
  return headers;
}

/**
 * Build ZCode API key upstream headers (api.z.ai fingerprint — matches zcode_proxy).
 * @param {object} credentials
 * @param {{ verifyParam?: string }} [options]
 */
export function buildZcodeApiKeyHeaders(credentials, options = {}) {
  const verifyParam =
    options.verifyParam ?? credentials?.providerSpecificData?._captchaVerifyParam;

  const headers = {
    "anthropic-version": "2023-06-01",
    ...buildZcodeAppSourceHeaders(),
    "X-ZCode-Agent": "glm",
  };

  if (credentials?.apiKey) {
    headers["x-api-key"] = credentials.apiKey;
  }

  if (verifyParam) {
    headers["X-Aliyun-Captcha-Verify-Param"] = verifyParam;
  }

  return headers;
}

/** Merge ZCode API key headers; strips Coding Plan / Claude Code beta headers. */
export function applyZcodeApiKeyHeaders(headers, credentials, options = {}) {
  clearZcodeCodingPlanHeaders(headers);
  delete headers["Authorization"];
  delete headers["Anthropic-Beta"];
  delete headers["anthropic-beta"];
  delete headers["Anthropic-Version"];
  Object.assign(headers, buildZcodeApiKeyHeaders(credentials, options));
  return headers;
}

export const __test__ = {
  randomUuid,
  sessionKey,
  sessionIdByConnection,
  resetDeviceMidCache() {
    _deviceMidCache = undefined;
  },
};