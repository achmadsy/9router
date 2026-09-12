// Request-scoped context for the active inbound HTTP request.
// custom-server.js stamps the unspoofable peer IP and runs the Next handler
// inside this ALS store; Sentry capture helpers read it when present.
// Fail-open: missing store → null IP (background jobs, tests without custom-server).

import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

// custom-server.js is CommonJS and boots first — share one store via globalThis
// so CJS and ESM import the same ALS instance in the same process.
if (!globalThis.__9router_request_als) {
  globalThis.__9router_request_als = storage;
}

function activeStorage() {
  return globalThis.__9router_request_als || storage;
}

/** Run fn with clientIp available to getRequestIp() (and nested async work). */
export function runWithClientIp(clientIp, fn) {
  const store = typeof clientIp === "string" && clientIp ? { clientIp } : {};
  return activeStorage().run(store, fn);
}

/** Active request client IP, or null outside a request / when unstamped. */
export function getRequestIp() {
  try {
    return activeStorage().getStore()?.clientIp || null;
  } catch {
    return null;
  }
}

/** Normalize IPv4-mapped IPv6 (`::ffff:1.2.3.4`) → plain IPv4. */
export function normalizeClientIp(ip) {
  if (!ip || typeof ip !== "string") return null;
  const trimmed = ip.trim();
  if (!trimmed) return null;
  const v4Mapped = trimmed.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  return v4Mapped ? v4Mapped[1] : trimmed;
}
