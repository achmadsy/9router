import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import crypto from "node:crypto";

const require = createRequire(import.meta.url);
const DatabaseSync = require("better-sqlite3");
const log = require("../../inference-access-log.cjs");
const dir = mkdtempSync(join(tmpdir(), "9router-ip-access-"));
const previousDataDir = process.env.DATA_DIR;
let server;
let baseUrl;

beforeAll(async () => {
  process.env.DATA_DIR = dir;
  require("../../custom-server.js");
  server = http.createServer((req, res) => {
    res.statusCode = req.url.startsWith("/v1/reject") ? 401 : 200;
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  const db = new DatabaseSync(join(dir, "db", "data.sqlite"));
  db.exec("DELETE FROM inferenceAccess");
  db.close();
});

describe("inference access records", () => {
  it("records trusted loopback proxy IP once, ignores forged peer header and query secrets", async () => {
    await fetch(`${baseUrl}/v1/chat/completions?key=sk-secret`, {
      headers: { "x-9r-real-ip": "203.0.113.55", "x-forwarded-for": "198.51.100.20", "authorization": "Bearer sk-unrecognized-key-value" },
    });
    const result = log.queryAccess();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ clientIp: "198.51.100.20", endpoint: "/v1/chat/completions", status: 200, apiKeyId: null });
    expect(JSON.stringify(result)).not.toContain("sk-secret");
  });

  it("links a valid key by ID without saving its secret", async () => {
    const secret = `sk-9r-${"a".repeat(43)}`;
    const digest = crypto.createHmac("sha256", process.env.API_KEY_SECRET || "endpoint-proxy-api-key-secret")
      .update(`9router-api-key:v1:${secret}`).digest("hex");
    const db = new DatabaseSync(join(dir, "db", "data.sqlite"));
    db.exec("CREATE TABLE IF NOT EXISTS apiKeys (id TEXT PRIMARY KEY, keyHash TEXT, isActive INTEGER)");
    db.prepare("INSERT OR REPLACE INTO apiKeys(id, keyHash, isActive) VALUES(?, ?, 1)").run("key-one", digest);
    db.close();
    await fetch(`${baseUrl}/v1/chat/completions`, { headers: { authorization: `Bearer ${secret}` } });
    const result = log.queryAccess({ apiKeyId: "key-one" });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].apiKeyId).toBe("key-one");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("filters valid key and no-key traffic independently", async () => {
    const secret = `sk-9r-${"b".repeat(43)}`;
    const digest = crypto.createHmac("sha256", process.env.API_KEY_SECRET || "endpoint-proxy-api-key-secret")
      .update(`9router-api-key:v1:${secret}`).digest("hex");
    const db = new DatabaseSync(join(dir, "db", "data.sqlite"));
    db.exec("CREATE TABLE IF NOT EXISTS apiKeys (id TEXT PRIMARY KEY, keyHash TEXT, isActive INTEGER)");
    db.prepare("INSERT OR REPLACE INTO apiKeys(id, keyHash, isActive) VALUES(?, ?, 1)").run("key-two", digest);
    db.close();
    await fetch(`${baseUrl}/v1/chat/completions`, { headers: { authorization: `Bearer ${secret}` } });
    await fetch(`${baseUrl}/v1/reject`);
    expect(log.queryAccess({ apiKeyId: "key-two" }).rows).toMatchObject([{ apiKeyId: "key-two", status: 200 }]);
    expect(log.queryAccess({ apiKeyId: "none" }).rows).toMatchObject([{ apiKeyId: null, status: 401 }]);
    expect(log.queryAccess({ status: 401 }).ips).toMatchObject([{ requests: 1 }]);
  });

  it("captures denied inference but not dashboard requests", async () => {
    await fetch(`${baseUrl}/v1/reject`);
    await fetch(`${baseUrl}/dashboard/usage`);
    expect(log.queryAccess().rows).toMatchObject([{ status: 401, endpoint: "/v1/reject" }]);
  });

  it("purges only IP rows older than seven days", () => {
    const DatabaseSync = require("better-sqlite3");
    const db = new DatabaseSync(join(dir, "db", "data.sqlite"));
    db.exec("CREATE TABLE IF NOT EXISTS usageHistory (id INTEGER PRIMARY KEY)");
    db.exec("INSERT OR IGNORE INTO usageHistory VALUES (1)");
    db.prepare("INSERT INTO inferenceAccess(timestamp, clientIp, method, endpoint, status) VALUES(?, ?, ?, ?, ?)")
      .run(new Date(Date.now() - 8 * 86400000).toISOString(), "198.51.100.1", "POST", "/v1/chat/completions", 200);
    db.close();
    log.purgeExpired();
    expect(log.queryAccess().rows).toHaveLength(0);
    const verify = new DatabaseSync(join(dir, "db", "data.sqlite"));
    expect(verify.prepare("SELECT COUNT(*) AS count FROM usageHistory").get().count).toBe(1);
    verify.close();
  });
});
