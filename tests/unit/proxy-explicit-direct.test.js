import { afterEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ fetch: null }));
vi.mock("undici", async (importOriginal) => ({
  ...await importOriginal(),
  fetch: (...args) => transport.fetch(...args),
}));

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
async function load(fetchMock) {
  vi.resetModules();
  transport.fetch = fetchMock;
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("HTTPS_PROXY", "http://env-proxy.test:3128");
  vi.stubEnv("NO_PROXY", "");
  vi.stubEnv("no_proxy", "");
  return (await import("../../open-sse/utils/proxyFetch.js")).proxyAwareFetch;
}

describe("proxy transport explicit direct mode", () => {
  it("bypasses environment proxies only when explicitly requested", async () => {
    const fetch = vi.fn(async () => new Response("ok"));
    const proxyFetch = await load(fetch);
    await proxyFetch("https://api.z.ai/api/auth/z/login", {}, { forceDirect: true });
    const directDispatcher = fetch.mock.calls[0][1].dispatcher;
    expect(directDispatcher).toBeDefined();
    await proxyFetch("https://api.z.ai/api/auth/z/login", {}, { connectionProxyEnabled: false });
    expect(fetch.mock.calls[1][1].dispatcher).toBeDefined();
    expect(fetch.mock.calls[1][1].dispatcher).not.toBe(directDispatcher);
  });
  it.each([{ strictProxy: true }, { proxyPoolId: "private" }, { connectionProxyEnabled: true }, { vercelRelayUrl: "https://relay.test" }])(
    "rejects contradictory direct and proxy policy: %j", async (policy) => {
      const fetch = vi.fn();
      const proxyFetch = await load(fetch);
      await expect(proxyFetch("https://api.z.ai", {}, { ...policy, forceDirect: true })).rejects.toThrow("conflicts");
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("keeps certificate verification enabled unless explicitly opted out", async () => {
    const error = new Error("certificate rejected", { cause: { code: "CERT_HAS_EXPIRED" } });
    const fetch = vi.fn(async () => { throw error; });
    const proxyFetch = await load(fetch);
    vi.stubEnv("STRICT_SSL", "");
    await expect(proxyFetch("https://api.z.ai", {}, { forceDirect: true })).rejects.toBe(error);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("never disables certificate verification for strict-TLS requests", async () => {
    const error = new Error("certificate rejected", { cause: { code: "CERT_HAS_EXPIRED" } });
    const fetch = vi.fn(async () => { throw error; });
    const proxyFetch = await load(fetch);
    vi.stubEnv("STRICT_SSL", "false");
    await expect(proxyFetch("https://api.z.ai", { strictTls: true }, { forceDirect: true })).rejects.toBe(error);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry a selected proxy request directly on failure", async () => {
    const fetch = vi.fn(async () => { throw new Error("proxy connect failed"); });
    const proxyFetch = await load(fetch);
    await expect(proxyFetch("https://api.z.ai", {}, { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.test:3128", strictProxy: true })).rejects.toThrow("Proxy required but failed");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
