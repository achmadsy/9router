import { describe, expect, it } from "vitest";
import { identityVerdictKey, identityEvidencePresentation, reportFromRun, probeResultStatus } from "@/lib/probe/reportPresentation.js";
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

  it("explains missing distribution evidence rather than presenting a fake exact match", () => {
    const identity = { predictedFamily: "anthropic", confidence: .4, claimedModel: "glm/glm-5.3",
      verdict: { status: "clean_match_family_only", trueFamily: "zhipu" },
      riskFlags: ["Advanced identity diagnostics unavailable; primary family assessment retained"] };
    const shown = identityEvidencePresentation(identity);
    expect(shown.family).toBe("zhipu");
    expect(shown.modelExplanation).toContain("No saved GLM distribution sample");
    expect(shown.modelExplanation).toContain("Rejudge reuses saved responses");
    expect(shown.diagnosticsUnavailable).toBe(true);
    expect(shown).not.toHaveProperty("confidence");
  });

  it("distinguishes partial samples from complete but abstained evidence", () => {
    const identity = { claimedModel: "glm-5.3", distributionEvidence: { observations: [{ answers: ["a"] }] } };
    expect(identityEvidencePresentation(identity).modelExplanation).toContain("1/51");
    identity.distributionEvidence.observations[0].answers = Array(51).fill("a");
    identity.advanced = { distribution: { state: "family-unconfirmed" } };
    expect(identityEvidencePresentation(identity).modelExplanation).toContain("family-unconfirmed");
    identity.advanced.distribution.state = "likely";
    expect(identityEvidencePresentation(identity).modelExplanation).toBeNull();
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
