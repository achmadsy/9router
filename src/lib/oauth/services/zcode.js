/**
 * ZCode OAuth flow for Start Plan.
 * Uses official CLI init/poll as primary flow. Desktop callback exchange remains
 * available for genuine deep-link callbacks, matching official fallback behavior.
 */

import { randomBytes } from "node:crypto";
import { makeKv } from "@/lib/db/helpers/kvStore.js";
import zcodeConfig from "@/lib/zcode/config.js";
import { buildZcodeOAuthHeaders } from "@/lib/zcode/headers.js";

const SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

const kv = makeKv("zcodeOAuthSessions");
const memorySessions = new Map();

function flowSessionKey(flowId) {
  return `flow:${flowId}`;
}

function parseJwtEmail(token) {
  if (!token || typeof token !== "string") return null;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
    return payload.email || payload.user_email || payload.sub || null;
  } catch {
    return null;
  }
}

async function readBoundedText(response) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      throw new Error("response exceeded 64 KiB limit");
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("response exceeded 64 KiB limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function collectSensitiveValues(options = {}) {
  const values = [];
  const authorization = options.headers?.Authorization || options.headers?.authorization;
  if (typeof authorization === "string") {
    values.push(authorization.replace(/^Bearer\s+/i, ""));
  }

  if (typeof options.body === "string") {
    try {
      const body = JSON.parse(options.body);
      for (const key of ["code", "state", "token", "access_token", "refresh_token"]) {
        if (typeof body?.[key] === "string") values.push(body[key]);
      }
    } catch {
      // Request body is controlled locally and may not be JSON for other callers.
    }
  }

  return values.filter((value) => value.length >= 6);
}

function redactDiagnostic(value, sensitiveValues = []) {
  let text = String(value || "").trim();
  for (const secret of sensitiveValues) {
    text = text.split(secret).join("[REDACTED]");
  }

  return text
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]")
    .replace(/\bcode-[A-Za-z0-9._~-]+\b/gi, "[REDACTED_CODE]")
    .replace(/\b[a-f0-9]{24,}\b/gi, "[REDACTED]")
    .replace(/([?&](?:code|authCode|state|token|access_token|refresh_token)=)[^&#\s]+/gi, "$1[REDACTED]")
    .slice(0, 300);
}

function safeBusinessCode(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const code = value.trim();
  return /^[A-Z0-9][A-Z0-9_:-]{0,63}$/i.test(code) ? code : null;
}

function describeEnvelopeError(envelope, sensitiveValues = []) {
  const code = safeBusinessCode(envelope?.code);
  const rawMessage = envelope?.msg || envelope?.message;
  const message = rawMessage ? redactDiagnostic(rawMessage, sensitiveValues) : "";

  if (code && message) return `upstream code ${code}: ${message}`;
  if (code) return `business error ${code}`;
  if (message) return message;
  return "business error missing code";
}

function parseEnvelope(raw, label, sensitiveValues = []) {
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new Error(`${label}: invalid JSON response`);
  }

  if (!envelope || typeof envelope !== "object" || envelope.code !== 0) {
    throw new Error(`${label}: ${describeEnvelopeError(envelope, sensitiveValues)}`);
  }
  if (!envelope.data || typeof envelope.data !== "object") {
    throw new Error(`${label}: missing response data`);
  }

  return envelope.data;
}

async function requestEnvelope(endpoint, options, label) {
  const requestOptions = {
    ...options,
    headers: buildZcodeOAuthHeaders(endpoint, options.headers),
  };

  let response;
  try {
    response = await fetch(endpoint, {
      ...requestOptions,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const wrapped = new Error(`${label}: request failed (${error?.message || "network error"})`);
    wrapped.transient = true;
    throw wrapped;
  }

  let raw;
  try {
    raw = await readBoundedText(response);
  } catch (error) {
    throw new Error(`${label}: ${error.message}`);
  }

  const sensitiveValues = collectSensitiveValues(requestOptions);
  if (!response.ok) {
    let detail = "";
    try {
      detail = describeEnvelopeError(JSON.parse(raw), sensitiveValues);
    } catch {
      // HTTP status remains useful when upstream returns HTML or malformed JSON.
    }

    const error = new Error(
      `${label}: HTTP ${response.status}${detail ? `; ${detail}` : ""}`,
    );
    error.transient = response.status === 408 || response.status === 429 || response.status >= 500;
    throw error;
  }

  return parseEnvelope(raw, label, sensitiveValues);
}

async function storeSession(session) {
  const keys = [session.state, flowSessionKey(session.flowId)];
  for (const key of keys) memorySessions.set(key, session);
  try {
    await Promise.all(keys.map((key) => kv.set(key, session)));
  } catch {
    // memory fallback
  }
}

async function loadSession(key) {
  let session = memorySessions.get(key);
  if (!session) {
    try {
      session = await kv.get(key);
    } catch {
      session = null;
    }
  }
  return session;
}

async function removeSession(session) {
  if (!session) return;
  const keys = [session.state, flowSessionKey(session.flowId)];
  for (const key of keys) memorySessions.delete(key);
  try {
    await Promise.all(keys.map((key) => kv.remove(key)));
  } catch {
    // memory fallback
  }
}

function mapReadyTokens(data, session, { requireUserId = false } = {}) {
  const zcodeJwtToken = data.token;
  const zaiAccessToken = data.zai?.access_token;
  const zcodeUserId = data.user?.user_id;
  if (!zcodeJwtToken || !zaiAccessToken || (requireUserId && !zcodeUserId)) {
    const missing = [
      !zcodeJwtToken && "token",
      !zaiAccessToken && "zai.access_token",
      requireUserId && !zcodeUserId && "user.user_id",
    ].filter(Boolean).join(", ");
    throw new Error(`Invalid ZCode OAuth response: missing ${missing}`);
  }

  const email =
    data.user?.email ||
    parseJwtEmail(zcodeJwtToken) ||
    `zcode-${session.flowId.slice(0, 8)}`;
  const expiresIn = Number(data.expires_in);

  return {
    accessToken: zcodeJwtToken,
    zaiAccessToken,
    email,
    displayName: data.user?.name || email,
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresIn } : {}),
    providerSpecificData: {
      authMethod: "zcode_oauth",
      useStartPlan: true,
      zcodeJwtToken,
      zcodeUserId,
      flowId: session.flowId,
    },
  };
}

export class ZcodeAuthService {
  async initFlow() {
    const generatedPollToken = randomBytes(32).toString("hex");
    const data = await requestEnvelope(
      zcodeConfig.oauthInitUrl,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${generatedPollToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ provider: "zai" }),
      },
      "ZCode auth init",
    );

    const flowId = data?.flow_id || data?.flowId;
    const rawAuthorizeUrl = data?.authorize_url || data?.authorizeUrl;
    if (!flowId || !rawAuthorizeUrl) {
      throw new Error("Invalid response from ZCode OAuth init endpoint");
    }

    let authorizeUrl;
    let state;
    try {
      authorizeUrl = new URL(rawAuthorizeUrl);
      if (authorizeUrl.protocol !== "https:" && authorizeUrl.protocol !== "http:") {
        throw new Error("invalid protocol");
      }
      state = authorizeUrl.searchParams.get("state")?.trim();
      if (!state) throw new Error("missing state");
      authorizeUrl.searchParams.set("redirect_uri", zcodeConfig.oauthDesktopRedirectUri);
    } catch {
      throw new Error("Invalid ZCode OAuth init authorize URL");
    }

    const now = Date.now();
    const upstreamExpiry = Number(data?.expires_at || data?.expiresAt);
    const upstreamExpiryMs = Number.isFinite(upstreamExpiry) && upstreamExpiry > 0
      ? upstreamExpiry * 1000
      : Number.POSITIVE_INFINITY;
    const expiresAt = Math.min(now + SESSION_TTL_MS, upstreamExpiryMs);
    if (expiresAt <= now) {
      throw new Error("Invalid ZCode OAuth init expiry");
    }

    const pollInterval = Math.max(2, Number(data?.poll_interval_sec || data?.pollIntervalSec) || 2);
    const session = {
      flowId,
      state,
      pollToken: generatedPollToken,
      redirectUri: zcodeConfig.oauthDesktopRedirectUri,
      pollInterval,
      expiresAt,
    };
    await storeSession(session);

    return {
      flowId,
      authorizeUrl: authorizeUrl.toString(),
      state,
      pollInterval,
      expiresIn: Math.max(1, Math.ceil((expiresAt - now) / 1000)),
    };
  }

  async exchangeCallback(rawCallbackUrl) {
    let callbackUrl;
    try {
      callbackUrl = new URL(String(rawCallbackUrl || "").trim());
    } catch {
      throw new Error("Invalid ZCode OAuth callback URL");
    }

    const callbackError = callbackUrl.searchParams.get("error");
    if (callbackError) {
      throw new Error(
        callbackUrl.searchParams.get("error_description") || callbackError,
      );
    }

    const code =
      callbackUrl.searchParams.get("code") ||
      callbackUrl.searchParams.get("authCode");
    const state = callbackUrl.searchParams.get("state")?.trim();
    if (!code) throw new Error("Missing ZCode OAuth callback code");
    if (!state) throw new Error("Missing ZCode OAuth callback state");

    const session = await loadSession(state);
    if (!session || session.state !== state) {
      throw new Error("ZCode OAuth session not found; restart login");
    }
    if (session.expiresAt <= Date.now()) {
      await removeSession(session);
      throw new Error("ZCode OAuth session expired; restart login");
    }

    const data = await requestEnvelope(
      zcodeConfig.oauthTokenUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider: "zai",
          code,
          redirect_uri: session.redirectUri,
          state,
        }),
      },
      "ZCode auth exchange",
    );

    const tokens = mapReadyTokens(data, session);
    await removeSession(session);
    return { status: "ready", tokens };
  }

  async pollFlow(flowId) {
    const session = await loadSession(flowSessionKey(flowId));
    if (!session || session.expiresAt < Date.now()) {
      if (session) await removeSession(session);
      return {
        status: "expired",
        error: "OAuth session expired or not found",
      };
    }

    let data;
    try {
      data = await requestEnvelope(
        `${zcodeConfig.oauthPollUrl}/${encodeURIComponent(flowId)}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${session.pollToken}`,
          },
        },
        "ZCode auth poll",
      );
    } catch (error) {
      if (error?.transient) {
        return { status: "pending", retryAfter: session.pollInterval };
      }
      return { status: "failed", error: error.message };
    }

    if (data?.status === "pending" || (!data?.status && !data?.token)) {
      return { status: "pending" };
    }

    if (data.status === "failed") {
      await removeSession(session);
      return { status: "failed", error: "Authorization denied" };
    }

    if (data.status === "ready") {
      try {
        const tokens = mapReadyTokens(data, session, { requireUserId: true });
        await removeSession(session);
        return { status: "ready", tokens };
      } catch (error) {
        return { status: "failed", error: error.message };
      }
    }

    if (data.token || data.zai?.access_token || data.user?.user_id) {
      return { status: "failed", error: "Invalid ZCode OAuth response: missing ready status" };
    }

    return { status: data.status || "pending" };
  }
}

export const __test__ = {
  parseEnvelope,
  readBoundedText,
  memorySessions,
};

export default ZcodeAuthService;
