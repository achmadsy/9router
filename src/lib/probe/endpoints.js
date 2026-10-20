export const PROBE_SOURCE_SELF = "this_9router";
export const PROBE_SOURCE_CUSTOM = "custom";

export function normalizeProbeSource(source, endpoint) {
  if (source === PROBE_SOURCE_SELF || source === PROBE_SOURCE_CUSTOM) return source;
  return endpoint ? PROBE_SOURCE_CUSTOM : PROBE_SOURCE_SELF;
}

export function getCurrentGatewayBaseUrl(request) {
  // Prefer the operator-configured public URL; a TLS-terminating proxy that
  // forwards plain HTTP otherwise yields an http:// self URL whose edge
  // redirect would strip credentials before the gateway sees them.
  const configured = process.env.PROBE_PUBLIC_BASE_URL
    || process.env.NEXT_PUBLIC_BASE_URL
    || process.env.BASE_URL;
  const origin = configured || new URL(request.url).origin;
  const parsed = new URL(origin);
  parsed.pathname = "/v1";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}
