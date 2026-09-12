// Migration 005: Self-Aware policies gain daily wall-clock reset mode.
// Existing rows stay duration mode (mode default 'duration', timeoutMs kept).
import { TABLES, buildCreateTableSql } from "../schema.js";

const migration005 = {
  version: 5,
  name: "self-aware-daily-reset",
  up(db) {
    // Fresh path (table created here with full columns) — CREATE is idempotent.
    db.exec(buildCreateTableSql("selfAwarePolicies", TABLES.selfAwarePolicies));
    for (const idx of TABLES.selfAwarePolicies.indexes || []) db.exec(idx);

    // v4 table: add columns if missing (syncSchemaFromTables also covers this).
    const cols = db.all(`PRAGMA table_info(selfAwarePolicies)`).map((r) => r.name);
    const add = (name, def) => {
      if (!cols.includes(name)) db.exec(`ALTER TABLE selfAwarePolicies ADD COLUMN ${name} ${def}`);
    };
    add("mode", "TEXT NOT NULL DEFAULT 'duration'");
    add("resetHour", "INTEGER");
    add("resetMinute", "INTEGER");
    // timeoutMs may already be NOT NULL on v4; leave as-is when present.
    if (!cols.includes("timeoutMs")) db.exec(`ALTER TABLE selfAwarePolicies ADD COLUMN timeoutMs INTEGER NOT NULL DEFAULT 0`);
  },
};

export default migration005;
