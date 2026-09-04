import { describe, it, expect, vi, beforeEach } from "vitest";
import { injectCaveman, formatCavemanTag } from "../../open-sse/rtk/caveman.js";
import { CAVEMAN_LEVELS, CAVEMAN_PROMPTS, CAVEMAN_ESTIMATED_REDUCTIONS, getCavemanReduction } from "../../open-sse/rtk/cavemanPrompts.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import * as sentryHelper from "../../open-sse/rtk/sentry.js";
import * as systemInjectModule from "../../open-sse/rtk/systemInject.js";

describe("injectCaveman", () => {
  it("injects caveman prompt into OpenAI chat messages and returns stats", () => {
    const body = {
      messages: [{ role: "user", content: "Hello world" }],
    };
    const result = injectCaveman(body, FORMATS.OPENAI, CAVEMAN_LEVELS.FULL);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain(CAVEMAN_PROMPTS[CAVEMAN_LEVELS.FULL]);
    expect(result).toEqual({
      level: CAVEMAN_LEVELS.FULL,
      reduction: "~65% cut",
      promptChars: expect.any(Number),
    });
  });

  it("injects caveman prompt into Claude system field and returns stats", () => {
    const body = {
      system: "Original prompt",
      messages: [{ role: "user", content: "Hello world" }],
    };
    const result = injectCaveman(body, FORMATS.CLAUDE, CAVEMAN_LEVELS.LITE);
    expect(body.system).toContain("Original prompt");
    expect(body.system).toContain(CAVEMAN_PROMPTS[CAVEMAN_LEVELS.LITE]);
    expect(result.reduction).toBe("~40% cut");
  });

  it("does nothing and returns null when level is unknown/invalid", () => {
    const body = {
      messages: [{ role: "user", content: "Hello" }],
    };
    const result = injectCaveman(body, FORMATS.OPENAI, "nonexistent-level");
    expect(body.messages.length).toBe(1);
    expect(body.messages[0].role).toBe("user");
    expect(result).toBeNull();
  });

  it("formats caveman tag with reduction estimate", () => {
    expect(formatCavemanTag(CAVEMAN_LEVELS.FULL)).toBe("CAVEMAN:full (~65% cut)");
    expect(formatCavemanTag(CAVEMAN_LEVELS.LITE)).toBe("CAVEMAN:lite (~40% cut)");
    expect(formatCavemanTag(CAVEMAN_LEVELS.ULTRA)).toBe("CAVEMAN:ultra (~80% cut)");
    expect(formatCavemanTag("unknown")).toBe("CAVEMAN:unknown");
  });

  it("fails open and reports to sentry if injector throws", () => {
    const sentrySpy = vi.spyOn(sentryHelper, "captureRtkError");
    const injectSpy = vi.spyOn(systemInjectModule, "injectSystemPrompt").mockImplementation(() => {
      throw new Error("Simulated injection crash");
    });

    const body = { messages: [{ role: "user", content: "Hello" }] };

    let res;
    expect(() => {
      res = injectCaveman(body, FORMATS.OPENAI, CAVEMAN_LEVELS.FULL);
    }).not.toThrow();

    expect(res).toBeNull();
    expect(sentrySpy).toHaveBeenCalledWith(
      expect.any(Error),
      "caveman:inject",
      expect.objectContaining({ format: FORMATS.OPENAI, level: CAVEMAN_LEVELS.FULL })
    );

    sentrySpy.mockRestore();
    injectSpy.mockRestore();
  });
});
