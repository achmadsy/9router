import { describe, it, expect, vi } from "vitest";
const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...a) => fetchMock(...a),
}));

import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import { getModelTargetFormat } from "../../open-sse/config/providerModels.js";
import { installCustomModelFormats } from "../../open-sse/providers/customModelFormats.js";

describe("opencode per-model endpoint override", () => {
  it("registry muse-spark keeps openai-responses target", () => {
    expect(getModelTargetFormat("oc", "muse-spark-1.2-contributor-free")).toBe("openai-responses");
  });

  it("custom model with targetFormat claude routes to /zen/v1/messages", async () => {
    await installCustomModelFormats(async () => [
      { providerAlias: "oc", id: "union-alpha", targetFormat: "claude" },
    ]);
    expect(getModelTargetFormat("oc", "union-alpha")).toBe("claude");

    const ex = new OpenCodeExecutor();
    expect(ex.buildUrl("union-alpha", true, 0, null)).toBe("https://opencode.ai/zen/v1/messages");
  });

  it("regular custom model without override stays on /chat/completions", async () => {
    await installCustomModelFormats(async () => [
      { providerAlias: "oc", id: "some-new-model-free" },
    ]);
    const ex = new OpenCodeExecutor();
    expect(ex.buildUrl("some-new-model-free", true, 0, null)).toBe("https://opencode.ai/zen/v1/chat/completions");
  });

  it("registry muse-spark still routes to /zen/v1/responses", () => {
    const ex = new OpenCodeExecutor();
    expect(ex.buildUrl("muse-spark-1.3-contributor-free", true, 0, null)).toBe("https://opencode.ai/zen/v1/responses");
  });
});

describe("opencode openai-responses override", () => {
  it("custom model with targetFormat openai-responses routes to /zen/v1/responses", async () => {
    const { installCustomModelFormats: install } = await import("../../open-sse/providers/customModelFormats.js");
    await install(async () => [
      { providerAlias: "oc", id: "some-union-model", targetFormat: "openai-responses" },
    ]);
    const ex = new OpenCodeExecutor();
    expect(ex.buildUrl("some-union-model", true, 0, null)).toBe("https://opencode.ai/zen/v1/responses");
  });
});
