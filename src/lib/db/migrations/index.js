// Migration registry — append new entries when schema changes.
// Each migration: { version: number, name: string, up(db): void }
// Versions MUST be unique and monotonically increasing.
import m001 from "./001-initial.js";
import m002 from "./002-api-key-policies.js";
import m003 from "./003-request-details-api-key.js";
import m004 from "./004-self-aware-cooldowns.js";
import m005 from "./005-self-aware-daily-reset.js";
import m006 from "./006-probe-profiles.js";
import m009 from "./009-probe-profile-source.js";
import m010 from "./010-probe-runs.js";

export const MIGRATIONS = [m001, m002, m003, m004, m005, m006, m009, m010].sort((a, b) => a.version - b.version);

export function latestVersion() {
  return MIGRATIONS.length ? MIGRATIONS[MIGRATIONS.length - 1].version : 0;
}
