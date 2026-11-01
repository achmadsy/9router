import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
const detail = readFileSync(new URL("../../src/app/(dashboard)/dashboard/probe/runs/[id]/RunDetailClient.js", import.meta.url), "utf8");
const summary = readFileSync(new URL("../../src/app/(dashboard)/dashboard/probe/components/ProbeReportSummary.js", import.meta.url), "utf8");
describe("saved probe detail layout", () => {
  it("has exactly one endpoint integrity score, owned by the report summary", () => {
    expect(detail).not.toMatch(/Endpoint integrity score/i);
    expect(detail.match(/<ProbeReportSummary\b/g)).toHaveLength(1);
    expect(summary.match(/Endpoint Integrity Score/g)).toHaveLength(1);
  });
  it("does not label uncalibrated percentages as identity confidence", () => {
    expect(detail).not.toContain("Assessment confidence");
    expect(detail).not.toContain("identity.confidence * 100");
    expect(summary).not.toContain("identity.confidence * 100");
    expect(detail).toContain("Raw family heuristic diagnostics");
    expect(detail).toContain("<details");
  });
});
