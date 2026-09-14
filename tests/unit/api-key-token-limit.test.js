// Per-key token limits: create/update validation, usage aggregation, 429 enforcement.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let keysRoute;
let keyIdRoute;
let db;
let usageRepo;

function jsonRequest(method, url, body) {
  return {
    method,
    url,
    json: async () => body,
    headers: new Headers(),
  };
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-ak-toklim-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  keysRoute = await import("@/app/api/keys/route.js");
  keyIdRoute = await import("@/app/api/keys/[id]/route.js");
  db = await import("@/lib/db/index.js");
  usageRepo = await import("@/lib/db/repos/usageRepo.js");
  await db.initDb();
});

afterAll(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function insertUsage(apiKeyId, promptTokens, completionTokens, timestamp) {
  const { getAdapter } = await import("@/lib/db/driver.js");
  const adb = await getAdapter();
  adb.run(
    `INSERT INTO usageHistory(timestamp, provider, model, apiKeyId, promptTokens, completionTokens, cost, status, tokens, meta)
     VALUES(?, 'test', 'test-model', ?, ?, ?, 0, 'ok', '{}', '{}')`,
    [timestamp, apiKeyId, promptTokens, completionTokens]
  );
}

describe("token limit validation", () => {
  it("rejects negative / non-integer tokenLimit", async () => {
    for (const bad of [-1, 1.5, "abc"]) {
      const res = await keysRoute.POST(jsonRequest("POST", "/api/keys", { name: `bad-${bad}`, tokenLimit: bad }));
      expect(res.status).toBe(400);
    }
  });

  it("rejects unknown tokenLimitPeriod", async () => {
    const res = await keysRoute.POST(jsonRequest("POST", "/api/keys", { name: "bad-period", tokenLimit: 100, tokenLimitPeriod: "weekly" }));
    expect(res.status).toBe(400);
  });
});

describe("create + update persistence", () => {
  it("creates key with daily limit; PUT can change period and clear limit", async () => {
    const created = await keysRoute.POST(jsonRequest("POST", "/api/keys", {
      name: "limited",
      tokenLimit: 1000,
      tokenLimitPeriod: "daily",
    }));
    expect(created.status).toBe(201);
    const { id } = await created.json();

    let row = await db.getApiKeyById(id);
    expect(row.tokenLimit).toBe(1000);
    expect(row.tokenLimitPeriod).toBe("daily");

    // Change period
    let res = await keyIdRoute.PUT(jsonRequest("PUT", `/api/keys/${id}`, { tokenLimitPeriod: "monthly" }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    row = await db.getApiKeyById(id);
    expect(row.tokenLimit).toBe(1000);
    expect(row.tokenLimitPeriod).toBe("monthly");

    // Clear limit
    res = await keyIdRoute.PUT(jsonRequest("PUT", `/api/keys/${id}`, { tokenLimit: null }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    row = await db.getApiKeyById(id);
    expect(row.tokenLimit).toBeNull();
    expect(row.tokenLimitPeriod).toBeNull();

    // Omitted → unchanged: re-set then PUT with only name
    await keyIdRoute.PUT(jsonRequest("PUT", `/api/keys/${id}`, { tokenLimit: 500 }), { params: Promise.resolve({ id }) });
    await keyIdRoute.PUT(jsonRequest("PUT", `/api/keys/${id}`, { name: "renamed" }), { params: Promise.resolve({ id }) });
    row = await db.getApiKeyById(id);
    expect(row.tokenLimit).toBe(500);
    expect(row.tokenLimitPeriod).toBe("forever");
  });
});

describe("getApiKeyTokenUsage aggregation", () => {
  it("sums prompt+completion per period window", async () => {
    const created = await keysRoute.POST(jsonRequest("POST", "/api/keys", { name: "agg-key" }));
    const { id } = await created.json();

    const now = new Date();
    const today = new Date(now); today.setHours(1, 0, 0, 0);
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 2, 1, 0, 0, 0);
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15, 1, 0, 0, 0);

    await insertUsage(id, 100, 10, today.toISOString());   // 110
    await insertUsage(id, 200, 20, thisMonth.toISOString()); // 220
    await insertUsage(id, 500, 50, lastMonth.toISOString()); // outside daily + monthly
    await insertUsage(id, 1, 1, today.toISOString());      // 2

    const daily = await usageRepo.getApiKeyTokenUsage(id, "daily");
    expect(daily.totalTokens).toBe(112);

    const monthly = await usageRepo.getApiKeyTokenUsage(id, "monthly");
    expect(monthly.totalTokens).toBe(332);

    const forever = await usageRepo.getApiKeyTokenUsage(id, "forever");
    expect(forever.totalTokens).toBe(882);

    // Other key's usage never counts
    const other = await keysRoute.POST(jsonRequest("POST", "/api/keys", { name: "agg-other" }));
    const { id: otherId } = await other.json();
    const otherUsage = await usageRepo.getApiKeyTokenUsage(otherId, "forever");
    expect(otherUsage.totalTokens).toBe(0);
  });
});

describe("enforcement via resolveApiKeyContext", () => {
  it("429 with insufficient_quota once limit reached; under-limit passes", async () => {
    const { resolveApiKeyContext } = await import("@/sse/services/apiKeyPolicy.js");
    const { saveRequestUsage } = usageRepo;

    const created = await keysRoute.POST(jsonRequest("POST", "/api/keys", {
      name: "enforced",
      tokenLimit: 100,
      tokenLimitPeriod: "forever",
    }));
    const { id, secret } = await created.json();
    expect(secret).toMatch(/^sk-9r-/);

    const req = () => new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
    });

    // Under limit → allowed
    let ctx = await resolveApiKeyContext(req());
    expect(ctx.errorResponse).toBeNull();
    expect(ctx.keyRow.tokenLimit).toBe(100);

    await saveRequestUsage({
      provider: "test", model: "m", tokens: { prompt_tokens: 60, completion_tokens: 60 },
      apiKeyId: id, apiKeyNameSnapshot: "enforced",
    });

    // 120 ≥ 100 → blocked
    ctx = await resolveApiKeyContext(req());
    expect(ctx.errorResponse).not.toBeNull();
    expect(ctx.errorResponse.status).toBe(429);
    const body = await ctx.errorResponse.json();
    expect(body.error.type).toBe("insufficient_quota");
    expect(body.error.code).toBe("token_limit_exceeded");
  });

  it("key without limit is never blocked", async () => {
    const { resolveApiKeyContext } = await import("@/sse/services/apiKeyPolicy.js");
    const { saveRequestUsage } = usageRepo;

    const created = await keysRoute.POST(jsonRequest("POST", "/api/keys", { name: "unlimited" }));
    const { id, secret } = await created.json();

    await saveRequestUsage({
      provider: "test", model: "m", tokens: { prompt_tokens: 100000, completion_tokens: 100000 },
      apiKeyId: id,
    });

    const ctx = await resolveApiKeyContext(new Request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { Authorization: `Bearer ${secret}` },
    }));
    expect(ctx.errorResponse).toBeNull();
  });
});
