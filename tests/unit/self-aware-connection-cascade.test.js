// HIGH: account delete cascades selfAwareCooldowns; board attaches connectionName.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let cooldowns;
let connectionsRepo;
let selfAwareCooldown;
let acc1;
let acc2;

async function setup() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-sa-cascade-"));
  process.env.DATA_DIR = tempDir;
  // Drop cached adapter so DATA_DIR changes take effect across tests
  global._dbAdapter = { instance: null, initPromise: null, logged: false };
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  cooldowns = await import("@/lib/db/repos/selfAwareRepo.js");
  connectionsRepo = await import("@/lib/db/repos/connectionsRepo.js");
  selfAwareCooldown = await import("@/sse/services/selfAwareCooldown.js");

  acc1 = await db.createProviderConnection({
    provider: "openai",
    name: "Account One",
    displayName: "acct-one",
  });
  acc2 = await db.createProviderConnection({
    provider: "openai",
    name: "Account Two",
    displayName: "acct-two",
  });
}

function expireMs(ms = 60_000) {
  return Date.now() + ms;
}

describe("self-aware connection cascade + board account name", () => {
  beforeEach(async () => {
    await setup();
  });

  afterEach(() => {
    vi.resetModules();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("multi-account: cooldown rows stay scoped per account", async () => {
    await cooldowns.upsertCooldown({
      provider: "openai",
      model: "gpt-4o",
      scopeType: "account",
      scopeId: acc1.id,
      expiresAtMs: expireMs(),
      source: "upstream-header",
      reason: "rate limit",
      status: 429,
    });
    await cooldowns.upsertCooldown({
      provider: "openai",
      model: "gpt-4o",
      scopeType: "account",
      scopeId: acc2.id,
      expiresAtMs: expireMs(),
      source: "unknown-quota",
      reason: "no header",
      status: 429,
    });

    const rows = await cooldowns.listActiveCooldowns(Date.now());
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.scopeId).sort()).toEqual([acc1.id, acc2.id].sort());
  });

  it("board attaches connectionName for live accounts", async () => {
    await cooldowns.upsertCooldown({
      provider: "openai",
      model: "gpt-4o",
      scopeType: "account",
      scopeId: acc1.id,
      expiresAtMs: expireMs(),
      source: "upstream-header",
      reason: "rl",
      status: 429,
    });

    const board = await selfAwareCooldown.listBoardCooldowns();
    const row = board.find((r) => r.scopeId === acc1.id && r.model === "gpt-4o");
    expect(row).toBeTruthy();
    expect(row.connectionName).toBe("acct-one");
    expect(row.connectionDeleted).toBe(false);
  });

  it("deleteProviderConnection removes that account's cooldown rows only", async () => {
    await cooldowns.upsertCooldown({
      provider: "openai",
      model: "gpt-4o",
      scopeType: "account",
      scopeId: acc1.id,
      expiresAtMs: expireMs(),
      source: "upstream-header",
      reason: "rl",
      status: 429,
    });
    await cooldowns.upsertCooldown({
      provider: "openai",
      model: "gpt-4o",
      scopeType: "account",
      scopeId: acc2.id,
      expiresAtMs: expireMs(),
      source: "upstream-header",
      reason: "rl",
      status: 429,
    });

    const ok = await connectionsRepo.deleteProviderConnection(acc1.id);
    expect(ok).toBe(true);

    const rows = await cooldowns.listActiveCooldowns(Date.now());
    expect(rows).toHaveLength(1);
    expect(rows[0].scopeId).toBe(acc2.id);
  });

  it("deleteProviderConnectionsByProvider removes all provider cooldowns", async () => {
    await cooldowns.upsertCooldown({
      provider: "openai",
      model: "gpt-4o",
      scopeType: "account",
      scopeId: acc1.id,
      expiresAtMs: expireMs(),
      source: "upstream-header",
      reason: "rl",
      status: 429,
    });
    await cooldowns.upsertCooldown({
      provider: "openai",
      model: "",
      scopeType: "account",
      scopeId: acc2.id,
      expiresAtMs: expireMs(),
      source: "legacy-backoff",
      reason: "rl",
      status: 429,
    });

    await connectionsRepo.deleteProviderConnectionsByProvider("openai");
    const rows = await cooldowns.listActiveCooldowns(Date.now());
    expect(rows).toHaveLength(0);
  });

  it("board flags leftover orphaned rows as connectionDeleted", async () => {
    // Write a sidecar without a live connection (pre-fix orphan / manual insert).
    await cooldowns.upsertCooldown({
      provider: "openai",
      model: "gpt-4o",
      scopeType: "account",
      scopeId: "ghost-account",
      expiresAtMs: expireMs(),
      source: "unknown-quota",
      reason: "orphan",
      status: 429,
    });

    const board = await selfAwareCooldown.listBoardCooldowns();
    const row = board.find((r) => r.scopeId === "ghost-account");
    expect(row).toBeTruthy();
    expect(row.connectionDeleted).toBe(true);
    expect(row.connectionName).toBeNull();
  });
});
