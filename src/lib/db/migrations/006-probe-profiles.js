// Migration 006: Probe profiles table.
// Encrypted target and judge profiles with 24-hour TTL.
import { TABLES, buildCreateTableSql } from "../schema.js";

const migration006 = {
  version: 6,
  name: "probe-profiles",
  up(db) {
    db.exec(buildCreateTableSql("probeProfiles", TABLES.probeProfiles));
    for (const idx of TABLES.probeProfiles.indexes || []) db.exec(idx);
  },
};

export default migration006;
