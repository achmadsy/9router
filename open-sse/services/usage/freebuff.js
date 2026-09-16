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
// Read-only session status poll — carries the daily quota as rateLimitsByModel.
const SESSION_URL = "https://www.codebuff.com/api/v1/freebuff/session";

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

  // GET the session status poll instead of POSTing the usage endpoint: the
  // session GET is read-only (returns shared per-model quota as
  // rateLimitsByModel without claiming anything), while POST /api/v1/usage is
  // the CLI's banner poll and POSTing /api/v1/freebuff/session would CLAIM a
  // session and burn 1.0 daily quota unit — a quota tracker must never do that.
  // Revert to the POST usage query if the session GET ever stops exposing
  // rateLimitsByModel:
  //   const response = await fetchFn(
  //     USAGE_URL,
  //     {
  //       method: "POST",
  //       headers: { "Content-Type": "application/json" },
  //       body: JSON.stringify({ fingerprintId: "cli-usage", authToken: token }),
  //     },
  //     proxyOptions,
  //   );
  const response = await fetchFn(
    SESSION_URL,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
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

  // 404 = no session row at all → pre-join state, no quota to report.
  if (response.status === 404) {
    return { plan: "Freebuff", message: "Freebuff connected. No session quota to report right now." };
  }
  // A 403 from the session endpoint is usually a server-side gate status
  // (country_blocked / banned), not a credential problem — telling the user
  // to re-login would be misleading.
  if (response.status === 403) {
    if (data?.status === "country_blocked") {
      return { message: "Freebuff is not available in your region." };
    }
    if (data?.status === "banned") {
      return { message: "Your Freebuff account has been banned." };
    }
    return {
      message: `Freebuff quota access denied (403)${data?.message ? `: ${data.message}` : ""}.`,
    };
  }

  // Session-GET shape: { status, rateLimitsByModel: { model: { limit,
  // recentCount, resetAt, period } }, accessTier?, rateLimit?, model? }.
  // recentCount is fractional (a long agent run can consume 1.3 units) and
  // includes the active session's own 1.0-unit reservation.
  const rateLimits = { ...(data.rateLimitsByModel || {}) };
  // An active session carries its own `rateLimit` row — fold it in when the
  // shared map omits the model (older servers).
  if (data.status === "active" && data.rateLimit && !rateLimits[data.model]) {
    rateLimits[data.model] = data.rateLimit;
  }

  if (Object.keys(rateLimits).length > 0) {
    const quotas = {};
    for (const [modelId, rl] of Object.entries(rateLimits)) {
      if (!rl || typeof rl !== "object") continue;
      const used = Number(rl.recentCount);
      const total = Number(rl.limit);
      quotas[modelId] = {
        used: Number.isFinite(used) ? used : 0,
        total: Number.isFinite(total) ? total : 0,
        resetAt: rl.resetAt || null,
        // Daily/weekly Pacific session allowance replenishes at resetAt —
        // the UI must say "Resets in", not "Expires in".
        recurring: true,
        unlimited: false,
      };
    }
    const plan = data.accessTier === "limited" ? "Freebuff (Limited)" : "Freebuff";
    return { plan, quotas, raw: data };
  }

  // Fallback: legacy POST /api/v1/usage balance shape (kept so a revert to
  // the POST query still parses — see the commented fetch above).
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
