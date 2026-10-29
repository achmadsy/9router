import zcodeConfig from "./config.js";
import { buildZcodeBillingHeaders } from "./headers.js";
import { proxyAwareFetch } from "../../../open-sse/utils/proxyFetch.js";

function safeReason(value, fallback = "Plan request failed") {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value
    .trim()
    .slice(0, 300)
    .replace(/bearer\s+[^\s"',;\]}>]+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]")
    .replace(
      /(["']?\b(?:access_token|refresh_token|id_token|jwt|authorization|cookie|secret|token)["']?\s*[:=]\s*["']?)([^"',\s;}>]{6,})([\"']?)/gi,
      "$1[REDACTED]$3"
    )
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[REDACTED]");
}

function billingUrl(baseUrl, { includePlatform = false } = {}) {
  const url = new URL(baseUrl);
  url.searchParams.set("app_version", zcodeConfig.appVersion);
  if (includePlatform) url.searchParams.set("platform", `${process.platform}-${process.arch}`);
  return url;
}

async function requestBilling(
  jwt,
  url,
  options = {},
  proxyOptions = null,
  fetchImpl = proxyAwareFetch
) {
  let response;
  try {
    response = await fetchImpl(
      url.toString(),
      {
        ...options,
        headers: {
          ...buildZcodeBillingHeaders(jwt, url.toString()),
          ...options.headers,
        },
        signal: options.signal || AbortSignal.timeout(15_000),
      },
      proxyOptions
    );
  } catch (error) {
    throw new Error(safeReason(error?.message, "Plan network request failed"));
  }

  const text = await response.text().catch(() => "");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  const code = json?.code;
  const envelopeOk =
    json?.success !== false &&
    (code === undefined || code === null || code === 0 || code === 200);
  if (!response.ok || !json || !envelopeOk) {
    throw new Error(
      safeReason(
        json?.data?.message || json?.msg,
        !json ? `Invalid provider response (${response.status})` : `Provider rejected request (${response.status})`
      )
    );
  }

  return json;
}

function normalizePlan(plan) {
  const planId = typeof plan?.plan_id === "string" ? plan.plan_id.trim() : "";
  if (!planId) return null;
  return {
    planId,
    name: typeof plan.name === "string" && plan.name.trim() ? plan.name.trim() : planId,
    description: typeof plan.description === "string" ? plan.description.trim() : "",
    status: typeof plan.status === "string" ? plan.status.trim().toLowerCase() : "",
    startsAt: Number.isFinite(plan.starts_at) ? plan.starts_at : null,
    endsAt: Number.isFinite(plan.ends_at) ? plan.ends_at : null,
  };
}

function normalizeOffer(plan, activePlanIds) {
  const normalized = normalizePlan(plan);
  if (!normalized) return null;
  return {
    ...normalized,
    claimable: !activePlanIds.has(normalized.planId),
    entitlements: Array.isArray(plan.entitlements)
      ? plan.entitlements.flatMap((entry) => {
          if (!entry || typeof entry !== "object") return [];
          return [{
            showName: typeof entry.show_name === "string" ? entry.show_name : "",
            grantUnits: Number.isFinite(entry.grant_units) ? entry.grant_units : null,
            unitType: typeof entry.unit_type === "string" ? entry.unit_type : "",
            period: typeof entry.period === "string" ? entry.period : "",
          }];
        })
      : [],
  };
}

function normalizeBalance(balance) {
  if (!balance || typeof balance !== "object") return null;
  return {
    name: balance.show_name || balance.meter || "Usage",
    total: Number.isFinite(Number(balance.total_units)) ? Number(balance.total_units) : null,
    used: Number.isFinite(Number(balance.used_units)) ? Number(balance.used_units) : null,
    remaining: Number.isFinite(Number(balance.remaining_units)) ? Number(balance.remaining_units) : null,
    expiresAt: Number.isFinite(Number(balance.expires_at)) ? Number(balance.expires_at) : null,
  };
}

export async function inspectZaiPlans(jwt, proxyOptions = null, fetchImpl = proxyAwareFetch) {
  const token = typeof jwt === "string" ? jwt.trim() : "";
  if (!token) throw new Error("ZCode OAuth login is required");

  const [balance, preview] = await Promise.all([
    requestBilling(
      token,
      billingUrl(zcodeConfig.startPlanBalanceUrl),
      { method: "GET" },
      proxyOptions,
      fetchImpl
    ),
    requestBilling(
      token,
      billingUrl(zcodeConfig.startPlanPreviewUrl, { includePlatform: true }),
      { method: "GET" },
      proxyOptions,
      fetchImpl
    ),
  ]);

  const activePlans = (Array.isArray(balance.data?.plans) ? balance.data.plans : [])
    .map(normalizePlan)
    .filter(Boolean);
  const activePlanIds = new Set(
    activePlans.filter((plan) => plan.status === "active").map((plan) => plan.planId)
  );
  const offers = (Array.isArray(preview.data?.plans) ? preview.data.plans : [])
    .map((plan) => normalizeOffer(plan, activePlanIds))
    .filter(Boolean);
  const balances = (Array.isArray(balance.data?.balances) ? balance.data.balances : [])
    .map(normalizeBalance)
    .filter(Boolean);

  return { activePlans, offers, balances };
}

export async function claimZaiPlan(
  jwt,
  planId,
  proxyOptions = null,
  fetchImpl = proxyAwareFetch
) {
  const token = typeof jwt === "string" ? jwt.trim() : "";
  const requestedPlanId = typeof planId === "string" ? planId.trim() : "";
  if (!token) throw new Error("ZCode OAuth login is required");
  if (!requestedPlanId) throw new Error("planId is required");

  const before = await inspectZaiPlans(token, proxyOptions, fetchImpl);
  if (before.activePlans.some((plan) => plan.planId === requestedPlanId && plan.status === "active")) {
    return { status: "already_active", planId: requestedPlanId, plans: before };
  }
  if (!before.offers.some((offer) => offer.planId === requestedPlanId && offer.claimable)) {
    throw new Error("This plan is not currently offered to the account");
  }

  const claim = await requestBilling(
    token,
    new URL(zcodeConfig.startPlanClaimUrl),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ZCode-App-Version": zcodeConfig.appVersion,
        "X-Platform": `${process.platform}-${process.arch}`,
      },
      body: JSON.stringify({ plan_id: requestedPlanId }),
    },
    proxyOptions,
    fetchImpl
  );

  const claimedPlan = normalizePlan(claim.data?.plan);
  if (!claimedPlan || claimedPlan.planId !== requestedPlanId || claimedPlan.status !== "active") {
    throw new Error(
      safeReason(
        claim.data?.message || claim.msg,
        "Z.AI did not return an active plan after the claim"
      )
    );
  }

  const after = await inspectZaiPlans(token, proxyOptions, fetchImpl).catch(() => null);
  return {
    status: after?.activePlans?.some(
      (plan) => plan.planId === requestedPlanId && plan.status === "active"
    ) ? "claimed" : "claimed_pending",
    planId: requestedPlanId,
    plan: claimedPlan,
    plans: after,
  };
}

export function summarizePlanError(error, fallback = "Plan operation failed") {
  return safeReason(error?.message, fallback);
}
