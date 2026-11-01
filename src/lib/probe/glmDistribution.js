// Sampling eligibility is based on the resolved target, never its claimed identity.
// Keep the supported set aligned with LLMprobe-engine/glm-distribution-models.ts.
export function supportsGlmDistribution(modelId) {
  return typeof modelId === "string" && /^(?:[^/]+\/)?glm-5(?:\.[12]|\.3(?:-flash)?)?$/i.test(modelId);
}
