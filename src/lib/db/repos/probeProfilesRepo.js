import { randomUUID } from "node:crypto";
import { getAdapter } from "../driver.js";
import { encryptProfileSecret, decryptProfileSecret } from "@/lib/probe/crypto.js";

const PROFILE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function rowToSafeProfile(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    provider: r.provider || null,
    model: r.model || null,
    endpoint: r.endpoint || null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    expiresAt: r.expiresAt,
  };
}

/**
 * Purge profiles that have expired past their 24-hour TTL.
 */
export async function purgeExpiredProbeProfiles(nowIso = new Date().toISOString()) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM probeProfiles WHERE expiresAt <= ?`, [nowIso]);
  return res?.changes ?? 0;
}

/**
 * List all active profiles (metadata only, no encrypted or plaintext secrets).
 */
export async function listProbeProfiles(type = null) {
  await purgeExpiredProbeProfiles();
  const db = await getAdapter();
  if (type) {
    const rows = db.all(
      `SELECT * FROM probeProfiles WHERE type = ? ORDER BY createdAt DESC`,
      [type]
    );
    return rows.map(rowToSafeProfile);
  }
  const rows = db.all(`SELECT * FROM probeProfiles ORDER BY createdAt DESC`);
  return rows.map(rowToSafeProfile);
}

/**
 * Get profile metadata by ID (safe metadata only).
 */
export async function getProbeProfileById(id) {
  await purgeExpiredProbeProfiles();
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM probeProfiles WHERE id = ?`, [id]);
  return rowToSafeProfile(row);
}

/**
 * Internal: retrieve profile with decrypted secrets for dispatching probe runs.
 * Never expose through API handlers.
 */
export async function getProbeProfileSecrets(id) {
  await purgeExpiredProbeProfiles();
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM probeProfiles WHERE id = ?`, [id]);
  if (!row) return null;
  const secrets = decryptProfileSecret(row.secretEncrypted);
  return {
    ...rowToSafeProfile(row),
    secrets,
  };
}

/**
 * Create an encrypted target or judge profile with a 24-hour expiration window.
 */
export async function createProbeProfile({
  name,
  type,
  provider = null,
  model = null,
  endpoint = null,
  secrets = {},
}) {
  await purgeExpiredProbeProfiles();
  const db = await getAdapter();
  const id = `prf_${randomUUID()}`;
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + PROFILE_TTL_MS).toISOString();
  const secretEncrypted = encryptProfileSecret(secrets);

  db.run(
    `INSERT INTO probeProfiles(id, name, type, provider, model, endpoint, secretEncrypted, expiresAt, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      name,
      type,
      provider || null,
      model || null,
      endpoint || null,
      secretEncrypted || "",
      expiresAt,
      createdAt,
      createdAt,
    ]
  );

  const row = db.get(`SELECT * FROM probeProfiles WHERE id = ?`, [id]);
  return rowToSafeProfile(row);
}

/**
 * Delete a profile by ID.
 */
export async function deleteProbeProfile(id) {
  await purgeExpiredProbeProfiles();
  const db = await getAdapter();
  const res = db.run(`DELETE FROM probeProfiles WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}
