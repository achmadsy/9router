import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getExecutor } from "../../open-sse/executors/index.js";
import {
  getCaptchaManager,
  isCaptchaError,
} from "../../src/lib/zcode/captcha-service.js";
import {
  buildZcodeCodingPlanHeaders,
  applyZcodeCodingPlanHeaders,
} from "../../src/lib/zcode/headers.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

describe("ZCode Captcha Integration & Retry Handling", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("identifies captcha errors properly with isCaptchaError", async () => {
    const errorResponse1 = new Response("Aliyun verification required: please solve captcha", {
      status: 403,
      statusText: "Forbidden",
    });
    expect(await isCaptchaError(errorResponse1)).toBe(true);

    const errorResponse2 = new Response("verify token invalid or expired", {
      status: 403,
      statusText: "Forbidden",
    });
    expect(await isCaptchaError(errorResponse2)).toBe(true);

    const normalResponse = new Response(JSON.stringify({ content: "Hello world" }), {
      status: 200,
    });
    expect(await isCaptchaError(normalResponse)).toBe(false);

    const otherError = new Response("Internal Server Error", {
      status: 500,
    });
    expect(await isCaptchaError(otherError)).toBe(false);
  });

  it("attaches verifyParam to request headers when available", () => {
    const credentials = {
      accessToken: "zcode-jwt-12345",
      providerSpecificData: {
        _captchaVerifyParam: "sample-verify-token-xyz",
      },
    };

    const headers = buildZcodeCodingPlanHeaders(credentials);
    expect(headers["X-Aliyun-Captcha-Verify-Param"]).toBe("sample-verify-token-xyz");
    expect(headers["X-Aliyun-Captcha-Verify-Region"]).toBe("sgp");
    expect(headers["Authorization"]).toBe("Bearer zcode-jwt-12345");

    const appliedHeaders = {};
    applyZcodeCodingPlanHeaders(appliedHeaders, credentials);
    expect(appliedHeaders["X-Aliyun-Captcha-Verify-Param"]).toBe("sample-verify-token-xyz");
    expect(appliedHeaders["X-Aliyun-Captcha-Verify-Region"]).toBe("sgp");
  });

  it("solves captcha BEFORE the first upstream attempt and attaches verifyParam", async () => {
    const executor = getExecutor("zcode");
    const manager = getCaptchaManager();

    const getVerifyParamSpy = vi
      .spyOn(manager, "getVerifyParam")
      .mockResolvedValue("solved-param-token");

    let callCount = 0;
    const executedParams = [];
    vi.spyOn(DefaultExecutor.prototype, "execute").mockImplementation(async (params) => {
      callCount++;
      executedParams.push(JSON.parse(JSON.stringify(params)));
      return {
        response: new Response(JSON.stringify({ choices: [{ message: { content: "Success" } }] }), {
          status: 200,
        }),
      };
    });

    const result = await executor.execute({
      credentials: {
        accessToken: "test-jwt",
        providerSpecificData: {},
      },
      model: "glm-5.3",
    });

    // Single attempt, success: getVerifyParam called exactly once, before the upstream call
    expect(callCount).toBe(1);
    expect(getVerifyParamSpy).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(200);

    // First (and only) upstream attempt carries the captcha verify param
    expect(executedParams[0]?.credentials?.providerSpecificData?._captchaVerifyParam).toBe(
      "solved-param-token"
    );
  });

  it("proceeds fail-open when captcha solve throws before first attempt", async () => {
    const executor = getExecutor("zcode");
    const manager = getCaptchaManager();

    const getVerifyParamSpy = vi
      .spyOn(manager, "getVerifyParam")
      .mockRejectedValue(new Error("CloakBrowser not running"));

    let callCount = 0;
    const executedParams = [];
    vi.spyOn(DefaultExecutor.prototype, "execute").mockImplementation(async (params) => {
      callCount++;
      executedParams.push(JSON.parse(JSON.stringify(params)));
      return {
        response: new Response(JSON.stringify({ choices: [{ message: { content: "Success" } }] }), {
          status: 200,
        }),
      };
    });

    const result = await executor.execute({
      credentials: {
        accessToken: "test-jwt",
        providerSpecificData: {},
      },
      model: "glm-5.3",
    });

    // Solve failed but plain request still goes out without the param
    expect(callCount).toBe(1);
    expect(getVerifyParamSpy).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(200);
    expect(executedParams[0]?.credentials?.providerSpecificData?._captchaVerifyParam).toBeUndefined();
  });

  it("retries upon 403 captcha error and uses solved verifyParam", async () => {
    const executor = getExecutor("zcode");
    const manager = getCaptchaManager();

    // Mock getVerifyParam to supply a valid param
    const getVerifyParamSpy = vi
      .spyOn(manager, "getVerifyParam")
      .mockResolvedValue("solved-param-token");

    const invalidateSpy = vi.spyOn(manager, "invalidate");

    let callCount = 0;
    const executedParams = [];
    vi.spyOn(DefaultExecutor.prototype, "execute").mockImplementation(async (params) => {
      callCount++;
      executedParams.push(JSON.parse(JSON.stringify(params)));
      if (callCount === 1) {
        return {
          response: new Response("Aliyun captcha required", { status: 403 }),
        };
      }
      return {
        response: new Response(JSON.stringify({ choices: [{ message: { content: "Success" } }] }), {
          status: 200,
        }),
      };
    });

    const result = await executor.execute({
      credentials: {
        accessToken: "test-jwt",
        providerSpecificData: {},
      },
      model: "glm-5.3",
    });

    expect(callCount).toBe(2);
    expect(invalidateSpy).toHaveBeenCalled();
    expect(getVerifyParamSpy).toHaveBeenCalled();
    expect(result.response.status).toBe(200);

    // Verify retried call actually contains _captchaVerifyParam set to solved token
    expect(executedParams[1]?.credentials?.providerSpecificData?._captchaVerifyParam).toBe(
      "solved-param-token"
    );
  });

  it("stops retrying after MAX_CAPTCHA_RETRIES if upstream repeatedly fails with captcha", async () => {
    const executor = getExecutor("zcode");
    const manager = getCaptchaManager();

    vi.spyOn(manager, "getVerifyParam").mockResolvedValue("mock-param");
    vi.spyOn(manager, "invalidate");

    let callCount = 0;
    vi.spyOn(DefaultExecutor.prototype, "execute").mockImplementation(async () => {
      callCount++;
      return {
        response: new Response("Aliyun captcha verification needed", { status: 403 }),
      };
    });

    const result = await executor.execute({
      credentials: {
        accessToken: "test-jwt",
      },
      model: "glm-5.3",
    });

    expect(callCount).toBe(2); // MAX_CAPTCHA_RETRIES = 2
    expect(result.response.status).toBe(403);
  });

  it("handles captcha config route correctly", async () => {
    const manager = getCaptchaManager();
    vi.spyOn(manager, "fetchCaptchaConfig").mockResolvedValue({
      enabled: true,
      prefix: "test-prefix",
      region: "sgp",
      sceneId: "test-scene",
    });

    const { GET } = await import("../../src/app/api/zcode/captcha/config/route.js");
    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.enabled).toBe(true);
    expect(data.prefix).toBe("test-prefix");
    expect(data.sceneId).toBe("test-scene");
  });

  it("handles captcha submit route correctly", async () => {
    const manager = getCaptchaManager();
    const submitSpy = vi.spyOn(manager, "submit").mockImplementation(() => {});

    const { POST } = await import("../../src/app/api/zcode/captcha/submit/route.js");
    const req = new Request("http://localhost:20128/api/zcode/captcha/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verifyParam: "token-12345" }),
    });

    const response = await POST(req);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(submitSpy).toHaveBeenCalledWith("token-12345");
  });

  it("rejects relay proxies (Vercel/Cloudflare/Deno) with an informative error", async () => {
    const executor = getExecutor("zcode");

    await expect(
      executor.execute({
        credentials: { accessToken: "jwt-123" },
        model: "glm-5.3",
        proxyOptions: { vercelRelayUrl: "https://my-relay.vercel.app" },
      })
    ).rejects.toThrow("relay-based proxies");
  });

  it("passes standard forward proxy to captchaManager.getVerifyParam", async () => {
    const executor = getExecutor("zcode");
    const manager = getCaptchaManager();

    const getVerifyParamSpy = vi
      .spyOn(manager, "getVerifyParam")
      .mockResolvedValue("solved-via-proxy");

    vi.spyOn(DefaultExecutor.prototype, "execute").mockResolvedValue({
      response: new Response(JSON.stringify({ ok: true }), { status: 200 }),
    });

    await executor.execute({
      credentials: {
        accessToken: "jwt-123",
        providerSpecificData: {
          connectionProxyEnabled: true,
          connectionProxyUrl: "http://127.0.0.1:7890",
        },
      },
      model: "glm-5.3",
      proxyOptions: {
        connectionProxyEnabled: true,
        connectionProxyUrl: "http://127.0.0.1:7890",
      },
    });

    expect(getVerifyParamSpy).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ proxy: "http://127.0.0.1:7890" })
    );
  });
});
