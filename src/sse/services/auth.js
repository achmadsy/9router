import { getProviderConnections, validateApiKey, updateProviderConnection, getSettings, getProxyPools } from "@/lib/localDb";
import { resolveConnectionProxyConfig, pickProxyPoolId } from "@/lib/network/connectionProxy";
import { formatRetryAfter, checkFallbackError, isModelLockActive, buildModelLockUpdate, getEarliestModelLockUntil } from "open-sse/services/accountFallback.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "open-sse/config/errorConfig.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import { getAntigravityQuotaCache } from "./antigravityQuota.js";
import {
  resolveSelfAwareDecision, getSelfAwarePolicyMs, upsertSelfAwareCooldown,
  clearSelfAwareCooldown, clearSelfAwareCooldownsForAccount, getActiveProxyCooldownMap,
  purgeExpiredSelfAwareCooldowns, listActiveSelfAwareCooldowns,
} from "./selfAwareCooldown.js";
import * as log from "../utils/logger.js";

// Mutex to prevent race conditions during account selection
let selectionMutex = Promise.resolve();

const GITHUB_MONTHLY_USAGE_LIMIT = "you've reached your additional usage limit for your plan";

function githubMonthlyResetMs(status, errorText, provider) {
  if (resolveProviderId(provider) !== "github" || Number(status) !== 402) return null;
  if (!String(errorText || "").toLowerCase().includes(GITHUB_MONTHLY_USAGE_LIMIT)) return null;
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  // Normalize to Set for consistent handling
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  const preferredConnectionId = options?.preferredConnectionId || null;
  // Acquire mutex to prevent race conditions
  const currentMutex = selectionMutex;
  let resolveMutex;
  selectionMutex = new Promise(resolve => { resolveMutex = resolve; });

  try {
    await currentMutex;

    // Resolve alias to provider ID (e.g., "kc" -> "kilocode")
    const providerId = resolveProviderId(provider);

    // Inject a virtual connection for no-auth free providers (with optional proxy pool from settings)
    if (FREE_PROVIDERS[providerId]?.noAuth) {
      const settings = await getSettings();
      const override = (settings.providerStrategies || {})[providerId] || {};
      const strategy = override.rotateStrategy || "none";
      let pickedId = override.proxyPoolId || null;
      let poolIds = [];
      if (strategy !== "none") {
        const allPools = await getProxyPools({ isActive: true });
        poolIds = allPools.filter(p => p.proxyUrl).map(p => p.id);
      } else if (pickedId) {
        poolIds = [pickedId];
      }

      // Self-Aware OpenCode: exclude proxy identities with active cooldowns
      let blockedMap = new Map();
      if (providerId === "opencode") {
        const candidates = poolIds.length > 0 ? poolIds : (pickedId ? [pickedId] : ["direct"]);
        try {
          blockedMap = await getActiveProxyCooldownMap("opencode", model || "", candidates);
        } catch { /* fail-open: no filter */ }
        const eligible = candidates.filter((id) => !blockedMap.has(id));
        if (candidates.length > 0 && eligible.length === 0) {
          // All proxies blocked — report earliest expiry
          let earliest = null;
          for (const { expiresAtMs } of blockedMap.values()) {
            if (!earliest || expiresAtMs < earliest) earliest = expiresAtMs;
          }
          const earliestIso = earliest ? new Date(earliest).toISOString() : null;
          log.warn("AUTH", `opencode | all proxies on cooldown${earliestIso ? ` until ${earliestIso}` : ""}`);
          return {
            allRateLimited: true,
            retryAfter: earliestIso,
            retryAfterHuman: formatRetryAfter(earliestIso),
            lastError: "All proxy identities on cooldown",
            lastErrorCode: 429,
          };
        }
        if (eligible.length > 0) {
          poolIds = eligible;
          if (pickedId && !eligible.includes(pickedId)) pickedId = null;
          if (strategy === "single" && !pickedId) {
            pickedId = pickProxyPoolId(eligible, "random", providerId);
          } else if (strategy !== "none" && !pickedId) {
            pickedId = pickProxyPoolId(eligible, strategy, providerId);
          }
        } else if (!pickedId && strategy === "none") {
          pickedId = null; // direct — only when no pools configured
        }
      } else if (strategy !== "none") {
        pickedId = pickProxyPoolId(poolIds, strategy, providerId);
      }

      const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: pickedId || "" });
      const proxyScopeId = providerId === "opencode"
        ? (resolvedProxy.proxyPoolId || pickedId || "direct")
        : undefined;
      return {
        id: "noauth",
        connectionName: "Public",
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
          connectionProxyUrl: resolvedProxy.connectionProxyUrl,
          connectionNoProxy: resolvedProxy.connectionNoProxy,
          connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
          vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
          // Self-Aware: which proxy identity this attempt is bound to
          ...(proxyScopeId ? {
            cooldownTarget: {
              scopeType: "proxy",
              scopeId: proxyScopeId,
              proxyPoolId: resolvedProxy.proxyPoolId || pickedId || null,
            },
          } : {}),
        },
      };
    }

    const connections = await getProviderConnections({ provider: providerId, isActive: true });
    log.debug("AUTH", `${provider} | total connections: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`);

    if (connections.length === 0) {
      log.warn("AUTH", `No credentials for ${provider}`);
      return null;
    }

    // Antigravity quota cache is lazy: only populated after that account returns 409/429.
    const isAntigravity = providerId === "antigravity";
    const antigravityQuotaCache = isAntigravity && model ? getAntigravityQuotaCache() : null;

    // Filter out model-locked, excluded, and Antigravity quota-exhausted connections.
    const availableConnections = connections.filter(c => {
      if (excludeSet.has(c.id)) return false;
      if (isModelLockActive(c, model)) return false;
      // Antigravity: skip if live quota exhausted for this model
      if (isAntigravity && model && antigravityQuotaCache) {
        const quota = antigravityQuotaCache.get(c.id)?.[model];
        if (quota && quota.remainingPercentage <= 0 && quota.resetAt && new Date(quota.resetAt).getTime() > Date.now()) {
          const account = c.id?.slice(0, 8) || "unknown";
          log.info("AG_QUOTA", `${account} | CACHE_BLOCK ${model} — skip upstream until ${quota.resetAt}`);
          return false;
        }
      }
      return true;
    });

    log.debug("AUTH", `${provider} | available: ${availableConnections.length}/${connections.length}`);
    connections.forEach(c => {
      const excluded = excludeSet.has(c.id);
      const locked = isModelLockActive(c, model);
      if (excluded || locked) {
        const lockUntil = getEarliestModelLockUntil(c);
        log.debug("AUTH", `  → ${c.id?.slice(0, 8)} | ${excluded ? "excluded" : ""} ${locked ? `modelLocked(${model}) until ${lockUntil}` : ""}`);
      }
    });

    if (availableConnections.length === 0) {
      // Find earliest persistent lock or lazy Antigravity quota-cache reset for retry timing.
      const lockedConns = connections.filter(c => isModelLockActive(c, model));
      const expiries = lockedConns.map(c => getEarliestModelLockUntil(c)).filter(Boolean);
      if (isAntigravity && model && antigravityQuotaCache) {
        connections.forEach((c) => {
          const resetAt = antigravityQuotaCache.get(c.id)?.[model]?.resetAt;
          if (resetAt && new Date(resetAt).getTime() > Date.now()) expiries.push(resetAt);
        });
      }
      const earliest = expiries.sort()[0] || null;
      if (earliest) {
        const earliestConn = lockedConns[0];
        log.warn("AUTH", `${provider} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | lastError=${earliestConn?.lastError?.slice(0, 50)}`);
        return {
          allRateLimited: true,
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          lastError: earliestConn?.lastError || null,
          lastErrorCode: earliestConn?.errorCode || null
        };
      }
      log.warn("AUTH", `${provider} | all ${connections.length} accounts unavailable`);
      return null;
    }

    const settings = await getSettings();
    // Per-provider strategy overrides global setting
    const providerOverride = (settings.providerStrategies || {})[providerId] || {};
    const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first";

    let connection;
    // Pin to preferred connection if specified and available
    if (preferredConnectionId) {
      connection = availableConnections.find((c) => c.id === preferredConnectionId);
      if (connection) {
        log.info("AUTH", `${provider} | pinned to ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`);
      }
    }
    if (connection) {
      // skip strategy
    } else if (strategy === "round-robin") {
      const stickyLimit = providerOverride.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3;

      // Sort by lastUsed (most recent first) to find current candidate
      const byRecency = [...availableConnections].sort((a, b) => {
        if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
        if (!a.lastUsedAt) return 1;
        if (!b.lastUsedAt) return -1;
        return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
      });

      const current = byRecency[0];
      const currentCount = current?.consecutiveUseCount || 0;

      if (current && current.lastUsedAt && currentCount < stickyLimit) {
        // Stay with current account
        connection = current;
        // Update lastUsedAt and increment count (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: (connection.consecutiveUseCount || 0) + 1
        });
      } else {
        // Pick the least recently used (excluding current if possible)
        const sortedByOldest = [...availableConnections].sort((a, b) => {
          if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
          if (!a.lastUsedAt) return -1;
          if (!b.lastUsedAt) return 1;
          return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
        });

        connection = sortedByOldest[0];

        // Update lastUsedAt and reset count to 1 (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: 1
        });
      }
    } else {
      // Default: fill-first (already sorted by priority in getProviderConnections)
      connection = availableConnections[0];
    }

    const resolvedProxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});

    return {
      authType: connection.authType,
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      idToken: connection.idToken,
      expiresAt: connection.expiresAt,
      expiresIn: connection.expiresIn,
      lastRefreshAt: connection.lastRefreshAt,
      projectId: connection.projectId,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
        connectionProxyUrl: resolvedProxy.connectionProxyUrl,
        connectionNoProxy: resolvedProxy.connectionNoProxy,
        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
      },
      connectionId: connection.id,
      // Include current status for optimization check
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      // Pass full connection for clearAccountError to read modelLock_* keys
      _connection: connection
    };
  } finally {
    if (resolveMutex) resolveMutex();
  }
}

/**
 * Mark account+model as unavailable — locks modelLock_${model} in DB.
 * All errors (429, 401, 5xx, etc.) lock per model, not per account.
 *
 * Self-Aware precedence: valid upstream wait header → manual per-model policy →
 * existing resetsAtMs / checkFallbackError. modelLock_* stays authoritative for
 * routing; selfAwareCooldowns is a metadata sidecar for the board.
 *
 * Accepts legacy positional args or object:
 *   markAccountUnavailable({ credentials, status, errorText, provider, model, resetsAtMs, cooldownHint })
 * @returns {{ shouldFallback: boolean, cooldownMs: number }}
 */
export async function markAccountUnavailable(connectionIdOrOpts, status, errorText, provider = null, model = null, resetsAtMs = null) {
  let connectionId = connectionIdOrOpts;
  let opts = {};
  if (connectionIdOrOpts && typeof connectionIdOrOpts === "object") {
    opts = connectionIdOrOpts;
    // OpenCode noauth credentials expose id: "noauth" (no connectionId field).
    connectionId = opts.connectionId || opts.credentials?.connectionId || opts.credentials?.id;
    status = opts.status;
    errorText = opts.errorText;
    provider = opts.provider ?? opts.credentials?.provider ?? null;
    model = opts.model ?? null;
    resetsAtMs = opts.resetsAtMs ?? null;
  }
  const cooldownHint = opts.cooldownHint ?? null;

  // noauth free providers (OpenCode Free): proxy-scoped cooldowns only — no modelLock
  if (connectionId === "noauth") {
    return markProxyCooldown({ ...opts, status, errorText, provider, model, resetsAtMs, cooldownHint });
  }
  if (!connectionId) return { shouldFallback: false, cooldownMs: 0 };

  const connections = await getProviderConnections({ provider });
  const conn = connections.find(c => c.id === connectionId);
  const backoffLevel = conn?.backoffLevel || 0;
  const resolvedProvider = resolveProviderId(provider || conn?.provider || null);

  // GitHub premium-request exhaustion is account-wide until the next UTC month.
  const githubResetAtMs = githubMonthlyResetMs(status, errorText, resolvedProvider);

  // Self-Aware: prefer upstream wait header, then manual policy, then legacy
  let shouldFallback = false;
  let cooldownMs = 0;
  let newBackoffLevel = null;
  let source = null;
  let headerName = null;
  let sidecarExpiresMs = null;
  let selfAware = null;

  if (!githubResetAtMs) {
    const manualPolicyMs = status === 429
      ? await getSelfAwarePolicyMs(resolvedProvider, model || "")
      : null;
    selfAware = resolveSelfAwareDecision({
      provider: resolvedProvider,
      model,
      status,
      errorText,
      cooldownHint,
      resetsAtMs,
      manualPolicyMs,
      scope: { scopeType: "account", scopeId: connectionId },
    });
    if (selfAware.shouldFallback && selfAware.cooldownMs > 0) {
      shouldFallback = true;
      cooldownMs = selfAware.cooldownMs;
      newBackoffLevel = selfAware.newBackoffLevel ?? 0;
      source = selfAware.source;
      headerName = selfAware.headerName;
      sidecarExpiresMs = selfAware.expiresAt ? new Date(selfAware.expiresAt).getTime() : null;
    }
  }

  if (githubResetAtMs) {
    shouldFallback = true;
    cooldownMs = githubResetAtMs - Date.now();
    newBackoffLevel = 0;
    source = "provider-reset";
  } else if (!shouldFallback) {
    // Legacy path unchanged
    ({ shouldFallback, cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel));
    source = "legacy-backoff";
  }
  if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0 };

  const reason = typeof errorText === "string" ? errorText.slice(0, 100) : "Provider error";
  // Single expiry: generate once, reuse for modelLock_* and sidecar
  const finalExpiresAtMs = sidecarExpiresMs || (Date.now() + cooldownMs);
  const lockExpiryIso = new Date(finalExpiresAtMs).toISOString();
  const lockKeyBase = githubResetAtMs ? null : model;
  const lockUpdate = lockKeyBase
    ? { [`modelLock_${lockKeyBase}`]: lockExpiryIso }
    : buildModelLockUpdate(null, cooldownMs);
  // buildModelLockUpdate uses Date.now() again — align to lockExpiryIso for null model
  if (!lockKeyBase) {
    const k = Object.keys(lockUpdate)[0];
    lockUpdate[k] = lockExpiryIso;
  }

  await updateProviderConnection(connectionId, {
    ...lockUpdate,
    testStatus: "unavailable",
    lastError: reason,
    errorCode: status,
    lastErrorAt: new Date().toISOString(),
    backoffLevel: newBackoffLevel ?? backoffLevel
  });

  // Sidecar metadata (fail-open — lock remains authoritative if this fails)
  const expiresAtMs = sidecarExpiresMs || (Date.now() + cooldownMs);
  await upsertSelfAwareCooldown({
    provider: resolvedProvider,
    model: lockKeyBase || "",
    scopeType: "account",
    scopeId: connectionId,
    expiresAtMs,
    source: source || "legacy-backoff",
    reason,
    status: status ?? null,
    headerName,
  }).catch((e) => {
    log.warn("AUTH", `selfAware sidecar write failed (lock remains): ${e.message}`);
  });

  const lockKey = Object.keys(lockUpdate)[0];
  const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
  log.warn("AUTH", `${connName} locked ${lockKey} for ${Math.round(cooldownMs / 1000)}s [${status}] src=${source || "legacy-backoff"}`);

  if (provider && status && reason) {
    console.error(`❌ ${provider} [${status}]: ${reason}`);
  }

  return { shouldFallback: true, cooldownMs };
}

/**
 * OpenCode Free (and other noauth free providers): record proxy-scoped cooldown.
 * Never creates modelLock_* or fake connection rows.
 */
async function markProxyCooldown({ status, errorText, provider, model, resetsAtMs, cooldownHint, credentials }) {
  const resolvedProvider = resolveProviderId(provider || "opencode");
  if (status === 401 || (status >= 500 && status < 600)) {
    return { shouldFallback: false, cooldownMs: 0 };
  }
  const target = credentials?.providerSpecificData?.cooldownTarget
    || credentials?.cooldownTarget
    || null;
  const manualPolicyMs = status === 429
    ? await getSelfAwarePolicyMs(resolvedProvider, model || "")
    : null;
  const decision = resolveSelfAwareDecision({
    provider: resolvedProvider,
    model,
    status,
    errorText,
    cooldownHint,
    resetsAtMs,
    manualPolicyMs,
    scope: {
      scopeType: target?.scopeType || "proxy",
      scopeId: target?.scopeId || "direct",
    },
  });
  if (!decision.shouldFallback || decision.cooldownMs <= 0) {
    return { shouldFallback: false, cooldownMs: 0 };
  }
  await upsertSelfAwareCooldown({
    provider: resolvedProvider,
    model: model || "",
    scopeType: "proxy",
    scopeId: decision.scopeId || "direct",
    expiresAtMs: decision.expiresAt ? new Date(decision.expiresAt).getTime() : Date.now() + decision.cooldownMs,
    source: decision.source || "upstream-header",
    reason: decision.reason,
    status: status ?? null,
    headerName: decision.headerName,
  }).catch(() => {});
  return { shouldFallback: true, cooldownMs: decision.cooldownMs };
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Lazy-cleans any other expired modelLock_* keys
 * - Resets error state only if no active locks remain
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 */
export async function clearAccountError(connectionId, currentConnection, model = null) {
  if (!connectionId || connectionId === "noauth") return;
  const conn = currentConnection._connection || currentConnection;
  const now = Date.now();
  const allLockKeys = Object.keys(conn).filter(k => k.startsWith("modelLock_"));

  // Self-Aware: always clear matching account-scope sidecar on success (fail-open).
  // Happens before lock-state early return — sidecar may outlive in-memory lock fields.
  if (conn.provider && connectionId) {
    try {
      await clearSelfAwareCooldown({
        provider: resolveProviderId(conn.provider),
        model: model || "",
        scopeType: "account",
        scopeId: connectionId,
      });
      await purgeExpiredSelfAwareCooldowns();
    } catch { /* fail-open */ }
  }

  if (!conn.testStatus && !conn.lastError && allLockKeys.length === 0) return;

  // Keys to clear: current model's lock + all expired locks
  const keysToClear = allLockKeys.filter(k => {
    if (model && k === `modelLock_${model}`) return true; // succeeded model
    if (model && k === "modelLock___all") return true;    // account-level lock
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() <= now;   // expired
  });

  if (keysToClear.length === 0 && conn.testStatus !== "unavailable" && !conn.lastError) return;

  // Check if any active locks remain after clearing
  const remainingActiveLocks = allLockKeys.filter(k => {
    if (keysToClear.includes(k)) return false;
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() > now;
  });

  const clearObj = Object.fromEntries(keysToClear.map(k => [k, null]));

  // Only reset error state if no active locks remain
  if (remainingActiveLocks.length === 0) {
    Object.assign(clearObj, {
      testStatus: "active",
      lastError: null,
      errorCode: null,
      lastErrorAt: null,
      backoffLevel: 0
    });
  }

  await updateProviderConnection(connectionId, clearObj);
}

/**
 * Extract API key from request headers
 */
export function extractApiKey(request) {
  // Check Authorization header first
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check Anthropic x-api-key header
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) {
    return xApiKey;
  }

  // Gemini native API key header
  const googleApiKey = request.headers.get("x-goog-api-key");
  if (googleApiKey) {
    return googleApiKey;
  }

  return null;
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey) {
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}
