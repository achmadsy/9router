const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const HMAC_CONTEXT = "9router-api-key:v1:";
let connection;
let lastCleanup = 0;

function isInferencePath(pathname) {
  if (pathname === "/v1/api/hello") return false;
  return ["/v1", "/v1beta", "/api/v1", "/api/v1beta", "/codex", "/responses", "/systemone"]
    .some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function normalizeIp(ip) {
  if (typeof ip !== "string") return null;
  const value = ip.trim();
  return value.replace(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i, "$1") || null;
}

function dataFile() {
  const base = process.env.DATA_DIR || path.join(os.homedir(), ".9router");
  return path.join(base, "db", "data.sqlite");
}

function getConnection() {
  if (connection) return connection;
  const fs = require("node:fs");
  const file = dataFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let db;
  if (process.versions.bun) {
    const { Database } = require("bun:sqlite");
    db = new Database(file);
  } else {
    const major = Number(process.versions.node.split(".")[0]);
    if (major < 24) {
      try {
        const BetterSqlite = require("better-sqlite3");
        db = new BetterSqlite(file);
      } catch { /* Fall back to node:sqlite when available. */ }
    }
    if (!db) {
      if (major < 22) throw new Error("IP access logging needs better-sqlite3 on Node <22, or Node >=22.5");
      const { DatabaseSync } = require("node:sqlite");
      db = new DatabaseSync(file);
    }
  }
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE IF NOT EXISTS inferenceAccess (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, clientIp TEXT, method TEXT NOT NULL, endpoint TEXT NOT NULL, status INTEGER NOT NULL, apiKeyId TEXT)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_ia_timestamp ON inferenceAccess(timestamp DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_ia_key_ts ON inferenceAccess(apiKeyId, timestamp DESC)");
  connection = db;
  return db;
}

function purgeExpired(db = getConnection(), now = Date.now()) {
  const cutoff = new Date(now - RETENTION_MS).toISOString();
  db.prepare("DELETE FROM inferenceAccess WHERE timestamp < ?").run(cutoff);
  lastCleanup = now;
}

function resolveKeyId(db, headers, requestUrl) {
  const authorization = headers.authorization || "";
  let secret = authorization.startsWith("Bearer ") ? authorization.slice(7) :
    headers["x-api-key"] || headers["x-goog-api-key"] || "";
  if (!secret) {
    try { secret = new URL(requestUrl, "http://localhost").searchParams.get("key") || ""; } catch { /* ignore */ }
  }
  if (typeof secret !== "string" || !secret.startsWith("sk-") || secret.length < 16 || secret.length > 512 || /\s/.test(secret)) return null;
  const digest = crypto.createHmac("sha256", process.env.API_KEY_SECRET || "endpoint-proxy-api-key-secret")
    .update(HMAC_CONTEXT + secret).digest("hex");
  try {
    return db.prepare("SELECT id FROM apiKeys WHERE keyHash = ? AND isActive = 1").get(digest)?.id || null;
  } catch { return null; }
}

function purgeExpiredSafely() {
  try { purgeExpired(); }
  catch (error) { console.error("[inference-access] Cleanup failed:", error?.message || error); }
}

function recordRequest({ ip, method, url, status, headers = {}, timestamp = new Date().toISOString() }) {
  try {
    const pathname = new URL(url, "http://localhost").pathname;
    if (!isInferencePath(pathname)) return;
    const db = getConnection();
    const now = Date.now();
    if (now - lastCleanup >= CLEANUP_INTERVAL_MS) purgeExpired(db, now);
    db.prepare("INSERT INTO inferenceAccess(timestamp, clientIp, method, endpoint, status, apiKeyId) VALUES(?, ?, ?, ?, ?, ?)")
      .run(timestamp, normalizeIp(ip), method || "GET", pathname, status || 0, resolveKeyId(db, headers, url));
  } catch (error) {
    console.error("[inference-access] Could not record request:", error?.message || error);
  }
}

function queryAccess({ apiKeyId = "", ip = "", startDate = "", endDate = "", status = null, page = 1, pageSize = 20 } = {}) {
  const db = getConnection();
  const now = Date.now();
  if (now - lastCleanup >= CLEANUP_INTERVAL_MS) purgeExpired(db, now);
  const conditions = ["timestamp >= ?"];
  const params = [new Date(Date.now() - RETENTION_MS).toISOString()];
  if (apiKeyId === "none") conditions.push("apiKeyId IS NULL");
  else if (apiKeyId) { conditions.push("apiKeyId = ?"); params.push(apiKeyId); }
  if (ip) { conditions.push("clientIp = ?"); params.push(ip); }
  if (startDate) { conditions.push("timestamp >= ?"); params.push(startDate); }
  if (endDate) { conditions.push("timestamp <= ?"); params.push(endDate); }
  if (status !== null) { conditions.push("status = ?"); params.push(status); }
  const where = conditions.join(" AND ");
  const totalItems = db.prepare(`SELECT COUNT(*) AS count FROM inferenceAccess WHERE ${where}`).get(...params).count;
  const rows = db.prepare(`SELECT id, timestamp, clientIp, method, endpoint, status, apiKeyId FROM inferenceAccess WHERE ${where} ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize);
  const ips = db.prepare(`SELECT clientIp AS ip, COUNT(*) AS requests, MAX(timestamp) AS lastSeen, COUNT(DISTINCT apiKeyId) AS keyCount FROM inferenceAccess WHERE ${where} GROUP BY clientIp ORDER BY requests DESC, lastSeen DESC LIMIT 100`)
    .all(...params);
  return { rows, ips, pagination: { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) } };
}

module.exports = { isInferencePath, normalizeIp, recordRequest, queryAccess, purgeExpired, purgeExpiredSafely };
