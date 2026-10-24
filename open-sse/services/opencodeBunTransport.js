import { timingSafeEqual } from "node:crypto";

const HOST = "127.0.0.1";
const PORT = Number(process.env.OPENCODE_BUN_TRANSPORT_PORT || 20131);
const TOKEN = process.env.OPENCODE_BUN_TRANSPORT_TOKEN || "";
const MAX_REQUEST_BYTES = 20 * 1024 * 1024;
const ALLOWED_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "anthropic-version",
  "authorization",
  "b3",
  "content-type",
  "traceparent",
  "user-agent",
  "x-opencode-client",
  "x-opencode-project",
  "x-opencode-session",
  "x-opencode-session-id",
  "x-session-affinity",
  "x-session-id",
]);

function authorized(request) {
  if (!TOKEN) return false;
  const supplied = request.headers.get("x-9r-bun-transport-token") || "";
  const expectedBytes = Buffer.from(TOKEN);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

function allowedTarget(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === "opencode.ai"
      && url.port === ""
      && url.pathname.startsWith("/inference/");
  } catch {
    return false;
  }
}

function filteredHeaders(input) {
  const headers = new Headers();
  if (!input || typeof input !== "object" || Array.isArray(input)) return headers;
  for (const [name, value] of Object.entries(input)) {
    const lower = name.toLowerCase();
    if (!ALLOWED_HEADERS.has(lower) || value == null) continue;
    headers.set(lower, String(value));
  }
  return headers;
}

function errorResponse(status, message, transportError = false) {
  return Response.json({ error: { type: "bun_transport_error", message } }, {
    status,
    headers: transportError ? { "x-9r-bun-transport-error": "1" } : undefined,
  });
}

if (!TOKEN || !Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) {
  console.error("[OpenCodeBunTransport] invalid startup configuration");
  process.exit(1);
}

Bun.serve({
  hostname: HOST,
  port: PORT,
  maxRequestBodySize: MAX_REQUEST_BYTES,
  async fetch(request) {
    if (request.method === "GET" && new URL(request.url).pathname === "/health") {
      return authorized(request) ? Response.json({ ok: true }) : errorResponse(401, "Unauthorized");
    }
    if (request.method !== "POST" || new URL(request.url).pathname !== "/fetch") {
      return errorResponse(404, "Not found");
    }
    if (!authorized(request)) return errorResponse(401, "Unauthorized");

    let payload;
    try {
      payload = await request.json();
    } catch {
      return errorResponse(400, "Invalid JSON payload");
    }
    if (!allowedTarget(payload?.url)) return errorResponse(403, "Target is not allowed");
    if (payload?.method !== "POST" || typeof payload?.body !== "string") {
      return errorResponse(400, "Only POST requests with a string body are supported");
    }

    const options = {
      method: "POST",
      headers: filteredHeaders(payload.headers),
      body: payload.body,
      redirect: "manual",
      signal: request.signal,
      ...(typeof payload.proxyUrl === "string" && payload.proxyUrl.trim()
        ? { proxy: payload.proxyUrl.trim() }
        : {}),
    };

    try {
      const upstream = await fetch(payload.url, options);
      const headers = new Headers(upstream.headers);
      headers.delete("content-length");
      headers.delete("connection");
      headers.delete("keep-alive");
      headers.delete("transfer-encoding");
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    } catch (error) {
      return errorResponse(502, error instanceof Error ? error.message : "Bun upstream request failed", true);
    }
  },
});

console.log(`[OpenCodeBunTransport] listening on http://${HOST}:${PORT}`);
