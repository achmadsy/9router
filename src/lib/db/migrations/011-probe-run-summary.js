// Migration 011: Probe run report summary — score, scoreMax, and the
// identityAssessment block needed for the verdict card after refresh.
import { TABLES } from "../schema.js";

const migration011 = {
  version: 11,
  name: "probe-run-summary",
  up(db) {
    const columns = db.all("PRAGMA table_info(probeRuns)");
    if (!columns.some((column) => column.name === "score")) {
      db.exec(`ALTER TABLE probeRuns ADD COLUMN score ${TABLES.probeRuns.columns.score}`);
    }
    if (!columns.some((column) => column.name === "scoreMax")) {
      db.exec(`ALTER TABLE probeRuns ADD COLUMN scoreMax ${TABLES.probeRuns.columns.scoreMax}`);
    }
    if (!columns.some((column) => column.name === "summaryJson")) {
      db.exec(`ALTER TABLE probeRuns ADD COLUMN summaryJson ${TABLES.probeRuns.columns.summaryJson}`);
    }
  },
};

export default migration011;
