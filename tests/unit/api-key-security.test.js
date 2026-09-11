// API key security: HMAC digest, one-time secret, timing-safe verify, no plaintext storage.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const originalSecret = process.env.API_KEY_SECRET;
let tempDir;
let db;
let auth;
let constants;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-ak-sec-"));
  process.env.DATA_DIR = tempDir;
  process.env.API_KEY_SECRET = "test-secret-for-hmac";
  vi.resetModules();
  constants = await import("@/lib/apiKeys/constants.js");
  auth = await import("@/lib/apiKeys/auth.js");
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalSecret === undefined) delete process.env.API_KEY_SECRET;
  else process.env.API_KEY_SECRET = originalSecret;
});

describe("API key secret format & HMAC", () => {
  it("generates sk-9r- base64url secret from crypto.randomBytes", () => {
    const s = auth.generateApiKeySecret();
    expect(s).toMatch(/^sk-9r-[A-Za-z0-9_-]{40,}$/);
    expect(auth.looksLikeApiKeySecret(s)).toBe(true);
  });

  it("accepts legacy sk- secrets and rejects non-key strings", () => {
    // Legacy format: sk-{machineId}-{keyId}-{crc}
    const legacy = "sk-machineXYZ-abc123-deadbeef";
    expect(legacy.length).toBeGreaterThanOrEqual(16);
    expect(auth.looksLikeApiKeySecret(legacy)).toBe(true);

    expect(auth.looksLikeApiKeySecret("sk-short")).toBe(false); // < 16
    expect(auth.looksLikeApiKeySecret("sk-has space-in-it-xxxx")).toBe(false);
    expect(auth.looksLikeApiKeySecret("sk-" + "a".repeat(600))).toBe(false); // > 512
    expect(auth.looksLikeApiKeySecret(123)).toBe(false);
    expect(auth.looksLikeApiKeySecret(null)).toBe(false);
  });

  it("migrated legacy secret still authenticates stored digest", async () => {
    const legacy = "sk-machineXYZ-abc123-deadbeef";
    const digest = auth.computeApiKeyDigest(legacy);
    const loaded = await auth.resolveApiKeyBySecret(legacy, {
      getApiKeyByHash: async (h) => (h === digest ? { id: "legacy-1", keyHash: digest, isActive: 1 } : null),
    });
    expect(loaded?.id).toBe("legacy-1");
    await expect(auth.resolveApiKeyBySecret("sk-machineXYZ-abc123-wrongcrc", {
      getApiKeyByHash: async () => null,
    })).resolves.toBe(null);
  });

  it("digest is fixed-hex HMAC-SHA256 with context prefix", () => {
    const s = "sk-9r-" + crypto.randomBytes(32).toString("base64url");
    const d = auth.computeApiKeyDigest(s);
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    const expected = crypto
      .createHmac("sha256", "test-secret-for-hmac")
      .update("9router-api-key:v1:" + s)
      .digest("hex");
    expect(d).toBe(expected);
  });

  it("hint is prefix + last 4, never full secret", () => {
    const s = auth.generateApiKeySecret();
    const hint = auth.buildApiKeyHint(s);
    expect(hint.startsWith("sk-9r-")).toBe(true);
    expect(hint.endsWith(s.slice(-4))).toBe(true);
    expect(hint.includes(s.slice(8, -4))).toBe(false);
  });

  it("create returns secret once; subsequent reads never include it", async () => {
    const created = await db.createApiKey("sec-test", "machine-1", {
      accessMode: constants.API_KEY_ACCESS_MODE.ALL,
    });
    expect(created.key).toMatch(/^sk-9r-/);

    const listed = await db.getApiKeys();
    const row = listed.find((k) => k.id === created.id);
    expect(row).toBeDefined();
    expect(row.key).toBeUndefined();
    expect(row.keyHash).toBeUndefined();
    expect(row.keyHint).toMatch(/^sk-9r-\*\*\*/);

    const fetched = await db.getApiKeyById(created.id);
    expect(fetched.key).toBeUndefined();
    expect(fetched.keyHash).toBeUndefined();

    // Internal auth path still sees digest for timing-safe lookup
    const authRow = await db.getApiKeyByHash(
      auth.computeApiKeyDigest(created.key),
    );
    expect(authRow).toBeTruthy();
    expect(authRow.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(authRow.key).toBeUndefined();

    // Raw DB: no plaintext `key` column after migration 002; only hashed verifier
    const adapter = (await import("@/lib/db/driver.js")).getAdapterSync
      ? (await import("@/lib/db/driver.js")).getAdapterSync()
      : await (await import("@/lib/db/driver.js")).getAdapter();
    const cols = adapter.all(`PRAGMA table_info(apiKeys)`);
    expect(cols.map((c) => c.name)).not.toContain("key");
    const raw = adapter.get(`SELECT keyHash FROM apiKeys WHERE id = ?`, [created.id]);
    expect(raw.keyHash).toBe(authRow.keyHash);
  });

  it("resolveApiKeyBySecret validates active key via timing-safe digest match", async () => {
    const created = await db.createApiKey("sec-resolve", "machine-1");
    const row = await auth.resolveApiKeyBySecret(created.key);
    expect(row).toBeTruthy();
    expect(row.id).toBe(created.id);
    expect(row.key).toBeUndefined();

    expect(await auth.resolveApiKeyBySecret(created.key + "x")).toBe(null);
    expect(await auth.resolveApiKeyBySecret("sk-9r-too-short")).toBe(null);
    expect(await auth.resolveApiKeyBySecret(null)).toBe(null);
  });

  it("paused key fails validation", async () => {
    const created = await db.createApiKey("sec-paused", "machine-1");
    await db.updateApiKey(created.id, { isActive: false });
    expect(await auth.resolveApiKeyBySecret(created.key)).toBe(null);
  });

  it("reroll rotates verifier; old secret stops working", async () => {
    const created = await db.createApiKey("sec-reroll", "machine-1");
    const oldKey = created.key;
    const rerolled = await db.rerollApiKey(created.id);
    expect(rerolled.key).toMatch(/^sk-9r-/);
    expect(rerolled.key).not.toBe(oldKey);
    expect(rerolled.id).toBe(created.id);

    expect(await auth.resolveApiKeyBySecret(oldKey)).toBe(null);
    const ok = await auth.resolveApiKeyBySecret(rerolled.key);
    expect(ok).toBeTruthy();
    expect(ok.id).toBe(created.id);
  });

  it("validateApiKey still works for dashboards that only need boolean", async () => {
    const created = await db.createApiKey("sec-bool", "machine-1");
    expect(await db.validateApiKey(created.key)).toBe(true);
    expect(await db.validateApiKey("sk-9r-not-a-real-key-value-xxxxxx")).toBe(false);
  });
});

describe("Migration 002 — hash legacy plaintext keys", () => {
  it("converts legacy plaintext rows, migrates usage attribution, idempotent", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const adapter = await getAdapter();
    const legacyId = "legacy-key-1";
    const legacySecret = "sk-machineXYZ-abc123-deadbeef";
    const now = new Date().toISOString();
    // Simulate pre-migration row: insert directly with plaintext `key`
    adapter.exec(`ALTER TABLE apiKeys RENAME TO apiKeys_old_mig`);
    adapter.exec(`CREATE TABLE apiKeys (id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT, machineId TEXT, isActive INTEGER DEFAULT 1, createdAt TEXT NOT NULL)`);
    adapter.run(`INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES(?,?,?,?,?,?)`,
      [legacyId, legacySecret, "Legacy", "m-legacy", 1, now]);
    // rename back: drop the temp and recreate via migration path — simpler: reset schema version and re-run
    adapter.run(`INSERT OR REPLACE INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      [now, "openai", "gpt-4", "c1", legacySecret, "/v1/chat/completions", 10, 5, 0.01, "ok", "{}", "{}"]);
    adapter.run(`INSERT OR REPLACE INTO usageDaily(dateKey, data) VALUES(?,?)`,
      ["2026-09-11", JSON.stringify({
        requests: 1, promptTokens: 10, completionTokens: 5, cost: 0.01,
        byApiKey: { [`${legacySecret}|gpt-4|openai`]: { requests: 1, promptTokens: 10, completionTokens: 5, cost: 0.01, rawModel: "gpt-4", provider: "openai", apiKey: legacySecret } },
      })]);
    // Drop migrated marker and force re-run of migration 002 by stamping version 1
    adapter.run(`INSERT OR REPLACE INTO _meta(key, value) VALUES('schemaVersion', '1')`);

    // Re-import migration runner
    vi.resetModules();
    const migrate = await import("@/lib/db/migrate.js");
    delete global._dbAdapter;
    const { getAdapter: getAdapter2 } = await import("@/lib/db/driver.js");
    const db2 = await getAdapter2();
    // driver auto-runs migration on getAdapter
    const { runMigrationOnce } = migrate;
    await runMigrationOnce(db2);

    const row = db2.get(`SELECT * FROM apiKeys WHERE id = ?`, [legacyId]);
    expect(row.key == null || row.key === "").toBe(true);
    expect(row.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.accessMode).toBe("all");
    expect(row.name).toBe("Legacy");

    const usage = db2.all(`SELECT apiKey, apiKeyId, apiKeyNameSnapshot FROM usageHistory WHERE apiKeyId = ?`, [legacyId]);
    expect(usage.length).toBeGreaterThanOrEqual(1);
    expect(usage[0].apiKeyId).toBe(legacyId);
    // Plaintext secret column is cleared for all rows after migration.
    expect(usage[0].apiKey == null || usage[0].apiKey === "").toBe(true);
    const anyPlaintext = db2.all(`SELECT id FROM usageHistory WHERE apiKey = ?`, [legacySecret]);
    expect(anyPlaintext.length).toBe(0);

    const day = db2.get(`SELECT data FROM usageDaily WHERE dateKey = '2026-09-11'`);
    const parsed = JSON.parse(day.data);
    const keys = Object.keys(parsed.byApiKey || {});
    expect(keys.some((k) => k.startsWith(`${legacyId}|`))).toBe(true);
    expect(day.data.includes(legacySecret)).toBe(false);
    for (const v of Object.values(parsed.byApiKey || {})) {
      expect(v.apiKey == null || v.apiKey === "").toBe(true);
    }

    // Idempotent rerun
    const before = db2.all(`SELECT * FROM apiKeys WHERE id = ?`, [legacyId]);
    adapter.run(`INSERT OR REPLACE INTO _meta(key, value) VALUES('schemaVersion', '1')`);
    await runMigrationOnce(db2);
    const after = db2.all(`SELECT * FROM apiKeys WHERE id = ?`, [legacyId]);
    expect(after[0].keyHash).toBe(before[0].keyHash);
  });
});
