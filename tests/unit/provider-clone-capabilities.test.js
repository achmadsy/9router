import { describe, expect, it, vi } from "vitest";
import { isUsageSupportedProvider, isUsageApiKeyProvider } from "@/shared/constants/providers";
import { supportsNormalProxyOnly } from "@/lib/network/connectionProxy";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { parseQuotaData } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";
import { connectionInScope } from "@/lib/apiKeys/quotaScope";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";
import { getRefreshLeadMs } from "open-sse/services/tokenRefresh.js";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({
      status: init?.status || 200,
      json: async () => body,
    }),
  },
}));

describe("Provider Clone Capability Inheritance", () => {
  it("inherits usage eligibility for duplicate providers", () => {
    expect(isUsageSupportedProvider("codex")).toBe(true);
    expect(isUsageSupportedProvider("codex-clone-12345")).toBe(true);
    expect(isUsageSupportedProvider("claude")).toBe(true);
    expect(isUsageSupportedProvider("claude-clone-xyz")).toBe(true);
    expect(isUsageSupportedProvider("glm")).toBe(true);
    expect(isUsageSupportedProvider("glm-clone-abc")).toBe(true);

    expect(isUsageApiKeyProvider("deepseek")).toBe(true);
    expect(isUsageApiKeyProvider("deepseek-clone-test")).toBe(true);
  });

  it("enforces normal HTTP/SOCKS proxy for GLM clones (rejects relay proxies for CAPTCHA compatibility)", () => {
    expect(supportsNormalProxyOnly("glm")).toBe(true);
    expect(supportsNormalProxyOnly("glm-clone-xyz")).toBe(true);
    expect(supportsNormalProxyOnly("codex")).toBe(false);
    expect(supportsNormalProxyOnly("codex-clone-xyz")).toBe(false);
  });

  it("dispatches getUsageForProvider via runtime base provider handler", async () => {
    const cloneConnection = {
      id: "conn-codex-clone",
      provider: "codex-clone-test",
      accessToken: "fake-token",
      providerSpecificData: {},
    };

    // Upstream fetch will fail gracefully with network error in unit test environment
    const result = await getUsageForProvider(cloneConnection);
    // Should NOT say "Usage API not implemented for codex-clone-test"
    expect(result.message).not.toContain("Usage API not implemented");
  });

  it("parses quota data for duplicate providers using base quota structure", () => {
    const mockCodexUsage = {
      plan: "team",
      quotas: {
        session: { used: 15, total: 100, remaining: 85, resetAt: "2026-08-22T05:00:00.000Z" },
        weekly: { used: 30, total: 100, remaining: 70, resetAt: "2026-08-28T05:00:00.000Z" },
      },
    };

    const parsedBase = parseQuotaData("codex", mockCodexUsage);
    const parsedClone = parseQuotaData("codex-clone-test", mockCodexUsage);

    expect(parsedClone).toEqual(parsedBase);
    expect(parsedClone.some((q) => q.name === "5h")).toBe(true);
    expect(parsedClone.some((q) => q.name === "Weekly")).toBe(true);
  });

  it("evaluates API-key quota scope matching base or clone identifiers", () => {
    const scopeWithBase = {
      isEmpty: false,
      providers: new Set(["codex"]),
      modelIds: new Set(["codex/gpt-5.5"]),
    };
    const cloneConn = { provider: "codex-clone-123" };

    expect(connectionInScope(scopeWithBase, cloneConn)).toBe(true);

    const emptyScope = { isEmpty: true, providers: new Set(), modelIds: new Set() };
    expect(connectionInScope(emptyScope, cloneConn)).toBe(false);
  });

  it("inherits model capabilities from base provider for duplicate", () => {
    const baseCaps = getCapabilitiesForModel("codex", "gpt-5.5");
    const cloneCaps = getCapabilitiesForModel("codex-clone-abc", "gpt-5.5");

    expect(cloneCaps).toEqual(baseCaps);
    expect(cloneCaps.reasoning).toBe(true);
  });

  it("inherits thinking levels for duplicate models", () => {
    const cloneLevels = getThinkingLevels("codex-clone-test", "gpt-5.5");
    const baseLevels = getThinkingLevels("codex", "gpt-5.5");

    expect(cloneLevels).toEqual(baseLevels);
  });

  it("inherits refresh lead time for duplicate providers", () => {
    expect(getRefreshLeadMs("github-clone-test")).toBe(getRefreshLeadMs("github"));
  });

  it("accepts duplicate Codex connection in codex-reset-credits route", async () => {
    const cloneConnection = {
      id: "conn-clone-credits",
      provider: "codex-clone-test",
      authType: "oauth",
      accessToken: "token-1",
      refreshToken: "refresh-1",
      providerSpecificData: {},
    };

    const mocks = {
      getProviderConnectionById: vi.fn().mockResolvedValue(cloneConnection),
      refreshAndUpdateCredentials: vi.fn().mockResolvedValue({ connection: cloneConnection }),
      resolveConnectionProxyConfig: vi.fn().mockResolvedValue({}),
      getCodexRateLimitResetCredits: vi.fn().mockResolvedValue({ availableCount: 1, credits: [] }),
    };

    vi.doMock("@/lib/localDb", () => ({
      getProviderConnectionById: mocks.getProviderConnectionById,
    }));
    vi.doMock("@/lib/network/connectionProxy", () => ({
      resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
    }));
    vi.doMock("@/app/api/usage/[connectionId]/route.js", () => ({
      refreshAndUpdateCredentials: mocks.refreshAndUpdateCredentials,
    }));
    vi.doMock("open-sse/services/usage.js", () => ({
      getCodexRateLimitResetCredits: mocks.getCodexRateLimitResetCredits,
    }));

    const { GET } = await import("../../src/app/api/usage/[connectionId]/codex-reset-credits/route.js");
    const res = await GET(new Request("http://localhost/api/usage/conn-clone-credits/codex-reset-credits"), {
      params: Promise.resolve({ connectionId: "conn-clone-credits" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.availableCount).toBe(1);
  });

  it("accepts duplicate Claude connection in claude-reset route", async () => {
    const cloneConnection = {
      id: "conn-claude-clone",
      provider: "claude-clone-test",
      authType: "oauth",
      accessToken: "token-claude",
      refreshToken: "refresh-claude",
      providerSpecificData: {},
    };

    const mocks = {
      getProviderConnectionById: vi.fn().mockResolvedValue(cloneConnection),
      refreshAndUpdateCredentials: vi.fn().mockResolvedValue({ connection: cloneConnection }),
      resolveConnectionProxyConfig: vi.fn().mockResolvedValue({}),
      consumeClaudeResetGrant: vi.fn().mockResolvedValue({ ok: true, success: true }),
    };

    vi.doMock("@/lib/localDb", () => ({
      getProviderConnectionById: mocks.getProviderConnectionById,
    }));
    vi.doMock("@/lib/network/connectionProxy", () => ({
      resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
    }));
    vi.doMock("@/app/api/usage/[connectionId]/route.js", () => ({
      refreshAndUpdateCredentials: mocks.refreshAndUpdateCredentials,
    }));
    vi.doMock("open-sse/services/usage.js", () => ({
      consumeClaudeResetGrant: mocks.consumeClaudeResetGrant,
    }));

    const { POST } = await import("../../src/app/api/usage/[connectionId]/claude-reset/route.js");
    const res = await POST(new Request("http://localhost/api/usage/conn-claude-clone/claude-reset", { method: "POST" }), {
      params: Promise.resolve({ connectionId: "conn-claude-clone" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });
});
