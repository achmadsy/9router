export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initSentry } = await import("@/lib/sentry");
    initSentry();

    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();
  }
}

// Next.js calls this for every request-level error (render failures, route
// handler throws, 5xx). Route them to Sentry with request context — console
// capture alone misses these when the response is a clean 500 page.
export function onRequestError(err, request, context) {
  try {
    const { captureException } = globalThis.__9router_sentry || {};
    if (typeof captureException === "function") {
      captureException(err, {
        tags: { source: "nextjs.onRequestError" },
        extra: {
          path: request?.path,
          method: request?.method,
          route: context?.router?.pathname ?? context?.routePath,
        },
      });
    }
  } catch {
    // fail-open
  }
}
