import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-probe-runs-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("probe run persistence", () => {
  it("encrypts replay credentials, excludes them from public results, and purges expired settings", async () => {
    const repo = await import("@/lib/db/repos/probeRunsRepo.js");
    const { getAdapter } = await import("@/lib/db/driver.js");
    const replayConfig = { target: { model: "m", apiKey: "secret-for-replay", customHeaders: { "x-token": "header-secret" } } };
    await repo.createProbeRun({ id: "encrypted", replayConfig });
    const db = await getAdapter();
    const stored = db.get("SELECT replayConfig FROM probeRuns WHERE id = ?", ["encrypted"]);
    expect(stored.replayConfig).toMatch(/^v1:/);
    expect(stored.replayConfig).not.toContain("secret-for-replay");
    expect(await repo.getProbeRunReplay("encrypted")).toEqual(replayConfig);
    const publicRun = await repo.getProbeRun("encrypted");
    expect(publicRun.canReplay).toBe(true);
    expect(JSON.stringify(publicRun)).not.toContain("secret-for-replay");
    expect(publicRun).not.toHaveProperty("replayConfig");
    db.run("UPDATE probeRuns SET replayExpiresAt = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", "encrypted"]);
    expect(await repo.getProbeRunReplay("encrypted")).toBeNull();
    expect((await repo.getProbeRun("encrypted")).canReplay).toBe(false);
    expect(db.get("SELECT replayConfig FROM probeRuns WHERE id = ?", ["encrypted"]).replayConfig).toBeNull();
  });
  it("persists incremental progress and returns it after a fresh module import", async () => {
    const repo = await import("@/lib/db/repos/probeRunsRepo.js");
    await repo.createProbeRun({
      id: "prun_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      targetModel: "model-a",
      targetSource: "this_9router",
      claimedModel: "model-a",
      ownerId: "admin",
    });
    await repo.appendProbeRunResults("prun_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", [
      { probeId: "one", status: "done", passed: true, response: "ok" },
      { probeId: "two", status: "done", passed: false, passReason: "failed check" },
    ], 86);

    const run = await repo.getProbeRun("prun_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(run.status).toBe("running");
    expect(run.totalProbes).toBe(86);
    expect(run.completedProbes).toBe(2);
    expect(run.passedCount).toBe(1);
    expect(run.failedCount).toBe(1);
    expect(run.results).toHaveLength(2);
    expect(JSON.stringify(run)).not.toContain("apiKey");
  });

  it("upserts progress by probe id and marks the run complete", async () => {
    const repo = await import("@/lib/db/repos/probeRunsRepo.js");
    const id = "prun_11111111-2222-3333-4444-555555555555";
    await repo.createProbeRun({ id, targetModel: "m" });
    await repo.appendProbeRunResults(id, [{ probeId: "one", passed: null, status: "running" }], 1);
    await repo.appendProbeRunResults(id, [{ probeId: "one", passed: true, status: "done" }], 1);
    await repo.finishProbeRun(id, "complete");

    const run = await repo.getProbeRun(id);
    expect(run.status).toBe("complete");
    expect(run.results).toHaveLength(1);
    expect(run.results[0].passed).toBe(true);
    expect(run.completedProbes).toBe(1);
    expect(run.finishedAt).toBeTruthy();
  });

  it("edits an existing run without losing sibling results, timestamps, or replay credentials", async () => {
    const repo = await import("@/lib/db/repos/probeRunsRepo.js");
    await repo.createProbeRun({ id: "same", targetModel: "glm/glm-5.3", replayConfig: { target: { apiKey: "secret" } } });
    await repo.finishProbeRun("same", "complete", [
      { probeId: "one", status: "error", response: null },
      { probeId: "two", status: "done", passed: true, response: "sibling" },
    ], { score: 50, scoreMax: 100 });
    const before = await repo.getProbeRun("same");
    await repo.beginProbeRunReplay("same");
    expect((await repo.getProbeRun("same")).results).toEqual(before.results);
    await repo.commitProbeRunReplay("same", before, { results: [{ probeId: "one", status: "done", passed: true, response: "fixed" }], score: 100, scoreMax: 100 });
    const after = await repo.getProbeRun("same");
    expect(after).toMatchObject({ id: "same", createdAt: before.createdAt, score: 100, errorCount: 0, passedCount: 2 });
    expect(after.results[1]).toEqual(before.results[1]);
    expect(await repo.listProbeRuns()).toHaveLength(1);
    expect(await repo.getProbeRunReplay("same")).toEqual({ target: { apiKey: "secret" } });
    await repo.beginProbeRunReplay("same");
    await repo.restoreProbeRunState("same", after);
    expect(await repo.getProbeRun("same")).toEqual(after);
  });

  it("keeps model estimates and exact saved observations through same-ID rejudge", async () => {
    const repo = await import("@/lib/db/repos/probeRunsRepo.js");
    const identityAssessment = { status: "match", predictedFamily: "zhipu",
      verdict: { status: "likely_match", trueModel: "z-ai/glm-5.3", confidence: "medium" },
      distributionEvidence: { version: 1, modelId: "glm/glm-5.3", attempts: 51, failures: 0,
        observations: [{ probeId: "day", answers: ["wednesday", "wednesday", "thursday"] }] } };
    await repo.createProbeRun({ id: "estimate", targetModel: "glm/glm-5.3" });
    await repo.finishProbeRun("estimate", "complete", [{ probeId: "one", status: "done", response: "saved" }], { identityAssessment });
    const previous = await repo.getProbeRun("estimate");
    await repo.beginProbeRunReplay("estimate");
    await repo.commitProbeRunReplay("estimate", previous, { results: previous.results, identityAssessment });
    expect((await repo.getProbeRun("estimate")).summary.identityAssessment).toEqual(identityAssessment);
    expect(await repo.listProbeRuns()).toHaveLength(1);
  });

  it("lists newest runs first without report payloads", async () => {
    const repo = await import("@/lib/db/repos/probeRunsRepo.js");
    await repo.createProbeRun({ id: "prun_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", targetModel: "first" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await repo.createProbeRun({ id: "prun_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", targetModel: "second" });

    const runs = await repo.listProbeRuns();
    expect(runs.map((r) => r.targetModel)).toEqual(["second", "first"]);
    expect(runs[0]).not.toHaveProperty("results");
    expect(runs[0]).not.toHaveProperty("reportJson");
  });
});
