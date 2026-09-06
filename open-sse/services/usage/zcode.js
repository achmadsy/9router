/**
 * ZCode Coding Plan usage fetching via zcode.z.ai endpoints
 * Model-level quota reporting aligned with Antigravity, including package/campaign quotas (e.g. Weekend Build)
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
    const res = await proxyAwareFetch(
      ZCODE_CLIENT_CONFIGS_URL,
      {
        headers: {
          Accept: "application/json",
        },
      },
      proxyOptions
    );

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

/**
 * Check if current time falls into ZCode Weekend Build promotion window:
 * From Friday 18:00 CST (10:00 UTC) until Monday 08:00 CST (00:00 UTC).
 * Returns { isWeekend: true, expiresAt: ISOString } or null.
 */
function getWeekendBuildWindow(now = new Date()) {
  const cstMs = now.getTime() + 8 * 60 * 60 * 1000;
  const cstDate = new Date(cstMs);

  const day = cstDate.getUTCDay(); // 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat
  const hour = cstDate.getUTCHours();

  const isWeekend =
    (day === 5 && hour >= 18) ||
    day === 6 ||
    day === 0 ||
    (day === 1 && hour < 8);

  if (!isWeekend) return null;

  const daysUntilMonday = day === 1 ? 0 : (8 - day) % 7;
  const mondayCst = new Date(cstDate);
  mondayCst.setUTCDate(mondayCst.getUTCDate() + daysUntilMonday);
  mondayCst.setUTCHours(8, 0, 0, 0);

  const expiresUtc = new Date(mondayCst.getTime() - 8 * 60 * 60 * 1000);

  return {
    isWeekend: true,
    expiresAt: expiresUtc.toISOString(),
  };
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
    const balances = [
      ...(Array.isArray(balanceJson?.data?.balances) ? balanceJson.data.balances : []),
      ...(Array.isArray(balanceJson?.data?.planBalances) ? balanceJson.data.planBalances : []),
      ...(Array.isArray(balanceJson?.data?.packages) ? balanceJson.data.packages : []),
      ...(Array.isArray(balanceJson?.data?.packageBalances) ? balanceJson.data.packageBalances : []),
      ...(Array.isArray(billingJson?.data?.packages) ? billingJson.data.packages : []),
    ];
    const plans = billingJson?.data?.plans || [];

    const defaultResetAt = calculateNextDailyResetTime();
    const weekendWindow = getWeekendBuildWindow();

    // 1. Process paid plan / package balances if returned by upstream
    if (balances.length > 0) {
      for (const b of balances) {
        const modelRaw = b.model || b.name || b.show_name || "";
        const baseKey = modelRaw.toLowerCase().replace(/\s+/g, "-");
        const packageName = b.package_name || b.packageName || b.campaign_name || b.title;

        let key = baseKey;
        let displayName = b.show_name || b.name || modelRaw;

        if (packageName && !displayName.toLowerCase().includes(packageName.toLowerCase())) {
          displayName = `${displayName} (${packageName})`;
          key = `${baseKey}-${packageName.toLowerCase().replace(/\s+/g, "-")}`;
        } else if (quotas[key]) {
          key = `${key}-pkg`;
        }

        const total = Number(b.total) || Number(b.limit) || 0;
        const used = Number(b.used) || 0;
        const remaining = Number(b.remaining) ?? Math.max(0, total - used);
        const remainingPercentage = total > 0 ? Math.round((remaining / total) * 100) : 100;
        const resetAt = b.reset_time || b.resetAt || (packageName?.includes("Weekend") && weekendWindow ? weekendWindow.expiresAt : defaultResetAt);

        quotas[key] = {
          used,
          total,
          resetAt: resetAt ? new Date(resetAt).toISOString() : null,
          remainingPercentage,
          unlimited: false,
          displayName,
          modelKey: baseKey,
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
          modelKey,
        };
      }
    }

    // 3. If in Weekend Build window, ensure Weekend Build quota is included
    if (weekendWindow) {
      const weekendKey = "glm-5.3-flash-weekend";
      if (!quotas[weekendKey]) {
        quotas[weekendKey] = {
          used: 0,
          total: 300000000,
          resetAt: weekendWindow.expiresAt,
          remainingPercentage: 100,
          unlimited: false,
          displayName: "GLM 5.3 Flash (Weekend Build)",
          modelKey: "glm-5.3-flash",
          packageName: "ZCode Weekend Build",
        };
      }
    }

    let planName =
      plans[0]?.plan_name ||
      billingJson?.data?.plan_name ||
      billingJson?.data?.name ||
      configs?.startPlanPreview?.name ||
      "Start Plan";

    if (weekendWindow) {
      planName = `${planName} · Weekend Build`;
    }

    return {
      plan: planName,
      quotas,
    };
  } catch (err) {
    return { message: `ZCode usage error: ${err.message}` };
  }
}

export default getZcodeUsage;
