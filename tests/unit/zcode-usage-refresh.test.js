import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connection: null,
  getConnection: vi.fn(), update: vi.fn(), usage: vi.fn(),
  needsRefresh: vi.fn(), refresh: vi.fn(),
}));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getConnection,
  updateProviderConnection: mocks.update,
  getApiKeyById: vi.fn(),
}));
vi.mock("@/lib/apiKeys/quotaScope.js", () => ({ resolveQuotaScope: vi.fn(), connectionInScope: vi.fn() }));
vi.mock("open-sse/services/usage.js", () => ({ getUsageForProvider: mocks.usage }));
vi.mock("open-sse/services/tokenRefresh.js", () => ({
  isUnrecoverableRefreshError: (result) => result?.error === "invalid_grant",
}));
vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: () => ({ needsRefresh: mocks.needsRefresh, refreshCredentials: mocks.refresh }),
}));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: async () => ({}) }));
const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connection = {
    id: "account", provider: "glm", authType: "oauth", apiKey: "static-key.secret",
    accessToken: "old-business-token", refreshToken: "invalid-auxiliary-refresh",
    expiresAt: "2020-01-01T00:00:00Z",
    providerSpecificData: { zcodeJwtToken: "existing-login-jwt" },
  };
  mocks.getConnection.mockImplementation(async () => mocks.connection);
  mocks.needsRefresh.mockReturnValue(true);
  mocks.refresh.mockResolvedValue({ error: "invalid_grant" });
  mocks.usage.mockResolvedValue({ plan: "Start", quotas: {} });
});

const requestQuota = () => GET(new Request("http://localhost/api/usage/account?force=1"), {
  params: Promise.resolve({ connectionId: "account" }),
});

describe("ZCode quota credential independence", () => {
  it.each(["glm", "glm-clone-test"])("reads %s quota without rotating auxiliary OAuth credentials", async (provider) => {
    mocks.connection.provider = provider;
    const snapshot = structuredClone(mocks.connection);
    const response = await requestQuota();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ plan: "Start", quotas: {} });
    expect(mocks.needsRefresh).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.connection).toEqual(snapshot);
    expect(mocks.usage).toHaveBeenCalledWith(mocks.connection, expect.any(Object), { force: true });
  });

  it("returns actual JWT rejection without trying an unrelated OAuth refresh", async () => {
    mocks.usage.mockResolvedValue({ message: "GLM Start Plan JWT invalid or expired." });
    const response = await requestQuota();
    expect(await response.json()).toEqual({ message: "GLM Start Plan JWT invalid or expired." });
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("does not turn not-active balance into success", async () => {
    mocks.usage.mockResolvedValue({ message: "GLM Start Plan not active." });
    const response = await requestQuota();
    expect(await response.json()).toEqual({ message: "GLM Start Plan not active." });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it.each(["codex", "glm"])("preserves refresh failure handling for %s without an independent JWT", async (provider) => {
    const warning = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.connection.provider = provider;
    mocks.connection.providerSpecificData = {};
    try {
      const response = await requestQuota();
      expect(response.status).toBe(401);
      expect((await response.json()).error).toContain("Refresh token invalid or reused");
      expect(mocks.refresh).toHaveBeenCalledTimes(1);
      expect(mocks.usage).not.toHaveBeenCalled();
    } finally { warning.mockRestore(); }
  });
});
