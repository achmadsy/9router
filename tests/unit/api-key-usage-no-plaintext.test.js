// HIGH1: usage history must never persist a presented API-key secret.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-usage-secret-"));
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

describe("saveRequestUsage never stores plaintext apiKey", () => {
  it("ignores presented secret and writes apiKeyId/name only", async () => {
    const { saveRequestUsage } = await import("@/lib/db/repos/usageRepo.js");
    const { getAdapter } = await import("@/lib/db/driver.js");
    const secret = "sk-9r-super-secret-do-not-persist";

    await saveRequestUsage({
      provider: "openai",
      model: "gpt-4o",
      timestamp: new Date().toISOString(),
      connectionId: "conn-1",
      apiKey: secret, // caller still may pass it — must be dropped
      apiKeyId: "ak-fixed",
      apiKeyNameSnapshot: "My Key",
      tokens: { prompt_tokens: 10, completion_tokens: 5 },
    });
    // allow async insert flush
    await new Promise((r) => setTimeout(r, 50));

    const db = await getAdapter();
    const rows = db.all(`SELECT apiKey, apiKeyId, apiKeyNameSnapshot FROM usageHistory`);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.apiKey === secret)).toBe(false);
    expect(rows.some((r) => r.apiKeyId === "ak-fixed")).toBe(true);
    expect(rows.some((r) => r.apiKeyNameSnapshot === "My Key")).toBe(true);
  });

  it("aggregate byApiKey meta never embeds the secret", async () => {
    const { saveRequestUsage } = await import("@/lib/db/repos/usageRepo.js");
    const { getAdapter } = await import("@/lib/db/driver.js");
    const secret = "sk-9r-agg-secret";

    await saveRequestUsage({
      provider: "openai",
      model: "gpt-4o",
      timestamp: new Date().toISOString(),
      apiKey: secret,
      apiKeyId: "ak-agg",
      apiKeyNameSnapshot: "Agg",
      tokens: { prompt_tokens: 1, completion_tokens: 1 },
    });
    await new Promise((r) => setTimeout(r, 50));

    const db = await getAdapter();
    const day = db.get(`SELECT data FROM usageDaily LIMIT 1`);
    expect(day.data.includes(secret)).toBe(false);
    const parsed = JSON.parse(day.data);
    const entry = Object.values(parsed.byApiKey || {})[0];
    expect(entry?.apiKey == null || entry?.apiKey === "").toBe(true);
    expect(entry?.apiKeyId === "ak-agg").toBe(true);
  });
});
