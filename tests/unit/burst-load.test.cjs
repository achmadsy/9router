const path = require("path");
const fs = require("fs");
const os = require("os");

const { spawnSync } = require("child_process");

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

  const duration = Date.now() - start;
  // Let the scheduled batch flush drain the burst, as it does in the server.
  await new Promise((resolve) => setTimeout(resolve, 500));
  console.log(`8,000 requests queued in ${duration}ms`);

  const Database = require("better-sqlite3");
  const db = new Database(path.join(tmpDir, "db", "data.sqlite"));
  const count = db.prepare("SELECT COUNT(*) AS c FROM inferenceAccess").get().c;
  const integrity = db.pragma("integrity_check");
  console.log("Recorded rows:", count, "Integrity:", integrity);

  db.close();
  const blocker = new Database(path.join(tmpDir, "db", "data.sqlite"));
  blocker.exec("BEGIN IMMEDIATE");
  const lockedStart = Date.now();
  for (let i = 0; i < 10500; i++) {
    log.recordRequest({ ip: "127.0.0.1", method: "GET", url: "/v1/models", status: 401 });
  }
  const enqueueMs = Date.now() - lockedStart;
  if (enqueueMs >= 2000) throw new Error(`Locked DB stalled request path: ${enqueueMs}ms`);
  log.flushPending();
  await new Promise((resolve) => setTimeout(resolve, 350));
  blocker.exec("COMMIT");
  blocker.close();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const afterRetry = new Database(path.join(tmpDir, "db", "data.sqlite"), { readonly: true });
  const retriedCount = afterRetry.prepare("SELECT COUNT(*) AS c FROM inferenceAccess").get().c;
  const afterIntegrity = afterRetry.pragma("quick_check");
  afterRetry.close();
  if (retriedCount !== total + 10000) throw new Error(`Locked batch not retried or queue unbounded: ${retriedCount}`);
  if (afterIntegrity[0].quick_check !== "ok") throw new Error("Database integrity check failed after lock recovery");

  for (const signal of [null, "SIGTERM"]) {
    const childDir = path.join(tmpDir, signal || "exit");
    fs.mkdirSync(childDir);
    const child = spawnSync(process.execPath, ["-e", `
      const log = require(${JSON.stringify(path.join(__dirname, "../../inference-access-log.cjs"))});
      log.recordRequest({ ip: "127.0.0.1", method: "GET", url: "/v1/models", status: 401 });
      ${signal ? 'const server = require("node:http").createServer((req, res) => res.end("ok")); server.listen(0, "127.0.0.1", () => process.kill(process.pid, "SIGTERM"));' : ""}
    `], { env: { ...process.env, DATA_DIR: childDir }, timeout: 5000 });
    const childDb = path.join(childDir, "db", "data.sqlite");
    const recorded = fs.existsSync(childDb)
      ? new Database(childDb, { readonly: true }).prepare("SELECT COUNT(*) AS c FROM inferenceAccess").get().c
      : 0;
    if (signal) {
      if (child.signal !== signal) throw new Error(`Signal handler blocked ${signal} shutdown: ${child.stderr}`);
    } else if (child.status !== 0 || recorded !== 1) {
      throw new Error(`Pending access record lost on exit: ${child.stderr}`);
    }
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });

  if (integrity[0].integrity_check !== "ok" || count !== total) {
    console.error("FAIL");
    process.exit(1);
  }
  console.log("PASS: 8,000 request burst handled safely without corruption!");
}

run().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
