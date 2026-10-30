import { createHash } from "node:crypto";
import config from "./config.js";
import { readZcodeDeviceMid } from "./headers.js";

const CACHE_TTL_MS = 60_000;
const PARTIAL_TTL_MS = 10_000;
const MAX_ENTRIES = 200;
const STATE_KEY = Symbol.for("9router.zcode.planInspections");
const entries = globalThis[STATE_KEY] ||= new Map();

export function planInspectionKey(jwt, proxyOptions, accountScope = "") {
  // Never retain raw tokens or proxy credentials in cache keys or diagnostics.
  return createHash("sha256").update(JSON.stringify([
    accountScope, jwt, readZcodeDeviceMid() || null,
    config.appVersion, config.userAgent, config.startPlanBalanceUrl,
    config.startPlanPreviewUrl, config.marketingTouchUrl,
    ...["proxyPoolId", "connectionProxyEnabled", "connectionProxyUrl", "connectionNoProxy", "strictProxy", "enabled", "url", "noProxy", "vercelRelayUrl"]
      .map((key) => proxyOptions?.[key] ?? null),
    ...["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]
      .map((key) => process.env[key] || null),
  ])).digest("hex");
}

function subscribe(flight, signal) {
  if (signal?.aborted) return Promise.reject(new DOMException("Plan inspection cancelled", "AbortError"));
  flight.readers += 1;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      flight.readers -= 1;
      if (flight.readers === 0 && !flight.done) flight.controller.abort();
      callback(value);
    };
    const onAbort = () => finish(reject, new DOMException("Plan inspection cancelled", "AbortError"));
    signal?.addEventListener("abort", onAbort, { once: true });
    flight.promise.then((value) => finish(resolve, structuredClone(value)), (error) => finish(reject, error));
  });
}

export function cachedPlanInspection(key, loader, signal) {
  if (signal?.aborted) return Promise.reject(new DOMException("Plan inspection cancelled", "AbortError"));
  const now = Date.now();
  for (const [id, entry] of entries) {
    if (!entry.flight && entry.expiresAt <= now) entries.delete(id);
  }
  let existing = entries.get(key);
  if (existing?.flight?.controller.signal.aborted) {
    entries.delete(key);
    existing = null;
  }
  if (existing?.value && existing.expiresAt > now) {
    return Promise.resolve({ ...structuredClone(existing.value), cached: true });
  }
  if (existing?.flight) return subscribe(existing.flight, signal);
  if (entries.size >= MAX_ENTRIES) {
    const evictable = [...entries].find(([, entry]) => !entry.flight);
    if (!evictable) return Promise.reject(new Error("Plan inspection queue is busy; wait for the current checks to finish"));
    entries.delete(evictable[0]);
  }
  const entry = { value: null, expiresAt: 0, flight: null };
  const flight = { controller: new AbortController(), readers: 0, done: false, promise: null };
  entry.flight = flight;
  entries.set(key, entry);
  flight.promise = Promise.resolve().then(() => {
    if (flight.controller.signal.aborted) throw new DOMException("Plan inspection cancelled", "AbortError");
    return loader(flight.controller.signal);
  }).then((result) => {
    const value = { ...result, checkedAt: Date.now(), cached: false };
    if (!flight.controller.signal.aborted && entries.get(key) === entry) {
      entry.value = structuredClone(value);
      entry.expiresAt = Math.min(
        Date.now() + (result.inspectionStatus === "complete" ? CACHE_TTL_MS : PARTIAL_TTL_MS),
        Number.isFinite(result.retryAt) ? result.retryAt : Infinity,
      );
    }
    return value;
  }).finally(() => {
    flight.done = true;
    entry.flight = null;
    if (!entry.value && entries.get(key) === entry) entries.delete(key);
  });
  return subscribe(flight, signal);
}

export function invalidatePlanInspection(key) {
  const entry = entries.get(key);
  entries.delete(key);
  entry?.flight?.controller.abort();
}

export function _clearPlanInspectionCacheForTests() {
  for (const key of entries.keys()) invalidatePlanInspection(key);
}
