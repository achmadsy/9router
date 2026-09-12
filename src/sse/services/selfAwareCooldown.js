/**
 * Self-Aware cooldown service.
 *
 * Owns precedence (upstream wait header → manual per-model policy → legacy
 * fallback), SQLite sidecar metadata for the dashboard board, and reset ops.
 * Routing itself stays on the existing modelLock_* / antigravity RAM paths —
 * this service only supplies durations and keeps the board in sync.
 *
 * Fail-open: any SQLite read/write failure logs and defers to legacy behavior.
 * Never persist secrets or proxy URLs.
 */
import { MAX_SELF_AWARE_COOLDOWN_MS, isQuotaLikeStatus } from "open-sse/utils/retryAfter.js";
import { checkFallbackError, buildModelLockUpdate } from "open-sse/services/accountFallback.js";
import { resolveProviderId } from "@/shared/constants/providers.js";
import { isProviderCloneId, resolveRuntimeProviderId } from "open-sse/providers/clones.js";
import * as log from "../utils/logger.js";

const REASON_MAX = 200;
export const SELF_AWARE_MAX_COOLDOWN_MS = MAX_SELF_AWARE_COOLDOWN_MS;

/**
 * Sanitize free-text reason for storage: redact secrets/proxy URLs, strip
 * control chars, cap length. Fail-open — never throws, always returns string|null.
 */
export function sanitizeReason(text) {
  if (text == null) return null;
  let s = String(text);
  // Redact before control-char stripping so patterns stay intact.
  s = s
    // URL userinfo (http://user:pass@host — proxy URLs)
    .replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^:\/\s]+:[^@\/\s]+@/g, "$1[REDACTED]@")
    // Full http(s) URLs (proxy endpoints etc.) — keep reason human-readable otherwise
    .replace(/https?:\/\/[^\s"',;)\]}]+/gi, "[REDACTED_URL]")
    .replace(/bearer\s+[^\s"',;\]}>]+/gi, "Bearer [REDACTED]")
    .replace(/\b(sk-[a-zA-Z0-9_\-]{8,})/gi, "sk-...[REDACTED]")
    .replace(/\b(AIza[0-9A-Za-z-_]{20,})/gi, "AIza...[REDACTED]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g, "[REDACTED]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED]");
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0);
    // Strip C0/C1 control characters except space/tab
    if ((code < 32 && ch !== " " && ch !== "\t") || (code >= 127 && code <= 159)) {
      out += " ";
      continue;
    }
    out += ch;
  }
  out = out.replace(/\s+/g, " ").trim();
  if (!out) return null;
  return out.slice(0, REASON_MAX);
}

function isoOf(ms) {
  return ms ? new Date(ms).toISOString() : null;
}

/**
 * Milliseconds until the next local wall-clock occurrence of HH:MM.
 * Always > 0 (if "now" is exactly on the minute, wait until tomorrow).
 */
export function msUntilDailyReset(hour, minute, nowMs = Date.now()) {
  if (hour == null || minute == null) return null;
  const h = Number(hour);
  const m = Number(minute);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    return null;
  }
  const now = new Date(nowMs);
  const next = new Date(now);
  next.setHours(h, m, 0, 0);
  if (next.getTime() <= nowMs) next.setDate(next.getDate() + 1);
  return next.getTime() - nowMs;
}

async function repo() {
  // Lazy import keeps pure decision path free of DB dependency in unit tests
  // that only call resolveSelfAwareDecision with in-memory inputs.
  return import("@/lib/db/repos/selfAwareRepo.js");
}

/**
 * Resolve how long to cool down and under which scope.
 * Pure when manualPolicyMs is passed in — callers that need DB policies
 * load them first via getSelfAwarePolicyMs().
 *
 * @param {object} input
 * @param {string} input.provider
 * @param {string|null} input.model
 * @param {number} [input.status] - HTTP status from upstream
 * @param {string|null} [input.errorText]
 * @param {object|null} [input.cooldownHint] - parseRateLimitCooldown result
 * @param {number|null} [input.resetsAtMs] - provider-specific precise expiry
 * @param {number|null} [input.backoffLevel]
 * @param {number|null} [input.manualPolicyMs]
 * @param {{scopeType?: string, scopeId?: string}|null} [input.scope]
 * @param {number} [input.nowMs]
 * @returns {{ shouldFallback: boolean, cooldownMs: number, expiresAt: string|null, source: string|null, scopeType: string, scopeId: string, headerName: string|null, status: number|null, reason: string|null, newBackoffLevel: number|null }}
 */
export function resolveSelfAwareDecision(input = {}) {
  const {
    provider = null,
    model = null,
    status = null,
    errorText = null,
    cooldownHint = null,
    resetsAtMs = null,
    backoffLevel = 0,
    manualPolicyMs = null,
    scope = null,
    scopeType: scopeTypeArg,
    scopeId: scopeIdArg,
    nowMs = Date.now(),
  } = input;

  const scopeType = scope?.scopeType || scopeTypeArg || "account";
  const scopeId = scope?.scopeId || scopeIdArg || (scopeType === "provider" ? "provider" : "account");
  const reason = sanitizeReason(errorText);
  const base = {
    shouldFallback: false,
    cooldownMs: 0,
    expiresAt: null,
    source: null,
    provider,
    model,
    scopeType,
    scopeId,
    headerName: null,
    status: status ?? null,
    reason,
    newBackoffLevel: null,
  };

  // 1) Valid upstream wait header (429 only)
  if (isQuotaLikeStatus(status, errorText) && cooldownHint && cooldownHint.source === "upstream-header") {
    const durationMs = Number(cooldownHint.durationMs);
    const expiresAtMs = Number(cooldownHint.expiresAtMs);
    if (
      Number.isFinite(durationMs) && durationMs > 0 &&
      Number.isFinite(expiresAtMs) && expiresAtMs > nowMs &&
      durationMs <= SELF_AWARE_MAX_COOLDOWN_MS
    ) {
      return {
        ...base,
        shouldFallback: true,
        cooldownMs: durationMs,
        expiresAt: isoOf(expiresAtMs),
        source: "upstream-header",
        headerName: cooldownHint.headerName || null,
        newBackoffLevel: 0,
      };
    }
  }

  // 2) Manual per-model wait policy (429 only — not 401/5xx)
  const manual = Number(manualPolicyMs);
  if (status === 429 && Number.isFinite(manual) && manual > 0) {
    const cooldownMs = Math.min(manual, SELF_AWARE_MAX_COOLDOWN_MS);
    return {
      ...base,
      shouldFallback: true,
      cooldownMs,
      expiresAt: isoOf(nowMs + cooldownMs),
      source: "manual-policy",
      newBackoffLevel: 0,
    };
  }

  // 3) Provider-specific precise resetsAtMs (codex/antigravity/github monthly).
  //    Only when no manual policy claimed the 429 above.
  const r = Number(resetsAtMs);
  if (Number.isFinite(r) && r > nowMs) {
    const isAntigravity = resolveProviderId(provider) === "antigravity";
    const cooldownMs = isAntigravity
      ? r - nowMs
      : Math.min(r - nowMs, SELF_AWARE_MAX_COOLDOWN_MS);
    return {
      ...base,
      shouldFallback: true,
      cooldownMs,
      expiresAt: isoOf(r),
      source: "provider-reset",
      newBackoffLevel: 0,
    };
  }

  // Caller falls back to existing checkFallbackError / modelLock path.
  return base;
}

/**
 * Load manual policy duration (ms) for provider+model, or null.
 * Fail-open: returns null on any DB error.
 */
export async function getSelfAwarePolicyMs(provider, model) {
  try {
    const r = await repo();
    let row = await r.getSelfAwarePolicy(provider, model);
    // Duplicates (codex-clone-…): inherit the base provider policy when no
    // clone-specific row exists. Blank-model fallback is already in the repo.
    if (!row && isProviderCloneId(provider)) {
      const base = resolveRuntimeProviderId(provider);
      if (base && base !== provider) {
        row = await r.getSelfAwarePolicy(base, model);
      }
    }
    if (!row) return null;
    if ((row.mode || "duration") === "daily") {
      const ms = msUntilDailyReset(row.resetHour, row.resetMinute);
      return ms != null && ms > 0 ? ms : null;
    }
    const ms = Number(row.timeoutMs);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  } catch (e) {
    log.warn("SELF_AWARE", `policy lookup failed ${provider}/${model}: ${e.message}`);
    return null;
  }
}

/**
 * List active cooldown rows (for the board + selection filters).
 * Fail-open: returns [] on DB error.
 */
export async function listActiveSelfAwareCooldowns(nowMs = Date.now()) {
  try {
    const r = await repo();
    return r.listActiveCooldowns(nowMs);
  } catch (e) {
    log.warn("SELF_AWARE", `list active failed: ${e.message}`);
    return [];
  }
}

/**
 * List active proxy-scoped cooldowns for OpenCode candidate filtering.
 * @returns {Promise<Map<string, { expiresAtMs: number, row: object }>>} scopeId → entry
 */
export async function getActiveProxyCooldownMap(provider, model, scopeIds, nowMs = Date.now()) {
  const out = new Map();
  if (!Array.isArray(scopeIds) || scopeIds.length === 0) return out;
  try {
    const r = await repo();
    const rows = await r.listCooldownsForScopes(provider, model, "proxy", scopeIds, nowMs);
    for (const row of rows) {
      const expiresAtMs = new Date(row.expiresAt).getTime();
      if (expiresAtMs <= nowMs) continue;
      const prev = out.get(row.scopeId);
      if (!prev || prev.expiresAtMs < expiresAtMs) {
        out.set(row.scopeId, { expiresAtMs, row });
      }
    }
  } catch (e) {
    log.warn("SELF_AWARE", `proxy cooldown map failed: ${e.message}`);
  }
  return out;
}

/**
 * Upsert a cooldown sidecar row. Fail-open — caller keeps legacy lock as authority.
 * @returns {Promise<object|null>} stored row or null
 */
export async function upsertSelfAwareCooldown(entry = {}) {
  try {
    const r = await repo();
    const expiresAtMs = Number(entry.expiresAtMs);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return null;
    const row = {
      id: entry.id || undefined,
      provider: entry.provider,
      model: entry.model || "",
      scopeType: entry.scopeType || "account",
      scopeId: entry.scopeId || "provider",
      startedAtMs: Number(entry.startedAtMs) || Date.now(),
      expiresAtMs,
      source: entry.source || "legacy-backoff",
      reason: sanitizeReason(entry.reason),
      status: entry.status ?? null,
      headerName: entry.headerName || null,
      data: entry.data || null,
    };
    return r.upsertCooldown(row);
  } catch (e) {
    log.warn("SELF_AWARE", `upsert failed ${entry.provider}/${entry.model}: ${e.message}`);
    return null;
  }
}

/** Delete one cooldown by id. */
export async function deleteSelfAwareCooldown(id) {
  try {
    const r = await repo();
    return r.deleteCooldown(id);
  } catch (e) {
    log.warn("SELF_AWARE", `delete failed ${id}: ${e.message}`);
    return false;
  }
}

/** Delete all currently active cooldowns (Reset All). Returns count. */
export async function resetAllSelfAwareCooldowns(nowMs = Date.now()) {
  try {
    const r = await repo();
    return r.deleteAllActive(nowMs);
  } catch (e) {
    log.warn("SELF_AWARE", `reset all failed: ${e.message}`);
    return 0;
  }
}

/** Clear matching account-scope sidecar when a request succeeds. */
export async function clearSelfAwareCooldown({ provider, model, scopeType = "account", scopeId }) {
  try {
    const r = await repo();
    return r.deleteByScope(provider, model, scopeType, scopeId);
  } catch (e) {
    log.warn("SELF_AWARE", `clear failed ${provider}/${model}: ${e.message}`);
    return false;
  }
}

/** Clear matching metadata on account activation (all modelLock_* cleared). */
export async function clearSelfAwareCooldownsForAccount(provider, scopeId) {
  try {
    const r = await repo();
    return r.deleteByScope(provider, null, "account", scopeId);
  } catch (e) {
    log.warn("SELF_AWARE", `clear account failed ${scopeId}: ${e.message}`);
    return false;
  }
}

/** Lazy-clean expired rows (called opportunistically). */
export async function purgeExpiredSelfAwareCooldowns(nowMs = Date.now()) {
  try {
    const r = await repo();
    return r.purgeExpired(nowMs);
  } catch {
    return 0;
  }
}

// ─── Board aggregation (old + new mechanisms) ──────────────────────

function decodeLockExpiry(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) && t > Date.now() ? t : null;
}

/**
 * Aggregate every currently active cooldown for the board:
 * - selfAwareCooldowns rows (all sources)
 * - providerConnections modelLock_* fields (legacy-backoff inference)
 * - Antigravity RAM cache via getAntigravityQuotaCache
 * Sidecar overlays only when provider/model/scope/expiry match within 1s.
 */
export async function listBoardCooldowns() {
  const now = Date.now();
  const rows = await listActiveSelfAwareCooldowns(now);
  const byKey = new Map();

  for (const row of rows) {
    const key = `${row.provider}|${row.model}|${row.scopeType}|${row.scopeId}`;
    byKey.set(key, {
      id: row.id,
      provider: row.provider,
      model: row.model,
      scopeType: row.scopeType,
      scopeId: row.scopeId,
      source: row.source,
      status: row.status ?? null,
      reason: row.reason || null,
      headerName: row.headerName || null,
      startedAt: row.startedAt,
      expiresAt: row.expiresAt,
      expiresAtMs: new Date(row.expiresAt).getTime(),
    });
  }

  // Legacy modelLock_* on connections
  try {
    const { getProviderConnections } = await import("@/lib/db/index.js");
    const connections = await getProviderConnections({});
    for (const c of connections) {
      for (const [k, val] of Object.entries(c)) {
        if (!k.startsWith("modelLock_") || !val) continue;
        const expiryMs = decodeLockExpiry(val);
        if (!expiryMs) continue;
        const model = k.slice("modelLock_".length);
        const modelKey = model === "__all" ? "" : model;
        const key = `${c.provider}|${modelKey}|account|${c.id}`;
        const existing = byKey.get(key);
        // Overlay sidecar only when expiry matches within 1s
        if (existing && Math.abs(existing.expiresAtMs - expiryMs) <= 1000) continue;
        byKey.set(key, {
          id: null,
          provider: c.provider,
          model: modelKey,
          scopeType: "account",
          scopeId: c.id,
          source: existing ? existing.source : "legacy-backoff",
          status: existing?.status ?? c.errorCode ?? null,
          reason: existing?.reason || sanitizeReason(c.lastError) || null,
          headerName: existing?.headerName || null,
          startedAt: existing?.startedAt || null,
          expiresAt: isoOf(expiryMs),
          expiresAtMs: expiryMs,
          connectionName: c.displayName || c.name || c.email || null,
        });
      }
    }
  } catch (e) {
    log.warn("SELF_AWARE", `board connections scan failed: ${e.message}`);
  }

  // Antigravity RAM quota/strike blocks (no modelLock_* on this path)
  try {
    const { getAntigravityQuotaCache } = await import("./antigravityQuota.js");
    const cache = getAntigravityQuotaCache();
    if (cache && typeof cache.forEach === "function") {
      cache.forEach((quotas, connectionId) => {
        if (!quotas) return;
        for (const [model, q] of Object.entries(quotas)) {
          const resetMs = q?.resetAt ? new Date(q.resetAt).getTime() : 0;
          if (!resetMs || resetMs <= now) continue;
          const key = `antigravity|${model}|account|${connectionId}`;
          if (byKey.has(key)) continue;
          byKey.set(key, {
            id: null,
            provider: "antigravity",
            model,
            scopeType: "account",
            scopeId: connectionId,
            source: "antigravity-quota",
            status: null,
            reason: "Antigravity quota exhausted",
            headerName: null,
            startedAt: null,
            expiresAt: isoOf(resetMs),
            expiresAtMs: resetMs,
          });
        }
      });
    }
  } catch {
    /* antigravity cache optional */
  }

  return [...byKey.values()].sort((a, b) => a.expiresAtMs - b.expiresAtMs);
}

export { buildModelLockUpdate, checkFallbackError };
