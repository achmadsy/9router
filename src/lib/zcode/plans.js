import zcodeConfig from "./config.js";
import { buildZcodeBillingHeaders } from "./headers.js";
import { billingUrl, friendlyBillingError, requestBilling, responseValueType, safeReason } from "./billingRequest.js";
import { proxyAwareFetch } from "../../../open-sse/utils/proxyFetch.js";
import { getCaptchaManager, getZcodeCaptchaPort } from "./captcha-service.js";
import { enrollZcodeProject } from "./provisioning.js";
import { ZCODE_ORIGINAL_START_PLAN_ID } from "./constants.js";
import { createStartPlanDiagnostics } from "./planDiagnostics.js";
import { planErrorDetails } from "./planRequests.js";
import { getZcodeBalance, invalidateZcodeBalance } from "./balances.js";
import { cachedPlanInspection, invalidatePlanInspection, planInspectionKey } from "./planInspections.js";

// Mirrors GlmExecutor's lazy captcha loop: claim first without the Aliyun
// headers; when Z.AI demands the security verification, mint a verify param
// through the shared CloakBrowser manager and retry.
const MAX_CLAIM_CAPTCHA_RETRIES = 2;

// The captured original daily plan is 0817. Other dated ids (notably the
// one-time 1029 Flash promotion) are not interchangeable with this entitlement.
function isStartPlanIdentity(plan) {
  return (plan?.planId || plan?.plan_id) === ZCODE_ORIGINAL_START_PLAN_ID;
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

async function inspectCampaignOffers(jwt, proxyOptions, fetchImpl, activePlanIds, diagnostics = null, { coordinator, signal, onError } = {}) {
  const offers = new Map();
  // Native login can return no delivery at seq=0 and an offer at seq=1.
  // Keep both responses: an empty second delivery must not erase the first.
  for (const seq of [0, 1]) {
    const url = new URL(zcodeConfig.marketingTouchUrl);
    url.searchParams.set("seq", String(seq));
    let json;
    try {
      json = await requestBilling(jwt, url, { method: "GET", signal }, proxyOptions, fetchImpl, diagnostics, `campaign-seq-${seq}`, coordinator);
      if (!Array.isArray(json.data?.deliveries)) throw new Error("Invalid campaign response; offer status is unavailable");
    } catch (error) {
      if (!onError || error?.name === "AbortError") throw error;
      onError(error);
      break;
    }
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

export async function inspectZaiPlans(jwt, proxyOptions = null, fetchImpl = proxyAwareFetch, {
  includeCampaigns = false, coordinator = null, signal, cacheScope = null, diagnostics = null,
  allowPreviewFailure = false, forceBalance = false,
} = {}) {
  const token = typeof jwt === "string" ? jwt.trim() : "";
  if (!token) throw new Error("ZCode OAuth login is required");
  const errors = [];
  let balance;
  try {
    balance = await getZcodeBalance(token, proxyOptions, fetchImpl, {
      coordinator, diagnostics, signal, accountScope: cacheScope || "",
      force: forceBalance, allowStale: includeCampaigns,
    });
    if (balance.stale) errors.push({ message: balance.warning, step: "balance", ...planErrorDetails(balance) });
  } catch (error) {
    if (error?.name === "AbortError" || !(coordinator && includeCampaigns)) throw error;
    errors.push({ message: error.message, step: "balance", ...planErrorDetails(error) });
  }

  // Cache discovery independently: a cached offer must never pin an old balance.
  const discover = async (discoverySignal) => {
    const discoveryErrors = [];
    let preview;
    try {
      preview = await requestBilling(token, billingUrl(zcodeConfig.startPlanPreviewUrl, { includePlatform: true }),
        { method: "GET", signal: discoverySignal }, proxyOptions, fetchImpl, diagnostics, "preview", coordinator);
      const data = preview.data;
      if (!data || typeof data !== "object" || Array.isArray(data) || (data.plans != null && !Array.isArray(data.plans))) {
        const missing = data == null;
        const error = new Error(missing
          ? "Z.AI reported success but omitted preview data; billing preview is unavailable. Balance and campaign checks are separate."
          : "Invalid plan preview response; status is unavailable");
        if (missing) error.reasonCode = "preview_missing_data";
        diagnostics?.event("preview", "failed", { reason: error.message,
          providerCode: Number.isFinite(preview.code) ? preview.code : null,
          dataType: responseValueType(data), plansType: responseValueType(data?.plans),
        });
        throw error;
      }
    } catch (error) {
      const tolerate = allowPreviewFailure && ![401, 403, 429].includes(error.httpStatus);
      if (error?.name === "AbortError" || (!(coordinator && includeCampaigns) && !tolerate)) throw error;
      discoveryErrors.push({ message: error.message, step: "preview", reasonCode: error.reasonCode, ...planErrorDetails(error) });
      preview = null;
    }
    const offers = (preview?.data?.plans || []).map((plan) => normalizeOffer(plan, new Set()))
      .filter(Boolean).map((offer) => ({ ...offer, source: "preview" }));
    let campaignError;
    if (includeCampaigns) {
      const campaigns = await inspectCampaignOffers(token, proxyOptions, fetchImpl, new Set(), diagnostics, {
        coordinator, signal: discoverySignal, onError(error) {
          campaignError = summarizePlanError(error, "Campaign offers could not be retrieved");
          discoveryErrors.push({ message: campaignError, step: "campaign", ...planErrorDetails(error) });
        },
      });
      const byId = new Map(campaigns.map((offer) => [offer.planId, offer]));
      for (const offer of offers) byId.set(offer.planId, { ...byId.get(offer.planId), ...offer });
      offers.splice(0, offers.length, ...byId.values());
    }
    return { offers, errors: discoveryErrors, campaignError,
      previewAvailable: !!preview, inspectionStatus: discoveryErrors.length ? "partial" : "complete" };
  };
  buildZcodeBillingHeaders(token);
  const discovery = coordinator && includeCampaigns && cacheScope !== null
    ? await cachedPlanInspection(planInspectionKey(token, proxyOptions, cacheScope), discover, signal)
    : await discover(signal);
  errors.push(...discovery.errors);
  const activePlans = (balance?.data.plans || []).map(normalizePlan).filter(Boolean);
  const owned = new Set(activePlans.map((plan) => plan.planId));
  const offers = discovery.offers.map((offer) => ({ ...offer,
    claimable: !!balance && !balance.stale && !owned.has(offer.planId),
  }));
  const primaryError = errors.find((error) => error.httpStatus === 429) || errors[0];
  return {
    activePlans, offers,
    balances: (balance?.data.balances || []).map(normalizeBalance).filter(Boolean),
    balanceStatus: balance ? (balance.stale ? "stale" : "available") : "unavailable",
    balanceCheckedAt: balance?.checkedAt || null,
    checkedAt: balance?.checkedAt || discovery.checkedAt || null,
    cached: !!balance?.cached && discovery.cached === true,
    inspectionStatus: errors.length ? (balance || discovery.previewAvailable ? "partial" : "unavailable") : "complete",
    ...(primaryError ? {
      error: summarizePlanError(primaryError), errorSource: primaryError.step,
      ...(primaryError.reasonCode ? { errorReasonCode: primaryError.reasonCode } : {}),
      ...planErrorDetails(primaryError),
    } : {}),
    ...(discovery.campaignError ? { campaignError: discovery.campaignError } : {}),
  };
}

export function invalidateZaiPlanInspection(jwt, proxyOptions, cacheScope) {
  invalidatePlanInspection(planInspectionKey(jwt.trim(), proxyOptions, cacheScope));
  invalidateZcodeBalance(jwt, proxyOptions, cacheScope || "");
}

export function hasActiveStartPlan(inspection) {
  return (inspection?.activePlans || []).some(
    (plan) => plan.status === "active" && isStartPlanIdentity(plan)
  );
}

/** Verify the login JWT's balance, as in the successful native login capture. */
export async function verifyOriginalStartPlan(jwt, proxyOptions = null, fetchImpl = proxyAwareFetch, diagnostics = null, { coordinator = null, accountScope = "" } = {}) {
  const token = typeof jwt === "string" ? jwt.trim() : "";
  if (!token) throw new Error("ZCode OAuth login is required");
  const balance = await getZcodeBalance(token, proxyOptions, fetchImpl, {
    coordinator, diagnostics, force: true, allowStale: false, accountScope,
  });
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

export async function prepareOriginalStartPlan(credentials, proxyOptions = null, fetchImpl = proxyAwareFetch, { coordinator = null, accountScope = "" } = {}) {
  const diagnostics = createStartPlanDiagnostics(credentials);
  diagnostics.event("preparation", "started", {
    proxyEnabled: proxyOptions?.connectionProxyEnabled === true,
    strictProxy: proxyOptions?.strictProxy === true,
    inferenceCredentialsChanged: false,
  });
  try {
    const jwt = credentials?.providerSpecificData?.zcodeJwtToken;
    if (typeof jwt !== "string" || !jwt.trim()) throw new Error("ZCode OAuth login is required");
    coordinator?.assertReady();
    const preparedFetch = coordinator
      ? (url, options, proxy) => coordinator.run(async () => {
          const response = await fetchImpl(url, options, proxy);
          if (response.status === 429) {
            void response.body?.cancel?.().catch(() => {});
            coordinator.observeResponse(response, new URL(url).origin);
          }
          return response;
        })
      : fetchImpl;
    await enrollZcodeProject(credentials, proxyOptions, preparedFetch, diagnostics);
    invalidateZcodeBalance(jwt, proxyOptions, accountScope);
    const result = await verifyOriginalStartPlan(jwt, proxyOptions, fetchImpl, diagnostics, { coordinator, accountScope });
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
  diagnostics = null,
  { coordinator = null, accountScope = "" } = {}
) {
  const token = typeof jwt === "string" ? jwt.trim() : "";
  const requestedPlanId = typeof planId === "string" ? planId.trim() : "";
  if (!token) throw new Error("ZCode OAuth login is required");

  // Generic requests verify only the original daily plan. Promotions require
  // an explicit offer id selected by the user, never an automatic fallback.
  if (!requestedPlanId || requestedPlanId === "zcode-v3-start-plan") {
    return verifyOriginalStartPlan(token, proxyOptions, fetchImpl, diagnostics, { coordinator, accountScope });
  }
  const before = await inspectZaiPlans(token, proxyOptions, fetchImpl, { coordinator, diagnostics, allowPreviewFailure: true, forceBalance: true, cacheScope: accountScope });
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
      new Set(before.activePlans.map((plan) => plan.planId)), diagnostics, { coordinator });
    claimPlanId = campaigns.find((offer) => offer.planId === requestedPlanId && offer.claimable)?.planId;
  }
  if (!claimPlanId) {
    const reason = before.error
      ? "Preview unavailable and requested plan absent from campaign responses; claim not sent"
      : "Requested plan absent from preview and both campaign responses; claim not sent";
    diagnostics?.event("eligibility", "failed", { reason });
    throw new Error(before.error
      ? "Could not verify this offer: preview is unavailable and the campaign did not return the selected plan; no claim was sent"
      : "This plan is not currently offered to the account");
  }
  diagnostics?.event("eligibility", "verified", { source: before.offers.some((offer) => offer.planId === claimPlanId) ? "preview" : "campaign" });

  // The pre-claim snapshot must not survive a write, including uncertain writes.
  invalidateZcodeBalance(token, proxyOptions, accountScope);
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
      "claim-api",
      coordinator
    );

  let claim;
  try {
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
  } finally {
    // Discard reads that overlapped the write, even if its outcome is uncertain.
    invalidateZcodeBalance(token, proxyOptions, accountScope);
  }

  const claimedPlan = normalizePlan(claim.data?.plan);
  diagnostics?.event("claim-api", "result", {
    requestedPlanMatches: claimedPlan?.planId === claimPlanId,
    activePlanReturned: claimedPlan?.status === "active",
  });
  if (!claimedPlan || claimedPlan.planId !== claimPlanId || claimedPlan.status !== "active") {
    const error = new Error(
      safeReason(
        friendlyBillingError(claim.code, claim.data?.message || claim.msg) ||
          "Z.AI did not return an active plan after the claim",
        "Plan claim failed"
      )
    );
    error.uncertain = true;
    throw error;
  }

  invalidateZcodeBalance(token, proxyOptions, accountScope);
  const after = await inspectZaiPlans(token, proxyOptions, fetchImpl, { coordinator, diagnostics, forceBalance: true, cacheScope: accountScope }).catch(() => null);
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
