import { billingUrl, requestBilling } from "./billingRequest.js";
import config from "./config.js";
import { planInspectionKey } from "./planInspections.js";
import { planErrorDetails, planRequestCoordinator } from "./planRequests.js";
import { proxyAwareFetch } from "../../../open-sse/utils/proxyFetch.js";

const FRESH_MS = 60_000;
const FAILURE_MS = 10_000;
const MAX_ENTRIES = 500;
const STATE_KEY = Symbol.for("9router.zcode.balanceSnapshots");
const entries = globalThis[STATE_KEY] ||= new Map();

export function balanceKey(jwt, proxyOptions, accountScope = "") {
  return planInspectionKey(jwt.trim(), proxyOptions, accountScope);
}

function subscribe(flight, signal) {
  if (signal?.aborted) return Promise.reject(new DOMException("Balance check cancelled", "AbortError"));
  flight.readers += 1;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (callback, value) => {
      if (done) return;
      done = true;
      signal?.removeEventListener("abort", abort);
      flight.readers -= 1;
      if (!flight.readers && !flight.done) flight.controller.abort();
      callback(value);
    };
    const abort = () => finish(reject, new DOMException("Balance check cancelled", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    flight.promise.then((value) => finish(resolve, structuredClone(value)), (error) => finish(reject, error));
  });
}

function snapshot(entry, error = null, cached = true) {
  const data = structuredClone(entry.data);
  const now = Date.now() / 1000;
  if (error && Array.isArray(data?.balances)) data.balances = data.balances.filter((row) => !Number(row?.expires_at) || Number(row.expires_at) > now);
  return {
    data, checkedAt: entry.checkedAt, cached,
    stale: !!error,
    ...(error ? { warning: error.message, ...planErrorDetails(error) } : {}),
  };
}

export function invalidateZcodeBalance(jwt, proxyOptions, accountScope = "") {
  const key = balanceKey(jwt, proxyOptions, accountScope);
  const entry = entries.get(key);
  entries.delete(key);
  entry?.flight?.controller.abort();
}

export async function getZcodeBalance(jwt, proxyOptions = null, fetchImpl = proxyAwareFetch, {
  accountScope = "", force = false, allowStale = true, signal,
  coordinator = planRequestCoordinator, diagnostics = null,
} = {}) {
  coordinator ||= planRequestCoordinator;
  const token = typeof jwt === "string" ? jwt.trim() : "";
  if (!token) throw new Error("ZCode OAuth login is required");
  if (signal?.aborted) throw new DOMException("Balance check cancelled", "AbortError");
  const key = balanceKey(token, proxyOptions, accountScope);
  let entry = entries.get(key);
  if (entry?.flight?.controller.signal.aborted) {
    entry.flight = null;
  }
  // Even forced readers share in-flight work and must honor the upstream gate.
  if (entry?.flight) {
    const value = await subscribe(entry.flight, signal);
    if (value.stale && !allowStale) throw entry.error;
    return value;
  }
  if (entry?.data && !force && Date.now() - entry.checkedAt < FRESH_MS && !entry.error) {
    return snapshot(entry);
  }
  if (entry?.error && (entry.retryAt > Date.now() || coordinator?.cooldown())) {
    if (entry.data && allowStale && ![401, 403].includes(entry.error.httpStatus)) return snapshot(entry, entry.error);
    throw entry.error;
  }
  try {
    coordinator?.assertReady();
  } catch (error) {
    if (entry?.data && allowStale && ![401, 403].includes(entry.error?.httpStatus)) return snapshot(entry, error);
    throw error;
  }
  if (!entry) {
    if (entries.size >= MAX_ENTRIES) {
      const evictable = [...entries].find(([, value]) => !value.flight);
      if (!evictable) throw new Error("Balance check queue is busy; wait for the current checks to finish");
      entries.delete(evictable[0]);
    }
    entry = { data: null, checkedAt: null, error: null, retryAt: 0, flight: null };
    entries.set(key, entry);
  }
  const flight = { controller: new AbortController(), readers: 0, done: false, promise: null };
  entry.flight = flight;
  flight.promise = Promise.resolve().then(async () => {
    if (flight.controller.signal.aborted) throw new DOMException("Balance check cancelled", "AbortError");
    try {
      const result = await requestBilling(token, billingUrl(config.startPlanBalanceUrl), {
        method: "GET", signal: flight.controller.signal,
      }, proxyOptions, fetchImpl, diagnostics, "balance", coordinator);
      const data = result.data;
      if (!data || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.plans) ||
          (data.balances != null && !Array.isArray(data.balances))) {
        throw new Error("Invalid plan balance response; status is unavailable");
      }
      if (flight.controller.signal.aborted) throw new DOMException("Balance check cancelled", "AbortError");
      // Retain only billing fields consumed by the two screens, never raw envelopes.
      const pick = (row, fields) => Object.fromEntries(fields.filter((field) => row?.[field] !== undefined).map((field) => [field, structuredClone(row[field])]));
      entry.data = {
        plans: data.plans.filter((row) => row && typeof row === "object").map((row) => pick(row, ["plan_id", "name", "description", "status", "starts_at", "ends_at"])),
        balances: (data.balances || []).filter((row) => row && typeof row === "object").map((row) => pick(row, [
          "entitlement_id", "plan_id", "show_name", "meter", "capabilities", "unit_type", "period", "total_units", "used_units", "remaining_units", "expires_at",
        ])),
      };
      entry.checkedAt = Date.now();
      entry.error = null;
      entry.retryAt = 0;
      return snapshot(entry, null, false);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      entry.error = error;
      if ([401, 403].includes(error.httpStatus)) entry.data = null;
      entry.retryAt = Math.max(Date.now() + FAILURE_MS, error.retryAt || 0);
      if (entry.data && ![401, 403].includes(error.httpStatus)) return snapshot(entry, error, false);
      throw error;
    }
  }).finally(() => {
    flight.done = true;
    if (entry.flight === flight) entry.flight = null;
  });
  const value = await subscribe(flight, signal);
  if (value.stale && !allowStale) throw entry.error;
  return value;
}

export function _clearZcodeBalancesForTests() {
  for (const entry of entries.values()) entry.flight?.controller.abort();
  entries.clear();
}
