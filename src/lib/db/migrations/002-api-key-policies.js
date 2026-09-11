// Migration 002: hashed API keys + access-target policies + usage attribution.
// Idempotent: no-ops when apiKeys already has keyHash and no plaintext `key`.
import crypto from "node:crypto";
import { TABLES, buildCreateTableSql } from "../schema.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const HMAC_CONTEXT = "9router-api-key:v1:";

function apiSecret() {
  return process.env.API_KEY_SECRET || "endpoint-proxy-api-key-secret";
}

function hashLegacySecret(secret) {
  return crypto.createHmac("sha256", apiSecret()).update(HMAC_CONTEXT + secret).digest("hex");
}

function hintFor(secret) {
  if (!secret || secret.length < 8) return "sk-***";
  return `sk-9r-***${secret.slice(-4)}`;
}

function columnNames(db, table) {
  return db.all(`PRAGMA table_info(${table})`).map((r) => r.name);
}

function loadStagedLegacyKeys(db) {
  try {
    return db.all(`SELECT id, key, name, machineId, isActive, createdAt FROM _legacy_api_keys`);
  } catch {
    return [];
  }
}

function hasColumn(db, table, col) {
  return columnNames(db, table).includes(col);
}

export default {
  version: 2,
  name: "api-key-policies",
  up(db) {
    // Ensure target table exists (fresh DB via 001 already created it from TABLES).
    db.exec(buildCreateTableSql("apiKeyAccessTargets", TABLES.apiKeyAccessTargets));
    for (const idx of TABLES.apiKeyAccessTargets.indexes || []) db.exec(idx);

    // usageHistory attribution columns (additive; fresh DB has them from TABLES).
    if (!hasColumn(db, "usageHistory", "apiKeyId")) {
      db.exec(`ALTER TABLE usageHistory ADD COLUMN apiKeyId TEXT`);
    }
    if (!hasColumn(db, "usageHistory", "apiKeyNameSnapshot")) {
      db.exec(`ALTER TABLE usageHistory ADD COLUMN apiKeyNameSnapshot TEXT`);
    }
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_uh_apiKeyId ON usageHistory(apiKeyId)`); } catch {}

    const cols = columnNames(db, "apiKeys");
    const hasLegacyPlain = cols.includes("key");
    const hasHash = cols.includes("keyHash");

    // Already migrated — hash any staged legacy plaintext keys, then backfill usage.
    if (!hasLegacyPlain && hasHash) {
      const stagedNow = loadStagedLegacyKeys(db);
      if (stagedNow.length > 0) {
        const secretToNow = new Map();
        for (const r of stagedNow) {
          if (r.key) secretToNow.set(String(r.key), { id: r.id, name: r.name || null });
        }
        for (const r of stagedNow) {
          const secret = r.key || null;
          const keyHash = secret ? hashLegacySecret(secret) : hashLegacySecret(`migrated:${r.id}:${new Date().toISOString()}`);
          const keyHint = secret ? hintFor(secret) : "sk-***";
          const existing = db.get(`SELECT id FROM apiKeys WHERE id = ?`, [r.id]);
          if (existing) continue;
          db.run(
            `INSERT OR REPLACE INTO apiKeys(id, keyHash, keyHint, hashVersion, name, machineId, accessMode, isActive, createdAt, updatedAt, rerolledAt)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
            [
              r.id,
              keyHash,
              keyHint,
              1,
              r.name || "Untitled",
              r.machineId || null,
              "all",
              r.isActive === 0 || r.isActive === false ? 0 : 1,
              r.createdAt || new Date().toISOString(),
              new Date().toISOString(),
            ]
          );
        }
        migrateUsageHistory(db, secretToNow);
        migrateUsageDaily(db, secretToNow);
        try { db.exec(`DROP TABLE IF EXISTS _legacy_api_keys`); } catch {}
      }
      backfillUsageAttribution(db);
      return;
    }

    // Capture legacy rows before rebuild. Prefer in-place `key` column; fall back to
    // the staging table populated by legacy db.json import.
    let legacyRows = hasLegacyPlain
      ? db.all(`SELECT id, key, name, machineId, isActive, createdAt FROM apiKeys`)
      : db.all(`SELECT id, name, machineId, isActive, createdAt FROM apiKeys`).map((r) => ({ ...r, key: null }));
    try {
      const staged = db.all(`SELECT id, key, name, machineId, isActive, createdAt FROM _legacy_api_keys`);
      const seen = new Set(legacyRows.map((r) => r.id));
      for (const s of staged) {
        if (!seen.has(s.id)) legacyRows.push(s);
      }
    } catch { /* no staging table */ }

    // Build secret → id map for usage migration BEFORE dropping plaintext.
    const secretToKey = new Map();
    for (const r of legacyRows) {
      if (r.key) secretToKey.set(String(r.key), { id: r.id, name: r.name || null });
    }

    // Rebuild apiKeys with new shape.
    db.exec(`DROP TABLE IF EXISTS apiKeys_new`);
    db.exec(buildCreateTableSql("apiKeys_new", TABLES.apiKeys));
    const now = new Date().toISOString();
    for (const r of legacyRows) {
      const secret = r.key || null;
      const keyHash = secret ? hashLegacySecret(secret) : hashLegacySecret(`migrated:${r.id}:${now}`);
      const keyHint = secret ? hintFor(secret) : "sk-***";
      db.run(
        `INSERT OR REPLACE INTO apiKeys_new(id, keyHash, keyHint, hashVersion, name, machineId, accessMode, isActive, createdAt, updatedAt, rerolledAt)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [
          r.id,
          keyHash,
          keyHint,
          1,
          r.name || "Untitled",
          r.machineId || null,
          "all",
          r.isActive === 0 || r.isActive === false ? 0 : 1,
          r.createdAt || now,
          now,
        ]
      );
    }
    db.exec(`DROP TABLE apiKeys`);
    db.exec(`ALTER TABLE apiKeys_new RENAME TO apiKeys`);
    for (const idx of TABLES.apiKeys.indexes || []) db.exec(idx);

    // Migrate usage attribution: raw secret → apiKeyId + name snapshot.
    migrateUsageHistory(db, secretToKey);
    migrateUsageDaily(db, secretToKey);
    try { db.exec(`DROP TABLE IF EXISTS _legacy_api_keys`); } catch {}
  },
};

function syntheticRef(secret) {
  return `skh:${hashLegacySecret(String(secret)).slice(0, 16)}`;
}

function looksLikeRawSecret(raw) {
  if (!raw) return false;
  const s = String(raw);
  if (s === "local-no-key") return false;
  if (s.startsWith("skh:")) return false;
  return true;
}

function migrateUsageHistory(db, secretToKey) {
  const rows = db.all(`SELECT id, apiKey, apiKeyId, apiKeyNameSnapshot FROM usageHistory`);
  for (const r of rows) {
    let apiKeyId = r.apiKeyId || null;
    let apiKeyNameSnapshot = r.apiKeyNameSnapshot || null;
    const rawSecret = r.apiKey;

    if (!apiKeyId && rawSecret && secretToKey.has(String(rawSecret))) {
      const match = secretToKey.get(String(rawSecret));
      apiKeyId = match.id;
      apiKeyNameSnapshot = match.name;
    } else if (!apiKeyId && looksLikeRawSecret(rawSecret)) {
      // Unknown secret: keep a non-reversible ref, never the raw value.
      apiKeyId = syntheticRef(rawSecret);
    }

    if (apiKeyId && !apiKeyNameSnapshot) {
      const nameRow = db.get(`SELECT name FROM apiKeys WHERE id = ?`, [apiKeyId]);
      if (nameRow?.name) apiKeyNameSnapshot = nameRow.name;
    }

    // Always clear the plaintext column (or replace with the synthetic ref).
    const nextApiKeyValue = apiKeyId && apiKeyId.startsWith("skh:") ? apiKeyId : null;
    if (r.apiKey !== nextApiKeyValue || r.apiKeyId !== apiKeyId || (r.apiKeyNameSnapshot || null) !== (apiKeyNameSnapshot || null)) {
      db.run(
        `UPDATE usageHistory SET apiKey = ?, apiKeyId = ?, apiKeyNameSnapshot = ? WHERE id = ?`,
        [nextApiKeyValue, apiKeyId, apiKeyNameSnapshot, r.id]
      );
    }
  }
  backfillUsageAttribution(db);
}

function backfillUsageAttribution(db) {
  const rows = db.all(
    `SELECT uh.id as rowId, uh.apiKeyId as kid, k.name as name FROM usageHistory uh JOIN apiKeys k ON k.id = uh.apiKeyId WHERE uh.apiKeyNameSnapshot IS NULL OR uh.apiKeyNameSnapshot = ''`
  );
  for (const r of rows) {
    db.run(`UPDATE usageHistory SET apiKeyNameSnapshot = ? WHERE id = ?`, [r.name, r.rowId]);
  }
}

function migrateUsageDaily(db, secretToKey) {
  const dayRows = db.all(`SELECT dateKey, data FROM usageDaily`);
  for (const dr of dayRows) {
    const day = parseJson(dr.data, null);
    if (!day || typeof day !== "object" || !day.byApiKey) continue;
    const next = {};
    let changed = false;
    for (const [k, v] of Object.entries(day.byApiKey)) {
      const [rawKey, model, provider] = k.split("|");
      let newRaw = rawKey;
      let apiKeyId = v?.apiKeyId || null;
      let apiKeyNameSnapshot = v?.apiKeyNameSnapshot || null;
      if (secretToKey.has(rawKey)) {
        const match = secretToKey.get(rawKey);
        newRaw = match.id;
        apiKeyId = match.id;
        apiKeyNameSnapshot = match.name;
        changed = true;
      } else if (rawKey && rawKey !== "local-no-key" && db.get(`SELECT id FROM apiKeys WHERE id = ?`, [rawKey])) {
        apiKeyId = rawKey;
        const nameRow = db.get(`SELECT name FROM apiKeys WHERE id = ?`, [rawKey]);
        apiKeyNameSnapshot = nameRow?.name || null;
      } else if (looksLikeRawSecret(rawKey)) {
        newRaw = syntheticRef(rawKey);
        apiKeyId = newRaw;
        changed = true;
      }
      const newK = [newRaw, model, provider].filter((x) => x !== undefined).join("|");
      next[newK] = { ...v, apiKeyId, apiKeyNameSnapshot, apiKey: null };
      if (v?.apiKey) changed = true;
    }
    // Preserve totals: only rewrite the byApiKey map.
    db.run(`INSERT OR REPLACE INTO usageDaily(dateKey, data) VALUES(?, ?)`, [
      dr.dateKey,
      stringifyJson({ ...day, byApiKey: next }),
    ]);
  }
}
