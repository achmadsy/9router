const path = require("path");
const fs = require("fs");
const os = require("os");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-burst-test-"));
process.env.DATA_DIR = tmpDir;

const log = require("../../inference-access-log.cjs");

async function run() {
  console.log("Starting 8,000 request burst test in:", tmpDir);
  const total = 8000;
  const start = Date.now();

  for (let i = 0; i < total; i++) {
    log.recordRequest({
      ip: `198.51.100.${(i % 250) + 1}`,
      method: i % 2 === 0 ? "POST" : "GET",
      url: "http://localhost/v1/chat/completions",
      status: 200,
      headers: { "x-api-key": `sk-test-${i}` },
      timestamp: new Date().toISOString()
    });
  }

  // Force drain
  log.flushPending();
  const duration = Date.now() - start;
  console.log(`8,000 requests pushed & flushed in ${duration}ms`);

  const Database = require("better-sqlite3");
  const db = new Database(path.join(tmpDir, "db", "data.sqlite"));
  const count = db.prepare("SELECT COUNT(*) AS c FROM inferenceAccess").get().c;
  const integrity = db.pragma("integrity_check");
  console.log("Recorded rows:", count, "Integrity:", integrity);

  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  if (integrity[0].integrity_check !== "ok" || count === 0) {
    console.error("FAIL");
    process.exit(1);
  }
  console.log("PASS: 8,000 request burst handled safely without corruption!");
}

run().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
