// HIGH: v3→v4 migration, fresh create, policy upsert atomicity, uniqueness, export shape.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

async function freshDb() {
  const { getAdapter } = await import("@/lib/db/driver.js");
  return getAdapter();
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-sa-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("self-aware schema v4", () => {
  it("fresh DB creates selfAwarePolicies + selfAwareCooldowns and stamps v4", async () => {
    const db = await freshDb();
    const row = db.get(`SELECT value FROM _meta WHERE key='schemaVersion'`);
    expect(parseInt(row.value, 10)).toBe(4);
    const tables = db.all(`SELECT name FROM sqlite_master WHERE type='table'`).map(t => t.name);
    expect(tables).toEqual(expect.arrayContaining(["selfAwarePolicies", "selfAwareCooldowns"]));
  });

  it("v3 DB upgrades to v4 and keeps existing data", async () => {
    // Boot once, then stamp to 3 and drop new tables to simulate pre-004 DB
    let db = await freshDb();
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      ['{"foo":"bar"}']
    );
    db.exec(`DROP TABLE IF EXISTS selfAwarePolicies`);
    db.exec(`DROP TABLE IF EXISTS selfAwareCooldowns`);
    db.run(`UPDATE _meta SET value = '3' WHERE key = 'schemaVersion'`);
    db.close?.();

    delete global._dbAdapter;
    vi.resetModules();
    db = await freshDb();
    const ver = parseInt(db.get(`SELECT value FROM _meta WHERE key='schemaVersion'`).value, 10);
    expect(ver).toBe(4);
    const tables = db.all(`SELECT name FROM sqlite_master WHERE type='table'`).map(t => t.name);
    expect(tables).toEqual(expect.arrayContaining(["selfAwarePolicies", "selfAwareCooldowns"]));
    const settings = db.get(`SELECT data FROM settings WHERE id=1`);
    expect(JSON.parse(settings.data)).toEqual({ foo: "bar" });
  });

  it("policy upsert is atomic (same provider+model replaces timeoutMs)", async () => {
    const db = await freshDb();
    const repo = await import("@/lib/db/repos/selfAwareRepo.js");
    await repo.upsertSelfAwarePolicy({ provider: "openai", model: "gpt-4o", timeoutMs: 30_000 });
    await repo.upsertSelfAwarePolicy({ provider: "openai", model: "gpt-4o", timeoutMs: 60_000 });
    const rows = db.all(`SELECT * FROM selfAwarePolicies WHERE provider='openai' AND model='gpt-4o'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].timeoutMs).toBe(60_000);
  });

  it("blank-model policy applies to named-model requests; exact model policy overrides blank", async () => {
    const repo = await import("@/lib/db/repos/selfAwareRepo.js");
    // Only a provider-wide ("all") row — named-model requests fall back to it
    await repo.upsertSelfAwarePolicy({ provider: "openai", model: "", timeoutMs: 45_000 });
    expect((await repo.getSelfAwarePolicy("openai", "gpt-4o")).timeoutMs).toBe(45_000);
    expect((await repo.getSelfAwarePolicy("openai", "gpt-4o-mini")).timeoutMs).toBe(45_000);

    // Exact model row wins over blank
    await repo.upsertSelfAwarePolicy({ provider: "openai", model: "gpt-4o", timeoutMs: 15_000 });
    expect((await repo.getSelfAwarePolicy("openai", "gpt-4o")).timeoutMs).toBe(15_000);
    expect((await repo.getSelfAwarePolicy("openai", "gpt-4o-mini")).timeoutMs).toBe(45_000);

    // No blank row + no exact row → null; blank lookup itself still exact
    expect(await repo.getSelfAwarePolicy("openrouter", "foo")).toBeNull();
    expect((await repo.getSelfAwarePolicy("openai", "")).timeoutMs).toBe(45_000);
  });

  it("policy PK isolates clones and dynamic models; composite PK (provider, model)", async () => {
    const db = await freshDb();
    const repo = await import("@/lib/db/repos/selfAwareRepo.js");
    await repo.upsertSelfAwarePolicy({ provider: "openai", model: "gpt-4o", timeoutMs: 1000 });
    await repo.upsertSelfAwarePolicy({ provider: "openai-dup-1", model: "gpt-4o", timeoutMs: 2000 });
    await repo.upsertSelfAwarePolicy({ provider: "openai", model: "gpt-4o-mini", timeoutMs: 3000 });
    expect((await repo.getSelfAwarePolicy("openai", "gpt-4o")).timeoutMs).toBe(1000);
    expect((await repo.getSelfAwarePolicy("openai-dup-1", "gpt-4o")).timeoutMs).toBe(2000);
    expect((await repo.getSelfAwarePolicy("openai", "gpt-4o-mini")).timeoutMs).toBe(3000);
    expect(await repo.getSelfAwarePolicy("openai", "missing")).toBeNull();
    // Composite PK: (provider, model) — INSERT omits id, no null-id column on fresh schema
    const info = db.all(`PRAGMA table_info(selfAwarePolicies)`).map((c) => c.name);
    expect(info).not.toContain("id");
    const pk = db.all(`PRAGMA table_info(selfAwarePolicies)`).filter((c) => c.pk > 0).map((c) => c.name);
    expect(pk).toEqual(["provider", "model"]);
  });

  it("cooldown unique index enforces one row per semantic target; upsert replaces", async () => {
    const db = await freshDb();
    const repo = await import("@/lib/db/repos/selfAwareRepo.js");
    const now = Date.now();
    await repo.upsertCooldown({
      provider: "opencode", model: "glm-4.6", scopeType: "proxy", scopeId: "pool-a",
      expiresAtMs: now + 60_000, source: "upstream-header", status: 429,
    });
    await repo.upsertCooldown({
      provider: "opencode", model: "glm-4.6", scopeType: "proxy", scopeId: "pool-a",
      expiresAtMs: now + 120_000, source: "manual-policy", status: 429,
    });
    const rows = db.all(`SELECT * FROM selfAwareCooldowns WHERE provider='opencode' AND scopeId='pool-a'`);
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0].expiresAt).getTime()).toBe(now + 120_000);
    expect(rows[0].source).toBe("manual-policy");
  });

  it("proxy A blocked does not block proxy B (scope isolation at storage layer)", async () => {
    const repo = await import("@/lib/db/repos/selfAwareRepo.js");
    const now = Date.now();
    await repo.upsertCooldown({
      provider: "opencode", model: "glm-4.6", scopeType: "proxy", scopeId: "pool-a",
      expiresAtMs: now + 60_000, source: "upstream-header",
    });
    const map = await repo.listCooldownsForScopes("opencode", "glm-4.6", "proxy", ["pool-a", "pool-b"], now);
    expect(map.map(r => r.scopeId)).toEqual(["pool-a"]);
  });

  it("listActiveCooldowns filters by expiry", async () => {
    const repo = await import("@/lib/db/repos/selfAwareRepo.js");
    const now = Date.now();
    await repo.upsertCooldown({
      provider: "p", model: "m", scopeType: "account", scopeId: "c1",
      expiresAtMs: now + 5_000, source: "legacy-backoff",
    });
    await repo.upsertCooldown({
      provider: "p", model: "m2", scopeType: "account", scopeId: "c2",
      expiresAtMs: now - 1_000, source: "legacy-backoff",
    });
    const active = await repo.listActiveCooldowns(now);
    expect(active.map(r => r.model)).toEqual(["m"]);
  });

  it("export includes selfAwarePolicies but not cooldown sidecars; service stays under @/lib/db", async () => {
    const mod = await import("@/lib/db/index.js");
    expect(typeof mod.getSelfAwarePolicy).toBe("function");
    expect(typeof mod.upsertSelfAwarePolicy).toBe("function");
    expect(typeof mod.listActiveCooldowns).toBe("function");
    expect(typeof mod.upsertCooldown).toBe("function");
    // service lives under src/sse/services — not re-exported from db barrel
    expect(mod.listBoardCooldowns).toBeUndefined();
    expect(mod.resolveSelfAwareDecision).toBeUndefined();

    // exportDb includes policies; importDb of older payload without key → empty
    await mod.upsertSelfAwarePolicy({ provider: "openai", model: "gpt-4o", timeoutMs: 45_000 });
    const exported = await mod.exportDb();
    expect(exported.selfAwarePolicies).toEqual([
      expect.objectContaining({ provider: "openai", model: "gpt-4o", timeoutMs: 45_000 }),
    ]);

    await mod.importDb({
      settings: exported.settings,
      connections: [],
      modelAliases: {},
      customModels: [],
      mitmAlias: exported.mitmAlias || {},
      mcpServers: [],
      aiProviders: [],
      guiAgents: {},
      agentWorkflows: {},
      proxyPools: [],
      providerNodes: exported.providerNodes || { list: [], ports: {} },
      keys: exported.keys,
      pricing: {},
      // no selfAwarePolicies key — older backup
    });
    expect(await mod.listSelfAwarePolicies()).toEqual([]);
  });
});
