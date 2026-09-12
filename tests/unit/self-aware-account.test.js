// HIGH: markAccountUnavailable — modelLock unchanged, header expiry, sidecar match/fail.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const NOW = Date.now();

const sharedConns = [];

vi.mock("@/lib/db/index.js", () => ({
  getProviderConnections: vi.fn(async (filter = {}) => {
    if (filter.id) return sharedConns.filter((c) => c.id === filter.id);
    if (filter.provider) return sharedConns.filter((c) => c.provider === filter.provider);
    return [...sharedConns];
  }),
  updateProviderConnection: vi.fn(async (id, data) => {
    const c = sharedConns.find((x) => x.id === id);
    if (c) Object.assign(c, data);
    return c;
  }),
  validateApiKey: vi.fn(async () => true),
  getSettings: vi.fn(async () => ({})),
  getProxyPools: vi.fn(async () => []),
  __setConnections(list) {
    sharedConns.length = 0;
    sharedConns.push(...list);
  },
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(async (filter = {}) => {
    if (filter.id) return sharedConns.filter((c) => c.id === filter.id);
    if (filter.provider) return sharedConns.filter((c) => c.provider === filter.provider);
    return [...sharedConns];
  }),
  updateProviderConnection: vi.fn(async (id, data) => {
    const c = sharedConns.find((x) => x.id === id);
    if (c) Object.assign(c, data);
    return c;
  }),
  validateApiKey: vi.fn(async () => true),
  getSettings: vi.fn(async () => ({})),
  getProxyPools: vi.fn(async () => []),
}));

vi.mock("@/lib/db/repos/selfAwareRepo.js", () => {
  const store = new Map();
  let failWrites = false;
  return {
    upsertCooldown: vi.fn(async (entry) => {
      if (failWrites) throw new Error("disk full");
      const key = `${entry.provider}|${entry.model || ""}|${entry.scopeType || "account"}|${entry.scopeId}`;
      const row = { id: entry.id || `id-${store.size}`, ...entry, expiresAt: new Date(entry.expiresAtMs).toISOString() };
      store.set(key, row);
      return row;
    }),
    getSelfAwarePolicy: vi.fn(() => null),
    listActiveCooldowns: vi.fn(() => [...store.values()]),
    listCooldownsForScopes: vi.fn(() => []),
    deleteCooldown: vi.fn(async (id) => {
      for (const [k, v] of store) if (v.id === id) { store.delete(k); return true; }
      return false;
    }),
    deleteByScope: vi.fn(async (provider, model, scopeType, scopeId) => {
      for (const [k, v] of store) {
        if (v.provider === provider && v.scopeType === scopeType && v.scopeId === scopeId &&
            (model == null || (v.model || "") === (model || ""))) {
          store.delete(k);
        }
      }
      return true;
    }),
    deleteAllActive: vi.fn(async () => { const n = store.size; store.clear(); return n; }),
    purgeExpired: vi.fn(async () => 0),
    __setFailWrites(v) { failWrites = v; },
    __store: store,
  };
});

vi.mock("@/lib/network/connectionProxy.js", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({
    connectionProxyEnabled: false, connectionProxyUrl: "", connectionNoProxy: "", proxyPoolId: null,
  })),
  pickProxyPoolId: vi.fn(() => null),
}));

vi.mock("@/models", () => ({
  getProxyPools: vi.fn(async () => []),
}));

let auth;
let dbMock;
let repoMock;

beforeEach(async () => {
  vi.resetModules();
  process.env.DATA_DIR = "/tmp/self-aware-account-test";
  dbMock = await import("@/lib/db/index.js");
  repoMock = await import("@/lib/db/repos/selfAwareRepo.js");
  auth = await import("@/sse/services/auth.js");
  dbMock.__setConnections([{
    id: "conn-1", provider: "openai", displayName: "OpenAI Main",
    backoffLevel: 0, isActive: true,
  }]);
  repoMock.__store.clear();
  repoMock.__setFailWrites(false);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("markAccountUnavailable — modelLock + sidecar", () => {
  it("writes modelLock_* with header expiry and sidecar matching expiry within 1s", async () => {
    const expiresAtMs = NOW + 45_000;
    const result = await auth.markAccountUnavailable({
      credentials: { id: "conn-1", connectionId: "conn-1", provider: "openai" },
      status: 429,
      errorText: "Rate limit exceeded",
      provider: "openai",
      model: "gpt-4o",
      cooldownHint: {
        source: "upstream-header", headerName: "Retry-After",
        expiresAtMs, durationMs: 45_000, format: "delta-seconds",
      },
    });
    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBe(45_000);

    const conns = await dbMock.getProviderConnections({ id: "conn-1" });
    const conn = conns[0];
    const lockVal = conn?.["modelLock_gpt-4o"];
    expect(lockVal).toBeTruthy();
    const lockMs = new Date(lockVal).getTime();
    expect(Math.abs(lockMs - expiresAtMs)).toBeLessThanOrEqual(1000);

    const sidecar = [...repoMock.__store.values()].find((r) => r.provider === "openai");
    expect(sidecar).toBeTruthy();
    expect(sidecar.source).toBe("upstream-header");
    expect(sidecar.headerName).toBe("Retry-After");
    expect(Math.abs(new Date(sidecar.expiresAt).getTime() - lockMs)).toBeLessThanOrEqual(1000);
  });

  it("HIGH-1: awaits getSelfAwarePolicy — manual policy timeoutMs actually applies on 429", async () => {
    // Real repo returns a Promise; the bug was calling without await so timeoutMs was always undefined.
    repoMock.getSelfAwarePolicy.mockResolvedValueOnce({
      id: "pol-1", provider: "openai", model: "gpt-4o",
      timeoutMs: 90_000, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const result = await auth.markAccountUnavailable({
      credentials: { id: "conn-1", connectionId: "conn-1", provider: "openai" },
      status: 429, errorText: "rate limit exceeded", provider: "openai", model: "gpt-4o",
    });
    expect(repoMock.getSelfAwarePolicy).toHaveBeenCalledWith("openai", "gpt-4o");
    expect(result.shouldFallback).toBe(true);
    const rows = [...repoMock.__store.values()];
    expect(rows[0].source).toBe("manual-policy");
    const expiry = new Date(rows[0].expiresAt).getTime();
    expect(expiry).toBeGreaterThanOrEqual(Date.now() + 89_000);
    expect(expiry).toBeLessThanOrEqual(Date.now() + 91_000);
  });

  it("clone provider inherits base manual policy when no clone-specific row", async () => {
    dbMock.__setConnections([{
      id: "conn-clone", provider: "codex-clone-abc", displayName: "Codex Dup",
      backoffLevel: 0, isActive: true,
    }]);
    repoMock.getSelfAwarePolicy.mockImplementation(async (provider, model) => {
      if (provider === "codex" && model === "gpt-5") {
        return {
          id: "pol-base", provider: "codex", model: "gpt-5",
          timeoutMs: 90_000, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        };
      }
      return null;
    });
    const result = await auth.markAccountUnavailable({
      credentials: { id: "conn-clone", connectionId: "conn-clone", provider: "codex-clone-abc" },
      status: 429, errorText: "rate limit exceeded",
      provider: "codex-clone-abc", model: "gpt-5",
    });
    expect(repoMock.getSelfAwarePolicy).toHaveBeenCalledWith("codex-clone-abc", "gpt-5");
    expect(repoMock.getSelfAwarePolicy).toHaveBeenCalledWith("codex", "gpt-5");
    expect(result.shouldFallback).toBe(true);
    const sidecar = [...repoMock.__store.values()][0];
    expect(sidecar.provider).toBe("codex-clone-abc");
    expect(sidecar.source).toBe("manual-policy");
    expect(sidecar.scopeId).toBe("conn-clone");
    const conn = (await dbMock.getProviderConnections({ provider: "codex-clone-abc" }))[0];
    expect(conn["modelLock_gpt-5"]).toBeTruthy();
  });

  it("sidecar write failure leaves lock authoritative", async () => {
    repoMock.__setFailWrites(true);
    const result = await auth.markAccountUnavailable({
      credentials: { id: "conn-1", connectionId: "conn-1", provider: "openai" },
      status: 429,
      errorText: "Rate limit",
      provider: "openai",
      model: "gpt-4o",
      cooldownHint: {
        source: "upstream-header", headerName: "Retry-After",
        expiresAtMs: Date.now() + 30_000, durationMs: 30_000,
      },
    });
    expect(result.shouldFallback).toBe(true);
    const conns = await dbMock.getProviderConnections({ id: "conn-1" });
    expect(conns[0]["modelLock_gpt-4o"]).toBeTruthy();
    expect(repoMock.__store.size).toBe(0);
  });

  it("success on one model clears only current model sidecar", async () => {
    await auth.markAccountUnavailable({
      credentials: { id: "conn-1", connectionId: "conn-1", provider: "openai" },
      status: 429, errorText: "rl", provider: "openai", model: "gpt-4o",
      cooldownHint: { source: "upstream-header", headerName: "Retry-After", expiresAtMs: Date.now() + 20_000, durationMs: 20_000 },
    });
    await auth.markAccountUnavailable({
      credentials: { id: "conn-1", connectionId: "conn-1", provider: "openai" },
      status: 429, errorText: "rl", provider: "openai", model: "gpt-4o-mini",
      cooldownHint: { source: "upstream-header", headerName: "Retry-After", expiresAtMs: Date.now() + 10_000, durationMs: 10_000 },
    });
    expect(repoMock.__store.size).toBe(2);

    await auth.clearAccountError("conn-1", { id: "conn-1", provider: "openai" }, "gpt-4o");
    const models = [...repoMock.__store.values()].map((r) => r.model);
    expect(models).toEqual(["gpt-4o-mini"]);
  });

  it("activation (testStatus active) clears matching account sidecars", async () => {
    await auth.markAccountUnavailable({
      credentials: { id: "conn-1", connectionId: "conn-1", provider: "openai" },
      status: 429, errorText: "rl", provider: "openai", model: "gpt-4o",
      cooldownHint: { source: "upstream-header", headerName: "Retry-After", expiresAtMs: Date.now() + 15_000, durationMs: 15_000 },
    });
    expect(repoMock.__store.size).toBe(1);
    await dbMock.updateProviderConnection("conn-1", { testStatus: "active" });
    // updateProviderConnection (real) clears sidecars; mock path: call service clear
    await (await import("@/sse/services/selfAwareCooldown.js")).clearSelfAwareCooldownsForAccount("openai", "conn-1");
    expect(repoMock.__store.size).toBe(0);
  });

  it("noauth (OpenCode) does not create modelLock", async () => {
    const result = await auth.markAccountUnavailable({
      // Real OpenCode noauth shape: id only, no connectionId field.
      credentials: { id: "noauth", provider: "opencode" },
      status: 429, errorText: "too many requests", provider: "opencode", model: "glm-4.6",
      cooldownHint: { source: "upstream-header", headerName: "Retry-After", expiresAtMs: Date.now() + 5_000, durationMs: 5_000 },
    });
    expect(result.shouldFallback).toBe(true);
    const conns = await dbMock.getProviderConnections({ provider: "opencode" });
    expect(conns.every((c) => !Object.keys(c).some((k) => k.startsWith("modelLock_")))).toBe(true);
  });
});

// Board aggregation — legacy fallback path (no sidecar row) must redact secrets in lastError.
describe("listBoardCooldowns — legacy lastError sanitized", () => {
  it("applies sanitizeReason to connection.lastError when sidecar missing", async () => {
    const svc = await import("@/sse/services/selfAwareCooldown.js");
    dbMock.__setConnections([{
      id: "conn-1",
      provider: "openai",
      name: "OpenAI Main",
      isActive: true,
      backoffLevel: 1,
      errorCode: 429,
      lastError: "429 via http://user:pass@proxy.example:8080 with Bearer supersecret123 and sk-abcdef987654",
      "modelLock_gpt-4o": new Date(Date.now() + 60_000).toISOString(),
    }]);
    repoMock.listActiveCooldowns.mockReturnValueOnce([]);

    const board = await svc.listBoardCooldowns();
    const legacy = board.find((r) => r.scopeType === "account" && r.scopeId === "conn-1");
    expect(legacy).toBeTruthy();
    expect(legacy.source).toBe("legacy-backoff");
    expect(legacy.status).toBe(429);
    expect(legacy.reason).not.toMatch(/pass@/);
    expect(legacy.reason).not.toMatch(/supersecret123/);
    expect(legacy.reason).not.toMatch(/sk-abcdef987654/);
    expect(legacy.reason).toMatch(/REDACTED/);
    expect(legacy.reason).toMatch(/proxy/);
  });
});
