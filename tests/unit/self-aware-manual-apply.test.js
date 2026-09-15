// HIGH: manual policy retro-apply re-dates active rows/locks unless a real
// provider-given time (provider-reset clock, short upstream header) exists.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let cooldowns;
let connectionsRepo;
let svc;
let acc1;

async function setup() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-sa-manual-"));
  process.env.DATA_DIR = tempDir;
  global._dbAdapter = { instance: null, initPromise: null, logged: false };
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  cooldowns = await import("@/lib/db/repos/selfAwareRepo.js");
  connectionsRepo = await import("@/lib/db/repos/connectionsRepo.js");
  svc = await import("@/sse/services/selfAwareCooldown.js");

  acc1 = await db.createProviderConnection({
    provider: "openai",
    name: "Account One",
    displayName: "acct-one",
  });
}

describe("applyManualPolicyToCooldowns", () => {
  beforeEach(async () => {
    await setup();
  });

  afterEach(() => {
    vi.resetModules();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("re-dates sidecar row + modelLock for legacy-backoff source", async () => {
    const lockMs = Date.now() + 200 * 3600 * 1000; // 200h absurd lock
    await cooldowns.upsertCooldown({
      provider: "openai", model: "gpt-4o", scopeType: "account", scopeId: acc1.id,
      expiresAtMs: lockMs, source: "legacy-backoff", status: 429,
    });
    await connectionsRepo.updateProviderConnection(acc1.id, {
      modelLock_gpt4o: new Date(lockMs).toISOString(),
      "modelLock_gpt-4o": new Date(lockMs).toISOString(),
    });

    const n = await svc.applyManualPolicyToCooldowns("openai", "gpt-4o", 60_000);
    expect(n).toBeGreaterThan(0);

    const conn = await connectionsRepo.getProviderConnectionById(acc1.id);
    const newExp = Date.now() + 60_000;
    // exact model lock re-dated within 2s tolerance
    expect(Math.abs(new Date(conn["modelLock_gpt-4o"]).getTime() - newExp)).toBeLessThan(2000);
    const rows = await cooldowns.listActiveCooldowns(Date.now());
    const row = rows.find((r) => r.model === "gpt-4o" && r.scopeId === acc1.id);
    expect(row.source).toBe("manual-policy");
    expect(Math.abs(new Date(row.expiresAt).getTime() - newExp)).toBeLessThan(2000);
  });

  it("leaves provider-reset rows alone", async () => {
    await cooldowns.upsertCooldown({
      provider: "openai", model: "gpt-4o", scopeType: "account", scopeId: acc1.id,
      expiresAtMs: Date.now() + 30 * 24 * 3600 * 1000, source: "provider-reset", status: 429,
    });
    const n = await svc.applyManualPolicyToCooldowns("openai", "gpt-4o", 60_000);
    expect(n).toBe(0);
    const rows = await cooldowns.listActiveCooldowns(Date.now());
    expect(rows[0].source).toBe("provider-reset");
  });

  it("overrides upstream-header only above 7d threshold", async () => {
    // 6d header wait — real ETA, keep
    await cooldowns.upsertCooldown({
      provider: "openai", model: "m-keep", scopeType: "account", scopeId: acc1.id,
      expiresAtMs: Date.now() + 6 * 24 * 3600 * 1000, source: "upstream-header", status: 429,
    });
    // 200h absurd header wait — treat as undefined, override
    await cooldowns.upsertCooldown({
      provider: "openai", model: "m-fix", scopeType: "account", scopeId: acc1.id,
      expiresAtMs: Date.now() + 200 * 3600 * 1000, source: "upstream-header", status: 429,
    });
    const n = await svc.applyManualPolicyToCooldowns("openai", "", 60_000);
    expect(n).toBe(1);
    const rows = await cooldowns.listActiveCooldowns(Date.now());
    const keep = rows.find((r) => r.model === "m-keep");
    const fix = rows.find((r) => r.model === "m-fix");
    expect(keep.source).toBe("upstream-header");
    expect(fix.source).toBe("manual-policy");
  });

  it("re-dates unknown-quota rows and clamps to max cooldown", async () => {
    await cooldowns.upsertCooldown({
      provider: "openai", model: "gpt-4o", scopeType: "account", scopeId: acc1.id,
      expiresAtMs: Date.now() + 30 * 24 * 3600 * 1000, source: "unknown-quota", status: 429,
    });
    const n = await svc.applyManualPolicyToCooldowns("openai", "gpt-4o", 60_000);
    expect(n).toBe(1);
    const rows = await cooldowns.listActiveCooldowns(Date.now());
    const row = rows.find((r) => r.scopeId === acc1.id);
    expect(row.source).toBe("manual-policy");
    expect(Math.abs(new Date(row.expiresAt).getTime() - (Date.now() + 60_000))).toBeLessThan(2000);
  });
});
