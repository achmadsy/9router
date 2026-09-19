import { beforeEach, describe, expect, it } from "vitest";
import {
  installModelCapabilityOverrides,
  sanitizeModelTokenCaps,
} from "../../open-sse/providers/modelCapabilityOverrides.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

beforeEach(async () => {
  await installModelCapabilityOverrides(async () => []);
});

describe("model capability overrides", () => {
  it("accepts only positive safe integer token limits", () => {
    expect(sanitizeModelTokenCaps({ contextWindow: "1000000", maxOutput: 128000, vision: true })).toEqual({
      contextWindow: 1000000,
      maxOutput: 128000,
    });
    expect(sanitizeModelTokenCaps({ contextWindow: 0, maxOutput: -1 })).toBeNull();
    expect(sanitizeModelTokenCaps({ contextWindow: 1.5, maxOutput: "bad" })).toBeNull();
  });

  it("merges user token limits after built-in metadata", async () => {
    await installModelCapabilityOverrides(async () => [{
      provider: "anthropic",
      model: "claude-opus-4-20250514",
      caps: { contextWindow: 500000, maxOutput: 96000 },
    }]);

    const caps = getCapabilitiesForModel("anthropic", "claude-opus-4-20250514");
    expect(caps.contextWindow).toBe(500000);
    expect(caps.maxOutput).toBe(96000);
    expect(caps.tools).toBe(true);
  });

  it("matches provider aliases and thinking-suffix variants", async () => {
    await installModelCapabilityOverrides(async () => [{
      provider: "oc",
      model: "claude-fable-5",
      caps: { maxOutput: 100000 },
    }]);

    expect(getCapabilitiesForModel("opencode", "claude-fable-5(high)").maxOutput).toBe(100000);
  });
});
