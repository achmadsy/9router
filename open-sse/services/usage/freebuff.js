import { proxyAwareFetch } from "../../utils/proxyFetch.js";

/**
 * Freebuff / Codebuff usage.
 *
 * Wire (from CodebuffAI/freebuff CLI `use-usage-query.ts` + `codebuff-api.ts`):
 *   POST {baseUrl}/api/v1/usage
 *     headers: Authorization: Bearer <token>
 *     body:   { fingerprintId: "cli-usage", authToken: <token> }
 *   → {
 *       type: "usage-response",
 *       usage: number,                 // sessions/quota units used
 *       remainingBalance: number|null, // Freebucks-style remaining
 *       balanceBreakdown?: { free, paid, ad?, referral?, admin? },
 *       next_quota_reset: string|null  // ISO instant
 *     }
 *
 * Session admission also carries richer rateLimitsByModel / freebucks, but the
 * usage endpoint is the lightweight path the CLI polls for the banner.
 */

// www. host directly — apex codebuff.com 307-redirects and fetch drops the
// body/auth on cross-host redirects.
const USAGE_URL = "https://www.codebuff.com/api/v1/usage";

export async function getFreebuffUsage(
  accessToken,
  apiKey,
  proxyOptions = null,
  fetchFn = proxyAwareFetch,
) {
  const token = accessToken || apiKey;
  if (!token) {
    return { message: "Freebuff usage requires an OAuth token" };
  }

  // Upstream sends NO Authorization header here — token travels in body only.
  const response = await fetchFn(
    USAGE_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fingerprintId: "cli-usage",
        authToken: token,
      }),
    },
    proxyOptions,
  );

  const text = await response.text().catch(() => "");
  if (!response.ok) {
    return {
      message: `Freebuff usage failed: HTTP ${response.status}`,
      detail: text?.slice(0, 200) || undefined,
    };
  }

  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    return { message: "Freebuff usage returned non-JSON body" };
  }

  const usedRaw = Number(data.usage);
  const used = Number.isFinite(usedRaw) ? Math.max(0, usedRaw) : 0;
  const remainingRaw = Number(data.remainingBalance);
  const hasRemaining =
    data.remainingBalance !== null &&
    data.remainingBalance !== undefined &&
    Number.isFinite(remainingRaw);
  const remaining = hasRemaining ? Math.max(0, remainingRaw) : 0;
  const resetAt = data.next_quota_reset || null;
  const total = hasRemaining ? used + remaining : used;

  // Standard 9router quota shape. Never expose absolute `remaining` because the
  // ProviderLimits UI interprets that field as a percentage.
  const quotas = {
    balance: {
      used,
      total,
      remainingPercentage:
        total > 0 ? (remaining / total) * 100 : hasRemaining ? 100 : 0,
      resetAt,
      unlimited: !hasRemaining,
    },
  };

  if (data.balanceBreakdown && typeof data.balanceBreakdown === "object") {
    for (const [name, value] of Object.entries(data.balanceBreakdown)) {
      const amount = Number(value);
      if (!Number.isFinite(amount)) continue;
      quotas[`balance_${name}`] = {
        used: 0,
        total: Math.max(0, amount),
        remainingPercentage: amount > 0 ? 100 : 0,
        resetAt,
        unlimited: false,
      };
    }
  }

  return {
    quotas,
    raw: data,
  };
}
