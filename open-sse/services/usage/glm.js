/**
 * GLM Coding Plan usage (international + China regions)
 * + ZCode Start Plan balance (zcode.z.ai JWT — native ZCode quota panel).
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import zcodeConfig from "../../../src/lib/zcode/config.js";
import { buildZcodeBalanceHeaders } from "../../../src/lib/zcode/headers.js";
import { U } from "./shared.js";

// GLM quota endpoints (region-aware) — url from registry transport.usage
const GLM_QUOTA_URLS = {
  international: U("glm").url,
  china: U("glm-cn").url,
};

/** Plan-level label for Start Plan buckets (native GUI: "Start"). */
const START_PLAN_LEVEL = "Start";

function getStartPlanJwt(providerSpecificData) {
  const psd = providerSpecificData;
  if (!psd || typeof psd !== "object") return "";
  const raw = psd.zcodeJwtToken || psd.accessToken || "";
  return typeof raw === "string" ? raw.trim() : "";
}

/** Native ZCode: active plan has status "active" and start-plan identity (or empty id/name). */
function isStartPlanIdentity(value) {
  if (!value) return false;
  const id = value.trim().toLowerCase();
  return id.includes("start-plan") || id.includes("start plan");
}

function hasActiveStartPlan(plans) {
  if (!Array.isArray(plans)) return false;
  return plans.some((plan) => {
    const status = plan?.status?.trim().toLowerCase();
    const planId = plan?.plan_id?.trim().toLowerCase();
    const name = plan?.name?.trim().toLowerCase();
    const identity = (!planId && !name) || isStartPlanIdentity(planId) || isStartPlanIdentity(name);
    return status === "active" && identity;
  });
}

function parseNumberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeCapabilities(capabilities) {
  if (!Array.isArray(capabilities)) return [];
  return capabilities
    .map((c) => {
      const s = typeof c === "string" ? c.trim() : "";
      return s.toLowerCase().startsWith("model:") ? s.slice(6).trim() : s;
    })
    .filter((s) => s.trim().length > 0);
}

/** Map billing/balance rows 1:1 with native normalizeZaiStartPlanBalanceLimits. */
function mapStartPlanBalances(balances, quotas = {}) {
  if (!Array.isArray(balances)) return quotas;

  for (const balance of balances) {
    const total = parseNumberOrNull(balance?.total_units);
    const used = parseNumberOrNull(balance?.used_units);
    const remaining = parseNumberOrNull(balance?.remaining_units);
    if (total === null && used === null && remaining === null) continue;

    const models = normalizeCapabilities(balance?.capabilities);
    const showName = typeof balance?.show_name === "string" ? balance.show_name.trim() : "";
    const name =
      showName ||
      models.join(", ") ||
      (typeof balance?.meter === "string" && balance.meter.trim()) ||
      "model_usage";
    const expiresSec = parseNumberOrNull(balance?.expires_at);
    const resetAt =
      expiresSec !== null && expiresSec > 0 ? new Date(expiresSec * 1000).toISOString() : null;
    const remainingPct =
      total !== null && remaining !== null && total > 0
        ? (remaining / total) * 100
        : undefined;

    // Prefix keeps Start buckets distinct from Coding Plan "Session (5h)" etc.
    let key = `${START_PLAN_LEVEL}: ${name}`;
    let suffix = 2;
    while (quotas[key]) {
      key = `${START_PLAN_LEVEL}: ${name} (${suffix++})`;
    }

    quotas[key] = {
      used: used ?? 0,
      total: total ?? 0,
      remaining: remaining ?? undefined,
      remainingPercentage: remainingPct,
      resetAt,
      unlimited: false,
    };
  }

  return quotas;
}

/**
 * Fetch Start Plan balance exactly like native ZCode NodeApiClient:
 * GET /billing/balance?app_version=... with GUI source headers + Bearer JWT.
 */
async function fetchStartPlanUsage(jwt, proxyOptions) {
  if (!jwt) return null;

  const balanceUrl = new URL(zcodeConfig.startPlanBalanceUrl);
  balanceUrl.searchParams.set("app_version", zcodeConfig.appVersion);

  try {
    const response = await proxyAwareFetch(
      balanceUrl.toString(),
      {
        method: "GET",
        headers: buildZcodeBalanceHeaders(jwt),
      },
      proxyOptions,
    );

    if (!response.ok) {
      if (response.status === 401) {
        return { message: "GLM Start Plan JWT invalid or expired." };
      }
      return { message: `GLM Start Plan quota API error (${response.status}).` };
    }

    let json;
    try {
      json = await response.json();
    } catch {
      return { message: "GLM Start Plan quota API returned invalid JSON." };
    }

    const code = json?.code;
    const envelopeOk =
      json?.success !== false &&
      (code === undefined || code === null || code === 0 || code === 200);
    if (!envelopeOk) {
      return { message: json?.msg || "GLM Start Plan unavailable." };
    }

    const data = json?.data && typeof json.data === "object" ? json.data : {};
    if (!hasActiveStartPlan(data.plans)) {
      return { message: "GLM Start Plan not active." };
    }

    const quotas = mapStartPlanBalances(data.balances, {});
    if (Object.keys(quotas).length === 0) {
      return { message: "GLM Start Plan active but no balance buckets returned." };
    }

    return { plan: START_PLAN_LEVEL, quotas };
  } catch (error) {
    return { message: `GLM Start Plan error: ${error.message}` };
  }
}

/**
 * GLM Coding Plan usage (international + China regions)
 * Supports both TOKENS_LIMIT and CREDIT_LIMIT and dynamic intervals (e.g. session 5h, weekly 7d).
 * When the connection has a ZCode JWT, also (or only) returns Start Plan balance
 * from the native ZCode billing endpoint — 1:1 with the desktop GUI.
 */
export async function getGlmUsage(apiKey, provider, proxyOptions = null, providerSpecificData = null) {
  const jwt = getStartPlanJwt(providerSpecificData);
  const startPlan = jwt ? await fetchStartPlanUsage(jwt, proxyOptions) : null;

  // Start Plan-only connection: no Coding Plan API key path.
  if (!apiKey) {
    if (startPlan?.quotas) return startPlan;
    if (startPlan?.message) return startPlan;
    return { message: "GLM API key not available." };
  }

  const region = provider === "glm-cn" ? "china" : "international";
  const quotaUrl = GLM_QUOTA_URLS[region];

  try {
    const response = await proxyAwareFetch(
      quotaUrl,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
      },
      proxyOptions,
    );

    if (!response.ok) {
      if (response.status === 401) {
        // JWT still works — surface Start Plan rather than bare 401.
        if (startPlan?.quotas) return startPlan;
        return { message: "GLM API key invalid or expired." };
      }
      if (startPlan?.quotas) return startPlan;
      return { message: `GLM quota API error (${response.status}).` };
    }

    const json = await response.json();
    const data = json?.data && typeof json.data === "object" ? json.data : {};
    const limits = Array.isArray(data.limits) ? data.limits : [];
    const quotas = startPlan?.quotas
      ? { ...startPlan.quotas }
      : {};

    for (const limit of limits) {
      // 1. Accept both TOKENS_LIMIT and CREDIT_LIMIT from GLM API
      if (!limit || (limit.type !== "TOKENS_LIMIT" && limit.type !== "CREDIT_LIMIT")) continue;
      const usedPercent = Number(limit.percentage) || 0;
      const resetMs = Number(limit.nextResetTime) || 0;
      const remaining = Math.max(0, 100 - usedPercent);

      // 2. Map key dynamically based on type and period (unit) to avoid overwriting
      let key = "session";
      if (limit.unit === 3) {
        key = `Session (${limit.number}h)`;
      } else if (limit.unit === 6) {
        key = "Weekly (7d)";
      } else if (limit.type === "TOKENS_LIMIT") {
        key = "Tokens";
      } else {
        key = `Limit (${limit.number})`;
      }

      quotas[key] = {
        used: usedPercent,
        total: 100,
        remaining,
        remainingPercentage: remaining,
        resetAt: resetMs > 0 ? new Date(resetMs).toISOString() : null,
        unlimited: false,
      };
    }

    const levelRaw = typeof data.level === "string" ? data.level : "";
    const plan =
      startPlan?.plan ||
      (levelRaw
        ? levelRaw.charAt(0).toUpperCase() + levelRaw.slice(1).toLowerCase()
        : "Unknown");

    // Prefer Start Plan label when both sources present.
    const planLabel = startPlan?.plan ? START_PLAN_LEVEL : plan;

    if (Object.keys(quotas).length === 0) {
      return { message: startPlan?.message || "GLM quota unavailable." };
    }

    return { plan: planLabel, quotas };
  } catch (error) {
    if (startPlan?.quotas) return startPlan;
    return { message: `GLM error: ${error.message}` };
  }
}
