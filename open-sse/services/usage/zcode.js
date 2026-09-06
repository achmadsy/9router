/**
 * ZCode Coding Plan usage fetching via zcode.z.ai endpoints
 * Model-level quota reporting aligned with Antigravity
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";

const ZCODE_CURRENT_BILLING_URL = "https://zcode.z.ai/api/v1/zcode-plan/billing/current";
const ZCODE_BALANCE_URL = "https://zcode.z.ai/api/v1/zcode-plan/billing/balance";
const ZCODE_CLIENT_CONFIGS_URL = "https://zcode.z.ai/api/v1/client/configs?app_version=3.0.1";

// Cache client configs for 1 hour
let cachedConfigs = null;
let cachedConfigsExpiry = 0;

async function fetchZcodeConfigs(proxyOptions = null) {
  const now = Date.now();
  if (cachedConfigs && cachedConfigsExpiry > now) {
    return cachedConfigs;
  }

  try {
    const res = await proxyAwareFetch(ZCODE_CLIENT_CONFIGS_URL, {
      headers: {
        Accept: "application/json",
      },
    }, proxyOptions);

    if (res.ok) {
      const json = await res.json();
      cachedConfigs = json?.data?.configs || {};
      cachedConfigsExpiry = now + 3600000;
      return cachedConfigs;
    }
  } catch {
    // ignore
  }

  return cachedConfigs || {};
}

function calculateNextDailyResetTime() {
  const reset = new Date();
  reset.setUTCHours(16, 0, 0, 0); // Midnight UTC+8 (China Standard Time)
  if (reset.getTime() <= Date.now()) {
    reset.setUTCDate(reset.getUTCDate() + 1);
  }
  return reset.toISOString();
}

export async function getZcodeUsage(jwtToken, proxyOptions = null) {
  if (!jwtToken) {
    return { message: "ZCode JWT token not available." };
  }

  const headers = {
    Authorization: `Bearer ${jwtToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  try {
    const [billingRes, balanceRes, configs] = await Promise.all([
      proxyAwareFetch(ZCODE_CURRENT_BILLING_URL, { headers }, proxyOptions).catch(() => null),
      proxyAwareFetch(ZCODE_BALANCE_URL, { headers }, proxyOptions).catch(() => null),
      fetchZcodeConfigs(proxyOptions),
    ]);

    if (billingRes && !billingRes.ok && balanceRes && !balanceRes.ok) {
      if (billingRes.status === 401 || balanceRes.status === 401) {
        return { message: "ZCode token expired or unauthorized. Please re-login." };
      }
    }

    const billingJson = billingRes && billingRes.ok ? await billingRes.json().catch(() => ({})) : {};
    const balanceJson = balanceRes && balanceRes.ok ? await balanceRes.json().catch(() => ({})) : {};

    const quotas = {};
    const balances = balanceJson?.data?.balances || balanceJson?.data?.planBalances || [];
    const plans = billingJson?.data?.plans || [];

    const defaultResetAt = calculateNextDailyResetTime();

    // 1. Process paid plan balances if returned by upstream
    if (Array.isArray(balances) && balances.length > 0) {
      for (const b of balances) {
        const modelRaw = b.model || b.name || b.show_name || "";
        const modelKey = modelRaw.toLowerCase().replace(/\s+/g, "-");
        const displayName = b.show_name || b.name || modelRaw;

        const total = Number(b.total) || Number(b.limit) || 0;
        const used = Number(b.used) || 0;
        const remaining = Number(b.remaining) ?? Math.max(0, total - used);
        const remainingPercentage = total > 0 ? Math.round((remaining / total) * 100) : 100;
        const resetAt = b.reset_time || b.resetAt || defaultResetAt;

        quotas[modelKey] = {
          used,
          total,
          resetAt: resetAt ? new Date(resetAt).toISOString() : null,
          remainingPercentage,
          unlimited: false,
          displayName,
        };
      }
    }

    // 2. Fall back to Start Plan entitlements if no paid balance records
    if (Object.keys(quotas).length === 0) {
      const entitlements = configs?.startPlanPreview?.entitlements || [
        { showName: "GLM-5.3", grantUnits: 3000000, period: "daily" },
        { showName: "GLM-5.3-Flash", grantUnits: 5000000, period: "daily" },
        { showName: "GLM-5-Turbo", grantUnits: 2000000, period: "daily" },
      ];

      for (const ent of entitlements) {
        const showName = ent.showName || "GLM Model";
        const modelKey = showName.toLowerCase().replace(/\s+/g, "-");
        const total = Number(ent.grantUnits) || 3000000;

        quotas[modelKey] = {
          used: 0,
          total,
          resetAt: defaultResetAt,
          remainingPercentage: 100,
          unlimited: false,
          displayName: showName,
        };
      }
    }

    const planName =
      plans[0]?.plan_name ||
      billingJson?.data?.plan_name ||
      billingJson?.data?.name ||
      configs?.startPlanPreview?.name ||
      "Start Plan";

    return {
      plan: planName,
      quotas,
    };
  } catch (err) {
    return { message: `ZCode usage error: ${err.message}` };
  }
}

export default getZcodeUsage;
