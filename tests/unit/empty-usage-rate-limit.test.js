// IN 0 · OUT 0 → silent 429 gate: GLM family only, other providers unaffected.
import { describe, it, expect } from "vitest";
import { isEmptyUsageRateLimit } from "../../open-sse/handlers/chatCore/requestDetail.js";

describe("isEmptyUsageRateLimit — provider gate", () => {
  const empty = {};
  const used = { prompt_tokens: 12, completion_tokens: 3 };

  it("treats GLM Coding zero-token completion as rate limit", () => {
    expect(isEmptyUsageRateLimit("glm", empty)).toBe(true);
  });

  it("does NOT rate-limit GLM (China) — only GLM Coding (z.ai)", () => {
    expect(isEmptyUsageRateLimit("glm-cn", empty)).toBe(false);
  });

  it("resolves glm clones to their base provider", () => {
    expect(isEmptyUsageRateLimit("glm-clone-abc123", empty)).toBe(true);
  });

  it("does NOT rate-limit other providers on zero tokens", () => {
    expect(isEmptyUsageRateLimit("openai", empty)).toBe(false);
    expect(isEmptyUsageRateLimit("antigravity", empty)).toBe(false);
    expect(isEmptyUsageRateLimit("codex", empty)).toBe(false);
  });

  it("does not fire when tokens are actually present (even for glm)", () => {
    expect(isEmptyUsageRateLimit("glm", used)).toBe(false);
  });

  it("handles null/undefined usage without throwing", () => {
    expect(isEmptyUsageRateLimit("glm", null)).toBe(true);
    expect(isEmptyUsageRateLimit("openai", undefined)).toBe(false);
  });
});
