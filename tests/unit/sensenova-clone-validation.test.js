import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/localDb", () => mocks);
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn().mockResolvedValue({}),
}));
vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { testSingleConnection } from "@/app/api/providers/[id]/test/testUtils.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("SenseNova clone validation", () => {
  it.each([
    ["sensenova-clone-test", "token.sensenova.cn"],
    ["sensenova-intl-clone-test", "token.sensenova.ai"],
  ])("validates %s against its base provider's fixed host", async (provider, host) => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "connection-test",
      provider,
      authType: "apikey",
      apiKey: "test-key",
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testSingleConnection("connection-test");

    expect(result.valid).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(`https://${host}/v1/models`, expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
    }));
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith("connection-test", expect.objectContaining({
      testStatus: "active",
    }));
  });
});
