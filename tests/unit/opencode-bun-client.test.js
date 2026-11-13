import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), Agent: vi.fn(function () {}) }));
vi.mock("undici", () => ({ fetch: mocks.fetch, Agent: mocks.Agent }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("OPENCODE_BUN_TRANSPORT_TOKEN", "test-transport-token");
  vi.stubEnv("OPENCODE_BUN_TRANSPORT_URL", "http://127.0.0.1:29999/fetch");
  vi.stubEnv("OPENCODE_BUN_TRANSPORT_MODE", "");
  vi.stubEnv("OPENCODE_BUN_TRANSPORT_DISABLED", "");
});
afterEach(() => vi.unstubAllEnvs());
const load = () => import("../../open-sse/services/opencodeBunClient.js");
const TARGET = "https://opencode.ai/inference/openai/v1/chat/completions";

describe("OpenCode Bun transport client", () => {
  it("sends an authenticated direct loopback envelope and returns the live stream", async () => {
    const upstream = new Response("data: ok\n\n", { headers: { "content-type": "text/event-stream" } });
    mocks.fetch.mockResolvedValue(upstream);
    const { opencodeBunFetch } = await load();
    const controller = new AbortController();
    const result = await opencodeBunFetch(TARGET, {
      method: "POST", headers: { authorization: "Bearer public" }, body: "{}", signal: controller.signal,
    }, "http://account:secret@proxy.example:8080");
    expect(result).toBe(upstream);
    expect(result.bodyUsed).toBe(false);
    const [url, options] = mocks.fetch.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:29999/fetch");
    expect(options).toMatchObject({ redirect: "manual", signal: controller.signal });
    expect(options.dispatcher).toBeDefined();
    expect(options.headers["x-9r-bun-transport-token"]).toBe("test-transport-token");
    expect(JSON.parse(options.body)).toMatchObject({ url: TARGET, method: "POST", body: "{}", proxyUrl: "http://account:secret@proxy.example:8080" });
    expect(await result.text()).toBe("data: ok\n\n");
  });

  it.each(["disabled", "unavailable"])("does not select a %s managed helper despite a token", async (mode) => {
    vi.stubEnv("OPENCODE_BUN_TRANSPORT_MODE", mode);
    expect((await load()).getOpencodeBunTransportConfig()).toBeNull();
  });

  it("honors explicit disable and requires deliberate configuration outside managed startup", async () => {
    const { getOpencodeBunTransportConfig } = await load();
    vi.stubEnv("OPENCODE_BUN_TRANSPORT_DISABLED", "1");
    expect(getOpencodeBunTransportConfig()).toBeNull();
    vi.stubEnv("OPENCODE_BUN_TRANSPORT_DISABLED", "");
    vi.stubEnv("OPENCODE_BUN_TRANSPORT_URL", "");
    expect(getOpencodeBunTransportConfig()).toBeNull();
    vi.stubEnv("OPENCODE_BUN_TRANSPORT_MODE", "managed");
    expect(getOpencodeBunTransportConfig()?.url).toBe("http://127.0.0.1:20131/fetch");
  });

  it("reads configuration after import but keeps an explicit request snapshot stable", async () => {
    vi.stubEnv("OPENCODE_BUN_TRANSPORT_TOKEN", "");
    const { getOpencodeBunTransportConfig, opencodeBunFetch } = await load();
    expect(getOpencodeBunTransportConfig()).toBeNull();
    vi.stubEnv("OPENCODE_BUN_TRANSPORT_TOKEN", "first-token");
    const snapshot = getOpencodeBunTransportConfig();
    vi.stubEnv("OPENCODE_BUN_TRANSPORT_TOKEN", "second-token");
    vi.stubEnv("OPENCODE_BUN_TRANSPORT_URL", "http://127.0.0.1:28888/fetch");
    mocks.fetch.mockResolvedValue(new Response("ok"));
    await opencodeBunFetch(TARGET, { body: "{}" }, "", snapshot);
    expect(mocks.fetch.mock.calls[0][0]).toBe("http://127.0.0.1:29999/fetch");
    expect(mocks.fetch.mock.calls[0][1].headers["x-9r-bun-transport-token"]).toBe("first-token");
  });

  it.each([
    "http://remote.example/fetch", "http://localhost/fetch", "https://127.0.0.1/fetch",
    "http://user:password@127.0.0.1/fetch", "http://127.0.0.1/other", "http://127.0.0.1/fetch?token=secret",
  ])("rejects unsafe helper endpoint %s without dispatch or secret output", async (url) => {
    vi.stubEnv("OPENCODE_BUN_TRANSPORT_URL", url);
    const { opencodeBunFetch } = await load();
    await expect(opencodeBunFetch(TARGET)).rejects.toThrow(/^Invalid OpenCode Bun loopback endpoint$/);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("fails closed on missing managed token", async () => {
    vi.stubEnv("OPENCODE_BUN_TRANSPORT_MODE", "managed");
    vi.stubEnv("OPENCODE_BUN_TRANSPORT_TOKEN", "");
    await expect((await load()).opencodeBunFetch(TARGET)).rejects.toThrow(/token is not configured/);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("does not expose credentials in network or marked helper errors", async () => {
    const { opencodeBunFetch } = await load();
    mocks.fetch.mockRejectedValueOnce(new Error("http://account:secret@proxy.example test-transport-token"));
    await expect(opencodeBunFetch(TARGET)).rejects.toThrow(/^OpenCode Bun transport unavailable$/);
    mocks.fetch.mockResolvedValueOnce(new Response("account:secret test-transport-token", {
      status: 502, headers: { "x-9r-bun-transport-error": "1" },
    }));
    await expect(opencodeBunFetch(TARGET)).rejects.toThrow(/^OpenCode Bun upstream transport failed$/);
  });

  it("preserves cancellation as AbortError rather than a retryable helper error", async () => {
    const controller = new AbortController();
    controller.abort(new Error("caller cancellation detail"));
    mocks.fetch.mockRejectedValueOnce(controller.signal.reason);
    await expect((await load()).opencodeBunFetch(TARGET, { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it.each([429, 307])("returns provider status %s unchanged without retry/follow", async (status) => {
    const response = new Response("provider reply", { status, headers: { "retry-after": "32400", location: "https://other.example" } });
    mocks.fetch.mockResolvedValue(response);
    expect(await (await load()).opencodeBunFetch(TARGET)).toBe(response);
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });
});
