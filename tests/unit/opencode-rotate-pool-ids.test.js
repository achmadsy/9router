// NoAuthProxyCard rotatePoolIds: round-robin candidates restricted to selected pools
import { describe, it, expect, beforeEach, vi } from "vitest";

const pools = [
  { id: "pool-a", name: "CN A", proxyUrl: "http://a:1", isActive: true },
  { id: "pool-b", name: "CN B", proxyUrl: "http://b:2", isActive: true },
  { id: "pool-c", name: "CN C", proxyUrl: "http://c:3", isActive: true },
];

const defaultSettings = () => ({
  providerStrategies: {
    opencode: {
      rotateStrategy: "round-robin",
      rotatePoolIds: ["pool-b", "pool-c"],
    },
  },
});

const getSettings = vi.fn(async () => defaultSettings());

const getProxyPools = vi.fn(async () => pools);

vi.mock("@/lib/db/index.js", () => ({
  getProviderConnections: vi.fn(async () => []),
  updateProviderConnection: vi.fn(async (id, data) => ({ id, ...data })),
  getSettings: (...a) => getSettings(...a),
  getProxyPools: (...a) => getProxyPools(...a),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(async () => []),
  updateProviderConnection: vi.fn(async (id, data) => ({ id, ...data })),
  validateApiKey: vi.fn(async () => true),
  getSettings: (...a) => getSettings(...a),
  getProxyPools: (...a) => getProxyPools(...a),
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
    listCooldownsForScopes: vi.fn(() => []),
    deleteCooldown: vi.fn(async () => true),
    deleteByScope: vi.fn(async () => true),
    deleteAllActive: vi.fn(async () => { store.clear(); return 0; }),
    purgeExpired: vi.fn(async () => 0),
    __store: store,
  };
});

// Real pickProxyPoolId so round-robin actually cycles the filtered list
vi.mock("@/lib/network/connectionProxy.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveConnectionProxyConfig: vi.fn(async ({ proxyPoolId }) => ({
      connectionProxyEnabled: !!proxyPoolId,
      connectionProxyUrl: proxyPoolId ? "http://proxy.local:8080" : "",
      connectionNoProxy: "",
      proxyPoolId: proxyPoolId || null,
    })),
  };
});

vi.mock("@/models", () => ({
  getProxyPools: (...a) => getProxyPools(...a),
}));
vi.mock("@/models/index.js", () => ({
  getProxyPools: (...a) => getProxyPools(...a),
}));
vi.mock("@/models/proxyPools.js", () => ({
  getProxyPools: (...a) => getProxyPools(...a),
}));

let auth;

beforeEach(async () => {
  vi.resetModules();
  process.env.DATA_DIR = "/tmp/opencode-rotate-pool-ids-test";
  getSettings.mockClear();
  getSettings.mockImplementation(async () => defaultSettings());
  getProxyPools.mockClear();
  auth = await import("@/sse/services/auth.js");
});

describe("OpenCode rotatePoolIds subset", () => {
  it("only rotates through selected pools when rotatePoolIds set", async () => {
    const picked = new Set();
    for (let i = 0; i < 6; i++) {
      const creds = await auth.getProviderCredentials("opencode", null, "glm-4.6");
      const scopeId = creds.providerSpecificData?.cooldownTarget?.scopeId;
      picked.add(scopeId);
    }
    expect(picked.has("pool-a")).toBe(false);
    expect(picked.has("pool-b")).toBe(true);
    expect(picked.has("pool-c")).toBe(true);
  });

  it("falls back to all active pools when rotatePoolIds empty", async () => {
    getSettings.mockImplementation(async () => ({
      providerStrategies: {
        opencode: { rotateStrategy: "round-robin", rotatePoolIds: [] },
      },
    }));
    const creds = await auth.getProviderCredentials("opencode", null, "glm-4.6");
    expect(["pool-a", "pool-b", "pool-c"]).toContain(
      creds.providerSpecificData?.cooldownTarget?.scopeId
    );
  });

  it("ignores rotatePoolIds that are not active pools", async () => {
    getSettings.mockImplementation(async () => ({
      providerStrategies: {
        opencode: { rotateStrategy: "round-robin", rotatePoolIds: ["missing", "pool-a"] },
      },
    }));
    const picked = new Set();
    for (let i = 0; i < 4; i++) {
      const creds = await auth.getProviderCredentials("opencode", null, "glm-4.6");
      picked.add(creds.providerSpecificData?.cooldownTarget?.scopeId);
    }
    expect(picked).toEqual(new Set(["pool-a"]));
  });
});
