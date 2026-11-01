// Shared display projection: every summary reads the same saved assessment.
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
