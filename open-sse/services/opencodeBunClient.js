import { Agent, fetch as loopbackFetch } from "undici";

const DEFAULT_URL = "http://127.0.0.1:20131/fetch";
let loopbackDispatcher;

export class OpenCodeBunTransportError extends Error {
  constructor(message) {
    super(message);
    this.name = "OpenCodeBunTransportError";
  }
}

/** Snapshot configuration once per executor call, never as a health fallback. */
export function getOpencodeBunTransportConfig() {
  const mode = process.env.OPENCODE_BUN_TRANSPORT_MODE;
  if (process.env.OPENCODE_BUN_TRANSPORT_DISABLED === "1"
      || mode === "disabled" || mode === "unavailable") return null;
  const token = process.env.OPENCODE_BUN_TRANSPORT_TOKEN || "";
  const configuredUrl = process.env.OPENCODE_BUN_TRANSPORT_URL || "";
  if (!mode && !(token && configuredUrl)) return null;
  if (!token) throw new OpenCodeBunTransportError("OpenCode Bun transport token is not configured");
  let url;
  try {
    url = new URL(configuredUrl || DEFAULT_URL);
  } catch {
    throw new OpenCodeBunTransportError("Invalid OpenCode Bun loopback endpoint");
  }
  // Never send the process-local token or conversation to a remote endpoint,
  // DNS alias, URL credential, or redirect target.
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.pathname !== "/fetch" || url.search || url.hash) {
    throw new OpenCodeBunTransportError("Invalid OpenCode Bun loopback endpoint");
  }
  return Object.freeze({ url: url.href, token });
}

/**
 * Forward through the authenticated, allowlisted Bun helper. The explicit
 * dispatcher keeps this local hop out of global/env proxy-aware fetch patches.
 * The helper's header allowlist deliberately does not forward arbitrary custom
 * headers, unlike wreq. Keep that security boundary when selecting Bun.
 */
export async function opencodeBunFetch(url, options = {}, proxyUrl = "", config = getOpencodeBunTransportConfig()) {
  if (!config) throw new OpenCodeBunTransportError("OpenCode Bun transport is not configured");
  let response;
  try {
    loopbackDispatcher ||= new Agent();
    response = await loopbackFetch(config.url, {
      dispatcher: loopbackDispatcher,
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        "x-9r-bun-transport-token": config.token,
      },
      body: JSON.stringify({
        url: typeof url === "string" ? url : url.toString(),
        method: (options.method || "POST").toUpperCase(),
        headers: options.headers instanceof Headers
          ? Object.fromEntries(options.headers.entries())
          : { ...(options.headers || {}) },
        body: typeof options.body === "string" ? options.body : JSON.stringify(options.body ?? {}),
        proxyUrl: proxyUrl || "",
      }),
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted || error?.name === "AbortError") {
      throw new DOMException("OpenCode Bun request aborted", "AbortError");
    }
    // Do not expose arbitrary proxy URLs, helper tokens, or raw error causes.
    throw new OpenCodeBunTransportError("OpenCode Bun transport unavailable");
  }

  if (response.headers.get("x-9r-bun-transport-error") === "1") {
    await response.body?.cancel().catch(() => {});
    throw new OpenCodeBunTransportError("OpenCode Bun upstream transport failed");
  }
  return response;
}
