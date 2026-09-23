import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({
  getApiKeys: vi.fn(async () => [{ id: "key-one", name: "Test key" }]),
}));

const require = createRequire(import.meta.url);
const log = require("../../inference-access-log.cjs");
const dir = mkdtempSync(join(tmpdir(), "9router-ip-route-"));
const oldDataDir = process.env.DATA_DIR;
const { GET } = await import("@/app/api/usage/ip-access/route.js");

beforeAll(() => {
  process.env.DATA_DIR = dir;
  const { DatabaseSync } = require("node:sqlite");
  const dbPath = join(dir, "db", "data.sqlite");
  mkdirSync(join(dir, "db"), { recursive: true });
  log.queryAccess(); // create schema
  const db = new DatabaseSync(dbPath);
  db.prepare("INSERT INTO inferenceAccess(timestamp, clientIp, method, endpoint, status, apiKeyId) VALUES(?, ?, ?, ?, ?, ?)")
    .run(new Date().toISOString(), "127.0.0.1", "POST", "/v1/messages", 200, "key-one");
  db.close();
});

afterAll(() => {
  if (oldDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = oldDataDir;
  rmSync(dir, { recursive: true, force: true });
});

function request(query) {
  return new Request(`http://localhost/api/usage/ip-access?${query}`);
}

describe("inference IP access API", () => {
  it("rejects malformed pagination, status, and dates", async () => {
    for (const query of ["page=0", "pageSize=101", "status=abc", "startDate=nope"]) {
      expect((await GET(request(query))).status).toBe(400);
    }
  });

  it("returns key names and paginated metadata only", async () => {
    const response = await GET(request("page=1&pageSize=20&apiKeyId=key-one"));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.rows[0]).toMatchObject({ clientIp: "127.0.0.1", apiKeyId: "key-one", apiKeyName: "Test key" });
    expect(result.pagination.totalItems).toBe(1);
    expect(result.ips[0].requests).toBe(1);
  });
});
