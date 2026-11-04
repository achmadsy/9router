import { describe, expect, it, vi } from "vitest";
vi.mock("@/models", () => ({
  createProxyPool: vi.fn(), getProviderConnections: vi.fn(),
  getProxyPools: vi.fn(async () => [{ id: "pool-one", name: "Private pool", type: "http", proxyUrl: "http://user:password-canary@proxy.test:3128", noProxy: "private.test", isActive: true }]),
}));
const { GET } = await import("../../src/app/api/proxy-pools/route.js");

describe("proxy selector safe metadata", () => {
  it("returns pool names and ids without proxy URLs or credentials", async () => {
    const result = await GET(new Request("http://localhost/api/proxy-pools?isActive=true&metadataOnly=true"));
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ proxyPools: [{ id: "pool-one", name: "Private pool", type: "http" }] });
  });
});
