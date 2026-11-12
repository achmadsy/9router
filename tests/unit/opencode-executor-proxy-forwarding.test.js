import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tlsFetch: vi.fn(),
  bunFetch: vi.fn(),
  rawFetch: vi.fn(),
}));

vi.mock("../../open-sse/services/opencodeTlsClient.js", () => ({
  opencodeTlsFetch: mocks.tlsFetch,
}));
vi.mock("../../open-sse/services/opencodeBunClient.js", () => ({
  opencodeBunFetch: mocks.bunFetch,
  OpenCodeBunTransportError: class extends Error {},
}));
// All network boundaries are mocked, including the explicit relay path.
vi.mock("undici", () => ({ fetch: mocks.rawFetch }));

import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";

const TARGET = "https://opencode.ai/inference/openai/v1/chat/completions";
const PROXY = "http://account:secret@proxy.example:8080";
const strictProxy = {
  connectionProxyEnabled: true,
  connectionProxyUrl: PROXY,
  strictProxy: true,
};

function execute(options = {}) {
  const executor = new OpenCodeExecutor();
  // Test dispatch, not the pre-existing network-error retry schedule.
  executor.config = {
    ...executor.config,
    retry: { ...executor.config.retry, 502: { attempts: 0 } },
  };
  return executor.execute({
    model: "glm-5.3-flash-free",
    body: { messages: [{ role: "user", content: "hi" }] },
    stream: true,
    credentials: {},
    ...options,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
    vi.stubEnv(key, "");
  }
  // Match custom-server deployments: the helper is configured and healthy, not
  // unavailable. The upstream adapter must still be the default transport.
  vi.stubEnv("OPENCODE_BUN_TRANSPORT_TOKEN", "test-helper-token");
  vi.stubEnv("OPENCODE_BUN_TRANSPORT_URL", "http://127.0.0.1:29999/fetch");
  mocks.tlsFetch.mockImplementation(async () => new Response("data: ok\n\n"));
  mocks.bunFetch.mockImplementation(async () => new Response("Bun helper response"));
  mocks.rawFetch.mockImplementation(async () => new Response("relay response"));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("OpenCode default upstream transport", () => {
  it("uses the upstream adapter even with a healthy configured Bun helper", async () => {
    const response = new Response("data: ok\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
    mocks.tlsFetch.mockResolvedValue(response);
    const controller = new AbortController();

    const result = await execute({ proxyOptions: strictProxy, signal: controller.signal });

    expect(mocks.tlsFetch).toHaveBeenCalledOnce();
    expect(mocks.tlsFetch).toHaveBeenCalledWith(TARGET, expect.objectContaining({
      method: "POST",
      body: expect.any(String),
    }), expect.objectContaining({ proxyUrl: PROXY, signal: expect.any(AbortSignal) }));
    expect(result.response).toBe(response);
    expect(response.bodyUsed).toBe(false);
    expect(await response.text()).toBe("data: ok\n\n");
    controller.abort();
    expect(mocks.tlsFetch.mock.calls[0][2].signal.aborted).toBe(true);
    expect(mocks.bunFetch).not.toHaveBeenCalled();
    expect(mocks.rawFetch).not.toHaveBeenCalled();
  });

  it("keeps explicit direct mode on the adapter without a proxy", async () => {
    await execute({ proxyOptions: { forceDirect: true } });

    expect(mocks.tlsFetch).toHaveBeenCalledOnce();
    expect(mocks.tlsFetch.mock.calls[0][2].proxyUrl).toBeUndefined();
    expect(mocks.bunFetch).not.toHaveBeenCalled();
    expect(mocks.rawFetch).not.toHaveBeenCalled();
  });

  it("preserves connection no_proxy exclusions", async () => {
    await execute({ proxyOptions: {
      connectionProxyEnabled: true,
      connectionProxyUrl: PROXY,
      connectionNoProxy: "opencode.ai",
    } });

    expect(mocks.tlsFetch).toHaveBeenCalledOnce();
    expect(mocks.tlsFetch.mock.calls[0][2].proxyUrl).toBeUndefined();
    expect(mocks.bunFetch).not.toHaveBeenCalled();
  });

  it("keeps explicitly configured relays on the existing relay path", async () => {
    await execute({ proxyOptions: { vercelRelayUrl: "https://relay.example/fetch" } });

    expect(mocks.rawFetch).toHaveBeenCalledWith("https://relay.example/fetch", expect.objectContaining({
      headers: expect.objectContaining({
        "x-relay-target": "https://opencode.ai",
        "x-relay-path": "/inference/openai/v1/chat/completions",
      }),
    }));
    expect(mocks.tlsFetch).not.toHaveBeenCalled();
    expect(mocks.bunFetch).not.toHaveBeenCalled();
  });

  it("fails before dispatch when a required proxy has no usable URL", async () => {
    await expect(execute({ proxyOptions: {
      connectionProxyEnabled: true,
      strictProxy: true,
    } })).rejects.toThrow(/none resolved/);

    expect(mocks.tlsFetch).not.toHaveBeenCalled();
    expect(mocks.bunFetch).not.toHaveBeenCalled();
    expect(mocks.rawFetch).not.toHaveBeenCalled();
  });

  it("never falls back to Bun or a direct request when the strict proxy fails", async () => {
    mocks.tlsFetch.mockRejectedValue(new Error("proxy tunnel refused"));

    await expect(execute({ proxyOptions: strictProxy })).rejects.toThrow(/strictProxy=true/);

    expect(mocks.tlsFetch).toHaveBeenCalledOnce();
    expect(mocks.tlsFetch.mock.calls[0][2].proxyUrl).toBe(PROXY);
    expect(mocks.bunFetch).not.toHaveBeenCalled();
    expect(mocks.rawFetch).not.toHaveBeenCalled();
  });

  it("returns a long-reset quota 429 without another transport or retry", async () => {
    const body = JSON.stringify({ type: "error", error: {
      type: "FreeUsageLimitError", message: "Free usage limit reached.",
    } });
    const response = new Response(body, { status: 429, headers: { "retry-after": "32400" } });
    mocks.tlsFetch.mockResolvedValue(response);
    // Even a working helper must not be used to retry a quota rejection.
    const result = await execute({ proxyOptions: strictProxy });

    expect(result.response).toBe(response);
    expect(result.response.status).toBe(429);
    expect(result.response.headers.get("retry-after")).toBe("32400");
    expect(await result.response.text()).toBe(body);
    expect(mocks.tlsFetch).toHaveBeenCalledOnce();
    expect(mocks.bunFetch).not.toHaveBeenCalled();
    expect(mocks.rawFetch).not.toHaveBeenCalled();
  });
});
