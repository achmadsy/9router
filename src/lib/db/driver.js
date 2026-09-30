import { ensureDirs, DATA_FILE } from "./paths.js";

// Use global to survive Next.js dev hot-reload (module state resets on reload)
if (!global._dbAdapter) global._dbAdapter = { instance: null, initPromise: null, logged: false };
const state = global._dbAdapter;

async function tryBunSqlite() {
  // Bun runtime only — built-in, no install needed
  if (!process.versions.bun) return null;
  try {
    const { createBunSqliteAdapter } = await import("./adapters/bunSqliteAdapter.js");
    return await createBunSqliteAdapter(DATA_FILE);
  } catch (e) {
    console.warn(`[DB] bun:sqlite unavailable: ${e.message}`);
    return null;
  }
}

async function tryBetterSqlite() {
  // Skip on Bun — better-sqlite3 native bindings unsupported
  if (process.versions.bun) return null;
  // Skip on Node >= 24: the native addon SIGSEGVs on load there, which is a
  // process-level crash the try/catch below cannot recover from. node:sqlite covers it.
  const [nodeMajor] = process.versions.node.split(".").map(Number);
  if (nodeMajor >= 24) return null;
  try {
    const { createBetterSqliteAdapter } = await import("./adapters/betterSqliteAdapter.js");
    return createBetterSqliteAdapter(DATA_FILE);
  } catch (e) {
    console.warn(`[DB] better-sqlite3 unavailable: ${e.message}`);
    return null;
  }
}

async function tryNodeSqlite() {
  // Built-in since Node 22.5.0 — no install needed. Skip under Bun (no node:sqlite).
  if (process.versions.bun) return null;
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 5)) return null;
  try {
    const { createNodeSqliteAdapter } = await import("./adapters/nodeSqliteAdapter.js");
    return await createNodeSqliteAdapter(DATA_FILE);
  } catch (e) {
    console.warn(`[DB] node:sqlite unavailable: ${e.message}`);
    return null;
  }
}

async function trySqlJs() {
  try {
    const { createSqlJsAdapter } = await import("./adapters/sqljsAdapter.js");
    return await createSqlJsAdapter(DATA_FILE);
  } catch (e) {
    console.warn(`[DB] sql.js unavailable: ${e.message}`);
    return null;
  }
}

async function initAdapter() {
  ensureDirs();
  // Order per runtime:
  //   Bun:  bun:sqlite → sql.js (only for new databases)
  //   Node: better-sqlite3 → node:sqlite (≥22.5) → sql.js (only for new databases)
  // A damaged existing file must not trigger a fallback that rewrites it.
  const fs = await import("node:fs");
  const hasDatabase = fs.existsSync(DATA_FILE);
  if (hasDatabase) {
    const header = Buffer.alloc(16);
    const fd = fs.openSync(DATA_FILE, "r");
    try { fs.readSync(fd, header, 0, header.length, 0); }
    finally { fs.closeSync(fd); }
    if (!header.equals(Buffer.from("SQLite format 3\0"))) {
      throw new Error(`[DB] Invalid SQLite header: ${DATA_FILE}. Restore a verified backup; original file was not changed.`);
    }
  }
  let adapter = await tryBunSqlite();
  if (!adapter) adapter = await tryBetterSqlite();
  if (!adapter) adapter = await tryNodeSqlite();
  if (!adapter && !hasDatabase) adapter = await trySqlJs();
  if (!adapter) throw new Error(hasDatabase
    ? `[DB] Existing SQLite database could not be opened: ${DATA_FILE}. Restore a verified backup; original file was not changed.`
    : "[DB] No SQLite driver available (bun/better/node/sql.js all failed)");
  if (hasDatabase) {
    try {
      const check = adapter.get("PRAGMA quick_check");
      if (Object.values(check || {})[0] !== "ok") throw new Error("SQLite quick_check failed");
    } catch (error) {
      // Leave the original file untouched; adapter shutdown may checkpoint WAL.
      throw new Error(`[DB] Database integrity check failed: ${error.message}. Restore a verified backup; original file was not changed.`);
    }
  }

  if (!state.logged) {
    console.log(`[DB] Driver: ${adapter.driver} | file: ${DATA_FILE}`);
    state.logged = true;
  }

  const { runMigrationOnce } = await import("./migrate.js");
  await runMigrationOnce(adapter);
  return adapter;
}

export async function getAdapter() {
  if (state.instance) return state.instance;
  if (!state.initPromise) state.initPromise = initAdapter()
    .then((a) => { state.instance = a; return a; })
    .catch((error) => { state.initPromise = null; throw error; });
  return state.initPromise;
}

export function getAdapterSync() {
  if (!state.instance) throw new Error("[DB] adapter not initialized — await getAdapter() first");
  return state.instance;
}
