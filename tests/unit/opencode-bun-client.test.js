import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_TOKEN = process.env.OPENCODE_BUN_TRANSPORT_TOKEN;
const ORIGINAL_URL = process.env.OPENCODE_BUN_TRANSPORT_URL;

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn());
  process.env.OPENCODE_BUN_TRANSPORT_TOKEN = "test-transport-token";
  process.env.OPENCODE_BUN_TRANSPORT_URL = "http://127.0.0.1:29999/fetch";
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL_TOKEN === undefined) delete process.env.OPENCODE_BUN_TRANSPORT_TOKEN;
  else process.env.OPENCODE_BUN_TRANSPORT_TOKEN = ORIGINAL_TOKEN;
  if (ORIGINAL_URL === undefined) delete process.env.OPENCODE_BUN_TRANSPORT_URL;
  else process.env.OPENCODE_BUN_TRANSPORT_URL = ORIGINAL_URL;
});

describe("OpenCode Bun transport client", () => {
  it("sends an authenticated loopback envelope and returns the streamed response", async () => {
    const upstream = new Response("data: ok\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    fetch.mockResolvedValue(upstream);
    const { opencodeBunFetch } = await import("../../open-sse/services/opencodeBunClient.js");

    const result = await opencodeBunFetch(
      "https://opencode.ai/inference/openai/v1/chat/completions",
      { method: "POST", headers: { authorization: "Bearer public" }, body: "{}" },
      "http://proxy.example:8080",
    );

    expect(result).toBe(upstream);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:29999/fetch");
    expect(options.headers["x-9r-bun-transport-token"]).toBe("test-transport-token");
    expect(JSON.parse(options.body)).toMatchObject({
      url: "https://opencode.ai/inference/openai/v1/chat/completions",
      method: "POST",
      body: "{}",
      proxyUrl: "http://proxy.example:8080",
    });
  });

  it("surfaces helper transport failures instead of returning a provider response", async () => {
    fetch.mockResolvedValue(new Response(JSON.stringify({ error: { message: "proxy connect failed" } }), {
      status: 502,
      headers: { "x-9r-bun-transport-error": "1", "content-type": "application/json" },
    }));
    const { opencodeBunFetch, OpenCodeBunTransportError } = await import("../../open-sse/services/opencodeBunClient.js");

    await expect(opencodeBunFetch("https://opencode.ai/inference/v1/chat/completions", { body: "{}" }))
      .rejects.toBeInstanceOf(OpenCodeBunTransportError);
  });
});
