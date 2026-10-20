// Migration 010: Probe run history — server-side persistence for run state
// and redacted report rows, written incrementally during the run.
import { TABLES, buildCreateTableSql } from "../schema.js";

const migration010 = {
  version: 10,
  name: "probe-runs",
  up(db) {
    db.exec(buildCreateTableSql("probeRuns", TABLES.probeRuns));
    for (const idx of TABLES.probeRuns.indexes || []) db.exec(idx);
  },
};

export default migration010;
