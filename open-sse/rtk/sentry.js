// Safe fail-open Sentry capture helper for open-sse and standalone modules.
// Must never throw or break LLM request flows.

let sentryModule = null;

export function setSentryBridge(bridge) {
  sentryModule = bridge;
  if (typeof globalThis !== "undefined" && bridge) {
    globalThis.__9router_sentry = bridge;
  }
}

async function getSentry() {
  if (sentryModule !== null) return sentryModule;
  try {
    sentryModule = await import("@/lib/sentry.js");
  } catch {
    try {
      sentryModule = await import("../../src/lib/sentry.js");
    } catch {
      if (typeof globalThis !== "undefined" && globalThis.__9router_sentry) {
        sentryModule = globalThis.__9router_sentry;
      } else {
        sentryModule = false;
      }
    }
  }
  return sentryModule;
}

export function captureException(err, context = {}) {
  try {
    const bridge = sentryModule || (typeof globalThis !== "undefined" && globalThis.__9router_sentry);
    if (bridge && typeof bridge.captureException === "function") {
      return bridge.captureException(err, context);
    }
    // Fire-and-forget fallback if module not loaded yet
    if (sentryModule === null) {
      getSentry()
        .then((m) => {
          if (m && typeof m.captureException === "function") {
            m.captureException(err, context);
          }
        })
        .catch(() => {});
    }
  } catch {
    // Sentry reporting must never crash
  }
  return null;
}

export function captureMessage(msg, level = "info", context = {}) {
  try {
    const bridge = sentryModule || (typeof globalThis !== "undefined" && globalThis.__9router_sentry);
    if (bridge && typeof bridge.captureMessage === "function") {
      return bridge.captureMessage(msg, level, context);
    }
    if (sentryModule === null) {
      getSentry()
        .then((m) => {
          if (m && typeof m.captureMessage === "function") {
            m.captureMessage(msg, level, context);
          }
        })
        .catch(() => {});
    }
  } catch {
    // Sentry reporting must never crash
  }
  return null;
}

export function isSentryReady() {
  try {
    const bridge = sentryModule || (typeof globalThis !== "undefined" && globalThis.__9router_sentry);
    if (bridge && typeof bridge.isSentryReady === "function") {
      return bridge.isSentryReady();
    }
  } catch {}
  return false;
}

export function captureRtkError(error, stage, extra = {}) {
  try {
    // Fire and forget, strictly fail-open
    getSentry()
      .then((sentry) => {
        if (sentry && typeof sentry.captureException === "function") {
          sentry.captureException(error, {
            tags: { stage: stage || "rtk" },
            extra,
          });
        }
      })
      .catch(() => {});
  } catch {
    // Sentry reporting must never crash RTK
  }
}