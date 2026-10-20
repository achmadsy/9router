import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-probe-test-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try {
    global._dbAdapter?.instance?.close?.();
  } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Probe Profile Crypto (AES-256-GCM)", () => {
  it("encrypts and decrypts secrets payload successfully", async () => {
    const { encryptProfileSecret, decryptProfileSecret } = await import(
      "../../src/lib/probe/crypto.js"
    );

    const secretPayload = {
      apiKey: "sk-proj-test1234567890",
      customHeaders: { "X-Custom": "test-val" },
    };

    const encrypted = encryptProfileSecret(secretPayload);
    expect(encrypted).toMatch(/^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);

    const decrypted = decryptProfileSecret(encrypted);
    expect(decrypted).toEqual(secretPayload);
  });

  it("returns null for tampered ciphertext or wrong key", async () => {
    const { encryptProfileSecret, decryptProfileSecret } = await import(
      "../../src/lib/probe/crypto.js"
    );

    const encrypted = encryptProfileSecret({ apiKey: "secret" });
    const parts = encrypted.split(":");
    // Tamper with the ciphertext body
    parts[2] = parts[2].slice(0, -2) + "AA";
    const tampered = parts.join(":");

    expect(decryptProfileSecret(tampered)).toBeNull();
    expect(decryptProfileSecret("not-a-valid-encrypted-string")).toBeNull();
    expect(decryptProfileSecret(null)).toBeNull();
  });
});

describe("Probe Profile Repository & 24h TTL", () => {
  it("creates profile with 24-hour TTL and safe metadata only", async () => {
    const {
      createProbeProfile,
      listProbeProfiles,
      getProbeProfileById,
      getProbeProfileSecrets,
    } = await import("../../src/lib/db/repos/probeProfilesRepo.js");

    const before = Date.now();
    const profile = await createProbeProfile({
      name: "GPT-4o Target",
      type: "target",
      source: "custom",
      provider: "openai",
      model: "gpt-4o",
      endpoint: "https://api.openai.com/v1",
      secrets: { apiKey: "sk-secret-key-123" },
    });

    const after = Date.now();
    expect(profile.id).toMatch(/^prf_/);
    expect(profile.name).toBe("GPT-4o Target");
    expect(profile.type).toBe("target");
    expect(profile.source).toBe("custom");
    expect(profile.provider).toBe("openai");
    expect(profile.model).toBe("gpt-4o");
    expect(profile.endpoint).toBe("https://api.openai.com/v1");

    // Safe metadata only: no secretEncrypted or plaintext apiKey
    expect(profile.secretEncrypted).toBeUndefined();
    expect(profile.apiKey).toBeUndefined();
    expect(profile.secrets).toBeUndefined();

    // Verify 24-hour expiration window
    const createdAtMs = new Date(profile.createdAt).getTime();
    const expiresAtMs = new Date(profile.expiresAt).getTime();
    const diffHours = (expiresAtMs - createdAtMs) / (1000 * 60 * 60);
    expect(Math.round(diffHours)).toBe(24);
    expect(createdAtMs).toBeGreaterThanOrEqual(before - 1000);
    expect(createdAtMs).toBeLessThanOrEqual(after + 1000);

    // listProbeProfiles also only returns safe metadata
    const list = await listProbeProfiles();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(profile.id);
    expect(list[0].secretEncrypted).toBeUndefined();

    // getProbeProfileById only returns safe metadata
    const fetched = await getProbeProfileById(profile.id);
    expect(fetched.id).toBe(profile.id);
    expect(fetched.secretEncrypted).toBeUndefined();

    // Internal getter decrypts secrets
    const withSecrets = await getProbeProfileSecrets(profile.id);
    expect(withSecrets.secrets).toEqual({ apiKey: "sk-secret-key-123" });
  });

  it("infers legacy profile sources from endpoint metadata", async () => {
    const { createProbeProfile, getProbeProfileById } = await import(
      "../../src/lib/db/repos/probeProfilesRepo.js"
    );

    const custom = await createProbeProfile({
      name: "Legacy Custom",
      type: "target",
      endpoint: "https://api.example.com/v1",
    });
    const self = await createProbeProfile({
      name: "Legacy Self",
      type: "judge",
    });

    expect((await getProbeProfileById(custom.id)).source).toBe("custom");
    expect((await getProbeProfileById(self.id)).source).toBe("this_9router");
  });

  it("filters profiles by type (target vs judge)", async () => {
    const { createProbeProfile, listProbeProfiles } = await import(
      "../../src/lib/db/repos/probeProfilesRepo.js"
    );

    await createProbeProfile({
      name: "Target Profile",
      type: "target",
      provider: "openai",
      secrets: { apiKey: "key-1" },
    });
    await createProbeProfile({
      name: "Judge Profile",
      type: "judge",
      provider: "anthropic",
      secrets: { apiKey: "key-2" },
    });

    const targets = await listProbeProfiles("target");
    expect(targets).toHaveLength(1);
    expect(targets[0].type).toBe("target");

    const judges = await listProbeProfiles("judge");
    expect(judges).toHaveLength(1);
    expect(judges[0].type).toBe("judge");

    const all = await listProbeProfiles();
    expect(all).toHaveLength(2);
  });

  it("purges expired profiles automatically on operations", async () => {
    const {
      createProbeProfile,
      listProbeProfiles,
      getProbeProfileById,
      purgeExpiredProbeProfiles,
    } = await import("../../src/lib/db/repos/probeProfilesRepo.js");
    const { getAdapter } = await import("../../src/lib/db/driver.js");

    const profile = await createProbeProfile({
      name: "Old Profile",
      type: "target",
      secrets: { apiKey: "old-key" },
    });

    // Manually backdate expiresAt in DB to 1 hour in the past
    const db = await getAdapter();
    const pastIso = new Date(Date.now() - 3600 * 1000).toISOString();
    db.run(`UPDATE probeProfiles SET expiresAt = ? WHERE id = ?`, [pastIso, profile.id]);

    // Listing or getting automatically purges expired profiles
    const list = await listProbeProfiles();
    expect(list).toHaveLength(0);

    const fetched = await getProbeProfileById(profile.id);
    expect(fetched).toBeNull();
  });

  it("deletes a profile by id", async () => {
    const { createProbeProfile, deleteProbeProfile, getProbeProfileById } =
      await import("../../src/lib/db/repos/probeProfilesRepo.js");

    const profile = await createProbeProfile({
      name: "To Delete",
      type: "target",
      secrets: { apiKey: "key" },
    });

    const deleted = await deleteProbeProfile(profile.id);
    expect(deleted).toBe(true);

    expect(await getProbeProfileById(profile.id)).toBeNull();
  });
});
