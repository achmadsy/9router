import { randomUUID } from "node:crypto";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

function rowToPolicy(r) {
  if (!r) return null;
  return {
    id: r.id,
    provider: r.provider,
    model: r.model,
    timeoutMs: r.timeoutMs,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function rowToCooldown(r) {
  if (!r) return null;
  return {
    id: r.id,
    provider: r.provider,
    model: r.model || "",
    scopeType: r.scopeType,
    scopeId: r.scopeId,
    startedAt: r.startedAt,
    expiresAt: r.expiresAt,
    source: r.source,
    reason: r.reason,
    status: r.status,
    headerName: r.headerName,
    data: parseJson(r.data, null),
  };
}

// ─── Policies (manual per-model wait) ──────────────────────────────

export async function getSelfAwarePolicy(provider, model) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM selfAwarePolicies WHERE provider = ? AND model = ?`, [provider, model || ""]);
  if (row) return rowToPolicy(row);
  // Blank-model ("all") fallback: UI saves empty model as provider-wide wait.
  // Exact model match still wins; named-model requests fall back to the "" row.
  if (model) {
    const all = db.get(`SELECT * FROM selfAwarePolicies WHERE provider = ? AND model = ?`, [provider, ""]);
    if (all) return rowToPolicy(all);
  }
  return null;
}

export async function listSelfAwarePolicies() {
  const db = await getAdapter();
  return db.all(`SELECT * FROM selfAwarePolicies ORDER BY provider, model`).map(rowToPolicy);
}

export async function upsertSelfAwarePolicy({ provider, model, timeoutMs }) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const m = model || "";
  db.run(
    `INSERT INTO selfAwarePolicies(provider, model, timeoutMs, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(provider, model) DO UPDATE SET timeoutMs = excluded.timeoutMs, updatedAt = excluded.updatedAt`,
    [provider, m, Math.round(timeoutMs), now, now]
  );
  return rowToPolicy(db.get(`SELECT * FROM selfAwarePolicies WHERE provider = ? AND model = ?`, [provider, m]));
}

export async function deleteSelfAwarePolicy(provider, model) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM selfAwarePolicies WHERE provider = ? AND model = ?`, [provider, model || ""]);
  return (res?.changes ?? 0) > 0;
}

// ─── Cooldowns (metadata sidecar + proxy/provider scopes) ──────────

export async function upsertCooldown(entry) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const id = entry.id || randomUUID();
  const startedAt = entry.startedAtMs ? new Date(entry.startedAtMs).toISOString() : now;
  const expiresAt = new Date(entry.expiresAtMs).toISOString();
  db.run(
    `INSERT INTO selfAwareCooldowns(id, provider, model, scopeType, scopeId, startedAt, expiresAt, source, reason, status, headerName, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, model, scopeType, scopeId) DO UPDATE SET
       id = excluded.id,
       startedAt = excluded.startedAt,
       expiresAt = excluded.expiresAt,
       source = excluded.source,
       reason = excluded.reason,
       status = excluded.status,
       headerName = excluded.headerName,
       data = excluded.data,
       updatedAt = excluded.updatedAt`,
    [
      id,
      entry.provider,
      entry.model || "",
      entry.scopeType || "account",
      entry.scopeId || "provider",
      startedAt,
      expiresAt,
      entry.source || "legacy-backoff",
      entry.reason || null,
      entry.status ?? null,
      entry.headerName || null,
      entry.data ? stringifyJson(entry.data) : null,
      now,
      now,
    ]
  );
  return rowToCooldown(db.get(
    `SELECT * FROM selfAwareCooldowns WHERE provider = ? AND model = ? AND scopeType = ? AND scopeId = ?`,
    [entry.provider, entry.model || "", entry.scopeType || "account", entry.scopeId || "provider"]
  ));
}

export async function listActiveCooldowns(nowMs = Date.now()) {
  const db = await getAdapter();
  const iso = new Date(nowMs).toISOString();
  return db
    .all(`SELECT * FROM selfAwareCooldowns WHERE expiresAt > ? ORDER BY expiresAt`, [iso])
    .map(rowToCooldown);
}

export async function listCooldownsForScopes(provider, model, scopeType, scopeIds, nowMs = Date.now()) {
  const db = await getAdapter();
  if (!scopeIds || scopeIds.length === 0) return [];
  const iso = new Date(nowMs).toISOString();
  const placeholders = scopeIds.map(() => "?").join(",");
  return db
    .all(
      `SELECT * FROM selfAwareCooldowns
       WHERE provider = ? AND model = ? AND scopeType = ? AND scopeId IN (${placeholders}) AND expiresAt > ?`,
      [provider, model || "", scopeType, ...scopeIds, iso]
    )
    .map(rowToCooldown);
}

export async function deleteCooldown(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM selfAwareCooldowns WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function deleteByScope(provider, model, scopeType, scopeId) {
  const db = await getAdapter();
  if (model == null) {
    const res = db.run(
      `DELETE FROM selfAwareCooldowns WHERE provider = ? AND scopeType = ? AND scopeId = ?`,
      [provider, scopeType, scopeId]
    );
    return (res?.changes ?? 0) > 0;
  }
  const res = db.run(
    `DELETE FROM selfAwareCooldowns WHERE provider = ? AND model = ? AND scopeType = ? AND scopeId = ?`,
    [provider, model || "", scopeType, scopeId]
  );
  return (res?.changes ?? 0) > 0;
}

export async function deleteAllActive(nowMs = Date.now()) {
  const db = await getAdapter();
  const iso = new Date(nowMs).toISOString();
  const res = db.run(`DELETE FROM selfAwareCooldowns WHERE expiresAt > ?`, [iso]);
  return res?.changes ?? 0;
}

export async function purgeExpired(nowMs = Date.now()) {
  const db = await getAdapter();
  const iso = new Date(nowMs).toISOString();
  const res = db.run(`DELETE FROM selfAwareCooldowns WHERE expiresAt <= ?`, [iso]);
  return res?.changes ?? 0;
}
