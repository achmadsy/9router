// Probe run history repo — persists run state and redacted report rows.
// Rows are written incrementally as SSE events land so a page refresh can
// hydrate from the server instead of losing everything to React state.
import { getAdapter } from "../driver.js";
import { TABLES } from "../schema.js";

const STALE_RUNNING_MS = 10 * 60 * 1000; // running rows with no update for 10 min are dead

function summarizeRow(row) {
  if (row.status === "error") return "error";
  if (row.status === "skipped") return "skipped";
  if (typeof row.passed === "boolean") return row.passed ? "passed" : "failed";
  return "neutral";
}

function computeCounts(results) {
  const counts = { completedProbes: results.length, passedCount: 0, failedCount: 0, errorCount: 0, neutralCount: 0 };
  for (const row of results) {
    const s = summarizeRow(row);
    if (s === "passed") counts.passedCount++;
    else if (s === "failed") counts.failedCount++;
    else if (s === "error") counts.errorCount++;
    else counts.neutralCount++;
  }
  return counts;
}

function rowToSummary(r) {
  return {
    id: r.id,
    status: r.status,
    targetModel: r.targetModel || null,
    targetSource: r.targetSource || null,
    claimedModel: r.claimedModel || null,
    totalProbes: r.totalProbes ?? null,
    completedProbes: r.completedProbes ?? 0,
    passedCount: r.passedCount ?? 0,
    failedCount: r.failedCount ?? 0,
    errorCount: r.errorCount ?? 0,
    neutralCount: r.neutralCount ?? 0,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    finishedAt: r.finishedAt || null,
  };
}

export async function createProbeRun({ id, targetModel, targetSource, claimedModel, totalProbes, ownerId }) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  db.run(
    `INSERT OR REPLACE INTO probeRuns (id, status, targetModel, targetSource, claimedModel, totalProbes, completedProbes, passedCount, failedCount, errorCount, neutralCount, reportJson, ownerId, createdAt, updatedAt, finishedAt)
     VALUES (?, 'running', ?, ?, ?, ?, 0, 0, 0, 0, 0, NULL, ?, ?, ?, NULL)`,
    [id, targetModel ?? null, targetSource ?? null, claimedModel ?? null, totalProbes ?? null, ownerId ?? null, now, now],
  );
  return { id, status: "running", createdAt: now };
}

/**
 * Merge a batch of redacted result rows into the stored report and refresh counts.
 * Accepts any subset; rows are keyed by probeId, so progress and final report
 * events can both call this idempotently.
 */
export async function appendProbeRunResults(runId, rows, totalProbes = null) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  const db = await getAdapter();
  const existing = db.get(`SELECT reportJson, status FROM probeRuns WHERE id = ?`, [runId]);
  if (!existing || existing.status !== "running") return;

  let results = [];
  try { results = existing.reportJson ? JSON.parse(existing.reportJson) : []; } catch { results = []; }
  const byId = new Map(results.map((r) => [r.probeId || r.id, r]));
  for (const row of rows) {
    const key = row.probeId || row.id;
    if (!key) continue;
    const prev = byId.get(key);
    byId.set(key, { ...prev, ...row });
  }
  const merged = [...byId.values()];
  const counts = computeCounts(merged);
  const now = new Date().toISOString();
  db.run(
    `UPDATE probeRuns SET reportJson = ?, completedProbes = ?, passedCount = ?, failedCount = ?, errorCount = ?, neutralCount = ?, totalProbes = COALESCE(?, totalProbes), updatedAt = ?
     WHERE id = ? AND status = 'running'`,
    [
      JSON.stringify(merged).slice(0, 8 * 1024 * 1024),
      counts.completedProbes, counts.passedCount, counts.failedCount, counts.errorCount, counts.neutralCount,
      totalProbes ?? null, now, runId,
    ],
  );
}

export async function finishProbeRun(runId, status = "complete", rows = null, summary = null) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  if (Array.isArray(rows) && rows.length > 0) {
    await appendProbeRunResults(runId, rows);
  }
  if (summary && typeof summary === "object") {
    // Keep only the verdict/metadata the dashboard renders; result rows live
    // in reportJson and secrets were already redacted by the engine.
    const { score, scoreMax, identityAssessment, totalInputTokens, totalOutputTokens, modelId, startedAt, completedAt } = summary;
    db.run(
      `UPDATE probeRuns SET score = ?, scoreMax = ?, summaryJson = ?, updatedAt = ? WHERE id = ?`,
      [
        typeof score === "number" ? Math.round(score) : null,
        typeof scoreMax === "number" ? Math.round(scoreMax) : null,
        JSON.stringify({ identityAssessment, totalInputTokens, totalOutputTokens, modelId, startedAt, completedAt }).slice(0, 2 * 1024 * 1024),
        now, runId,
      ],
    );
  }
  db.run(
    `UPDATE probeRuns SET status = ?, finishedAt = ?, updatedAt = ? WHERE id = ?`,
    [status, now, now, runId],
  );
}

export async function getProbeRun(runId) {
  const db = await getAdapter();
  const r = db.get(`SELECT * FROM probeRuns WHERE id = ?`, [runId]);
  if (!r) return null;
  let results = [];
  try { results = r.reportJson ? JSON.parse(r.reportJson) : []; } catch { results = []; }
  let summary = null;
  try { summary = r.summaryJson ? JSON.parse(r.summaryJson) : null; } catch { summary = null; }
  return {
    ...rowToSummary(r),
    score: r.score ?? null,
    scoreMax: r.scoreMax ?? null,
    summary,
    results,
  };
}

export async function listProbeRuns(limit = 20) {
  const db = await getAdapter();
  // Rows stuck "running" past the staleness window (e.g. gateway restarted
  // mid-run) can never resume — downgrade them so the list stays truthful.
  const staleBefore = new Date(Date.now() - STALE_RUNNING_MS).toISOString();
  db.run(`UPDATE probeRuns SET status = 'interrupted', finishedAt = updatedAt WHERE status = 'running' AND updatedAt < ?`, [staleBefore]);
  const rows = db.all(
    `SELECT id, status, targetModel, targetSource, claimedModel, totalProbes, completedProbes, passedCount, failedCount, errorCount, neutralCount, createdAt, updatedAt, finishedAt
     FROM probeRuns ORDER BY createdAt DESC LIMIT ?`,
    [Math.min(Math.max(1, limit), 100)],
  );
  return rows.map(rowToSummary);
}
