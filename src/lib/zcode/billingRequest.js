import zcodeConfig from "./config.js";
import { buildZcodeBillingHeaders } from "./headers.js";
import { proxyAwareFetch } from "../../../open-sse/utils/proxyFetch.js";

function isCaptchaRejection(code, message) {
  const text = String(message || "").toLowerCase();
  return (
    code === 3007 ||
    text.includes("captcha") ||
    text.includes("security_verification")
  );
}

export function safeReason(value, fallback = "Plan request failed") {
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

export function responseValueType(value) {
  return value === undefined ? "missing" : value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

export function billingUrl(baseUrl, { includePlatform = false } = {}) {
  const url = new URL(baseUrl);
  url.searchParams.set("app_version", zcodeConfig.appVersion);
  if (includePlatform) url.searchParams.set("platform", `${process.platform}-${process.arch}`);
  return url;
}

export function friendlyBillingError(code, message) {
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

export async function requestBilling(
  jwt,
  url,
  options = {},
  proxyOptions = null,
  fetchImpl = proxyAwareFetch,
  diagnostics = null,
  step = "balance",
  coordinator = null
) {
  if (coordinator) {
    return coordinator.run(() => requestBilling(jwt, url, {
      ...options, _planCoordinator: coordinator,
    }, proxyOptions, fetchImpl, diagnostics, step), { signal: options.signal });
  }
  const { _planCoordinator, ...requestOptions } = options;
  const started = Date.now();
  const endpoint = `${url.origin}${url.pathname}`;
  diagnostics?.event(step, "request", { method: options.method || "GET", endpoint, appVersion: zcodeConfig.appVersion });
  let response;
  try {
    response = await fetchImpl(
      url.toString(),
      {
        ...requestOptions,
        redirect: "error",
        headers: {
          ...buildZcodeBillingHeaders(jwt, url.toString()),
          ...requestOptions.headers,
        },
        signal: requestOptions.signal
          ? AbortSignal.any([requestOptions.signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
      },
      proxyOptions
    );
  } catch {
    diagnostics?.event(step, "failed", { endpoint, durationMs: Date.now() - started, reason: "Network request failed or timed out" });
    if (requestOptions.signal?.aborted) throw new DOMException("Plan inspection cancelled", "AbortError");
    const failure = new Error("Plan network failure or timeout");
    failure.uncertain = requestOptions.method === "POST";
    throw failure;
  }

  if (response.status === 429 && _planCoordinator) {
    diagnostics?.event(step, "failed", { endpoint, httpStatus: 429, durationMs: Date.now() - started });
    void response.body?.cancel?.().catch(() => {});
    _planCoordinator.observeResponse(response, endpoint);
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
    responseType: responseValueType(json), dataType: responseValueType(json?.data),
    plansType: responseValueType(json?.data?.plans),
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
    error.httpStatus = response.status;
    error.uncertain = requestOptions.method === "POST" && (response.status >= 500 || !json);
    error.captchaRequired = !error.uncertain && response.status !== 429 && isCaptchaRejection(code, rawMessage);
    throw error;
  }

  return json;
}
