import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
async function load(fetchMock) {
  vi.resetModules();
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
    expect(fetch.mock.calls[0][1].dispatcher).toBeUndefined();
    await proxyFetch("https://api.z.ai/api/auth/z/login", {}, { connectionProxyEnabled: false });
    expect(fetch.mock.calls[1][1].dispatcher).toBeDefined();
  });
  it.each([{ strictProxy: true }, { proxyPoolId: "private" }, { connectionProxyEnabled: true }, { vercelRelayUrl: "https://relay.test" }])(
    "rejects contradictory direct and proxy policy: %j", async (policy) => {
      const fetch = vi.fn();
      const proxyFetch = await load(fetch);
      await expect(proxyFetch("https://api.z.ai", {}, { ...policy, forceDirect: true })).rejects.toThrow("conflicts");
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("does not retry a selected proxy request directly on failure", async () => {
    const fetch = vi.fn(async () => { throw new Error("proxy connect failed"); });
    const proxyFetch = await load(fetch);
    await expect(proxyFetch("https://api.z.ai", {}, { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.test:3128", strictProxy: true })).rejects.toThrow("Proxy required but failed");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
