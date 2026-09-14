import { describe, it, expect, beforeEach } from "vitest";
import {
  applyZcodeApiKeyHeaders,
  applyZcodeCodingPlanHeaders,
  buildZcodeApiKeyHeaders,
  buildZcodeBalanceHeaders,
  buildZcodeCodingPlanHeaders,
  clearZcodeCodingPlanHeaders,
  stripAnthropicHeadersForZcodePlan,
  __test__,
} from "../../src/lib/zcode/headers.js";

describe("zcode headers", () => {
  beforeEach(() => {
    __test__.sessionIdByConnection.clear();
  });

  const credentials = {
    connectionId: "conn-a",
    accessToken: "jwt-token",
    providerSpecificData: {
      useCodingPlan: true,
      zcodeJwtToken: "jwt-token",
      _captchaVerifyParam: "verify-123",
    },
  };

  it("strips Anthropic headers for zcode-plan upstream", () => {
    const headers = {
      "Anthropic-Version": "2023-06-01",
      "Anthropic-Beta": "claude-code-20250219",
      "Content-Type": "application/json",
    };
    stripAnthropicHeadersForZcodePlan(headers);
    expect(headers["Anthropic-Version"]).toBeUndefined();
    expect(headers["Anthropic-Beta"]).toBeUndefined();
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("builds ZCode 3.11.2 headers with native fingerprint", () => {
    const headers = buildZcodeCodingPlanHeaders(credentials);
    expect(headers["User-Agent"]).toBe("ZCode/3.11.2");
    expect(headers["X-ZCode-App-Version"]).toBe("3.11.2");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["HTTP-Referer"]).toBe("https://zcode.z.ai");
    expect(headers["X-Release-Channel"]).toBe("production");
    expect(headers["X-Platform"]).toContain(process.platform);
    expect(headers["x-zcode-session-type"]).toBe("main");
    expect(headers["X-Aliyun-Captcha-Verify-Region"]).toBe("sgp");
    expect(headers["x-session-id"]).toBeTruthy();
  });

  it("builds native billing/balance headers without inference-only fields", () => {
    const headers = buildZcodeBalanceHeaders("jwt-token");

    expect(headers.Authorization).toBe("Bearer jwt-token");
    expect(headers["User-Agent"]).toBe("ZCode/3.11.2");
    expect(headers["X-ZCode-App-Version"]).toBe("3.11.2");
    expect(headers["HTTP-Referer"]).toBe("https://zcode.z.ai");
    expect(headers["X-Release-Channel"]).toBe("production");
    expect(headers["X-Device-Mid"]).toBeTruthy();
    expect(headers["x-request-id"]).toBeTruthy();

    expect(headers.Accept).toBeUndefined();
    expect(headers["anthropic-version"]).toBeUndefined();
    expect(headers["X-ZCode-Agent"]).toBeUndefined();
    expect(headers["x-zcode-session-type"]).toBeUndefined();
    expect(headers["x-zcode-trace-id"]).toBeUndefined();
    expect(headers["x-query-id"]).toBeUndefined();
    expect(headers["x-session-id"]).toBeUndefined();
    expect(headers["X-Aliyun-Captcha-Verify-Param"]).toBeUndefined();
  });

  it("applyZcodeCodingPlanHeaders merges into existing headers", () => {
    const headers = {
      "Anthropic-Version": "2023-06-01",
      "Anthropic-Beta": "claude-code-20250219",
      "x-api-key": "should-remove",
    };
    applyZcodeCodingPlanHeaders(headers, credentials);
    expect(headers.Authorization).toBe("Bearer jwt-token");
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["Anthropic-Version"]).toBeUndefined();
    expect(headers["Anthropic-Beta"]).toBeUndefined();
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["X-Title"]).toBe("Z Code@electron");
  });

  it("builds ZCode API key headers with captcha but no region (zcode_proxy parity)", () => {
    const headers = buildZcodeApiKeyHeaders(
      { apiKey: "org.key.secret", providerSpecificData: { _captchaVerifyParam: "verify-123" } }
    );
    expect(headers["x-api-key"]).toBe("org.key.secret");
    expect(headers["X-Aliyun-Captcha-Verify-Param"]).toBe("verify-123");
    expect(headers["X-Aliyun-Captcha-Verify-Region"]).toBeUndefined();
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["User-Agent"]).toBe("ZCode/3.11.2");
  });

  it("applyZcodeApiKeyHeaders strips Claude beta headers", () => {
    const headers = {
      "Anthropic-Version": "2023-06-01",
      "Anthropic-Beta": "claude-code-20250219",
      Authorization: "Bearer stale",
    };
    applyZcodeApiKeyHeaders(headers, {
      apiKey: "org.key.secret",
      providerSpecificData: { _captchaVerifyParam: "verify-123" },
    });
    expect(headers.Authorization).toBeUndefined();
    expect(headers["Anthropic-Beta"]).toBeUndefined();
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["x-api-key"]).toBe("org.key.secret");
  });

  it("clearZcodeCodingPlanHeaders removes ZCode fields only", () => {
    const headers = {
      Authorization: "Bearer jwt-token",
      "X-ZCode-Agent": "glm",
      "Anthropic-Version": "2023-06-01",
    };
    clearZcodeCodingPlanHeaders(headers);
    expect(headers.Authorization).toBeUndefined();
    expect(headers["X-ZCode-Agent"]).toBeUndefined();
    expect(headers["Anthropic-Version"]).toBe("2023-06-01");
  });
});