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
