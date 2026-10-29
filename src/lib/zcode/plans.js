import zcodeConfig from "./config.js";
import { buildZcodeBillingHeaders } from "./headers.js";
import { proxyAwareFetch } from "../../../open-sse/utils/proxyFetch.js";
import { getCaptchaManager, getZcodeCaptchaPort } from "./captcha-service.js";

// Mirrors GlmExecutor's lazy captcha loop: claim first without the Aliyun
// headers; when Z.AI demands the security verification, mint a verify param
// through the shared CloakBrowser manager and retry.
const MAX_CLAIM_CAPTCHA_RETRIES = 2;

function isCaptchaRejection(code, message) {
  const text = String(message || "").toLowerCase();
  return (
    code === 3007 ||
    text.includes("captcha") ||
    text.includes("security_verification")
  );
}

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

// Z.AI serves the Start Plan as rotating dated campaign variants
// ("zcode-v3-start-plan-1029"), not the static id. Match the campaign family
// like the official client's hasActiveStartPlan does — never one exact id.
function isStartPlanIdentity(plan) {
  const id = (plan?.planId || plan?.plan_id || "").toLowerCase();
  const name = (plan?.name || "").toLowerCase();
  return (
    id.startsWith("zcode-v3-start-plan") ||
    /start[-_ ]?plan/.test(id) ||
    /start[-_ ]?plan/.test(name)
  );
}

function friendlyBillingError(code, message) {
  const text = typeof message === "string" ? message.toLowerCase() : "";
  if (
    text.includes("captcha") ||
    text.includes("security_verification") ||
    code === 3007
  ) {
    return "Z.AI requires captcha verification for this claim — claim once from the official ZCode app, then refresh here";
  }
  if (code === 3001) {
    return "ZCode session expired — re-authenticate this account and retry";
  }
  return typeof message === "string" && message.trim() ? message : null;
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
    const rawMessage = json?.data?.message || json?.msg;
    const error = new Error(
      safeReason(
        friendlyBillingError(code, rawMessage) ||
          (!json ? `Invalid provider response (${response.status})` : `Provider rejected request (${response.status})`),
        "Plan request failed"
      )
    );
    error.code = code;
    error.captchaRequired = isCaptchaRejection(code, rawMessage);
    throw error;
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

export function hasActiveStartPlan(inspection) {
  return (inspection?.activePlans || []).some(
    (plan) => plan.status === "active" && isStartPlanIdentity(plan)
  );
}

// Newest campaign variant wins: dated suffixes ("…-1029") sort above the
// generic id, so a fresh campaign is claimed rather than a stale one.
export function selectClaimableStartPlan(inspection) {
  const claimable = (inspection?.offers || [])
    .filter((offer) => offer.claimable && isStartPlanIdentity(offer))
    .sort((a, b) => b.planId.localeCompare(a.planId));
  return claimable[0] || null;
}

export async function claimZaiPlan(
  jwt,
  planId,
  proxyOptions = null,
  fetchImpl = proxyAwareFetch,
  captchaProxyUrl = "",
  { activationRetries = 0, activationDelayMs = 5000 } = {}
) {
  const token = typeof jwt === "string" ? jwt.trim() : "";
  const requestedPlanId = typeof planId === "string" ? planId.trim() : "";
  if (!token) throw new Error("ZCode OAuth login is required");

  // Empty or generic id → auto-select the Start Plan campaign the account is
  // actually offered (dated variants like zcode-v3-start-plan-1029).
  const autoSelect = !requestedPlanId || requestedPlanId === zcodeConfig.startPlanId;

  let before = await inspectZaiPlans(token, proxyOptions, fetchImpl);
  if (autoSelect) {
    if (hasActiveStartPlan(before)) {
      const active = before.activePlans.find(
        (plan) => plan.status === "active" && isStartPlanIdentity(plan)
      );
      return { status: "already_active", planId: active.planId, plans: before };
    }
  } else if (before.activePlans.some((plan) => plan.planId === requestedPlanId && plan.status === "active")) {
    return { status: "already_active", planId: requestedPlanId, plans: before };
  }

  // Z.AI activates the trial asynchronously after login (observed ~3h lag),
  // so the offer may not be visible yet — re-inspect before giving up.
  const target = autoSelect
    ? selectClaimableStartPlan(before)
    : before.offers.find((offer) => offer.planId === requestedPlanId && offer.claimable) || null;
  if (!target) {
    for (let attempt = 0; attempt < activationRetries; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, activationDelayMs));
      before = await inspectZaiPlans(token, proxyOptions, fetchImpl);
      const found = autoSelect
        ? selectClaimableStartPlan(before)
        : before.offers.find((offer) => offer.planId === requestedPlanId && offer.claimable) || null;
      if (found) {
        // Re-enter with the original planId so the fresh inspection decides.
        return claimZaiPlan(jwt, requestedPlanId, proxyOptions, fetchImpl, captchaProxyUrl);
      }
      if (autoSelect && hasActiveStartPlan(before)) {
        const active = before.activePlans.find(
          (plan) => plan.status === "active" && isStartPlanIdentity(plan)
        );
        return { status: "already_active", planId: active.planId, plans: before };
      }
    }
    throw new Error(
      autoSelect
        ? "No Start Plan is currently offered to this account (Z.AI activates the trial asynchronously — try again in a few minutes)"
        : "This plan is not currently offered to the account"
    );
  }
  const claimPlanId = target.planId;

  let verifyParam = null;
  const captchaManager = getCaptchaManager();
  const claimOnce = () =>
    requestBilling(
      token,
      new URL(zcodeConfig.startPlanClaimUrl),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-ZCode-App-Version": zcodeConfig.appVersion,
          "X-Platform": `${process.platform}-${process.arch}`,
          ...(verifyParam
            ? {
                "X-Aliyun-Captcha-Verify-Param": verifyParam,
                "X-Aliyun-Captcha-Verify-Region": "sgp",
              }
            : {}),
        },
        body: JSON.stringify({ plan_id: claimPlanId }),
      },
      proxyOptions,
      fetchImpl
    );

  let claim;
  for (let attempt = 0; ; attempt += 1) {
    try {
      claim = await claimOnce();
      break;
    } catch (error) {
      if (!error?.captchaRequired || attempt >= MAX_CLAIM_CAPTCHA_RETRIES || !captchaManager?.getVerifyParam) {
        throw error;
      }
      captchaManager.invalidate?.();
      captchaManager.setProxy?.(captchaProxyUrl || "");
      verifyParam = await captchaManager.getVerifyParam(getZcodeCaptchaPort());
    }
  }

  const claimedPlan = normalizePlan(claim.data?.plan);
  if (!claimedPlan || claimedPlan.planId !== claimPlanId || claimedPlan.status !== "active") {
    throw new Error(
      safeReason(
        friendlyBillingError(claim.code, claim.data?.message || claim.msg) ||
          "Z.AI did not return an active plan after the claim",
        "Plan claim failed"
      )
    );
  }

  const after = await inspectZaiPlans(token, proxyOptions, fetchImpl).catch(() => null);
  return {
    status: after?.activePlans?.some(
      (plan) => plan.planId === claimPlanId && plan.status === "active"
    ) ? "claimed" : "claimed_pending",
    planId: claimPlanId,
    plan: claimedPlan,
    plans: after,
  };
}

export function summarizePlanError(error, fallback = "Plan operation failed") {
  return safeReason(error?.message, fallback);
}
