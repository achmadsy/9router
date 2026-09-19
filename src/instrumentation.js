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

    // Per-model upstream endpoint overrides stored on custom models
    // (targetFormat). Sync read side lives in providerModels.js's format
    // lookup; refresh is re-triggered by the custom-model API routes.
    const { installCustomModelFormats } = await import("open-sse/providers/customModelFormats.js");
    const { getCustomModels } = await import("@/lib/db/repos/aliasRepo.js");
    await installCustomModelFormats(() => getCustomModels());

    const { installModelCapabilityOverrides } = await import("open-sse/providers/modelCapabilityOverrides.js");
    const { getModelCapabilityOverrides } = await import("@/lib/db/repos/modelCapabilityRepo.js");
    await installModelCapabilityOverrides(async () => {
      const [overrides, customModels] = await Promise.all([
        getModelCapabilityOverrides(),
        getCustomModels(),
      ]);
      return [
        ...customModels.map((model) => ({
          provider: model.providerAlias,
          model: model.id,
          caps: model.caps,
        })),
        ...overrides,
      ];
    });

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();
  }
}

// Next.js calls this for every request-level error (render failures, route
// handler throws, 5xx). Route them to Sentry with request context — console
// capture alone misses these when the response is a clean 500 page.
export function onRequestError(err, request, context) {
  try {
    // ALS store (from custom-server) usually already has the IP. Header is fallback
    // when the error path lost the async context.
    let headerIp = null;
    try {
      const h = request?.headers;
      if (h) headerIp = typeof h.get === "function" ? h.get("x-9r-real-ip") : h["x-9r-real-ip"];
    } catch {}

    const { captureException } = globalThis.__9router_sentry || {};
    if (typeof captureException === "function") {
      captureException(err, {
        tags: { source: "nextjs.onRequestError" },
        clientIp: headerIp || undefined,
        extra: {
          path: request?.path,
          method: request?.method,
          route: context?.router?.pathname ?? context?.routePath,
          client_ip: headerIp || undefined,
        },
      });
    }
  } catch {
    // fail-open
  }
}
