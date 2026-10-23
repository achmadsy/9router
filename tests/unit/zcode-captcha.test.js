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
import {
  buildZcodeClientConfigUrl,
  resolveZcodeClientConfigPlatform,
} from "../../src/lib/zcode/config.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

describe("GLM Coding captcha integration (lazy)", () => {
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

    const code3007 = new Response(JSON.stringify({ error: { code: 3007, message: "captcha" } }), {
      status: 400,
    });
    expect(await isCaptchaError(code3007)).toBe(true);

    const normalResponse = new Response(JSON.stringify({ content: "Hello world" }), {
      status: 200,
    });
    expect(await isCaptchaError(normalResponse)).toBe(false);

    const otherError = new Response("Internal Server Error", {
      status: 500,
    });
    expect(await isCaptchaError(otherError)).toBe(false);
  });

  it("attaches verifyParam on coding-plan headers", () => {
    const credentials = {
      zcodeJwtToken: "zcode-jwt-12345",
      providerSpecificData: {
        zcodeJwtToken: "zcode-jwt-12345",
        _captchaVerifyParam: "sample-verify-token-xyz",
      },
    };

    const headers = buildZcodeCodingPlanHeaders(credentials);
    expect(headers["X-Aliyun-Captcha-Verify-Param"]).toBe("sample-verify-token-xyz");
    expect(headers["X-Aliyun-Captcha-Verify-Region"]).toBe("sgp");
    expect(headers.Authorization).toBe("Bearer zcode-jwt-12345");

    const appliedHeaders = {};
    applyZcodeCodingPlanHeaders(appliedHeaders, credentials);
    expect(appliedHeaders["X-Aliyun-Captcha-Verify-Param"]).toBe("sample-verify-token-xyz");
    expect(appliedHeaders["X-Aliyun-Captcha-Verify-Region"]).toBe("sgp");
  });

  it("does not solve captcha on clean 200 responses", async () => {
    const executor = getExecutor("glm");
    const manager = getCaptchaManager();
    const getVerifyParamSpy = vi.spyOn(manager, "getVerifyParam");

    vi.spyOn(DefaultExecutor.prototype, "execute").mockResolvedValue({
      response: new Response(JSON.stringify({ choices: [{ message: { content: "Success" } }] }), {
        status: 200,
      }),
    });

    const result = await executor.execute({
      credentials: {
        accessToken: "test-jwt",
        providerSpecificData: { zcodeJwtToken: "test-jwt", useCodingPlan: true },
      },
      model: "glm-5.2",
    });

    expect(result.response.status).toBe(200);
    expect(getVerifyParamSpy).not.toHaveBeenCalled();
  });

  it("retries upon 403 captcha error and uses solved verifyParam", async () => {
    const executor = getExecutor("glm");
    const manager = getCaptchaManager();

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
        providerSpecificData: { zcodeJwtToken: "test-jwt", useCodingPlan: true },
      },
      model: "glm-5.2",
    });

    expect(callCount).toBe(2);
    expect(invalidateSpy).toHaveBeenCalled();
    expect(getVerifyParamSpy).toHaveBeenCalled();
    expect(result.response.status).toBe(200);
    expect(executedParams[1]?.credentials?.providerSpecificData?._captchaVerifyParam).toBe(
      "solved-param-token"
    );
  });

  it("stops retrying after MAX_CAPTCHA_RETRIES if upstream repeatedly fails with captcha", async () => {
    const executor = getExecutor("glm");
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

    await expect(
      executor.execute({
        credentials: {
          accessToken: "test-jwt",
          providerSpecificData: { zcodeJwtToken: "test-jwt", useCodingPlan: true },
        },
        model: "glm-5.2",
      })
    ).rejects.toThrow(/Captcha expired multiple times/);

    // initial + MAX_CAPTCHA_RETRIES retries
    expect(callCount).toBe(4);
  });

  it("matches the 3.16.3 client config URL and platform key", () => {
    expect(resolveZcodeClientConfigPlatform("linux", "x64")).toBe("linux-x86_64");
    expect(resolveZcodeClientConfigPlatform("darwin", "arm64")).toBe("darwin-aarch64");
    expect(resolveZcodeClientConfigPlatform("win32", "x64")).toBe("windows-x86_64");

    const url = new URL(buildZcodeClientConfigUrl());
    expect(url.origin).toBe("https://zcode.z.ai");
    expect(url.pathname).toBe("/api/v1/client/configs");
    expect(url.searchParams.get("app_version")).toBe("3.16.3");
    expect(url.searchParams.get("platform")).toBe(
      resolveZcodeClientConfigPlatform()
    );
  });

  it("fetches captcha config from the configured 3.16.3 client URL", async () => {
    const manager = getCaptchaManager();
    manager.captchaConfigCache = null;
    manager.captchaConfigCacheTime = 0;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          configs: {
            captcha: {
              enabled: true,
              prefix: "remote-prefix",
              region: "sgp",
              sceneId: "remote-scene",
            },
          },
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await manager.fetchCaptchaConfig();

    expect(fetchMock).toHaveBeenCalledWith(
      buildZcodeClientConfigUrl(),
      expect.objectContaining({
        method: "GET",
        credentials: "omit",
        redirect: "error",
        headers: expect.objectContaining({
          "HTTP-Referer": "https://zcode.z.ai",
          "User-Agent": "ZCode/3.16.3",
          "X-ZCode-App-Version": "3.16.3",
        }),
      })
    );
    expect(fetchMock.mock.calls[0][1].headers["x-request-id"]).toBeTruthy();
    expect(result.sceneId).toBe("remote-scene");
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

  it("solves captcha after Start Plan 403 and retains coding-plan JWT path", async () => {
    const executor = getExecutor("glm");
    const manager = getCaptchaManager();
    const getVerifyParamSpy = vi
      .spyOn(manager, "getVerifyParam")
      .mockResolvedValue("solved-param-token");

    let callCount = 0;
    vi.spyOn(DefaultExecutor.prototype, "execute").mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { response: new Response("captcha verify failed", { status: 400 }) };
      }
      return { response: new Response(JSON.stringify({ ok: true }), { status: 200 }) };
    });

    const result = await executor.execute({
      credentials: {
        accessToken: "raw-zcode-jwt",
        providerSpecificData: {
          zcodeJwtToken: "raw-zcode-jwt",
          useCodingPlan: true,
          zaiAccessToken: "zai-account-token",
        },
      },
      model: "glm-5.3",
    });

    expect(result.response.status).toBe(200);
    expect(callCount).toBe(2);
    expect(getVerifyParamSpy).toHaveBeenCalled();
  });

  it("forwards normal proxy from credentials onto captcha manager", async () => {
    const executor = getExecutor("glm");
    const manager = getCaptchaManager();
    const setProxySpy = vi.spyOn(manager, "setProxy").mockImplementation(() => {});

    vi.spyOn(manager, "getVerifyParam").mockResolvedValue("solved-via-proxy");
    let callCount = 0;
    vi.spyOn(DefaultExecutor.prototype, "execute").mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { response: new Response("Aliyun captcha required", { status: 403 }) };
      }
      return { response: new Response(JSON.stringify({ ok: true }), { status: 200 }) };
    });

    const result = await executor.execute({
      credentials: {
        accessToken: "jwt-123",
        providerSpecificData: {
          zcodeJwtToken: "jwt-123",
          useCodingPlan: true,
          connectionProxyEnabled: true,
          connectionProxyUrl: "http://127.0.0.1:7890",
        },
      },
      model: "glm-5.2",
    });

    expect(result.response.status).toBe(200);
    expect(setProxySpy).toHaveBeenCalledWith("http://127.0.0.1:7890");
  });
});
