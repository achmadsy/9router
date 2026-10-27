// HIGH: OpenCode proxy-scoped isolation — proxy A block ≠ proxy B, round-robin skips blocked.
import { describe, it, expect, beforeEach, vi } from "vitest";

const { settingsMock, pickProxyPoolIdMock } = vi.hoisted(() => ({
  settingsMock: vi.fn(async () => ({ providerStrategies: { opencode: { rotateStrategy: "round-robin" } } })),
  pickProxyPoolIdMock: vi.fn((poolIds) => poolIds[0] || null),
}));

vi.mock("@/lib/db/index.js", () => ({
  getProviderConnections: vi.fn(async () => []),
  updateProviderConnection: vi.fn(async (id, data) => ({ id, ...data })),
  getSettings: settingsMock,
  getProxyPools: vi.fn(async () => ([
    { id: "pool-a", name: "CN A", proxyUrl: "http://a:1", isActive: true },
    { id: "pool-b", name: "CN B", proxyUrl: "http://b:2", isActive: true },
    { id: "pool-c", name: "CN C", proxyUrl: "http://c:3", isActive: true },
  ])),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(async () => []),
  updateProviderConnection: vi.fn(async (id, data) => ({ id, ...data })),
  validateApiKey: vi.fn(async () => true),
  getSettings: settingsMock,
  getProxyPools: vi.fn(async () => ([
    { id: "pool-a", name: "CN A", proxyUrl: "http://a:1", isActive: true },
    { id: "pool-b", name: "CN B", proxyUrl: "http://b:2", isActive: true },
    { id: "pool-c", name: "CN C", proxyUrl: "http://c:3", isActive: true },
  ])),
}));

vi.mock("@/lib/db/repos/selfAwareRepo.js", () => {
  const store = new Map();
  return {
    upsertCooldown: vi.fn(async (entry) => {
      const key = `${entry.provider}|${entry.model || ""}|${entry.scopeType}|${entry.scopeId}`;
      const row = { id: `id-${key}`, ...entry, expiresAt: new Date(entry.expiresAtMs).toISOString() };
      store.set(key, row);
      return row;
    }),
    getSelfAwarePolicy: vi.fn(() => null),
    listActiveCooldowns: vi.fn((nowMs = Date.now()) =>
      [...store.values()].filter((r) => new Date(r.expiresAt).getTime() > nowMs)),
    listCooldownsForScopes: vi.fn((provider, model, scopeType, scopeIds, nowMs = Date.now()) =>
      [...store.values()].filter((r) =>
        r.provider === provider && (r.model || "") === (model || "") &&
        r.scopeType === scopeType && scopeIds.includes(r.scopeId) &&
        new Date(r.expiresAt).getTime() > nowMs)),
    deleteCooldown: vi.fn(async () => true),
    deleteByScope: vi.fn(async (provider, model, scopeType, scopeId) => {
      for (const [key, row] of store) {
        if (row.provider === provider && row.scopeType === scopeType && row.scopeId === scopeId &&
            (model == null || (row.model || "") === (model || ""))) {
          store.delete(key);
        }
      }
      return true;
    }),
    deleteAllActive: vi.fn(async () => { const n = store.size; store.clear(); return n; }),
    purgeExpired: vi.fn(async () => 0),
    __store: store,
  };
});

vi.mock("@/lib/network/connectionProxy.js", () => ({
  resolveConnectionProxyConfig: vi.fn(async ({ proxyPoolId }) => ({
    connectionProxyEnabled: !!proxyPoolId,
    connectionProxyUrl: proxyPoolId ? "http://proxy.local:8080" : "",
    connectionNoProxy: "",
    proxyPoolId: proxyPoolId || null,
  })),
  pickProxyPoolId: pickProxyPoolIdMock,
}));

vi.mock("@/models", () => ({
  getProxyPools: vi.fn(async () => ([
    { id: "pool-a", name: "CN A", proxyUrl: "http://a:1", isActive: true },
    { id: "pool-b", name: "CN B", proxyUrl: "http://b:2", isActive: true },
    { id: "pool-c", name: "CN C", proxyUrl: "http://c:3", isActive: true },
  ])),
}));
vi.mock("@/models/index.js", () => ({
  getProxyPools: vi.fn(async () => ([
    { id: "pool-a", name: "CN A", proxyUrl: "http://a:1", isActive: true },
    { id: "pool-b", name: "CN B", proxyUrl: "http://b:2", isActive: true },
    { id: "pool-c", name: "CN C", proxyUrl: "http://c:3", isActive: true },
  ])),
}));
vi.mock("@/models/proxyPools.js", () => ({
  getProxyPools: vi.fn(async () => ([
    { id: "pool-a", name: "CN A", proxyUrl: "http://a:1", isActive: true },
    { id: "pool-b", name: "CN B", proxyUrl: "http://b:2", isActive: true },
    { id: "pool-c", name: "CN C", proxyUrl: "http://c:3", isActive: true },
  ])),
}));

let auth;
let repoMock;

beforeEach(async () => {
  vi.resetModules();
  process.env.DATA_DIR = "/tmp/self-aware-opencode-test";
  repoMock = await import("@/lib/db/repos/selfAwareRepo.js");
  repoMock.__store.clear();
  settingsMock.mockReset();
  settingsMock.mockResolvedValue({ providerStrategies: { opencode: { rotateStrategy: "round-robin" } } });
  pickProxyPoolIdMock.mockClear();
  pickProxyPoolIdMock.mockImplementation((poolIds) => poolIds[0] || null);
  auth = await import("@/sse/services/auth.js");
});

describe("OpenCode proxy-scope isolation", () => {
  it("classifies only native-client no-tool FreeUsageLimitError as auxiliary", () => {
    const base = {
      provider: "opencode",
      userAgent: "opencode/latest/2.1.2/cli",
      body: { messages: [{ role: "user", content: "title" }] },
      status: 429,
      errorText: "[429]: FreeUsageLimitError",
    };
    expect(auth.isOpenCodeAuxiliaryFreeLimit(base)).toBe(true);
    expect(auth.isOpenCodeAuxiliaryFreeLimit({ ...base, body: { ...base.body, tools: [{ type: "function" }] } })).toBe(false);
    expect(auth.isOpenCodeAuxiliaryFreeLimit({ ...base, userAgent: "claude-code/2.1.0" })).toBe(false);
    expect(auth.isOpenCodeAuxiliaryFreeLimit({ ...base, errorText: "ordinary rate limit" })).toBe(false);
    expect(auth.isOpenCodeAuxiliaryFreeLimit({ ...base, provider: "glm" })).toBe(false);
  });

  it("marks cooldown on selected proxy identity, no fake connection rows, no modelLock", async () => {
    const result = await auth.markAccountUnavailable({
      credentials: {
        // Real OpenCode noauth shape: id only, no connectionId field.
        id: "noauth", provider: "opencode",
        providerSpecificData: {
          cooldownTarget: { scopeType: "proxy", scopeId: "pool-a", proxyPoolId: "pool-a" },
        },
      },
      status: 429,
      errorText: "too many requests",
      provider: "opencode",
      model: "glm-4.6",
      cooldownHint: {
        source: "upstream-header", headerName: "Retry-After",
        expiresAtMs: Date.now() + 30_000, durationMs: 30_000,
      },
    });
    expect(result.shouldFallback).toBe(true);
    const rows = [...repoMock.__store.values()];
    expect(rows).toHaveLength(1);
    // scope from cooldownTarget — proxy identity, not a fake connection row
    expect(rows[0].scopeType).toBe("proxy");
    expect(rows[0].scopeId).toBe("pool-a");
    expect(rows[0].source).toBe("upstream-header");
    // Real noauth shape (id: "noauth", no connectionId) must still reach proxy-cooldown recording
    expect(rows[0].provider).toBe("opencode");
  });

  it("caps OpenCode upstream reset headers to a 90-second re-probe", async () => {
    const result = await auth.markAccountUnavailable({
      credentials: {
        id: "noauth", provider: "opencode",
        providerSpecificData: {
          cooldownTarget: { scopeType: "proxy", scopeId: "pool-a", proxyPoolId: "pool-a" },
        },
      },
      status: 429,
      errorText: "FreeUsageLimitError",
      provider: "opencode",
      model: "glm-5.3-flash-free",
      cooldownHint: {
        source: "upstream-header", headerName: "Retry-After",
        expiresAtMs: Date.now() + 12 * 60 * 60 * 1000,
        durationMs: 12 * 60 * 60 * 1000,
      },
    });

    expect(result).toEqual({ shouldFallback: true, cooldownMs: 90_000 });
    const row = [...repoMock.__store.values()][0];
    const remainingMs = new Date(row.expiresAt).getTime() - Date.now();
    expect(remainingMs).toBeGreaterThanOrEqual(89_000);
    expect(remainingMs).toBeLessThanOrEqual(90_000);
    expect(row.source).toBe("upstream-header");
  });

  it("preserves ordinary OpenCode 429 cooldowns that are not FreeUsageLimitError", async () => {
    const result = await auth.markAccountUnavailable({
      credentials: {
        id: "noauth", provider: "opencode",
        providerSpecificData: {
          cooldownTarget: { scopeType: "proxy", scopeId: "pool-a", proxyPoolId: "pool-a" },
        },
      },
      status: 429,
      errorText: "ordinary rate limit",
      provider: "opencode",
      model: "glm-5.3-flash-free",
      cooldownHint: {
        source: "upstream-header", headerName: "Retry-After",
        expiresAtMs: Date.now() + 5 * 60 * 1000,
        durationMs: 5 * 60 * 1000,
      },
    });

    expect(result).toEqual({ shouldFallback: true, cooldownMs: 5 * 60 * 1000 });
  });

  it("successful noauth request clears its matching OpenCode proxy cooldown", async () => {
    await repoMock.upsertCooldown({
      provider: "opencode", model: "glm-5.3-flash-free", scopeType: "proxy", scopeId: "pool-a",
      expiresAtMs: Date.now() + 90_000, source: "upstream-header",
    });

    await auth.clearAccountError("noauth", {
      id: "noauth",
      provider: "opencode",
      providerSpecificData: {
        cooldownTarget: { scopeType: "proxy", scopeId: "pool-a", proxyPoolId: "pool-a" },
      },
    }, "glm-5.3-flash-free");

    expect(repoMock.__store.size).toBe(0);
  });

  it("proxy A blocked does not block proxy B", async () => {
    await repoMock.upsertCooldown({
      provider: "opencode", model: "glm-4.6", scopeType: "proxy", scopeId: "pool-a",
      expiresAtMs: Date.now() + 60_000, source: "upstream-header",
    });
    const { getActiveProxyCooldownMap } = await import("@/sse/services/selfAwareCooldown.js");
    const map = await getActiveProxyCooldownMap("opencode", "glm-4.6", ["pool-a", "pool-b", "pool-c"]);
    expect(map.has("pool-a")).toBe(true);
    expect(map.has("pool-b")).toBe(false);
    expect(map.has("pool-c")).toBe(false);
  });

  it("all proxies blocked → allRateLimited with earliest expiry", async () => {
    const now = Date.now();
    await repoMock.upsertCooldown({
      provider: "opencode", model: "glm-4.6", scopeType: "proxy", scopeId: "pool-a",
      expiresAtMs: now + 20_000, source: "upstream-header",
    });
    await repoMock.upsertCooldown({
      provider: "opencode", model: "glm-4.6", scopeType: "proxy", scopeId: "pool-b",
      expiresAtMs: now + 40_000, source: "upstream-header",
    });
    await repoMock.upsertCooldown({
      provider: "opencode", model: "glm-4.6", scopeType: "proxy", scopeId: "pool-c",
      expiresAtMs: now + 10_000, source: "upstream-header",
    });

    const creds = await auth.getProviderCredentials("opencode", null, "glm-4.6");
    expect(creds.allRateLimited).toBe(true);
    const earliest = new Date(creds.retryAfter).getTime();
    expect(Math.abs(earliest - (now + 10_000))).toBeLessThanOrEqual(1000);
  });

  it("round-robin ignores the saved single-pool selection while rotation is active", async () => {
    settingsMock.mockResolvedValue({
      providerStrategies: {
        opencode: {
          proxyPoolId: "pool-a",
          rotateStrategy: "round-robin",
          rotatePoolIds: ["pool-a", "pool-b", "pool-c"],
        },
      },
    });
    pickProxyPoolIdMock.mockReturnValue("pool-b");

    const creds = await auth.getProviderCredentials("opencode", null, "glm-4.6");

    expect(pickProxyPoolIdMock).toHaveBeenCalledWith(
      ["pool-a", "pool-b", "pool-c"],
      "round-robin",
      "opencode",
    );
    expect(creds.providerSpecificData.connectionProxyPoolId).toBe("pool-b");
  });

  it("provider clones inherit the no-auth OpenCode proxy path", async () => {
    settingsMock.mockResolvedValue({
      providerStrategies: {
        "opencode-clone-test": {
          rotateStrategy: "round-robin",
          rotatePoolIds: ["pool-a", "pool-b"],
        },
      },
    });
    pickProxyPoolIdMock.mockReturnValue("pool-b");

    const creds = await auth.getProviderCredentials("opencode-clone-test", null, "glm-4.6");

    expect(creds.id).toBe("noauth");
    expect(creds.provider).toBe("opencode-clone-test");
    expect(creds.providerSpecificData.connectionProxyPoolId).toBe("pool-b");
  });

  it("round-robin skips blocked proxy", async () => {
    const now = Date.now();
    await repoMock.upsertCooldown({
      provider: "opencode", model: "glm-4.6", scopeType: "proxy", scopeId: "pool-a",
      expiresAtMs: now + 60_000, source: "upstream-header",
    });

    const { getActiveProxyCooldownMap } = await import("@/sse/services/selfAwareCooldown.js");
    const map = await getActiveProxyCooldownMap("opencode", "glm-4.6", ["pool-a", "pool-b", "pool-c"]);
    const eligible = ["pool-a", "pool-b", "pool-c"].filter((id) => !map.has(id));
    expect(eligible).toEqual(["pool-b", "pool-c"]);

    // free selection returns eligible non-blocked pool
    const creds = await auth.getProviderCredentials("opencode", null, "glm-4.6");
    expect(creds.allRateLimited).toBeFalsy();
    const picked = creds.providerSpecificData?.cooldownTarget?.scopeId;
    expect(picked).toBeTruthy();
    expect(picked).not.toBe("pool-a");
  });

  it("401 does not create proxy cooldown (manual does not override auth errors)", async () => {
    const result = await auth.markAccountUnavailable({
      credentials: { id: "noauth", provider: "opencode" },
      status: 401,
      errorText: "unauthorized",
      provider: "opencode",
      model: "glm-4.6",
    });
    expect(result.shouldFallback).toBe(false);
    expect(repoMock.__store.size).toBe(0);
  });
});
