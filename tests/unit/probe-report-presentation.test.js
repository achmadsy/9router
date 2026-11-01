import { describe, expect, it } from "vitest";
import { identityVerdictKey, reportFromRun, probeResultStatus } from "@/lib/probe/reportPresentation.js";
import { VERDICT_MAP } from "../../src/app/(dashboard)/dashboard/probe/components/probeConstants.js";

describe("saved probe summary presentation", () => {
  it("passes persisted score and identity to every report card instead of zero/defaults", () => {
    const identityAssessment = { status: "uncertain", verdict: { status: "ambiguous" }, predictedFamily: "anthropic" };
    const report = reportFromRun({ score: 72, scoreMax: 88, targetModel: "glm/glm-5.3", summary: { identityAssessment, totalInputTokens: 123 }, createdAt: "start", finishedAt: "end" });
    expect(report).toMatchObject({ score: 72, scoreMax: 88, identityAssessment, totalInputTokens: 123, modelId: "glm/glm-5.3" });
    expect(identityVerdictKey(report.identityAssessment)).toBe("ambiguous");
    expect(VERDICT_MAP[identityVerdictKey(report.identityAssessment)].label).toBe("Ambiguous evidence");
  });

  it.each(["likely_match", "likely_submodel_mismatch", "model_estimate", "clean_match_family_only", "ambiguous", "insufficient_data", "plain_mismatch"])("recognizes canonical nested verdict %s consistently", (status) => {
    expect(identityVerdictKey({ status: "mismatch", verdict: { status } })).toBe(status);
    expect(VERDICT_MAP[status]).toBeTruthy();
  });

  it("never displays finished warning/neutral/error results as pending", () => {
    expect(probeResultStatus({ status: "done", passed: "warning" })).toBe("warning");
    expect(probeResultStatus({ status: "done", passed: null })).toBe("neutral");
    expect(probeResultStatus({ status: "error", passed: null })).toBe("error");
  });

  it("supports older flat assessments without claiming exact model verification", () => {
    expect(identityVerdictKey({ status: "match" })).toBe("clean_match_family_only");
    expect(identityVerdictKey({ status: "uncertain" })).toBe("ambiguous");
  });
});
