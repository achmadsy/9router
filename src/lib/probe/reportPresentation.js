import { supportsGlmDistribution } from "./glmDistribution.js";

// Shared display projection: every summary reads the same saved assessment.
export function identityEvidencePresentation(identity, targetModel) {
  const verdict = identity?.verdict;
  const family = typeof verdict === "object" && verdict.trueFamily ? verdict.trueFamily : identity?.predictedFamily;
  const glmTarget = supportsGlmDistribution(targetModel) || supportsGlmDistribution(identity?.claimedModel);
  const evidence = identity?.distributionEvidence;
  const samples = Array.isArray(evidence?.observations) ? evidence.observations.reduce((n, o) => n + (Array.isArray(o.answers) ? o.answers.length : 0), 0) : 0;
  const state = identity?.advanced?.distribution?.state;
  const unavailable = Array.isArray(identity?.riskFlags) && identity.riskFlags.some(line => typeof line === "string" && line.startsWith("Advanced identity diagnostics unavailable"));
  let modelExplanation = null;
  if (glmTarget && !samples) {
    modelExplanation = "No saved GLM distribution sample is available for this run. Rejudge reuses saved responses; it cannot identify the exact sibling without those samples. Re-run all checks collects up to 51 new distribution answers.";
  } else if (glmTarget && samples < 51) {
    modelExplanation = `Only ${samples}/51 GLM distribution answers were saved. The exact model remains unconfirmed; rejudge does not collect missing answers.`;
  } else if (glmTarget && state && state !== "likely") {
    modelExplanation = `GLM distribution recheck: ${state}. Complete sampling alone does not establish a model when family evidence or acceptance gates do not pass.`;
  }
  return { family, samples, modelExplanation, diagnosticsUnavailable: Boolean(unavailable) };
}

export function identityVerdictKey(identity) {
  if (!identity) return "insufficient_data";
  const nested = typeof identity.verdict === "object" ? identity.verdict?.status : identity.verdict;
  return nested || ({ match: "clean_match_family_only", mismatch: "plain_mismatch", uncertain: "ambiguous" }[identity.status])
    || identity.status || "insufficient_data";
}

export function probeResultStatus(result) {
  if (result.status === "error" || result.status === "skipped") return result.status;
  if (result.passed === "warning") return "warning";
  if (typeof result.passed === "boolean") return result.passed ? "passed" : "failed";
  if (result.status === "done" || result.neutral) return "neutral";
  return result.status || "pending";
}

export function reportFromRun(run) {
  return {
    ...run.summary,
    score: run.score,
    scoreMax: run.scoreMax,
    modelId: run.targetModel,
    startedAt: run.createdAt,
    completedAt: run.finishedAt,
  };
}
