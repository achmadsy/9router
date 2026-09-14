import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

vi.mock("../../src/lib/zcode/headers.js", () => ({
  buildZcodeBalanceHeaders: vi.fn((jwt) => ({
    "User-Agent": "ZCode/3.11.2",
    "X-ZCode-App-Version": "3.11.2",
    "X-Device-Mid": "test-device-mid",
    "x-request-id": "test-request-id",
    Authorization: `Bearer ${jwt}`,
  })),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import { getGlmUsage } from "../../open-sse/services/usage/glm.js";
import {
  USAGE_SUPPORTED_PROVIDERS,
  USAGE_APIKEY_PROVIDERS,
} from "../../src/shared/constants/providers.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const SAMPLE_GLM_CREDIT_USAGE = {
  code: 200,
  msg: "Operation successful",
  data: {
    limits: [
      {
        type: "CREDIT_LIMIT",
        unit: 3,
        number: 5,
        usage: 2000,
        currentValue: 0,
        remaining: 1999,
        percentage: 25,
        nextResetTime: 1787905548392,
      },
      {
        type: "CREDIT_LIMIT",
        unit: 6,
        number: 1,
        usage: 10000,
        currentValue: 0,
        remaining: 9999,
        percentage: 10,
        nextResetTime: 1788492142997,
      },
    ],
    level: "lite",
  },
  success: true,
};

const SAMPLE_GLM_TOKENS_USAGE = {
  code: 200,
  msg: "Operation successful",
  data: {
    limits: [
      {
        type: "TOKENS_LIMIT",
        percentage: 40,
        nextResetTime: 1787905548392,
      },
    ],
    level: "standard",
  },
  success: true,
};

const SAMPLE_START_PLAN_BALANCE = {
  code: 0,
  msg: "ok",
  data: {
    plans: [
      {
        name: "GLM Start Plan",
        plan_id: "zai-start-plan",
        status: "active",
      },
    ],
    balances: [
      {
        entitlement_id: "ent-1",
        show_name: "GLM-5.3",
        plan_id: "zai-start-plan",
        total_units: 1000,
        used_units: 250,
        remaining_units: 750,
        available_units: 750,
        reserved_units: 0,
        expires_at: 1787905548,
        capabilities: ["model:GLM-5.3"],
        meter: "model_usage",
      },
      {
        entitlement_id: "ent-2",
        show_name: "GLM-5.3-Flash",
        plan_id: "zai-start-plan",
        total_units: 500,
        used_units: 0,
        remaining_units: 500,
        expires_at: 0,
        capabilities: ["model:GLM-5.3-Flash"],
      },
    ],
  },
};

describe("glm registry usage flags", () => {
  it("is listed for apikey quota dashboard", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("glm");
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("glm-cn");
    expect(USAGE_APIKEY_PROVIDERS).toContain("glm");
    expect(USAGE_APIKEY_PROVIDERS).toContain("glm-cn");
  });
});

describe("getGlmUsage and getUsageForProvider(glm)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles CREDIT_LIMIT with session 5h and weekly 7d quotas", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(SAMPLE_GLM_CREDIT_USAGE));

    const usage = await getUsageForProvider({
      provider: "glm",
      apiKey: "glm-key-123",
    });

    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("Lite");
    expect(usage.quotas["Session (5h)"]).toEqual({
      used: 25,
      total: 100,
      remaining: 75,
      remainingPercentage: 75,
      resetAt: new Date(1787905548392).toISOString(),
      unlimited: false,
    });
    expect(usage.quotas["Weekly (7d)"]).toEqual({
      used: 100 ? 10 : 10,
      total: 100,
      remaining: 90,
      remainingPercentage: 90,
      resetAt: new Date(1788492142997).toISOString(),
      unlimited: false,
    });
  });

  it("handles TOKENS_LIMIT quotas", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(SAMPLE_GLM_TOKENS_USAGE));

    const usage = await getUsageForProvider({
      provider: "glm-cn",
      apiKey: "glm-cn-key",
    });

    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("Standard");
    expect(usage.quotas["Tokens"]).toEqual({
      used: 40,
      total: 100,
      remaining: 60,
      remainingPercentage: 60,
      resetAt: new Date(1787905548392).toISOString(),
      unlimited: false,
    });
  });

  it("handles fallback key for custom limit units", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({
        code: 200,
        data: {
          limits: [
            {
              type: "CREDIT_LIMIT",
              unit: 99,
              number: 12,
              percentage: 5,
              nextResetTime: 0,
            },
          ],
          level: "pro",
        },
      })
    );

    const usage = await getGlmUsage("glm-key", "glm");
    expect(usage.plan).toBe("Pro");
    expect(usage.quotas["Limit (12)"]).toEqual({
      used: 5,
      total: 100,
      remaining: 95,
      remainingPercentage: 95,
      resetAt: null,
      unlimited: false,
    });
  });

  it("surfaces invalid key message on 401", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401));

    const usage = await getUsageForProvider({
      provider: "glm",
      apiKey: "invalid-key",
    });

    expect(usage.message).toMatch(/invalid or expired/i);
  });

  it("handles non-200 error response", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ error: "server error" }, 500));

    const usage = await getUsageForProvider({
      provider: "glm",
      apiKey: "valid-key",
    });

    expect(usage.message).toMatch(/GLM quota API error \(500\)/);
  });

  it("returns message when apiKey is missing", async () => {
    const usage = await getUsageForProvider({
      provider: "glm",
      apiKey: "",
    });

    expect(usage.message).toBe("GLM API key not available.");
  });
});

describe("getGlmUsage Start Plan (zcode JWT / billing/balance)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("JWT-only connection returns Start Plan buckets without Coding Plan fetch", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(SAMPLE_START_PLAN_BALANCE));

    const usage = await getGlmUsage(undefined, "glm", null, {
      zcodeJwtToken: "fake-jwt",
    });

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = proxyAwareFetch.mock.calls[0];
    expect(String(url)).toContain("https://zcode.z.ai/api/v1/zcode-plan/billing/balance");
    expect(String(url)).toContain("app_version=");
    expect(opts.method).toBe("GET");
    expect(opts.headers.Authorization).toBe("Bearer fake-jwt");
    expect(opts.headers["User-Agent"]).toBe("ZCode/3.11.2");
    expect(opts.headers["X-ZCode-App-Version"]).toBe("3.11.2");
    expect(opts.headers["X-Device-Mid"]).toBe("test-device-mid");
    expect(opts.headers["x-request-id"]).toBe("test-request-id");
    expect(opts.headers["anthropic-version"]).toBeUndefined();
    expect(opts.headers["X-ZCode-Agent"]).toBeUndefined();
    expect(opts.headers["x-zcode-session-type"]).toBeUndefined();
    expect(opts.headers["x-zcode-trace-id"]).toBeUndefined();
    expect(opts.headers["x-query-id"]).toBeUndefined();
    expect(opts.headers["x-session-id"]).toBeUndefined();
    expect(opts.headers["X-Aliyun-Captcha-Verify-Param"]).toBeUndefined();

    expect(usage.plan).toBe("Start");
    expect(usage.quotas["Start: GLM-5.3"]).toMatchObject({
      used: 250,
      total: 1000,
      remaining: 750,
      remainingPercentage: 75,
      resetAt: new Date(1787905548 * 1000).toISOString(),
    });
    expect(usage.quotas["Start: GLM-5.3-Flash"]).toMatchObject({
      used: 0,
      total: 500,
      remaining: 500,
      remainingPercentage: 100,
      resetAt: null,
    });
  });

  it("JWT + apiKey merges Start Plan with Coding Plan quotas", async () => {
    proxyAwareFetch.mockImplementation(async (url) =>
      jsonResponse(
        String(url).includes("billing/balance")
          ? SAMPLE_START_PLAN_BALANCE
          : SAMPLE_GLM_CREDIT_USAGE,
      ),
    );

    const usage = await getGlmUsage("glm-key", "glm", null, {
      zcodeJwtToken: "fake-jwt",
    });

    expect(usage.plan).toBe("Start");
    expect(usage.quotas["Start: GLM-5.3"].remaining).toBe(750);
    expect(usage.quotas["Session (5h)"].used).toBe(25);
    expect(usage.quotas["Weekly (7d)"].used).toBe(10);
  });

  it("JWT present but no active plan falls through to Coding Plan only", async () => {
    proxyAwareFetch.mockImplementation(async (url) => {
      if (String(url).includes("billing/balance")) {
        return jsonResponse({
          code: 0,
          data: {
            plans: [{ name: "old", plan_id: "zai-start-plan", status: "expired" }],
            balances: [],
          },
        });
      }
      return jsonResponse(SAMPLE_GLM_CREDIT_USAGE);
    });

    const usage = await getGlmUsage("glm-key", "glm", null, {
      zcodeJwtToken: "fake-jwt",
    });

    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
    expect(proxyAwareFetch.mock.calls.some(([url]) => String(url).includes("billing/current"))).toBe(false);
    expect(usage.quotas["Start:"]).toBeUndefined();
    expect(usage.quotas["Session (5h)"]).toBeTruthy();
    expect(usage.plan).toBe("Lite");
  });

  it("JWT-only, non-zero code → soft message without current fallback", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({ code: 1113, msg: "no plan", data: null }),
    );

    const usage = await getGlmUsage(undefined, "glm", null, {
      zcodeJwtToken: "fake-jwt",
    });

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(usage.message).toBe("no plan");
    expect(usage.quotas).toBeUndefined();
  });

  it("JWT-only, HTTP 401 → invalid JWT message", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({}, 401));

    const usage = await getGlmUsage(undefined, "glm", null, {
      zcodeJwtToken: "expired",
    });

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(usage.message).toBe("GLM Start Plan JWT invalid or expired.");
  });

  it("balances missing numeric units are skipped", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({
        code: 0,
        data: {
          plans: [{ plan_id: "zai-start-plan", status: "active" }],
          balances: [
            { entitlement_id: "empty", total_units: null, used_units: null, remaining_units: null },
            {
              entitlement_id: "meter-only",
              meter: "model_usage",
              total_units: 10,
              used_units: 10,
              remaining_units: 0,
            },
          ],
        },
      }),
    );

    const usage = await getGlmUsage(undefined, "glm", null, { zcodeJwtToken: "jwt" });

    expect(usage.quotas["Start: model_usage"]).toMatchObject({
      used: 10,
      total: 10,
      remaining: 0,
      remainingPercentage: 0,
    });
    expect(Object.keys(usage.quotas)).toHaveLength(1);
  });
});
