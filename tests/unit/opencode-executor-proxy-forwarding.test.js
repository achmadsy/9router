import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tlsFetch: vi.fn(),
  bunFetch: vi.fn(),
  rawFetch: vi.fn(),
}));

vi.mock("../../open-sse/services/opencodeTlsClient.js", () => ({
  opencodeTlsFetch: mocks.tlsFetch,
}));
vi.mock("../../open-sse/services/opencodeBunClient.js", async (importOriginal) => ({
  ...await importOriginal(),
  opencodeBunFetch: mocks.bunFetch,
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
  // Managed helper eligibility is established before Next imports at startup.
  vi.stubEnv("OPENCODE_BUN_TRANSPORT_MODE", "managed");
  vi.stubEnv("OPENCODE_BUN_TRANSPORT_DISABLED", "");
  vi.stubEnv("OPENCODE_BUN_TRANSPORT_TOKEN", "test-helper-token");
  vi.stubEnv("OPENCODE_BUN_TRANSPORT_URL", "http://127.0.0.1:29999/fetch");
  mocks.tlsFetch.mockImplementation(async () => new Response("data: ok\n\n"));
  mocks.bunFetch.mockImplementation(async () => new Response("Bun helper response"));
  mocks.rawFetch.mockImplementation(async () => new Response("relay response"));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("OpenCode helper configuration selection", () => {
  it.each([
    { mode: "", token: "", url: "", disabled: "" },
    { mode: "disabled", token: "test", url: "http://127.0.0.1:29999/fetch", disabled: "" },
    { mode: "unavailable", token: "test", url: "http://127.0.0.1:29999/fetch", disabled: "" },
    { mode: "managed", token: "test", url: "http://127.0.0.1:29999/fetch", disabled: "1" },
  ])("keeps wreq for absent/disabled/unavailable helper: %j", async ({ mode, token, url, disabled }) => {
    vi.stubEnv("OPENCODE_BUN_TRANSPORT_MODE", mode);
    vi.stubEnv("OPENCODE_BUN_TRANSPORT_TOKEN", token);
    vi.stubEnv("OPENCODE_BUN_TRANSPORT_URL", url);
    vi.stubEnv("OPENCODE_BUN_TRANSPORT_DISABLED", disabled);
    await execute({ proxyOptions: strictProxy });
    expect(mocks.tlsFetch).toHaveBeenCalledOnce();
    expect(mocks.bunFetch).not.toHaveBeenCalled();
  });

  it("selects an explicitly configured external loopback helper", async () => {
    vi.stubEnv("OPENCODE_BUN_TRANSPORT_MODE", "");
    await execute({ proxyOptions: strictProxy });
    expect(mocks.bunFetch).toHaveBeenCalledOnce();
    expect(mocks.tlsFetch).not.toHaveBeenCalled();
  });
});

describe.each(["Bun", "wreq"])("OpenCode %s shared proxy adapter", (transport) => {
  let selected;
  let alternative;
  beforeEach(() => {
    selected = transport === "Bun" ? mocks.bunFetch : mocks.tlsFetch;
    alternative = transport === "Bun" ? mocks.tlsFetch : mocks.bunFetch;
    if (transport === "wreq") vi.stubEnv("OPENCODE_BUN_TRANSPORT_MODE", "unavailable");
  });
  const forwardedProxy = () => transport === "Bun" ? selected.mock.calls[0][2] : selected.mock.calls[0][2].proxyUrl;
  const forwardedSignal = () => transport === "Bun" ? selected.mock.calls[0][1].signal : selected.mock.calls[0][2].signal;
  it("uses the configured adapter and preserves the response stream and signal", async () => {
    const response = new Response("data: ok\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
    selected.mockResolvedValue(response);
    const controller = new AbortController();

    const result = await execute({ proxyOptions: strictProxy, signal: controller.signal });

    expect(selected).toHaveBeenCalledOnce();
    expect(selected.mock.calls[0][0]).toBe(TARGET);
    expect(selected.mock.calls[0][1]).toMatchObject({ method: "POST", body: expect.any(String) });
    expect(forwardedProxy()).toBe(PROXY);
    expect(result.response).toBe(response);
    expect(response.bodyUsed).toBe(false);
    expect(await response.text()).toBe("data: ok\n\n");
    controller.abort();
    expect(forwardedSignal().aborted).toBe(true);
    expect(alternative).not.toHaveBeenCalled();
    expect(mocks.rawFetch).not.toHaveBeenCalled();
  });

  it("keeps explicit direct mode on the adapter without a proxy", async () => {
    await execute({ proxyOptions: { forceDirect: true } });

    expect(selected).toHaveBeenCalledOnce();
    expect(forwardedProxy()).toBe(transport === "Bun" ? "" : undefined);
    expect(alternative).not.toHaveBeenCalled();
    expect(mocks.rawFetch).not.toHaveBeenCalled();
  });

  it("preserves connection no_proxy exclusions", async () => {
    await execute({ proxyOptions: {
      connectionProxyEnabled: true,
      connectionProxyUrl: PROXY,
      connectionNoProxy: "opencode.ai",
    } });

    expect(selected).toHaveBeenCalledOnce();
    expect(forwardedProxy()).toBe(transport === "Bun" ? "" : undefined);
    expect(alternative).not.toHaveBeenCalled();
  });

  it("preserves strict-proxy caller aborts without turning them into retries", async () => {
    selected.mockRejectedValue(new DOMException("cancelled", "AbortError"));
    await expect(execute({ proxyOptions: strictProxy })).rejects.toMatchObject({ name: "AbortError" });
    expect(selected).toHaveBeenCalledOnce();
    expect(alternative).not.toHaveBeenCalled();
  });

  it("honors environment NO_PROXY through the resolver", async () => {
    vi.stubEnv("HTTPS_PROXY", PROXY);
    vi.stubEnv("NO_PROXY", "opencode.ai");
    await execute();
    expect(selected).toHaveBeenCalledOnce();
    expect(forwardedProxy()).toBe(transport === "Bun" ? "" : undefined);
    expect(alternative).not.toHaveBeenCalled();
  });

  it("honors resolved environment proxies", async () => {
    vi.stubEnv("HTTPS_PROXY", PROXY);
    await execute();
    expect(forwardedProxy()).toBe(PROXY);
    expect(alternative).not.toHaveBeenCalled();
  });

  it("does not switch transport after a selected direct adapter fails", async () => {
    selected.mockRejectedValue(new Error("helper or transport unavailable"));
    await expect(execute({ proxyOptions: { forceDirect: true } })).rejects.toThrow(/unavailable/);
    expect(selected).toHaveBeenCalledOnce();
    expect(alternative).not.toHaveBeenCalled();
    expect(mocks.rawFetch).not.toHaveBeenCalled();
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

  it("never changes transport or falls back to direct when the strict proxy fails", async () => {
    selected.mockRejectedValue(new Error("proxy tunnel refused"));

    await expect(execute({ proxyOptions: strictProxy })).rejects.toThrow(/strictProxy=true/);

    expect(selected).toHaveBeenCalledOnce();
    expect(forwardedProxy()).toBe(PROXY);
    expect(alternative).not.toHaveBeenCalled();
    expect(mocks.rawFetch).not.toHaveBeenCalled();
  });

  it("returns a long-reset quota 429 without another transport or retry", async () => {
    const body = JSON.stringify({ type: "error", error: {
      type: "FreeUsageLimitError", message: "Free usage limit reached.",
    } });
    const response = new Response(body, { status: 429, headers: { "retry-after": "32400" } });
    selected.mockResolvedValue(response);
    // A quota response is never retried through the alternative transport.
    const result = await execute({ proxyOptions: strictProxy });

    expect(result.response).toBe(response);
    expect(result.response.status).toBe(429);
    expect(result.response.headers.get("retry-after")).toBe("32400");
    expect(await result.response.text()).toBe(body);
    expect(selected).toHaveBeenCalledOnce();
    expect(alternative).not.toHaveBeenCalled();
    expect(mocks.rawFetch).not.toHaveBeenCalled();
  });
});
