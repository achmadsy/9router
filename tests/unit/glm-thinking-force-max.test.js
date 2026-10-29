import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { GlmExecutor } from "../../open-sse/executors/glm.js";
import { applyProviderThinkingOverride } from "../../open-sse/handlers/chatCore.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
const providerPageSource = readFileSync(
  new URL("../../src/app/(dashboard)/dashboard/providers/[id]/page.js", import.meta.url),
  "utf8"
);

describe("GLM force max thinking", () => {
  it.each([
    ["glm", "glm-5.3"],
    ["glm", "glm-5.3-flash"],
    ["glm", "glm-5.2"],
    ["glm-cn", "glm-5.3"],
    ["glm-cn", "glm-5.3-flash"],
  ])("publishes max for %s/%s", (provider, model) => {
    expect(getThinkingLevels(provider, model)).toContain("max");
  });

  it("overrides lower or disabled client thinking for GLM", () => {
    const result = applyProviderThinkingOverride(
      {
        reasoning_effort: "low",
        output_config: { effort: "low", keep: true },
        thinking: { type: "disabled" },
        enable_thinking: false,
      },
      "glm",
      { forceMax: true }
    );

    expect(result).toMatchObject({
      reasoning_effort: "max",
      output_config: { effort: "max", keep: true },
      thinking: { type: "enabled", budget_tokens: 32000 },
      enable_thinking: true,
    });
  });

  it("does not change other providers or disabled overrides", () => {
    const body = { reasoning_effort: "low" };
    expect(applyProviderThinkingOverride(body, "openai", { forceMax: true })).toBe(body);
    expect(applyProviderThinkingOverride(body, "glm", { forceMax: false })).toBe(body);
  });

  it("persists an explicit provider-page toggle", () => {
    expect(providerPageSource).toContain("Force Max Thinking");
    expect(providerPageSource).toContain("forceMaxThinking");
    expect(providerPageSource).toContain("if (forceMax) config.forceMax = true;");
  });

  it("preserves max effort for Start Plan Anthropic requests", () => {
    const executor = new GlmExecutor();
    executor.getUrlIndex = () => 0;
    const transformed = executor.transformRequest(
      "glm-5.3",
      {
        model: "glm-5.3",
        messages: [{ role: "user", content: "hello" }],
        thinking: { type: "enabled", budget_tokens: 32000 },
      },
      true,
      { providerSpecificData: { zcodeJwtToken: "jwt", useCodingPlan: true } }
    );

    expect(transformed.thinking).toMatchObject({ type: "enabled", budgetTokens: 32000 });
    expect(transformed.output_config).toMatchObject({ effort: "max" });
  });

  it("keeps the 32k budget through the full translator → executor pipeline", () => {
    const overridden = applyProviderThinkingOverride(
      { model: "glm-5.3", messages: [{ role: "user", content: "hello" }], reasoning_effort: "low" },
      "glm",
      { forceMax: true }
    );
    // Same pipeline order as chatCore: override → applyThinking → GlmExecutor.
    // glm/glm-5.3 resolves to the claude-budget thinking format, which maps
    // effort "max" back to budget_tokens 32000 (the thinkingRange ceiling).
    const translated = applyThinking("anthropic", "glm-5.3", overridden, "glm");
    expect(translated.thinking).toEqual({ type: "enabled", budget_tokens: 32000 });

    const executor = new GlmExecutor();
    executor.getUrlIndex = () => 0;
    const transformed = executor.transformRequest(
      "glm-5.3",
      translated,
      true,
      { providerSpecificData: { zcodeJwtToken: "jwt", useCodingPlan: true } }
    );

    expect(transformed.thinking).toMatchObject({ type: "enabled", budgetTokens: 32000 });
    expect(transformed.output_config).toMatchObject({ effort: "max" });
  });

  it("recovers 32000 from reasoning_effort max when no budget survives translation", () => {
    // Transports whose thinkingFormat resolves to "zai" rebuild `thinking`
    // without budget_tokens but keep reasoning_effort — the executor must not
    // fall back to the 8k default there.
    const executor = new GlmExecutor();
    executor.getUrlIndex = () => 0;
    const transformed = executor.transformRequest(
      "glm-5.3",
      { model: "glm-5.3", messages: [{ role: "user", content: "hi" }], reasoning_effort: "max", thinking: { type: "enabled" } },
      true,
      { providerSpecificData: { zcodeJwtToken: "jwt", useCodingPlan: true } }
    );
    expect(transformed.thinking).toMatchObject({ type: "enabled", budgetTokens: 32000 });
    expect(transformed.output_config).toMatchObject({ effort: "max" });
  });
});
