import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { buildZcodeStartPlanBalanceUrl } from "../../../src/lib/zcode/config.js";

const QUOTA_ARRAY_KEYS = [
  "balances",
  "planBalances",
  "plan_balances",
  "packages",
  "packageBalances",
  "package_balances",
  "quotas",
  "resources",
  "items",
];

function finiteNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function safeIsoDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function unwrapData(json) {
  if (!json || typeof json !== "object") return null;
  if (Object.hasOwn(json, "code") && json.code !== 0) return null;
  const data = Object.hasOwn(json, "data") ? json.data : json;
  return data && typeof data === "object" ? data : null;
}

function quotaRecords(data) {
  if (!data || typeof data !== "object") return [];
  const records = [];
  for (const key of QUOTA_ARRAY_KEYS) {
    if (Array.isArray(data[key])) records.push(...data[key]);
  }
  return records.filter((item) => item && typeof item === "object");
}

function normalizeKey(value, fallback) {
  const key = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return key || fallback;
}

function normalizeQuota(record, index) {
  const model =
    record.model ||
    record.model_code ||
    record.modelCode ||
    record.resource_name ||
    record.resourceName ||
    record.show_name ||
    record.showName ||
    record.name ||
    record.title;
  const packageName =
    record.package_name || record.packageName || record.campaign_name || record.campaignName;
  const displayName = String(record.show_name || record.showName || record.name || model || packageName || `Quota ${index + 1}`);
  const modelKey = normalizeKey(model || displayName, `quota-${index + 1}`);

  const total = finiteNumber(
    record.total,
    record.limit,
    record.grant_units,
    record.grantUnits,
    record.total_amount,
    record.totalAmount,
    record.initial,
  );
  const used = finiteNumber(
    record.used,
    record.consumed,
    record.used_units,
    record.usedUnits,
    record.used_amount,
    record.usedAmount,
  );
  const remaining = finiteNumber(
    record.remaining,
    record.balance,
    record.available,
    record.remaining_units,
    record.remainingUnits,
  );
  const suppliedPercentage = finiteNumber(
    record.remaining_percentage,
    record.remainingPercentage,
    record.percent_remaining,
    record.percentRemaining,
  );

  if (total === null && used === null && remaining === null && suppliedPercentage === null) {
    return null;
  }

  const derivedTotal = total ?? (used !== null && remaining !== null ? used + remaining : null);
  const derivedUsed = used ?? (derivedTotal !== null && remaining !== null ? derivedTotal - remaining : null);
  const derivedRemaining =
    remaining ?? (derivedTotal !== null && derivedUsed !== null ? derivedTotal - derivedUsed : null);
  const remainingPercentage = suppliedPercentage ?? (
    derivedTotal !== null && derivedTotal > 0 && derivedRemaining !== null
      ? Math.round((derivedRemaining / derivedTotal) * 100)
      : null
  );
  const resetAt = safeIsoDate(
    record.reset_at ||
    record.resetAt ||
    record.reset_time ||
    record.resetTime ||
    record.expires_at ||
    record.expiresAt ||
    record.expire_time ||
    record.expireTime,
  );

  return {
    key: normalizeKey(`${modelKey}${packageName ? `-${packageName}` : ""}`, `quota-${index + 1}`),
    value: {
      used: derivedUsed,
      total: derivedTotal,
      remaining: derivedRemaining,
      resetAt,
      remainingPercentage,
      unlimited: record.unlimited === true,
      displayName: packageName && !displayName.toLowerCase().includes(String(packageName).toLowerCase())
        ? `${displayName} (${packageName})`
        : displayName,
      modelKey,
      ...(packageName ? { packageName: String(packageName) } : {}),
      ...(record.unit ? { unit: record.unit } : {}),
    },
  };
}

function planName(...payloads) {
  for (const data of payloads) {
    if (!data || typeof data !== "object") continue;
    const plans = Array.isArray(data.plans) ? data.plans : [];
    const name =
      plans[0]?.plan_name ||
      plans[0]?.planName ||
      plans[0]?.name ||
      data.plan_name ||
      data.planName ||
      data.name;
    if (name) return String(name);
  }
  return "Start Plan";
}

async function fetchBilling(url, authorization, proxyOptions) {
  try {
    const response = await proxyAwareFetch(
      url,
      {
        method: "GET",
        headers: { Authorization: authorization },
        signal: AbortSignal.timeout(15000),
      },
      proxyOptions,
    );
    if (response.status === 401) return { unauthorized: true, data: null };
    if (!response.ok) return { error: `HTTP ${response.status}`, data: null };
    const json = await response.json().catch(() => null);
    const data = unwrapData(json);
    return data ? { data } : { error: "invalid or unsuccessful response", data: null };
  } catch (error) {
    return { error: error?.message || "request failed", data: null };
  }
}

export async function getZcodeUsage(credentials, proxyOptions = null) {
  const context = typeof credentials === "string"
    ? { accessToken: credentials, providerSpecificData: { zcodeJwtToken: credentials } }
    : credentials;
  const jwtToken = context?.providerSpecificData?.zcodeJwtToken || context?.accessToken;
  if (!jwtToken) return { message: "ZCode Start Plan JWT not available." };

  const balance = await fetchBilling(
    buildZcodeStartPlanBalanceUrl(),
    `Bearer ${jwtToken}`,
    proxyOptions,
  );

  if (balance.unauthorized) {
    return { message: "ZCode token expired or unauthorized. Please re-login." };
  }

  const records = quotaRecords(balance.data);
  const quotas = {};
  for (const [index, record] of records.entries()) {
    const normalized = normalizeQuota(record, index);
    if (!normalized) continue;
    let key = normalized.key;
    let suffix = 2;
    while (Object.hasOwn(quotas, key)) {
      key = `${normalized.key}-${suffix}`;
      suffix += 1;
    }
    quotas[key] = normalized.value;
  }

  if (Object.keys(quotas).length === 0) {
    const detail = balance.error ? ` (${balance.error})` : "";
    return {
      plan: planName(balance.data),
      quotas: {},
      message: `ZCode Start Plan usage is not available from billing balance${detail}.`,
    };
  }

  return {
    plan: planName(balance.data),
    quotas,
  };
}

export const __test__ = {
  buildBalanceUrl: buildZcodeStartPlanBalanceUrl,
  finiteNumber,
  normalizeQuota,
  quotaRecords,
  unwrapData,
};

export default getZcodeUsage;
