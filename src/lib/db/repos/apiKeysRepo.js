import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { API_KEY_ACCESS_MODE, API_KEY_HASH_VERSION } from "@/lib/apiKeys/constants.js";
import {
  generateApiKeySecret,
  computeApiKeyDigest,
  buildApiKeyHint,
  encryptApiKeySecret,
  decryptApiKeySecret,
} from "@/lib/apiKeys/auth.js";
import { normalizeTargets, buildTargetIdSet } from "@/lib/apiKeys/policy.js";

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    keyHash: row.keyHash,
    keyHint: row.keyHint,
    hashVersion: row.hashVersion,
    name: row.name,
    machineId: row.machineId || null,
    accessMode: row.accessMode || API_KEY_ACCESS_MODE.ALL,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    rerolledAt: row.rerolledAt || null,
  };
}

function rowToTarget(row) {
  return { targetType: row.targetType, targetId: row.targetId };
}

export async function getApiKeyAccessTargets(apiKeyId) {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT targetType, targetId FROM apiKeyAccessTargets WHERE apiKeyId = ? ORDER BY targetType, targetId`,
    [apiKeyId]
  );
  return rows.map(rowToTarget);
}

async function loadKeyWithTargets(row) {
  const key = rowToKey(row);
  if (!key) return null;
  key.targets = await getApiKeyAccessTargets(key.id);
  return key;
}

/** Metadata-only list (no secret material beyond hint/hash for verify). */
export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  const out = [];
  for (const row of rows) {
    const key = rowToKey(row);
    // strip keyHash + recoverable ciphertext from management list responses
    const { keyHash, secretEncrypted, ...meta } = key;
    meta.targets = await getApiKeyAccessTargets(key.id);
    out.push(meta);
  }
  return out;
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  if (!row) return null;
  const key = rowToKey(row);
  const { keyHash, secretEncrypted, ...meta } = key;
  meta.targets = await getApiKeyAccessTargets(id);
  return meta;
}

/** Decrypt recoverable secret for dashboard show/copy. Null if missing/corrupt. */
export async function getRecoverableApiKeySecret(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT secretEncrypted FROM apiKeys WHERE id = ?`, [id]);
  if (!row?.secretEncrypted) return null;
  return decryptApiKeySecret(row.secretEncrypted);
}

/** Internal: lookup by digest for request auth (returns full row incl. hash). */
export async function getApiKeyByHash(keyHash) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE keyHash = ?`, [keyHash]);
  if (!row) return null;
  const key = rowToKey(row);
  key.targets = await getApiKeyAccessTargets(key.id);
  return key;
}

function insertTargets(db, apiKeyId, targets) {
  const normalized = normalizeTargets(targets);
  const now = new Date().toISOString();
  for (const t of normalized) {
    db.run(
      `INSERT OR IGNORE INTO apiKeyAccessTargets(id, apiKeyId, targetType, targetId, createdAt) VALUES(?, ?, ?, ?, ?)`,
      [uuidv4(), apiKeyId, t.targetType, t.targetId, now]
    );
  }
  return normalized;
}

/**
 * Create a key. Returns metadata + plaintext `key` (HMAC digest for auth; ciphertext for re-copy).
 * @param {string} name
 * @param {string|null} machineId
 * @param {{ accessMode?: string, targets?: Array }} [options]
 */
export async function createApiKey(name, machineId, options = {}) {
  const db = await getAdapter();
  const secret = generateApiKeySecret();
  const keyHash = computeApiKeyDigest(secret);
  const keyHint = buildApiKeyHint(secret);
  const accessMode = options.accessMode === API_KEY_ACCESS_MODE.RESTRICTED
    ? API_KEY_ACCESS_MODE.RESTRICTED
    : API_KEY_ACCESS_MODE.ALL;
  const now = new Date().toISOString();
  const id = uuidv4();

  db.transaction(() => {
    db.run(
      `INSERT INTO apiKeys(id, keyHash, keyHint, hashVersion, name, machineId, accessMode, isActive, createdAt, updatedAt, rerolledAt, secretEncrypted)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      [id, keyHash, keyHint, API_KEY_HASH_VERSION, name, machineId || null, accessMode, 1, now, now, encryptApiKeySecret(secret)]
    );
    if (accessMode === API_KEY_ACCESS_MODE.RESTRICTED) {
      insertTargets(db, id, options.targets || []);
    }
  });

  return {
    id,
    key: secret,
    keyHint,
    name,
    machineId: machineId || null,
    accessMode,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Update key metadata + optional full policy replace.
 * Never accepts key/secret/keyHash/hashVersion.
 */
export async function updateApiKey(id, data = {}) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const existing = rowToKey(row);
    const now = new Date().toISOString();

    const name = data.name !== undefined ? data.name : existing.name;
    const isActive = data.isActive !== undefined ? (data.isActive ? 1 : 0) : (existing.isActive ? 1 : 0);
    const machineId = data.machineId !== undefined ? data.machineId : existing.machineId;

    let accessMode = existing.accessMode;
    let replaceTargets = false;
    let nextTargets = [];
    if (data.accessMode !== undefined) {
      accessMode = data.accessMode === API_KEY_ACCESS_MODE.RESTRICTED
        ? API_KEY_ACCESS_MODE.RESTRICTED
        : API_KEY_ACCESS_MODE.ALL;
      replaceTargets = true;
      nextTargets = data.targets || [];
    } else if (data.targets !== undefined) {
      replaceTargets = true;
      nextTargets = data.targets;
      // targets without accessMode implies restricted if non-empty, else keep
      if (nextTargets.length > 0) accessMode = API_KEY_ACCESS_MODE.RESTRICTED;
    }

    db.run(
      `UPDATE apiKeys SET name = ?, machineId = ?, isActive = ?, accessMode = ?, updatedAt = ? WHERE id = ?`,
      [name, machineId || null, isActive, accessMode, now, id]
    );

    if (replaceTargets) {
      db.run(`DELETE FROM apiKeyAccessTargets WHERE apiKeyId = ?`, [id]);
      if (accessMode === API_KEY_ACCESS_MODE.RESTRICTED) {
        insertTargets(db, id, nextTargets);
      }
    }

    result = { id };
  });

  if (!result) return null;
  return await getApiKeyById(id);
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  let ok = false;
  db.transaction(() => {
    db.run(`DELETE FROM apiKeyAccessTargets WHERE apiKeyId = ?`, [id]);
    const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
    ok = (res?.changes ?? 0) > 0;
  });
  return ok;
}

/**
 * Rotate the secret verifier. Same ID + policy. Returns metadata + new one-time key.
 */
export async function rerollApiKey(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  if (!row) return null;
  const existing = rowToKey(row);
  const secret = generateApiKeySecret();
  const keyHash = computeApiKeyDigest(secret);
  const keyHint = buildApiKeyHint(secret);
  const now = new Date().toISOString();
  db.run(
    `UPDATE apiKeys SET keyHash = ?, keyHint = ?, hashVersion = ?, updatedAt = ?, rerolledAt = ?, secretEncrypted = ? WHERE id = ?`,
    [keyHash, keyHint, API_KEY_HASH_VERSION, now, now, encryptApiKeySecret(secret), id]
  );
  return {
    id,
    key: secret,
    keyHint,
    name: existing.name,
    machineId: existing.machineId,
    accessMode: existing.accessMode,
    isActive: existing.isActive,
    createdAt: existing.createdAt,
    updatedAt: now,
    rerolledAt: now,
  };
}

/**
 * Validate a presented secret. Returns metadata (with targets) or false.
 * Uses timing-safe digest compare after indexed lookup.
 */
export async function validateApiKey(key) {
  if (!key) return false;
  try {
    const { resolveApiKeyBySecret } = await import("@/lib/apiKeys/auth.js");
    const row = await resolveApiKeyBySecret(key, { getApiKeyByHash });
    return row ? true : false;
  } catch {
    return false;
  }
}

/** Resolve presented secret → key metadata + policy, or null. */
export async function authenticateApiKey(key) {
  if (!key) return null;
  const { resolveApiKeyBySecret } = await import("@/lib/apiKeys/auth.js");
  return await resolveApiKeyBySecret(key, { getApiKeyByHash });
}

export { rowToKey, buildTargetIdSet };
