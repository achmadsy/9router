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

const routeMocks = vi.hoisted(() => ({
  verifyProbeAdminAuth: vi.fn(),
  verifyCsrfOrigin: vi.fn(() => true),
}));

beforeEach(() => {
  routeMocks.verifyProbeAdminAuth.mockResolvedValue({ authorized: true, ownerId: "admin" });
  routeMocks.verifyCsrfOrigin.mockReturnValue(true);
});

vi.mock("@/lib/probe/auth.js", () => ({
  verifyProbeAdminAuth: routeMocks.verifyProbeAdminAuth,
  verifyCsrfOrigin: routeMocks.verifyCsrfOrigin,
}));

vi.mock("@/shared/utils/ssrfGuard.js", () => ({
  assertPublicUrlResolved: vi.fn(async () => {}),
}));

vi.mock("@/lib/probe/endpoints.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getCurrentGatewayBaseUrl: () => "https://router.test",
}));

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
      secrets: {
        apiKey: "sk-secret-key-123",
        customHeaders: {
          "User-Agent": "Secret Probe Agent/1.0",
          "X-Private-Tenant": "tenant-secret",
        },
      },
    });

    const after = Date.now();
    expect(profile.id).toMatch(/^prf_/);
    expect(profile.name).toBe("GPT-4o Target");
    expect(profile.type).toBe("target");
    expect(profile.source).toBe("custom");
    expect(profile.provider).toBe("openai");
    expect(profile.model).toBe("gpt-4o");
    expect(profile.endpoint).toBe("https://api.openai.com/v1");

    // Safe metadata only: no encrypted blob or plaintext credentials/headers.
    expect(profile.secretEncrypted).toBeUndefined();
    expect(profile.apiKey).toBeUndefined();
    expect(profile.customHeaders).toBeUndefined();
    expect(profile.secrets).toBeUndefined();
    expect(JSON.stringify(profile)).not.toContain("Secret Probe Agent");
    expect(JSON.stringify(profile)).not.toContain("X-Private-Tenant");
    expect(JSON.stringify(profile)).not.toContain("tenant-secret");

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
    expect(list[0].customHeaders).toBeUndefined();
    expect(JSON.stringify(list)).not.toContain("tenant-secret");

    // getProbeProfileById only returns safe metadata
    const fetched = await getProbeProfileById(profile.id);
    expect(fetched.id).toBe(profile.id);
    expect(fetched.secretEncrypted).toBeUndefined();
    expect(fetched.customHeaders).toBeUndefined();
    expect(JSON.stringify(fetched)).not.toContain("X-Private-Tenant");

    // Internal getter decrypts secrets
    const withSecrets = await getProbeProfileSecrets(profile.id);
    expect(withSecrets.secrets).toEqual({
      apiKey: "sk-secret-key-123",
      customHeaders: {
        "User-Agent": "Secret Probe Agent/1.0",
        "X-Private-Tenant": "tenant-secret",
      },
    });
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

describe("Probe Profiles POST Route Limits", () => {
  const postJson = async (payloadObj, authed = true) => {
    const { POST: profilesPost } = await import(
      "../../src/app/api/probe/profiles/route.js"
    );
    const req = new Request("https://router.test/api/probe/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof payloadObj === "string" ? payloadObj : JSON.stringify(payloadObj),
    });
    if (!authed) routeMocks.verifyProbeAdminAuth.mockResolvedValueOnce({ authorized: false, ownerId: null });
    const res = await profilesPost(req);
    return res;
  };

  beforeEach(() => {
    routeMocks.verifyProbeAdminAuth.mockResolvedValue({ authorized: true, ownerId: "admin" });
    routeMocks.verifyCsrfOrigin.mockReturnValue(true);
  });

  it("returns 401 when not authorized", async () => {
    const res = await postJson({ name: "x", type: "target" }, false);
    expect(res.status).toBe(401);
  });

  it("returns 413 for oversized bodies", async () => {
    const res = await postJson({
      name: "Big",
      type: "target",
      fill: "x".repeat(40_000),
    });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatch(/too large/i);
  });

  it("returns 400 for an over-long API key", async () => {
    const res = await postJson({
      name: "Mega key",
      type: "target",
      secrets: { apiKey: "k".repeat(9000) },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/too long/i);
  });

  it("returns 400 for missing name and for name over 128 chars", async () => {
    const resMissing = await postJson({ type: "target" });
    expect(resMissing.status).toBe(400);
    expect((await resMissing.json()).error).toMatch(/name is required/i);

    const resLong = await postJson({ name: "n".repeat(129), type: "target" });
    expect(resLong.status).toBe(400);
    expect((await resLong.json()).error).toMatch(/128 characters/i);
  });

  it("rejects oversized custom headers before persisting", async () => {
    const res = await postJson({
      name: "Header bomb",
      type: "target",
      secrets: {
        customHeaders: Object.fromEntries(
          Array.from({ length: 20 }, (_, i) => [`X-H${i}`, `v${i}`])
        ),
      },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/additional header/i);
  });

  it("creates a profile with trimmed name and normalized custom headers", async () => {
    const res = await postJson({
      name: "  Outer Target  ",
      type: "target",
      source: "custom",
      endpoint: "https://api.example.com/v1",
      secrets: {
        apiKey: "sk-ok",
        customHeaders: [{ name: "User-Agent", value: "Probe/1.0" }],
      },
    });
    expect(res.status).toBe(201);
    const { profile } = await res.json();
    expect(profile.name).toBe("Outer Target");
    expect(JSON.stringify(profile)).not.toContain("sk-ok");
    expect(JSON.stringify(profile)).not.toContain("Probe/1.0");

    const { getProbeProfileSecrets } = await import(
      "../../src/lib/db/repos/probeProfilesRepo.js"
    );
    const withSecrets = await getProbeProfileSecrets(profile.id);
    expect(withSecrets.secrets.customHeaders).toEqual({ "User-Agent": "Probe/1.0" });
    expect(withSecrets.secrets.apiKey).toBe("sk-ok");
  });
});
