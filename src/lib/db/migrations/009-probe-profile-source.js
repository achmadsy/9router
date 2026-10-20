// Migration 009: Preserve whether a Probe profile targets this 9Router or a custom endpoint.
import { TABLES } from "../schema.js";

const migration009 = {
  version: 9,
  name: "probe-profile-source",
  up(db) {
    const columns = db.all("PRAGMA table_info(probeProfiles)");
    if (!columns.some((column) => column.name === "source")) {
      db.exec(`ALTER TABLE probeProfiles ADD COLUMN source ${TABLES.probeProfiles.columns.source}`);
    }
  },
};

export default migration009;
