const DEFAULT_URL = "http://127.0.0.1:20131/fetch";
const TRANSPORT_URL = process.env.OPENCODE_BUN_TRANSPORT_URL || DEFAULT_URL;
const TRANSPORT_TOKEN = process.env.OPENCODE_BUN_TRANSPORT_TOKEN || "";

export class OpenCodeBunTransportError extends Error {
  constructor(message) {
    super(message);
    this.name = "OpenCodeBunTransportError";
  }
}

/**
 * Forward an OpenCode inference request through the loopback Bun transport.
 * The helper allowlists opencode.ai/inference/* and streams the response back.
 */
export async function opencodeBunFetch(url, options = {}, proxyUrl = "") {
  if (!TRANSPORT_TOKEN) {
    throw new OpenCodeBunTransportError("OpenCode Bun transport token is not configured");
  }

  let response;
  try {
    response = await fetch(TRANSPORT_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-9r-bun-transport-token": TRANSPORT_TOKEN,
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
    throw new OpenCodeBunTransportError(
      `OpenCode Bun transport unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }

  if (response.headers.get("x-9r-bun-transport-error") === "1") {
    let detail = "Bun upstream request failed";
    try {
      const data = await response.json();
      detail = data?.error?.message || detail;
    } catch { /* keep default */ }
    throw new OpenCodeBunTransportError(detail);
  }
  return response;
}
