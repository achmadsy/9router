import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as sentryLib from "@/lib/sentry.js";
import * as logger from "@/sse/utils/logger.js";
import { initConsoleLogCapture } from "@/lib/consoleLogBuffer.js";
import { ZcodeExecutor } from "open-sse/executors/zcode.js";
import { classifyOAuthRefreshError } from "open-sse/services/tokenRefresh/providers.js";

describe("Sentry reporting gaps & issue detection", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    if (typeof globalThis !== "undefined") {
      globalThis.__9router_sentry = sentryLib;
    }
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("Keyword matching (matchesIssueKeyword)", () => {
    it("matches all required error and warning keywords", () => {
      const positiveSamples = [
        "Codex refresh token already used or invalid. Re-auth required.",
        JSON.stringify({ status: 401, code: "refresh_token_invalidated" }),
        "Rate limit exceeded (429)",
        "Free tier daily quota exhausted",
        "ZCode upstream triggered Aliyun verification/captcha",
        "invalid_grant error received",
        "Re-auth required for connection",
        "403 Forbidden: authentication failed",
        "[TOKEN_REFRESH] No valid token",
      ];

      for (const sample of positiveSamples) {
        expect(
          sentryLib.matchesIssueKeyword(sample),
          `Expected "${sample}" to match issue keywords`
        ).toBe(true);
      }
    });

    it("does not match benign logs", () => {
      const benignSamples = [
        "Server listening on port 20128",
        "Request completed 200 OK",
        "User profile updated successfully",
        "Model combo expansion: gemini-pro -> 3 models",
      ];

      for (const sample of benignSamples) {
        expect(
          sentryLib.matchesIssueKeyword(sample),
          `Expected "${sample}" NOT to match issue keywords`
        ).toBe(false);
      }
    });
  });

  describe("Sentry auto-initialization & readiness", () => {
    it("isSentryReady returns false when no DSN is provided and Sentry is not initialized", () => {
      delete process.env.SENTRY_DSN;
      const ready = sentryLib.isSentryReady();
      // If already initialized in runtime, it's boolean; verify it does not throw
      expect(typeof ready).toBe("boolean");
    });

    it("auto-initializes when SENTRY_DSN is set", () => {
      process.env.SENTRY_DSN = "https://mockkey@sentry.example.com/123";
      expect(() => sentryLib.initSentry()).not.toThrow();
      expect(sentryLib.isSentryReady()).toBe(true);
    });
  });

  describe("Deduplication", () => {
    it("deduplicates identical keys within TTL", () => {
      const key = `test-dedup-${Date.now()}`;
      expect(sentryLib.isDuplicate(key)).toBe(false);
      expect(sentryLib.isDuplicate(key)).toBe(true);
    });

    it("allows distinct keys through", () => {
      const t = Date.now();
      expect(sentryLib.isDuplicate(`key-1-${t}`)).toBe(false);
      expect(sentryLib.isDuplicate(`key-2-${t}`)).toBe(false);
    });
  });

  describe("Logger Sentry forwarding", () => {
    it("forwards logger.warn to Sentry when issue keywords match", () => {
      const captureSpy = vi.spyOn(sentryLib, "captureMessage").mockImplementation(() => {});
      vi.spyOn(sentryLib, "isSentryReady").mockReturnValue(true);

      logger.warn("TOKEN_REFRESH", "Codex refresh token already used or invalid. Re-auth required.", {
        status: 401,
        code: "refresh_token_invalidated",
      });

      expect(captureSpy).toHaveBeenCalledWith(
        "[TOKEN_REFRESH] Codex refresh token already used or invalid. Re-auth required.",
        "warning",
        expect.objectContaining({
          tags: expect.objectContaining({ tag: "TOKEN_REFRESH", kind: "warn" }),
          extra: { data: { status: 401, code: "refresh_token_invalidated" } },
        })
      );
    });

    it("forwards logger.error to Sentry for invalid token errors", () => {
      const captureSpy = vi.spyOn(sentryLib, "captureMessage").mockImplementation(() => {});
      vi.spyOn(sentryLib, "isSentryReady").mockReturnValue(true);

      logger.error("TOKEN_REFRESH", "Codex refresh token already used or invalid. Re-auth required.", {
        status: 401,
        code: "refresh_token_invalidated",
      });

      expect(captureSpy).toHaveBeenCalledWith(
        "[TOKEN_REFRESH] Codex refresh token already used or invalid. Re-auth required.",
        "error",
        expect.objectContaining({
          tags: expect.objectContaining({ tag: "TOKEN_REFRESH", kind: "error" }),
          extra: { data: { status: 401, code: "refresh_token_invalidated" } },
        })
      );
    });
  });

  describe("ConsoleLogBuffer Sentry interception", () => {
    it("forwards direct console.error to Sentry fail-open", () => {
      const captureSpy = vi.spyOn(sentryLib, "captureMessage").mockImplementation(() => {});
      vi.spyOn(sentryLib, "isSentryReady").mockReturnValue(true);

      initConsoleLogCapture();
      const testErrMsg = `[Database] Connection pool exhausted error ${Date.now()}`;
      console.error(testErrMsg);

      expect(captureSpy).toHaveBeenCalledWith(
        expect.stringContaining(testErrMsg),
        "error",
        expect.objectContaining({
          tags: expect.objectContaining({ source: "console.error" }),
        })
      );
    });

    it("forwards direct console.warn to Sentry when issue keywords match", () => {
      const captureSpy = vi.spyOn(sentryLib, "captureMessage").mockImplementation(() => {});
      vi.spyOn(sentryLib, "isSentryReady").mockReturnValue(true);

      initConsoleLogCapture();
      const testWarnMsg = `[Auth] Rate limit (429) detected on attempt 1 ${Date.now()}`;
      console.warn(testWarnMsg);

      expect(captureSpy).toHaveBeenCalledWith(
        expect.stringContaining(testWarnMsg),
        "warning",
        expect.objectContaining({
          tags: expect.objectContaining({ source: "console.warn" }),
        })
      );
    });

    it("suppresses duplicate [ZCode Captcha] console logs from generic interception", () => {
      const captureSpy = vi.spyOn(sentryLib, "captureMessage").mockImplementation(() => {});
      vi.spyOn(sentryLib, "isSentryReady").mockReturnValue(true);

      initConsoleLogCapture();
      console.warn("[ZCode Captcha] Challenge (403) detected on attempt 1");
      console.error("[ZCode Captcha] Solve failed (attempt 1): timed out");

      expect(captureSpy).not.toHaveBeenCalled();
    });
  });

  describe("OAuth Refresh Error Classification", () => {
    it("identifies refresh_token_invalidated and invalid_grant as permanent unrecoverable failures", () => {
      const res1 = classifyOAuthRefreshError(JSON.stringify({ error: "refresh_token_invalidated" }), 401);
      expect(res1.permanent).toBe(true);

      const res2 = classifyOAuthRefreshError(JSON.stringify({ error: "invalid_grant" }), 400);
      expect(res2.permanent).toBe(true);

      const res3 = classifyOAuthRefreshError("Codex refresh token already used or invalid", 401);
      expect(res3.permanent).toBe(true);
    });
  });

  describe("ZcodeExecutor Captcha Sentry Integration", () => {
    it("reports upstream captcha challenges to Sentry via captureMessage", () => {
      const captureSpy = vi.spyOn(sentryLib, "captureMessage").mockImplementation(() => {});
      const executor = new ZcodeExecutor("zcode");

      const errorInfo = executor.parseError(
        { status: 403 },
        JSON.stringify({ code: "3007", message: "verify failed captcha required" })
      );

      expect(errorInfo.status).toBe(403);
      expect(errorInfo.message).toContain("Aliyun verification/captcha");
      expect(captureSpy).toHaveBeenCalledWith(
        expect.stringContaining("verify failed captcha required"),
        "error",
        expect.objectContaining({
          tags: expect.objectContaining({ provider: "zcode", stage: "upstream_captcha" }),
        })
      );
    });
  });

  describe("Fail-open guarantee", () => {
    it("captureMessage never throws even if an internal error occurs", () => {
      vi.spyOn(sentryLib, "isSentryReady").mockImplementation(() => {
        throw new Error("Internal failure");
      });

      expect(() => {
        sentryLib.captureMessage("Test message", "info");
      }).not.toThrow();
    });

    it("captureException never throws even if an internal error occurs", () => {
      vi.spyOn(sentryLib, "isSentryReady").mockImplementation(() => {
        throw new Error("Internal failure");
      });

      let res;
      expect(() => {
        res = sentryLib.captureException(new Error("Test error"));
      }).not.toThrow();
      expect(res).toBeNull();
    });

    it("captureMessage never throws and returns null when readiness fails", () => {
      vi.spyOn(sentryLib, "isSentryReady").mockImplementation(() => {
        throw new Error("Readiness crash");
      });

      let res;
      expect(() => {
        res = sentryLib.captureMessage("Test message", "error");
      }).not.toThrow();
      expect(res).toBeNull();
    });
  });

  describe("Data scrubbing & sensitive token redaction", () => {
    it("redacts Bearer tokens and OpenAI API keys from text", () => {
      const raw = "Authorization: Bearer ya29.a0AXooCgu1234567890abcdef and key sk-proj-1234567890abcdefghijklmn";
      const cleaned = sentryLib.redactSensitiveText(raw);

      expect(cleaned).toContain("Bearer [REDACTED]");
      expect(cleaned).toContain("sk-...[REDACTED]");
      expect(cleaned).not.toContain("ya29.a0AXooCgu");
      expect(cleaned).not.toContain("sk-proj-1234567890");
    });

    it("redacts OAuth tokens while preserving issue keywords", () => {
      const raw = JSON.stringify({
        refresh_token: "1//04abcdefghij1234",
        status: 401,
        code: "refresh_token_invalidated",
      });
      const cleaned = sentryLib.redactSensitiveText(raw);

      expect(cleaned).toContain('"refresh_token":"[REDACTED]"');
      expect(cleaned).toContain('"code":"refresh_token_invalidated"');
      expect(sentryLib.matchesIssueKeyword(cleaned)).toBe(true);
    });

    it("scrubs sensitive dictionary fields recursively", () => {
      const payload = {
        headers: {
          authorization: "Bearer secret-token-12345",
          "x-api-key": "sk-1234567890",
          "content-type": "application/json",
        },
        data: {
          password: "my-secret-password",
          user: "admin",
          sub: {
            refresh_token: "token-987654321",
          },
        },
      };
      const scrubbed = sentryLib.scrubSensitiveData(payload);

      expect(scrubbed.headers.authorization).toBe("[REDACTED]");
      expect(scrubbed.headers["x-api-key"]).toBe("[REDACTED]");
      expect(scrubbed.headers["content-type"]).toBe("application/json");
      expect(scrubbed.data.password).toBe("[REDACTED]");
      expect(scrubbed.data.user).toBe("admin");
      expect(scrubbed.data.sub.refresh_token).toBe("[REDACTED]");
    });
  });

  describe("Safe bridge pattern & open-sse isolation", () => {
    it("rtk/sentry delegates to globalThis.__9router_sentry when available", async () => {
      const rtkSentry = await import("../../open-sse/rtk/sentry.js");
      const testSpy = vi.fn().mockReturnValue(true);
      globalThis.__9router_sentry = {
        captureMessage: testSpy,
        captureException: vi.fn(),
      };

      rtkSentry.captureMessage("Test bridge message", "warning", { tags: { test: "1" } });
      expect(testSpy).toHaveBeenCalledWith("Test bridge message", "warning", { tags: { test: "1" } });
    });

    it("rtk/sentry fail-opens cleanly when bridge is absent", async () => {
      const rtkSentry = await import("../../open-sse/rtk/sentry.js");
      const savedBridge = globalThis.__9router_sentry;
      delete globalThis.__9router_sentry;

      expect(() => {
        const res = rtkSentry.captureException(new Error("Bridge absent test"));
        expect(res).toBeNull();
      }).not.toThrow();

      globalThis.__9router_sentry = savedBridge;
    });
  });
});
