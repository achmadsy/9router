import { SCHEMA_VERSION, TABLES } from "./schema.js";

export const FULL_BACKUP_FORMAT = "9router-full-db";
const FORMAT_VERSION = 1;
const TABLE_NAMES = Object.keys(TABLES);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const quoted = (name) => `"${name}"`;

export function exportFullDb(db) {
  return db.transaction(() => {
    const tables = {};
    for (const name of TABLE_NAMES) tables[name] = db.all(`SELECT * FROM ${quoted(name)}`);
    return {
      format: FULL_BACKUP_FORMAT,
      formatVersion: FORMAT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      tables,
      sequences: db.all("SELECT name, seq FROM sqlite_sequence"),
    };
  });
}

export function validateFullDb(payload, db) {
  if (!isObject(payload) || payload.format !== FULL_BACKUP_FORMAT ||
      payload.formatVersion !== FORMAT_VERSION || payload.schemaVersion !== SCHEMA_VERSION ||
      !isObject(payload.tables) || !Array.isArray(payload.sequences)) {
    throw new Error("Unsupported or incomplete full database backup");
  }
  if (Object.keys(payload.tables).length !== TABLE_NAMES.length ||
      Object.keys(payload.tables).some((name) => !TABLE_NAMES.includes(name))) {
    throw new Error("Full database backup has missing or unknown tables");
  }
  if (payload.sequences.length > TABLE_NAMES.length ||
      new Set(payload.sequences.map((entry) => entry?.name)).size !== payload.sequences.length) {
    throw new Error("Invalid database sequences");
  }
  const meta = payload.tables._meta;
  if (!Array.isArray(meta) || !meta.some((row) => row?.key === "backupSchemaVersion" &&
      Number(row.value) === payload.schemaVersion)) {
    throw new Error("Full database backup schema metadata is inconsistent");
  }
  for (const name of TABLE_NAMES) {
    const rows = payload.tables[name];
    if (!Array.isArray(rows)) throw new Error(`Invalid ${name} rows`);
    const expected = db.all(`PRAGMA table_info(${quoted(name)})`).map((column) => column.name);
    if (expected.length === 0) throw new Error(`Missing destination table: ${name}`);
    for (const row of rows) {
      if (!isObject(row) || Object.keys(row).length !== expected.length ||
          expected.some((column) => !Object.hasOwn(row, column))) {
        throw new Error(`Invalid ${name} row columns`);
      }
      for (const value of Object.values(row)) {
        if (value !== null && typeof value !== "string" &&
            !(typeof value === "number" && Number.isFinite(value))) {
          throw new Error(`Invalid ${name} row value`);
        }
      }
    }
  }
  for (const entry of payload.sequences) {
    if (!isObject(entry) || !TABLE_NAMES.includes(entry.name) ||
        !Number.isSafeInteger(entry.seq) || entry.seq < 0) {
      throw new Error("Invalid database sequence");
    }
  }
}

export function importFullDb(db, payload) {
  validateFullDb(payload, db);
  db.transaction(() => {
    // Only application tables are replaced; SQLite's internal sequence table is handled below.
    for (const name of [...TABLE_NAMES].reverse()) db.run(`DELETE FROM ${quoted(name)}`);
    for (const name of TABLE_NAMES) {
      const columns = db.all(`PRAGMA table_info(${quoted(name)})`).map((column) => column.name);
      const sql = `INSERT INTO ${quoted(name)} (${columns.map(quoted).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
      for (const row of payload.tables[name]) db.run(sql, columns.map((column) => row[column]));
    }
    db.run("DELETE FROM sqlite_sequence");
    for (const { name, seq } of payload.sequences) {
      db.run("INSERT INTO sqlite_sequence(name, seq) VALUES(?, ?)", [name, seq]);
    }
  });
}
