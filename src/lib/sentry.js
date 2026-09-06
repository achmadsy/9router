// Sentry integration for 9Router
// Fail-open: if SENTRY_DSN is not configured, all calls no-op safely.

import * as Sentry from "@sentry/node";

let initialized = false;

// Regex matching issue keywords (invalid, required, invalidated, rate, limit, free, captcha, quota, auth, etc.)
export const ISSUE_KEYWORD_REGEX =
  /(?:invalid|required|invalidated|rate|limit|free|quota|exhausted|captcha|unauthorized|forbidden|re-?auth|token_refresh|refresh_token|401|403|429)/i;

export function matchesIssueKeyword(input) {
  if (!input) return false;
  if (typeof input === "string") return ISSUE_KEYWORD_REGEX.test(input);
  try {
    return ISSUE_KEYWORD_REGEX.test(JSON.stringify(input));
  } catch {
    return false;
  }
}

// Redact sensitive text (Bearer tokens, API keys, OAuth tokens, secrets, URL credentials, cookies)
export function redactSensitiveText(text) {
  if (!text || typeof text !== "string") return text;
  return text
    .replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^:\/\s]+:[^@\/\s]+@/g, "$1[REDACTED_USERINFO]@")
    .replace(/bearer\s+[^\s"',;\]}>]+/gi, "Bearer [REDACTED]")
    .replace(/basic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED]")
    .replace(/\b(sk-[a-zA-Z0-9_\-]{8,})/gi, "sk-...[REDACTED]")
    .replace(/\b(AIza[0-9A-Za-z-_]{20,})/gi, "AIza...[REDACTED]")
    .replace(/(?:cookie|set-cookie)\s*:\s*([^;\r\n]+)/gi, "cookie: [REDACTED]")
    .replace(/(?:x-api-key)\s*[:=]\s*["']?[^"',\s;}>]+/gi, "x-api-key: [REDACTED]")
    .replace(
      /(["']?\b(?:access_token|refresh_token|client_secret|api_key|apiKey|password|peer_token|token)["']?\s*[:=]\s*["']?)([^"',\s;}>]{6,})([\"']?)/gi,
      "$1[REDACTED]$3"
    );
}

const SENSITIVE_KEY_REGEX =
  /^(?:authorization|x-api-key|x-9r-peer-token|cookie|set-cookie|password|secret|client_secret|access_token|refresh_token|token|apiKey|api_key|proxy-authorization)$/i;

export function scrubSensitiveData(val, depth = 0) {
  if (depth > 6 || val === null || val === undefined) return val;
  if (typeof val === "string") {
    return redactSensitiveText(val);
  }
  if (Array.isArray(val)) {
    return val.map((item) => scrubSensitiveData(item, depth + 1));
  }
  if (typeof val === "object") {
    const cleaned = {};
    for (const [k, v] of Object.entries(val)) {
      if (SENSITIVE_KEY_REGEX.test(k)) {
        cleaned[k] = "[REDACTED]";
      } else {
        cleaned[k] = scrubSensitiveData(v, depth + 1);
      }
    }
    return cleaned;
  }
  return val;
}

// Rolling deduplication cache (2s TTL) to prevent event storming
const recentEvents = new Map();
const DEDUP_TTL_MS = 2000;

export function isDuplicate(key) {
  const now = Date.now();
  if (recentEvents.size > 100) {
    for (const [k, ts] of recentEvents.entries()) {
      if (now - ts > DEDUP_TTL_MS) recentEvents.delete(k);
    }
  }
  const last = recentEvents.get(key);
  if (last && now - last < DEDUP_TTL_MS) {
    return true;
  }
  recentEvents.set(key, now);
  return false;
}

export function isSentryReady() {
  try {
    if (initialized) return true;
    if (Sentry.getClient?.()) {
      initialized = true;
      return true;
    }
    const dsn = process.env.SENTRY_DSN;
    if (dsn && typeof dsn === "string" && dsn.startsWith("http")) {
      initSentry();
      return initialized;
    }
    return false;
  } catch {
    return false;
  }
}

export function initSentry() {
  if (initialized) return;
  if (Sentry.getClient?.()) {
    initialized = true;
    return;
  }
  const dsn = process.env.SENTRY_DSN;
  if (!dsn || typeof dsn !== "string" || !dsn.startsWith("http")) {
    return;
  }

  try {
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || "production",
      release: "9router@" + (process.env.npm_package_version || "0.5.65"),
      tracesSampleRate: 0.1,
      // Scrub sensitive headers & tokens before sending to Sentry
      beforeSend(event) {
        try {
          if (event.request?.headers) {
            delete event.request.headers.authorization;
            delete event.request.headers["x-api-key"];
            delete event.request.headers["x-9r-peer-token"];
            delete event.request.headers.cookie;
            delete event.request.headers["set-cookie"];
            delete event.request.headers["proxy-authorization"];
          }
          if (event.message) {
            event.message = redactSensitiveText(event.message);
          }
          if (event.breadcrumbs && Array.isArray(event.breadcrumbs)) {
            for (const b of event.breadcrumbs) {
              if (b.message) b.message = redactSensitiveText(b.message);
              if (b.data) b.data = scrubSensitiveData(b.data);
            }
          }
          if (event.extra) {
            event.extra = scrubSensitiveData(event.extra);
          }
          if (event.exception?.values && Array.isArray(event.exception.values)) {
            for (const v of event.exception.values) {
              if (v.value) v.value = redactSensitiveText(v.value);
            }
          }
        } catch {
          // fail-open in beforeSend
        }
        return event;
      },
    });
    initialized = true;
    console.log("[Sentry] initialized with DSN:", dsn.replace(/:[^@]+@/, ":***@"));
  } catch (err) {
    console.error("[Sentry] init failed:", err?.message || err);
  }
}

export function captureException(err, context = {}) {
  try {
    const checkReady =
      (typeof globalThis !== "undefined" && globalThis.__9router_sentry?.isSentryReady) || isSentryReady;
    if (!checkReady()) return null;
    const errMsg = redactSensitiveText(err?.message || String(err));
    const dedupKey = `err:${errMsg}:${context.tags?.stage || ""}`;
    if (!context.force && isDuplicate(dedupKey)) return null;

    const scrubbedExtra = context.extra ? scrubSensitiveData(context.extra) : undefined;

    Sentry.withScope((scope) => {
      if (context.tags) {
        for (const [k, v] of Object.entries(context.tags)) {
          if (v !== undefined && v !== null) scope.setTag(k, String(v));
        }
      }
      if (matchesIssueKeyword(errMsg)) {
        scope.setTag("has_issue_keyword", "true");
      }
      if (scrubbedExtra) {
        for (const [k, v] of Object.entries(scrubbedExtra)) {
          if (v !== undefined) scope.setExtra(k, v);
        }
      }
      if (context.level) scope.setLevel(context.level);
      if (err instanceof Error) {
        Sentry.captureException(err);
      } else {
        Sentry.captureMessage(errMsg);
      }
    });
    return true;
  } catch {
    // Sentry reporting must never crash the gateway
    return null;
  }
}

export function captureMessage(msg, level = "info", context = {}) {
  try {
    const checkReady =
      (typeof globalThis !== "undefined" && globalThis.__9router_sentry?.isSentryReady) || isSentryReady;
    if (!checkReady()) return null;
    const rawStr = typeof msg === "string" ? msg : JSON.stringify(msg);
    const msgStr = redactSensitiveText(rawStr);
    const dedupKey = `msg:${level}:${msgStr}:${context.tags?.stage || ""}`;
    if (!context.force && isDuplicate(dedupKey)) return null;

    const scrubbedExtra = context.extra ? scrubSensitiveData(context.extra) : undefined;

    Sentry.withScope((scope) => {
      scope.setLevel(level);
      if (context.tags) {
        for (const [k, v] of Object.entries(context.tags)) {
          if (v !== undefined && v !== null) scope.setTag(k, String(v));
        }
      }
      if (matchesIssueKeyword(msgStr)) {
        scope.setTag("has_issue_keyword", "true");
      }
      if (scrubbedExtra) {
        for (const [k, v] of Object.entries(scrubbedExtra)) {
          if (v !== undefined) scope.setExtra(k, v);
        }
      }
      Sentry.captureMessage(msgStr);
    });
    return true;
  } catch {
    // fail-open
    return null;
  }
}

// Auto-init on import if DSN is set in environment
if (typeof process !== "undefined" && process.env?.SENTRY_DSN) {
  try {
    initSentry();
  } catch {
    // fail-open
  }
}

// Expose safe bridge on globalThis for cross-boundary modules (open-sse, standalone zcode)
if (typeof globalThis !== "undefined") {
  globalThis.__9router_sentry = {
    get captureException() {
      return captureException;
    },
    get captureMessage() {
      return captureMessage;
    },
    get isSentryReady() {
      return isSentryReady;
    },
    get matchesIssueKeyword() {
      return matchesIssueKeyword;
    },
    get isDuplicate() {
      return isDuplicate;
    },
    get initSentry() {
      return initSentry;
    },
    redactSensitiveText,
    scrubSensitiveData,
  };
}

export { Sentry };
