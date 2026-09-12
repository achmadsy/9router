// /api/keys routes: metadata-only reads, one-time secret, policy replace, reroll, legacy PUT.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let keysRoute;
let keyIdRoute;
let rerollRoute;
let accessOptionsRoute;
let db;

function jsonRequest(method, url, body) {
  return {
    method,
    url,
    json: async () => body,
    headers: new Headers(),
  };
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-ak-routes-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  // next/server is available in this repo's tests via real next package
  keysRoute = await import("@/app/api/keys/route.js");
  keyIdRoute = await import("@/app/api/keys/[id]/route.js");
  rerollRoute = await import("@/app/api/keys/[id]/reroll/route.js");
  accessOptionsRoute = await import("@/app/api/keys/access-options/route.js");
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("GET /api/keys", () => {
  it("returns metadata only — never key/keyHash secrets in list", async () => {
    await db.createApiKey("meta-only", "m1");
    const res = await keysRoute.GET();
    const body = await res.json();
    expect(Array.isArray(body.keys)).toBe(true);
    for (const k of body.keys) {
      expect(k.key).toBeUndefined();
      expect(k.keyHash).toBeUndefined();
      expect(k.secretEncrypted).toBeUndefined();
      expect(k.keyHint).toMatch(/^sk-9r-/);
      expect(k.id).toBeTruthy();
      expect(k.accessMode).toBeTruthy();
    }
  });
});

describe("POST /api/keys", () => {
  it("201 with one-time secret; supports accessMode + targets", async () => {
    const res = await keysRoute.POST(jsonRequest("POST", "/api/keys", {
      name: "created-1",
      accessMode: "restricted",
      targets: [{ targetType: "model", targetId: "openai/gpt-4o" }],
    }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.secret).toMatch(/^sk-9r-/);
    expect(body.key).toBe(body.secret);
    expect(body.id).toBeTruthy();
    const row = await db.getApiKeyById(body.id);
    expect(row.accessMode).toBe("restricted");
    const targets = await db.getApiKeyAccessTargets(body.id);
    expect(targets).toEqual([{ targetType: "model", targetId: "openai/gpt-4o" }]);
  });

  it("400 without name", async () => {
    const res = await keysRoute.POST(jsonRequest("POST", "/api/keys", {}));
    expect(res.status).toBe(400);
  });

  it("400 on unknown accessMode (does not silently become all)", async () => {
    const res = await keysRoute.POST(jsonRequest("POST", "/api/keys", {
      name: "bad-mode",
      accessMode: "everything",
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/accessMode/i);
  });

  it("400 on unknown target type", async () => {
    const res = await keysRoute.POST(jsonRequest("POST", "/api/keys", {
      name: "bad-targets",
      accessMode: "restricted",
      targets: [{ targetType: "provider", targetId: "openai" }],
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/target/i);
  });
});

describe("GET/PUT/DELETE /api/keys/[id]", () => {
  it("GET returns key + targets, no secret", async () => {
    const created = await db.createApiKey("get-one", "m1");
    const res = await keyIdRoute.GET(null, { params: Promise.resolve({ id: created.id }) });
    const body = await res.json();
    expect(body.key.id).toBe(created.id);
    expect(body.key.key).toBeUndefined();
    expect(body.key.keyHash).toBeUndefined();
    expect(Array.isArray(body.targets)).toBe(true);
  });

  it("PUT replaces policy atomically; rejects key/secret fields", async () => {
    const created = await db.createApiKey("put-policy", "m1");
    const res = await keyIdRoute.PUT(jsonRequest("PUT", `/api/keys/${created.id}`, {
      name: "renamed",
      accessMode: "restricted",
      targets: [
        { targetType: "model", targetId: "a" },
        { targetType: "combo", targetId: "c1" },
      ],
    }), { params: Promise.resolve({ id: created.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.key.name).toBe("renamed");
    // Stored order is stable: ORDER BY targetType, targetId (combo before model)
    expect(body.targets).toEqual([
      { targetType: "combo", targetId: "c1" },
      { targetType: "model", targetId: "a" },
    ]);

    const bad = await keyIdRoute.PUT(jsonRequest("PUT", `/api/keys/${created.id}`, {
      key: "sk-9r-forge",
      keyHash: "deadbeef",
    }), { params: Promise.resolve({ id: created.id }) });
    expect(bad.status).toBe(400);

    const badMachine = await keyIdRoute.PUT(jsonRequest("PUT", `/api/keys/${created.id}`, {
      machineId: "attacker-machine",
    }), { params: Promise.resolve({ id: created.id }) });
    expect(badMachine.status).toBe(400);

    const badMode = await keyIdRoute.PUT(jsonRequest("PUT", `/api/keys/${created.id}`, {
      accessMode: "open",
    }), { params: Promise.resolve({ id: created.id }) });
    expect(badMode.status).toBe(400);
  });

  it("PUT machineId change is rejected and machineId stays unchanged", async () => {
    const created = await db.createApiKey("immutable-machine", "machine-original");
    const res = await keyIdRoute.PUT(jsonRequest("PUT", `/api/keys/${created.id}`, {
      machineId: "machine-forged",
    }), { params: Promise.resolve({ id: created.id }) });
    expect(res.status).toBe(400);
    const row = await db.getApiKeyById(created.id);
    expect(row.machineId).toBe("machine-original");
  });

  it("legacy status-only PUT still works", async () => {
    const created = await db.createApiKey("legacy-put", "m1");
    const res = await keyIdRoute.PUT(jsonRequest("PUT", `/api/keys/${created.id}`, {
      isActive: false,
    }), { params: Promise.resolve({ id: created.id }) });
    expect(res.status).toBe(200);
    const row = await db.getApiKeyById(created.id);
    expect(row.isActive).toBe(false);
  });

  it("DELETE returns success and keeps usage history", async () => {
    const created = await db.createApiKey("del-key", "m1");
    const adapter = (await import("@/lib/db/driver.js")).getAdapter
      ? await (await import("@/lib/db/driver.js")).getAdapter()
      : null;
    if (adapter) {
      adapter.run(
        `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, apiKeyId, apiKeyNameSnapshot, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [new Date().toISOString(), "openai", "gpt-4", null, null, created.id, "del-key", "/v1/chat", 1, 1, 0, "ok", "{}", "{}"],
      );
    }
    const res = await keyIdRoute.DELETE(null, { params: Promise.resolve({ id: created.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success || body.message).toBeTruthy();
    expect(await db.getApiKeyById(created.id)).toBe(null);
    if (adapter) {
      const hist = adapter.all(`SELECT * FROM usageHistory WHERE apiKeyId = ?`, [created.id]);
      expect(hist.length).toBe(1);
    }
  });
});

describe("POST /api/keys/[id]/reroll", () => {
  it("rotates secret once, same id/policy", async () => {
    const created = await db.createApiKey("rr", "m1", {
      accessMode: "restricted",
      targets: [{ targetType: "model", targetId: "x" }],
    });
    const res = await rerollRoute.POST(null, { params: Promise.resolve({ id: created.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.key).toMatch(/^sk-9r-/);
    expect(body.id).toBe(created.id);
    const targets = await db.getApiKeyAccessTargets(created.id);
    expect(targets).toEqual([{ targetType: "model", targetId: "x" }]);
  });

  it("404 for missing id", async () => {
    const res = await rerollRoute.POST(null, { params: Promise.resolve({ id: "nope" }) });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/keys/access-options", () => {
  it("returns unfiltered models + combos for management", async () => {
    const res = await accessOptionsRoute.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.models)).toBe(true);
    expect(Array.isArray(body.combos)).toBe(true);
  });
});
