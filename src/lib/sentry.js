// Sentry integration for 9Router
// Fail-open: if SENTRY_DSN is not configured, all calls no-op safely.

import * as Sentry from "@sentry/node";
import { getRequestIp, normalizeClientIp } from "@/lib/requestContext";

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

// ── Issue grouping normalization ──────────────────────────────────────────────
// Sentry groups message events by their title (= message text). Dynamic IDs,
// timestamps, attempt counters and cooldown durations embedded in titles split
// one underlying problem into dozens of issues. normalizeIssueTitle() strips
// those dynamic tokens BEFORE capture so titles (and therefore groups) stay
// stable. Words, provider names, model names and short HTTP status codes are
// preserved — they are meaningful, bounded vocabulary.

const ISO_TIME_RE = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?\b/g;
const CLOCK_TIME_RE = /\b\d{1,2}:\d{2}(?::\d{2})?\b/g;
const DURATION_RE = /\b\d+(?:\.\d+)?\s?(?:ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)\b/gi;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// Whole-token UUID (8-4-4-4-12 hex) for the bracket classifier: it runs
// BEFORE UUID_RE, so without this a bracketed UUID like
// "[abcdef12-abcd-…-abcdefabcdef]" (letter-led — short digit runs, long
// letter runs) dodges the ID heuristics and UUID_RE then rewrites it to the
// nested "[[ID]]" instead of emptying the brackets to "[]".
const UUID_TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Digit/hex runs must be STANDALONE tokens: bounded by characters that are
// not alnum, dash or underscore. Without the lookarounds, "claude-code-20250219"
// or "seed-2-0-code-preview-260328" lose their version/date digits, collapsing
// distinct model revisions into one title. Dash/underscore-joined runs are
// identifier/model-shaped and preserved.
const ID_TOKEN_BOUNDARY = "[0-9a-zA-Z_\\-]";
const HEX_RUN_RE = new RegExp(`(?<!${ID_TOKEN_BOUNDARY})[0-9a-f]{10,}(?!${ID_TOKEN_BOUNDARY})`, "gi");
const HASH_REF_RE = /#[0-9a-fA-F]{3,}\b/g;
const LONG_NUM_RE = new RegExp(`(?<!${ID_TOKEN_BOUNDARY})[0-9]{6,}(?!${ID_TOKEN_BOUNDARY})`, "g");
const ATTEMPT_BEFORE_RE = /\battempts?\s+\d+(?:\s*\/\s*\d+)?/gi;
const ATTEMPT_AFTER_RE = /\b\d+(?:\s*\/\s*\d+)?\s+attempts?\b/gi;
const BRACKET_CONTENT_RE = /\[([^\]\[]{4,})\]/g;

// Bracket content is "ID-like" (e.g. "1234-123", "a1b2c3d4-e5f6...", "req-98765",
// "capture-xyz-98765", "8842719") when it consists only of hex chars, letters,
// dashes and underscores AND its digits look like identifier noise, not a
// model name. Model-shaped tokens start with a known model-name prefix whose
// next segment is version-shaped — a digit directly after the prefix,
// optionally through one "-" or "." (gpt-5, gpt-4.1, claude-3-5-sonnet,
// seed-2-0-...); `o\d` carries the version digit inside the prefix itself
// (o3-mini). Those stay verbatim so distinct models stay distinct issues.
// A bare prefix is NOT enough: "gpt-request-98765", "seed-session-98765",
// "claude-job-123456" also start with a model prefix but are prefix-word +
// dynamic ID — kept verbatim they would split one issue per ID, so they fall
// through to the ID rules and empty to "[]".
// Deliberately conservative: when in doubt PRESERVE the token — collapsing two
// distinct real issues into one group loses information; keeping a doubtful
// token only splits groups. Vocabulary like [CHAT], [TOKEN_REFRESH], [429],
// [codex/gpt-5], [antigravity] (no digits, or containing slash/dot/space) is
// likewise preserved verbatim for debugging.
const MODEL_NAME_PREFIXES =
  /^(?:o\d|(?:gpt|claude|gemini|grok|seed|sonnet|opus|haiku|deepseek|qwen|kimi|llama|mistral|codex|antigravity|glm|ernie|hunyuan|doubao|moonshot|phi|minimax)[-.]?\d)/i;

function isIdLikeBracketContent(s) {
  if (!/[0-9]/.test(s)) return false; // no digits -> pure vocabulary, keep
  if (!/^[0-9a-zA-Z][0-9a-zA-Z\-_]*$/.test(s)) return false; // slash/dot/space -> keep
  if (s.length < 4) return false; // too short to be an ID, keep
  // Model-shaped (known model prefix followed by a version digit, like
  // gpt-5 / seed-2-0-..., NOT gpt-request-98765) -> keep.
  if (MODEL_NAME_PREFIXES.test(s)) return false;
  // Whole-token UUID: empty it HERE rather than later via UUID_RE, which
  // would rewrite "[<uuid>]" to the nested "[[ID]]" instead of "[]".
  if (UUID_TOKEN_RE.test(s)) return true;
  // ID-like: a substantial standalone digit run (>=3 consecutive digits)
  // like "1234-123", "8842719", "req-98765", "capture-xyz-98765".
  if (/\d{3,}/.test(s)) return true;
  // Otherwise require an alphabetic run of 2+ letters touching digits to be
  // absent — "x1y2z"-style identifiers empty, model-ish "t5" is kept as doubtful.
  return !/(?:[a-z]{2,}\d|\d[a-z]{2,})/i.test(s);
}

export function normalizeIssueTitle(text) {
  if (!text || typeof text !== "string") return text;
  try {
    let out = text;
    out = out.replace(ISO_TIME_RE, "[TIME]");
    out = out.replace(CLOCK_TIME_RE, "[TIME]");
    out = out.replace(DURATION_RE, (m) => "N" + m.replace(/^\d+(?:\.\d+)?\s?/, ""));
    // Bracket rule must run BEFORE UUID/hex rules, else a bracketed UUID is
    // first rewritten to "[[ID]]" and can no longer be emptied to "[]".
    out = out.replace(BRACKET_CONTENT_RE, (m, inner) =>
      isIdLikeBracketContent(inner) ? "[]" : m
    );
    out = out.replace(/\[\]\d+/g, "[]"); // "xxx [1234-123]4" -> "xxx []"
    out = out.replace(UUID_RE, "[ID]");
    out = out.replace(HEX_RUN_RE, (m) => (/[0-9]/.test(m) ? "[ID]" : m));
    out = out.replace(HASH_REF_RE, "#[ID]");
    out = out.replace(LONG_NUM_RE, "[ID]");
    out = out.replace(ATTEMPT_BEFORE_RE, (m) => m.replace(/\d+/g, "N"));
    out = out.replace(ATTEMPT_AFTER_RE, (m) => m.replace(/\d+/g, "N"));
    return out;
  } catch {
    return text; // fail-open: normalization must never drop the message
  }
}

// ── Caller origin extraction ────────────────────────────────────────────────
// The gateway logs through shared wrappers (logger.js, consoleLogBuffer.js,
// rtk/sentry.js bridge), so the immediate caller of capture* is never the real
// origin. Skip those wrapper frames and attach the first application frame as
// origin_file / origin_line tags so Sentry issues point at the offending file.

// Separator-agnostic (`[/\\]`) so POSIX and Windows stacks skip the same
// wrapper frames (sentry.js itself, logger, console buffer, SDK internals).
const ORIGIN_SKIP_RE =
  /(?:[/\\]sentry\.js|[/\\]consoleLogBuffer\.js|[/\\]utils[/\\]logger\.js|@sentry[/\\]|node:internal[/\\]|[/\\]instrumentation\.js)/;

const STACK_FRAME_RE = /\(([^()]+):(\d+):\d+\)|at\s+([^()\s]+):(\d+):\d+/;

function toRelativeOrigin(file) {
  let f = String(file).replace(/^file:\/\//, "").split("?")[0];
  const srcIdx = f.lastIndexOf("/src/");
  if (srcIdx !== -1) return f.slice(srcIdx + 1);
  const oaiIdx = f.lastIndexOf("/open-sse/");
  if (oaiIdx !== -1) return f.slice(oaiIdx + 1);
  const cliIdx = f.lastIndexOf("/cli/");
  if (cliIdx !== -1) return f.slice(cliIdx + 1);
  return f;
}

// Pure: parse a V8 stack string, return { file, line } of the first
// application frame (skipping wrapper/SDK/internal frames), or null.
// Accepts POSIX and Windows (backslash) stack paths.
export function extractOriginFromStack(stack) {
  if (!stack || typeof stack !== "string") return null;
  try {
    for (const rawLine of stack.split("\n").slice(1)) {
      const line = rawLine.trim();
      if (!line.startsWith("at ")) continue;
      const m = line.match(STACK_FRAME_RE);
      if (!m) continue;
      // Normalize Windows separators so wrapper-skip and relativization work
      // on both POSIX and win32 stacks.
      const file = String(m[1] || m[3] || "").replaceAll("\\", "/");
      if (!file || ORIGIN_SKIP_RE.test(file)) continue;
      return { file: toRelativeOrigin(file), line: Number(m[2] || m[4]) };
    }
    return null;
  } catch {
    return null;
  }
}

export function getCallerOrigin() {
  const err = new Error();
  Error.captureStackTrace?.(err, getCallerOrigin);
  return extractOriginFromStack(err.stack);
}

function applyOriginTags(scope, origin) {
  if (!origin) return;
  try {
    scope.setTag("origin_file", origin.file);
    scope.setTag("origin_line", String(origin.line));
  } catch {
    // fail-open: tags are metadata, never worth failing a capture
  }
}

// Custom fingerprint = (normalized title, origin file, origin line). Tags do
// NOT control Sentry grouping; only a custom fingerprint does. This makes:
//   - same normalized title at different call sites -> separate issues
//   - same call site with varying IDs (already normalized) -> ONE issue
function applyGroupingFingerprint(scope, normalizedTitle, origin) {
  try {
    const fingerprint = [
      normalizedTitle,
      origin?.file || "",
      origin ? String(origin.line) : "",
    ];
    scope.setFingerprint(fingerprint);
  } catch {
    // fail-open: fingerprint is grouping metadata, never worth failing a capture
  }
}

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
          // Normalize message/exception text BEFORE building the fingerprint
          // fallback so grouping keys collapse IDs, then pin issue grouping to
          // (title, file, line). applyGroupingFingerprint normally sets this on
          // the scope at capture time; this is a fail-open backstop for events
          // captured by any path that skipped the helper (SDK internals, etc.).
          if (event.message) {
            event.message = normalizeIssueTitle(redactSensitiveText(event.message));
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
              if (v.value) v.value = normalizeIssueTitle(redactSensitiveText(v.value));
            }
          }
          if (!Array.isArray(event.fingerprint)) {
            const title = event.message || event.exception?.values?.[0]?.value || "";
            if (title) {
              // Sentry frame arrays are oldest -> newest (the SDK parser
              // reverses the natural newest -> oldest V8 order; see
              // @sentry/core utils/stacktrace.js stripSentryFramesAndReverse).
              // The throw site is the NEWEST application frame — near the END
              // of the array. Reversed iteration makes extractOriginFromStack
              // (which scans from the first "at " line) find the newest app
              // frame first; the outer caller frames later are never reached.
              // Fail-open: no frames -> no origin -> empty components.
              const rawFrames =
                event?.exception?.values?.[0]?.stacktrace?.frames || [];
              const frames =
                (Array.isArray(rawFrames)
                  ? rawFrames.slice().reverse()
                  : []
                )
                  .map(
                    (f) =>
                      `    at ${f.function || "<anon>"} (${f.filename}:${f.lineno}:${f.colno})`
                  )
                  .join("\n") || "";
              let origin = null;
              try {
                origin = frames ? extractOriginFromStack(`Error:\n${frames}`) : null;
              } catch {
                origin = null;
              }
              event.fingerprint = [
                normalizeIssueTitle(title),
                origin?.file || "",
                origin ? String(origin.line) : "",
              ];
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
    // Resolve origin BEFORE the dedup check: the fingerprint groups by
    // (title, file, line), so the dedup key must include origin too —
    // otherwise the same normalized title+stage from two different call
    // sites within the 2s TTL is suppressed while fingerprint promised
    // distinct issues. One getCallerOrigin() call per capture, hoisted
    // from withScope below.
    const origin = getCallerOrigin();
    const originKey = origin ? `${origin.file}:${origin.line}` : "";
    // Same normalization as captureMessage: one stable dedup key + Sentry issue
    // group per underlying problem, regardless of embedded IDs.
    const dedupKey = `err:${normalizeIssueTitle(errMsg)}:${originKey}:${context.tags?.stage || ""}`;
    if (!context.force && isDuplicate(dedupKey)) return null;

    const scrubbedExtra = context.extra ? scrubSensitiveData(context.extra) : undefined;
    const clientIp =
      normalizeClientIp(context.clientIp || context.ip || getRequestIp()) || undefined;

    Sentry.withScope((scope) => {
      if (clientIp) {
        // Standard Sentry user.ip_address — shows under User on each event.
        scope.setUser({ ip_address: clientIp });
        scope.setTag("client_ip", clientIp);
      }
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
      if (clientIp) {
        scope.setExtra("client_ip", clientIp);
      }
      if (context.level) scope.setLevel(context.level);
      // Attach caller file/line so Sentry issues point at the real origin
      // (skips wrapper frames: logger, console buffer, bridge, SDK internals),
      // and pin issue grouping to (title, file, line) via fingerprint.
      // origin resolved once, before dedup (see dedup key above).
      applyOriginTags(scope, origin);
      applyGroupingFingerprint(scope, normalizeIssueTitle(errMsg), origin);
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
    // Normalize BEFORE dedup + capture: dynamic IDs/timestamps/attempts collapse
    // to one stable title, so Sentry groups them into one issue and dedup fires
    // on the normalized form too.
    const msgStr = normalizeIssueTitle(redactSensitiveText(rawStr));
    // Resolve origin BEFORE the dedup check (see captureException): the
    // fingerprint groups by (title, file, line), so origin belongs in the
    // dedup key. Single getCallerOrigin() call, hoisted from withScope.
    const origin = getCallerOrigin();
    const originKey = origin ? `${origin.file}:${origin.line}` : "";
    const dedupKey = `msg:${level}:${msgStr}:${originKey}:${context.tags?.stage || ""}`;
    if (!context.force && isDuplicate(dedupKey)) return null;

    const scrubbedExtra = context.extra ? scrubSensitiveData(context.extra) : undefined;
    const clientIp =
      normalizeClientIp(context.clientIp || context.ip || getRequestIp()) || undefined;

    Sentry.withScope((scope) => {
      scope.setLevel(level);
      if (clientIp) {
        scope.setUser({ ip_address: clientIp });
        scope.setTag("client_ip", clientIp);
      }
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
      if (clientIp) {
        scope.setExtra("client_ip", clientIp);
      }
      // Attach caller file/line so Sentry issues point at the real origin
      // (skips wrapper frames: logger, console buffer, bridge, SDK internals),
      // and pin issue grouping to (title, file, line) via fingerprint.
      // origin resolved once, before dedup (see dedup key above).
      applyOriginTags(scope, origin);
      applyGroupingFingerprint(scope, msgStr, origin);
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
