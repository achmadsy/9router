// Safe fail-open Sentry capture helper for RTK and Caveman stages.
// Must never throw or break LLM request flows.

let sentryModule = null;

async function getSentry() {
  if (sentryModule !== null) return sentryModule;
  try {
    sentryModule = await import("@/lib/sentry.js");
  } catch {
    try {
      sentryModule = await import("../../src/lib/sentry.js");
    } catch {
      sentryModule = false;
    }
  }
  return sentryModule;
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
