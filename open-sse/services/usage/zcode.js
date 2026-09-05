/**
 * ZCode Coding Plan usage fetching via zcode.z.ai endpoints
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";

const ZCODE_CURRENT_BILLING_URL = "https://zcode.z.ai/api/v1/zcode-plan/billing/current";
const ZCODE_BALANCE_URL = "https://zcode.z.ai/api/v1/zcode-plan/billing/balance";

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
    const [billingRes, balanceRes] = await Promise.all([
      proxyAwareFetch(ZCODE_CURRENT_BILLING_URL, { headers }, proxyOptions),
      proxyAwareFetch(ZCODE_BALANCE_URL, { headers }, proxyOptions),
    ]);

    if (!billingRes.ok && !balanceRes.ok) {
      if (billingRes.status === 401 || balanceRes.status === 401) {
        return { message: "ZCode token expired or unauthorized. Please re-login." };
      }
      return { message: `ZCode usage error: ${billingRes.status}` };
    }

    const billingJson = billingRes.ok ? await billingRes.json().catch(() => ({})) : {};
    const balanceJson = balanceRes.ok ? await balanceRes.json().catch(() => ({})) : {};

    const quotas = {};
    const balances = balanceJson?.data?.balances || balanceJson?.data?.planBalances || [];

    if (Array.isArray(balances)) {
      for (const b of balances) {
        const name = b.show_name || b.name || b.model || "Coding Plan";
        const total = Number(b.total) || Number(b.limit) || 0;
        const used = Number(b.used) || 0;
        const remaining = Number(b.remaining) ?? Math.max(0, total - used);
        const remainingPercentage = total > 0 ? Math.round((remaining / total) * 100) : 100;
        const resetAt = b.reset_time || b.resetAt || null;

        quotas[name] = {
          used,
          total,
          remaining,
          remainingPercentage,
          resetAt: resetAt ? new Date(resetAt).toISOString() : null,
          unit: b.unit || "tokens",
        };
      }
    }

    const planName = billingJson?.data?.plan_name || billingJson?.data?.name || "ZCode Coding Plan";

    return {
      plan: planName,
      quotas: Object.keys(quotas).length > 0 ? quotas : {
        "Coding Plan": {
          used: 0,
          total: 100,
          remaining: 100,
          remainingPercentage: 100,
          resetAt: null,
          unlimited: true,
        },
      },
    };
  } catch (err) {
    return { message: `ZCode usage error: ${err.message}` };
  }
}

export default getZcodeUsage;
