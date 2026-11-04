import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
afterEach(() => vi.unstubAllEnvs());
const mocks = vi.hoisted(() => ({ pools: {} }));
vi.mock("@/models", () => ({ getProxyPoolById: vi.fn(async (id) => mocks.pools[id]) }));
const { resolveZaiNetwork, zaiNetworkConnectionData, zaiCaptchaProxyUrl } = await import("../../src/lib/zcode/network.js");
const { planInspectionKey } = await import("../../src/lib/zcode/planInspections.js");

beforeEach(() => {
  mocks.pools = { private: { id: "private", name: "Account Pool", isActive: true, proxyUrl: "http://user:password@proxy.test:3128" } };
});

describe("explicit Z.AI network selection", () => {
  it("uses the account pool and exposes only safe metadata", async () => {
    const selected = await resolveZaiNetwork("account", { proxyPoolId: "private" });
    expect(selected.proxyOptions).toMatchObject({ connectionProxyEnabled: true, strictProxy: true });
    expect(selected.network).toMatchObject({ source: "pool", poolId: "private", label: "Proxy pool: Account Pool" });
    expect(JSON.stringify(selected.network)).not.toMatch(/password|proxy\.test/);
  });
  it("keeps server default distinct from explicit direct", async () => {
    expect((await resolveZaiNetwork()).network.source).toBe("default");
    expect((await resolveZaiNetwork("direct", { proxyPoolId: "private" })).proxyOptions).toEqual({ forceDirect: true, connectionProxyEnabled: false });
  });
  it("does not let a saved direct preference silently override a later assigned proxy", async () => {
    const selected = await resolveZaiNetwork("account", { zaiPlanNetworkRoute: "direct", proxyPoolId: "private" });
    expect(selected.network.source).toBe("pool");
  });
  it.each(["missing", "inactive", "relay", "socks"])("rejects %s selected pools without fallback", async (id) => {
    mocks.pools.inactive = { ...mocks.pools.private, isActive: false };
    mocks.pools.relay = { ...mocks.pools.private, type: "vercel" };
    mocks.pools.socks = { ...mocks.pools.private, proxyUrl: "socks5://proxy.test:1080" };
    await expect(resolveZaiNetwork(id)).rejects.toMatchObject({ status: 400 });
  });
  it("isolates direct and environment-proxy inspection/balance caches", () => {
    const direct = planInspectionKey("fake-jwt", { connectionProxyEnabled: false, forceDirect: true }, "account-1");
    const fallback = planInspectionKey("fake-jwt", { connectionProxyEnabled: false }, "account-1");
    expect(direct).not.toBe(fallback);
  });
  it("rejects a pool whose bypass list would select another egress for Z.AI", async () => {
    mocks.pools.private.noProxy = ".z.ai";
    await expect(resolveZaiNetwork("private")).rejects.toThrow("bypass list excludes Z.AI");
  });
  it.each(["http://user:password@proxy.test", "", {}, "id with spaces"])("rejects arbitrary proxy URLs or malformed route input (%j)", async (value) => {
    await expect(resolveZaiNetwork(value)).rejects.toMatchObject({ status: 400, message: "Invalid Z.AI network route" });
  });
  it("binds CAPTCHA to the selected account/direct/environment route", () => {
    vi.stubEnv("HTTPS_PROXY", "http://env.test:3128");
    vi.stubEnv("NO_PROXY", ""); vi.stubEnv("no_proxy", "");
    expect(zaiCaptchaProxyUrl({})).toBe("http://env.test:3128");
    expect(zaiCaptchaProxyUrl({ forceDirect: true })).toBe("");
    expect(zaiCaptchaProxyUrl({ connectionProxyEnabled: true, connectionProxyUrl: "http://account.test:3128" })).toBe("http://account.test:3128");
    vi.stubEnv("NO_PROXY", ".z.ai");
    expect(zaiCaptchaProxyUrl({})).toBe("");
  });
  it("stores selection without duplicating pool secrets", () => {
    expect(zaiNetworkConnectionData("private")).toEqual({ proxyPoolId: "private" });
    expect(zaiNetworkConnectionData("account")).toEqual({});
    expect(zaiNetworkConnectionData("direct")).toEqual({ zaiPlanNetworkRoute: "direct" });
  });
});
