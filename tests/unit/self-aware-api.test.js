// MEDIUM: /api/self-aware* route shapes and auth surfaces.
import { describe, it, expect, beforeEach, vi } from "vitest";

const boardRows = [
  {
    id: "row-1", provider: "openai", model: "gpt-4o", scopeType: "account", scopeId: "c1",
    source: "upstream-header", status: 429, reason: "Rate limit exceeded",
    headerName: "Retry-After", expiresAt: new Date(Date.now() + 30_000).toISOString(),
    expiresAtMs: Date.now() + 30_000, connectionName: "Main",
  },
  {
    id: "row-2", provider: "opencode", model: "glm-4.6", scopeType: "proxy", scopeId: "pool-x",
    source: "upstream-header", status: 429, reason: "too many",
    expiresAt: new Date(Date.now() + 10_000).toISOString(), expiresAtMs: Date.now() + 10_000,
    proxyPoolName: null, proxyPoolDeleted: true,
  },
];

vi.mock("@/sse/services/selfAwareCooldown.js", () => ({
  listBoardCooldowns: vi.fn(async () => boardRows),
  deleteSelfAwareCooldown: vi.fn(async () => true),
  resetAllSelfAwareCooldowns: vi.fn(async () => 2),
  getSelfAwarePolicyMs: vi.fn(async () => null),
  upsertSelfAwareCooldown: vi.fn(async () => null),
  clearSelfAwareCooldown: vi.fn(async () => true),
  clearSelfAwareCooldownsForAccount: vi.fn(async () => true),
  purgeExpiredSelfAwareCooldowns: vi.fn(async () => 0),
  listActiveSelfAwareCooldowns: vi.fn(async () => []),
  getActiveProxyCooldownMap: vi.fn(async () => new Map()),
  resolveSelfAwareDecision: vi.fn(() => ({ shouldFallback: false })),
}));

const sharedConns = [
  { id: "c1", provider: "openai", name: "Main", "modelLock_gpt-4o": new Date(Date.now() + 30_000).toISOString() },
  { id: "c2", provider: "openai", name: "Second", "modelLock_gpt-4o": new Date(Date.now() + 30_000).toISOString() },
];

vi.mock("@/lib/db/index.js", () => ({
  listSelfAwarePolicies: vi.fn(async () => ([
    { id: "p1", provider: "openai", model: "gpt-4o", timeoutMs: 60000 },
  ])),
  upsertSelfAwarePolicy: vi.fn(async (p) => ({ id: "p2", ...p })),
  deleteSelfAwarePolicy: vi.fn(async () => true),
  getProviderConnections: vi.fn(async () => sharedConns),
  getProviderConnectionById: vi.fn(async (id) => sharedConns.find((c) => c.id === id) || null),
  updateProviderConnection: vi.fn(async (id, d) => {
    const c = sharedConns.find((x) => x.id === id);
    if (c) Object.assign(c, d);
    return { id, ...d };
  }),
}));

vi.mock("@/lib/localDb.js", () => ({
  getProxyPools: vi.fn(async () => ([
    { id: "pool-x", name: "Deleted?", proxyUrl: "http://x" },
  ])),
}));

vi.mock("@/sse/services/antigravityQuota.js", () => ({
  clearAntigravityCooldown: vi.fn(),
  clearAllAntigravityCooldowns: vi.fn(),
}));

vi.mock("@/shared/constants/providers.js", () => ({
  resolveProviderId: (p) => p || p,
}));

describe("Self-Aware API routes", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("GET /api/self-aware returns enriched board rows", async () => {
    const { GET } = await import("@/app/api/self-aware/route.js");
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.count).toBe(2);
    expect(data.cooldowns[0]).toMatchObject({ provider: "openai", connectionName: "Main" });
    // deleted pool flag
    const proxyRow = data.cooldowns.find((c) => c.scopeType === "proxy");
    expect(proxyRow.proxyPoolDeleted).toBe(false); // pool-x exists in mock
  });

  it("GET /api/self-aware/policies returns policies", async () => {
    const { GET } = await import("@/app/api/self-aware/policies/route.js");
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.policies).toHaveLength(1);
  });

  it("PUT /api/self-aware/policies validates timeoutMs bounds", async () => {
    const { PUT } = await import("@/app/api/self-aware/policies/route.js");
    const bad = await PUT(new Request("http://x", {
      method: "PUT",
      body: JSON.stringify({ provider: "openai", model: "m", timeoutMs: 500 }),
    }));
    expect(bad.status).toBe(400);

    const ok = await PUT(new Request("http://x", {
      method: "PUT",
      body: JSON.stringify({ provider: "openai", model: "m", timeoutMs: 60_000 }),
    }));
    expect(ok.status).toBe(200);
  });

  it("DELETE /api/self-aware/policies requires provider", async () => {
    const { DELETE } = await import("@/app/api/self-aware/policies/route.js");
    const res = await DELETE(new Request("http://x?model=m"));
    expect(res.status).toBe(400);
  });

  it("POST /api/self-aware/reset {all:true} clears", async () => {
    const { POST } = await import("@/app/api/self-aware/reset/route.js");
    const res = await POST(new Request("http://x", {
      method: "POST",
      body: JSON.stringify({ all: true }),
    }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  it("POST /api/self-aware/reset by id", async () => {
    const { POST } = await import("@/app/api/self-aware/reset/route.js");
    const res = await POST(new Request("http://x", {
      method: "POST",
      body: JSON.stringify({ id: "row-1" }),
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("reset clears the matching account (scopeId c2), not the first connection", async () => {
    const db = await import("@/lib/db/index.js");
    db.updateProviderConnection.mockClear();
    const lockIso = new Date(Date.now() + 30_000).toISOString();
    sharedConns[0]["modelLock_gpt-4o"] = lockIso;
    sharedConns[1]["modelLock_gpt-4o"] = lockIso;
    const svc = await import("@/sse/services/selfAwareCooldown.js");
    svc.listBoardCooldowns.mockResolvedValueOnce([{
      id: "row-c2", provider: "openai", model: "gpt-4o", scopeType: "account", scopeId: "c2",
      source: "upstream-header", status: 429, reason: "rl",
      expiresAt: new Date(Date.now() + 30_000).toISOString(), expiresAtMs: Date.now() + 30_000,
    }]);

    const { POST } = await import("@/app/api/self-aware/reset/route.js");
    const res = await POST(new Request("http://x", {
      method: "POST",
      body: JSON.stringify({ provider: "openai", model: "gpt-4o", scopeType: "account", scopeId: "c2" }),
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);

    // only the matching account is updated — never the first connection
    const updatedIds = db.updateProviderConnection.mock.calls.map((c) => c[0]);
    expect(updatedIds).toContain("c2");
    expect(updatedIds).not.toContain("c1");
    expect(sharedConns[1]["modelLock_gpt-4o"]).toBeNull();
    expect(sharedConns[0]["modelLock_gpt-4o"]).toBe(lockIso);
  });

  it("routes do not export 'use server'", async () => {
    const fs = await import("node:fs");
    const files = [
      "src/app/api/self-aware/route.js",
      "src/app/api/self-aware/policies/route.js",
      "src/app/api/self-aware/reset/route.js",
    ];
    for (const f of files) {
      const src = fs.readFileSync(`/home/ubuntu/9router-fork/${f}`, "utf8");
      expect(src.includes("use server")).toBe(false);
    }
  });
});
