// Migration 003: requestDetails.apiKeyId for per-key Details tab filter.
// Idempotent: no-ops when the column already exists.
import { TABLES, buildCreateTableSql } from "../schema.js";

function columnNames(db, table) {
  return db.all(`PRAGMA table_info(${table})`).map((r) => r.name);
}

const migration003 = {
  version: 3,
  name: "request-details-api-key",
  up(db) {
    // Fresh DB already has the column from TABLES; this covers pre-003 DBs.
    db.exec(buildCreateTableSql("requestDetails", TABLES.requestDetails));
    if (!columnNames(db, "requestDetails").includes("apiKeyId")) {
      db.exec(`ALTER TABLE requestDetails ADD COLUMN apiKeyId TEXT`);
    }
    for (const idx of TABLES.requestDetails.indexes || []) db.exec(idx);
  },
};

export default migration003;
