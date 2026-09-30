import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, TABLES, buildCreateTableSql } from "../../src/lib/db/schema.js";
import { exportFullDb, importFullDb } from "../../src/lib/db/fullBackup.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

function createDatabase() {
  const raw = new Database(":memory:");
  for (const [name, def] of Object.entries(TABLES)) raw.exec(buildCreateTableSql(name, def));
  return {
    raw,
    run(sql, params = []) { return raw.prepare(sql).run(...params); },
    all(sql, params = []) { return raw.prepare(sql).all(...params); },
    transaction(fn) { return raw.transaction(fn)(); },
  };
}

function seedAllTables(db) {
  for (const [name, def] of Object.entries(TABLES)) {
    const columns = Object.entries(def.columns)
      .filter(([, type]) => !type.includes("AUTOINCREMENT"));
    const values = columns.map(([column, type]) => {
      if (column === "id" && name === "settings") return 1;
      if (column === "id") return `${name}-id`;
      if (column === "scope") return "disabledModels";
      if (column === "key") return "sample";
      if (column === "value" || column === "data" || column === "models") return "{}";
      if (column === "timestamp" || column === "dateKey") return "2026-09-29T00:00:00Z";
      if (/INT|REAL/.test(type)) return 1;
      return `${name}-${column}`;
    });
    db.run(`INSERT INTO "${name}" (${columns.map(([column]) => `"${column}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`, values);
  }
  db.run("INSERT OR REPLACE INTO _meta(key, value) VALUES(?, ?)", ["backupSchemaVersion", String(SCHEMA_VERSION)]);
}

describe("full database UI backup", () => {
  it("round-trips all application tables, columns, and sequences", () => {
    const source = createDatabase();
    const target = createDatabase();
    try {
      seedAllTables(source);
      const payload = exportFullDb(source);
      expect(payload.schemaVersion).toBe(SCHEMA_VERSION);
      expect(Object.keys(payload.tables).sort()).toEqual(Object.keys(TABLES).sort());
      importFullDb(target, JSON.parse(JSON.stringify(payload)));
      expect(exportFullDb(target)).toEqual(payload);
    } finally {
      source.raw.close();
      target.raw.close();
    }
  });

  it("rejects missing tables before changing existing rows", () => {
    const db = createDatabase();
    try {
      seedAllTables(db);
      const before = exportFullDb(db);
      const incomplete = structuredClone(before);
      delete incomplete.tables.usageHistory;
      expect(() => importFullDb(db, incomplete)).toThrow(/missing or unknown tables/);
      expect(exportFullDb(db)).toEqual(before);
    } finally {
      db.raw.close();
    }
  });

  it("rolls back when imported rows violate destination constraints", () => {
    const db = createDatabase();
    try {
      seedAllTables(db);
      const before = exportFullDb(db);
      const broken = structuredClone(before);
      broken.tables.providerConnections[0].provider = null;
      expect(() => importFullDb(db, broken)).toThrow();
      expect(exportFullDb(db)).toEqual(before);
    } finally {
      db.raw.close();
    }
  });
});
