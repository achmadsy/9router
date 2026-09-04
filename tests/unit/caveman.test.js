import { describe, it, expect, vi, beforeEach } from "vitest";
import { injectCaveman } from "../../open-sse/rtk/caveman.js";
import { CAVEMAN_LEVELS, CAVEMAN_PROMPTS } from "../../open-sse/rtk/cavemanPrompts.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import * as sentryHelper from "../../open-sse/rtk/sentry.js";
import * as systemInjectModule from "../../open-sse/rtk/systemInject.js";

describe("injectCaveman", () => {
  it("injects caveman prompt into OpenAI chat messages", () => {
    const body = {
      messages: [{ role: "user", content: "Hello world" }],
    };
    injectCaveman(body, FORMATS.OPENAI, CAVEMAN_LEVELS.FULL);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain(CAVEMAN_PROMPTS[CAVEMAN_LEVELS.FULL]);
  });

  it("injects caveman prompt into Claude system field", () => {
    const body = {
      system: "Original prompt",
      messages: [{ role: "user", content: "Hello world" }],
    };
    injectCaveman(body, FORMATS.CLAUDE, CAVEMAN_LEVELS.LITE);
    expect(body.system).toContain("Original prompt");
    expect(body.system).toContain(CAVEMAN_PROMPTS[CAVEMAN_LEVELS.LITE]);
  });

  it("does nothing when level is unknown/invalid", () => {
    const body = {
      messages: [{ role: "user", content: "Hello" }],
    };
    injectCaveman(body, FORMATS.OPENAI, "nonexistent-level");
    expect(body.messages.length).toBe(1);
    expect(body.messages[0].role).toBe("user");
  });

  it("fails open and reports to sentry if injector throws", () => {
    const sentrySpy = vi.spyOn(sentryHelper, "captureRtkError");
    const injectSpy = vi.spyOn(systemInjectModule, "injectSystemPrompt").mockImplementation(() => {
      throw new Error("Simulated injection crash");
    });

    const body = { messages: [{ role: "user", content: "Hello" }] };

    expect(() => {
      injectCaveman(body, FORMATS.OPENAI, CAVEMAN_LEVELS.FULL);
    }).not.toThrow();

    expect(sentrySpy).toHaveBeenCalledWith(
      expect.any(Error),
      "caveman:inject",
      expect.objectContaining({ format: FORMATS.OPENAI, level: CAVEMAN_LEVELS.FULL })
    );

    sentrySpy.mockRestore();
    injectSpy.mockRestore();
  });
});
