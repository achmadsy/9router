// Migration 004: Self-Aware cooldown tables (policies + cooldown sidecar).
// Idempotent: CREATE TABLE IF NOT EXISTS + unique indexes.
import { TABLES, buildCreateTableSql } from "../schema.js";

const migration004 = {
  version: 4,
  name: "self-aware-cooldowns",
  up(db) {
    db.exec(buildCreateTableSql("selfAwarePolicies", TABLES.selfAwarePolicies));
    for (const idx of TABLES.selfAwarePolicies.indexes || []) db.exec(idx);
    db.exec(buildCreateTableSql("selfAwareCooldowns", TABLES.selfAwareCooldowns));
    for (const idx of TABLES.selfAwareCooldowns.indexes || []) db.exec(idx);
  },
};

export default migration004;
