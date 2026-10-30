import zcodeConfig from "./config.js";
import { buildZcodeBillingHeaders } from "./headers.js";
import { proxyAwareFetch } from "../../../open-sse/utils/proxyFetch.js";
import { getCaptchaManager, getZcodeCaptchaPort } from "./captcha-service.js";
import { enrollZcodeProject } from "./provisioning.js";
import { ZCODE_ORIGINAL_START_PLAN_ID } from "./constants.js";
import { createStartPlanDiagnostics } from "./planDiagnostics.js";

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

// The captured original daily plan is 0817. Other dated ids (notably the
// one-time 1029 Flash promotion) are not interchangeable with this entitlement.
function isStartPlanIdentity(plan) {
  return (plan?.planId || plan?.plan_id) === ZCODE_ORIGINAL_START_PLAN_ID;
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
  return typeof message === "string" && message.trim() ? message : null;
}

async function requestBilling(
  jwt,
  url,
  options = {},
  proxyOptions = null,
  fetchImpl = proxyAwareFetch,
  diagnostics = null,
  step = "balance"
) {
  const started = Date.now();
  const endpoint = `${url.origin}${url.pathname}`;
  diagnostics?.event(step, "request", { method: options.method || "GET", endpoint, appVersion: zcodeConfig.appVersion });
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
    diagnostics?.event(step, "failed", { endpoint, durationMs: Date.now() - started, reason: "Network request failed or timed out" });
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
  diagnostics?.event(step, response.ok && json && envelopeOk ? "response" : "failed", {
    endpoint, httpStatus: response.status, providerCode: Number.isFinite(code) ? code : null,
    validJson: !!json, durationMs: Date.now() - started,
  });
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

async function inspectCampaignOffers(jwt, proxyOptions, fetchImpl, activePlanIds, diagnostics = null) {
  const offers = new Map();
  // Native login can return no delivery at seq=0 and an offer at seq=1.
  // Keep both responses: an empty second delivery must not erase the first.
  for (const seq of [0, 1]) {
    const url = new URL(zcodeConfig.marketingTouchUrl);
    url.searchParams.set("seq", String(seq));
    const json = await requestBilling(jwt, url, { method: "GET" }, proxyOptions, fetchImpl, diagnostics, `campaign-seq-${seq}`);
    diagnostics?.event("campaign", "result", { seq, deliveryCount: Array.isArray(json.data?.deliveries) ? json.data.deliveries.length : 0 });
    for (const delivery of Array.isArray(json.data?.deliveries) ? json.data.deliveries : []) {
      for (const button of Array.isArray(delivery?.banner?.buttons) ? delivery.banner.buttons : []) {
        const action = button?.action;
        if (action?.type !== "claim_zcode_plan") continue;
        const planId = typeof action.args?.plan_id === "string" ? action.args.plan_id.trim() : "";
        if (!planId) continue;
        // Some native banners are image-only and supply no textual title.
        // Never invent a campaign name or assume a dated id identifies an event.
        const title = [action.args?.plan_name, delivery.banner.title, delivery.title]
          .find((value) => typeof value === "string" && value.trim());
        const offer = normalizeOffer({ plan_id: planId, name: title || planId }, activePlanIds);
        offers.set(planId, { ...offer, source: "campaign" });
      }
    }
  }
  return [...offers.values()];
}

export async function inspectZaiPlans(jwt, proxyOptions = null, fetchImpl = proxyAwareFetch, { includeCampaigns = false } = {}) {
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

  let campaignError;
  if (includeCampaigns) {
    // A one-time campaign already present in balance must not be offered again,
    // even if its status is no longer active or campaign discovery fails.
    const ownedPlanIds = new Set(activePlans.map((plan) => plan.planId));
    for (const offer of offers) offer.claimable = offer.claimable && !ownedPlanIds.has(offer.planId);
    try {
      const campaigns = await inspectCampaignOffers(token, proxyOptions, fetchImpl, ownedPlanIds);
      const byId = new Map(campaigns.map((offer) => [offer.planId, offer]));
      for (const offer of offers) {
        byId.set(offer.planId, { ...byId.get(offer.planId), ...offer,
          claimable: offer.claimable && !ownedPlanIds.has(offer.planId) });
      }
      offers.splice(0, offers.length, ...byId.values());
    } catch (error) {
      campaignError = summarizePlanError(error, "Campaign offers could not be retrieved");
    }
  }
  return { activePlans, offers, balances, ...(campaignError ? { campaignError } : {}) };
}

export function hasActiveStartPlan(inspection) {
  return (inspection?.activePlans || []).some(
    (plan) => plan.status === "active" && isStartPlanIdentity(plan)
  );
}

/** Verify the login JWT's balance, as in the successful native login capture. */
export async function verifyOriginalStartPlan(jwt, proxyOptions = null, fetchImpl = proxyAwareFetch, diagnostics = null) {
  const token = typeof jwt === "string" ? jwt.trim() : "";
  if (!token) throw new Error("ZCode OAuth login is required");
  const balance = await requestBilling(token, billingUrl(zcodeConfig.startPlanBalanceUrl),
    { method: "GET" }, proxyOptions, fetchImpl, diagnostics);
  const returnedPlans = Array.isArray(balance.data?.plans) ? balance.data.plans : [];
  diagnostics?.event("balance", "result", {
    planCount: returnedPlans.length,
    originalPlanPresent: returnedPlans.some((entry) => entry?.plan_id === ZCODE_ORIGINAL_START_PLAN_ID),
    originalPlanActive: returnedPlans.some((entry) => entry?.plan_id === ZCODE_ORIGINAL_START_PLAN_ID && entry?.status?.trim().toLowerCase() === "active"),
    balanceBuckets: Array.isArray(balance.data?.balances) ? balance.data.balances.length : 0,
  });
  const plan = (Array.isArray(balance.data?.plans) ? balance.data.plans : [])
    .map(normalizePlan)
    .find((entry) => entry?.status === "active" && isStartPlanIdentity(entry));
  if (!plan) {
    throw new Error("Original daily Start Plan (0817) is not active in the upstream balance; no promotional plan was claimed");
  }
  return { status: "already_active", planId: plan.planId };
}

export async function prepareOriginalStartPlan(credentials, proxyOptions = null, fetchImpl = proxyAwareFetch) {
  const diagnostics = createStartPlanDiagnostics(credentials);
  diagnostics.event("preparation", "started", {
    proxyEnabled: proxyOptions?.connectionProxyEnabled === true,
    strictProxy: proxyOptions?.strictProxy === true,
    inferenceCredentialsChanged: false,
  });
  try {
    const jwt = credentials?.providerSpecificData?.zcodeJwtToken;
    if (typeof jwt !== "string" || !jwt.trim()) throw new Error("ZCode OAuth login is required");
    await enrollZcodeProject(credentials, proxyOptions, fetchImpl, diagnostics);
    const result = await verifyOriginalStartPlan(jwt, proxyOptions, fetchImpl, diagnostics);
    diagnostics.event("preparation", "verified", { planId: result.planId, inferenceCredentialsChanged: false });
    return result;
  } catch (error) {
    diagnostics.event("preparation", "failed", { reason: summarizePlanError(error) });
    throw error;
  }
}

export async function claimZaiPlan(
  jwt,
  planId,
  proxyOptions = null,
  fetchImpl = proxyAwareFetch,
  captchaProxyUrl = "",
  diagnostics = null
) {
  const token = typeof jwt === "string" ? jwt.trim() : "";
  const requestedPlanId = typeof planId === "string" ? planId.trim() : "";
  if (!token) throw new Error("ZCode OAuth login is required");

  // Generic requests verify only the original daily plan. Promotions require
  // an explicit offer id selected by the user, never an automatic fallback.
  if (!requestedPlanId || requestedPlanId === "zcode-v3-start-plan") {
    return verifyOriginalStartPlan(token, proxyOptions, fetchImpl);
  }
  const before = await inspectZaiPlans(token, proxyOptions, fetchImpl);
  const ownedPlan = before.activePlans.find((plan) => plan.planId === requestedPlanId);
  if (ownedPlan) {
    diagnostics?.event("ownership", "skipped", { reason: "Plan already present; no claim sent" });
    return { status: ownedPlan.status === "active" ? "already_active" : "already_present", planId: requestedPlanId, plans: before };
  }
  let claimPlanId = before.offers.find(
    (offer) => offer.planId === requestedPlanId && offer.claimable
  )?.planId;
  if (!claimPlanId) {
    const campaigns = await inspectCampaignOffers(token, proxyOptions, fetchImpl,
      new Set(before.activePlans.map((plan) => plan.planId)), diagnostics);
    claimPlanId = campaigns.find((offer) => offer.planId === requestedPlanId && offer.claimable)?.planId;
  }
  if (!claimPlanId) {
    diagnostics?.event("eligibility", "failed", { reason: "Requested plan absent from preview and both campaign responses; claim not sent" });
    throw new Error("This plan is not currently offered to the account");
  }
  diagnostics?.event("eligibility", "verified", { source: before.offers.some((offer) => offer.planId === claimPlanId) ? "preview" : "campaign" });

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
      fetchImpl,
      diagnostics,
      "claim-api"
    );

  let claim;
  for (let attempt = 0; ; attempt += 1) {
    try {
      diagnostics?.event("claim-attempt", "started", { attemptNumber: attempt + 1, captchaAttached: !!verifyParam });
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
  diagnostics?.event("claim-api", "result", {
    requestedPlanMatches: claimedPlan?.planId === claimPlanId,
    activePlanReturned: claimedPlan?.status === "active",
  });
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
