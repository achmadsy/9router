import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-usage-apikey-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Usage page API-key filter", () => {
  it("scopes getUsageStats / getChartData by apiKeyId", async () => {
    for (let i = 0; i < 20; i++) {
      await db.saveRequestUsage({
        provider: "openai", model: "gpt-4", connectionId: "c1",
        tokens: { prompt_tokens: 10, completion_tokens: 5 },
        endpoint: "/v1/chat", status: "ok",
        apiKeyId: i % 2 === 0 ? "key-a" : "key-b",
        apiKeyNameSnapshot: i % 2 === 0 ? "Key A" : "Key B",
      });
    }

    const all = await db.getUsageStats("24h");
    const a = await db.getUsageStats("24h", { apiKeyId: "key-a" });
    const b = await db.getUsageStats("24h", { apiKeyId: "key-b" });

    expect(all.totalRequests).toBe(20);
    expect(a.totalRequests).toBe(10);
    expect(b.totalRequests).toBe(10);
    expect(a.byProvider.openai.requests).toBe(10);
    expect(b.byProvider.openai.requests).toBe(10);

    const chartAll = await db.getChartData("24h");
    const chartA = await db.getChartData("24h", { apiKeyId: "key-a" });
    const sumAll = chartAll.reduce((s, e) => s + e.tokens, 0);
    const sumA = chartA.reduce((s, e) => s + e.tokens, 0);
    expect(sumA).toBe(10 * 15);
    expect(sumAll).toBe(20 * 15);
  });

  it("filters getRequestDetails by apiKeyId after saveRequestDetail", async () => {
    await db.updateSettings({
      enableObservability: true,
      observabilityBatchSize: 1,
      observabilityFlushIntervalMs: 10,
    });

    await db.saveRequestDetail({
      id: "det-a", provider: "openai", model: "gpt-4", connectionId: "c1",
      apiKeyId: "key-a", status: "ok", tokens: { prompt_tokens: 1 },
      request: { a: 1 }, response: { ok: true },
    });
    await db.saveRequestDetail({
      id: "det-b", provider: "openai", model: "gpt-4", connectionId: "c1",
      apiKeyId: "key-b", status: "ok", tokens: { prompt_tokens: 1 },
      request: { b: 1 }, response: { ok: true },
    });
    await new Promise((r) => setTimeout(r, 250));

    const onlyA = await db.getRequestDetails({ apiKeyId: "key-a" });
    expect(onlyA.pagination.totalItems).toBe(1);
    expect(onlyA.details[0].apiKeyId).toBe("key-a");
  });
});
