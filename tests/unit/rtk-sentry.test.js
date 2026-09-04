import { describe, it, expect, vi, beforeEach } from "vitest";
import { captureRtkError } from "../../open-sse/rtk/sentry.js";
import { compressMessages } from "../../open-sse/rtk/index.js";
import * as sentryLib from "@/lib/sentry.js";

describe("RTK Sentry capture helper", () => {
  it("safely calls captureException when available without throwing", async () => {
    const spy = vi.spyOn(sentryLib, "captureException").mockImplementation(() => {});

    const err = new Error("Test RTK error");
    expect(() => {
      captureRtkError(err, "rtk:compress", { format: "standard" });
    }).not.toThrow();

    // Allow promise microtask to resolve
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(spy).toHaveBeenCalledWith(
      err,
      expect.objectContaining({
        tags: { stage: "rtk:compress" },
        extra: { format: "standard" },
      })
    );
    spy.mockRestore();
  });

  it("never throws if sentry module fails or throws", async () => {
    const spy = vi.spyOn(sentryLib, "captureException").mockImplementation(() => {
      throw new Error("Sentry internal failure");
    });

    expect(() => {
      captureRtkError(new Error("Another error"), "rtk:compress");
    }).not.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 50));
    spy.mockRestore();
  });
});

describe("RTK compressMessages Sentry integration", () => {
  it("captures error to Sentry on invalid body structure in compressMessages", async () => {
    const spy = vi.spyOn(sentryLib, "captureException").mockImplementation(() => {});

    // Create corrupted message list where accessing content throws
    const badBody = {
      messages: [
        {
          role: "tool",
          get content() {
            throw new Error("Corrupted content getter");
          },
        },
      ],
    };

    const result = compressMessages(badBody, true);
    expect(result).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(spy).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { stage: "rtk:compress" },
        extra: { format: "standard" },
      })
    );
    spy.mockRestore();
  });
});
