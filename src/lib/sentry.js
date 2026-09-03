// Sentry integration for 9Router
// Fail-open: if SENTRY_DSN is not configured, all calls no-op safely.

import * as Sentry from "@sentry/node";

let initialized = false;

export function initSentry() {
  if (initialized) return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn || typeof dsn !== "string" || !dsn.startsWith("http")) {
    return;
  }

  try {
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || "production",
      release: "9router@" + (process.env.npm_package_version || "0.5.65"),
      tracesSampleRate: 0.1,
      // Scrub sensitive headers & tokens before sending to Sentry
      beforeSend(event) {
        if (event.request?.headers) {
          delete event.request.headers.authorization;
          delete event.request.headers["x-api-key"];
          delete event.request.headers["x-9r-peer-token"];
        }
        return event;
      },
    });
    initialized = true;
    console.log("[Sentry] initialized with DSN:", dsn.replace(/:[^@]+@/, ":***@"));
  } catch (err) {
    console.error("[Sentry] init failed:", err?.message || err);
  }
}

export function captureException(err, context = {}) {
  if (!initialized) return;
  try {
    Sentry.withScope((scope) => {
      if (context.tags) {
        for (const [k, v] of Object.entries(context.tags)) {
          if (v !== undefined && v !== null) scope.setTag(k, String(v));
        }
      }
      if (context.extra) {
        for (const [k, v] of Object.entries(context.extra)) {
          if (v !== undefined) scope.setExtra(k, v);
        }
      }
      if (context.level) scope.setLevel(context.level);
      if (err instanceof Error) {
        Sentry.captureException(err);
      } else {
        Sentry.captureMessage(typeof err === "string" ? err : JSON.stringify(err));
      }
    });
  } catch {
    // Sentry reporting must never crash the gateway
  }
}

export function captureMessage(msg, level = "info", context = {}) {
  if (!initialized) return;
  try {
    Sentry.withScope((scope) => {
      scope.setLevel(level);
      if (context.tags) {
        for (const [k, v] of Object.entries(context.tags)) {
          if (v !== undefined && v !== null) scope.setTag(k, String(v));
        }
      }
      if (context.extra) {
        for (const [k, v] of Object.entries(context.extra)) {
          if (v !== undefined) scope.setExtra(k, v);
        }
      }
      Sentry.captureMessage(msg);
    });
  } catch {
    // fail-open
  }
}

export { Sentry };
