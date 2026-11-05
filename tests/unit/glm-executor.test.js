import { describe, it, expect, beforeEach, vi } from "vitest";
vi.mock("../../src/lib/zcode/captcha-service.js", () => ({
  getCaptchaManager: () => ({ fetchCaptchaConfig: async () => ({ enabled: false }) }),
  isCaptchaError: async () => false,
}));
import { GlmExecutor, glmRequestContext } from "../../open-sse/executors/glm.js";
import { createErrorResult, parseUpstreamError } from "../../open-sse/utils/error.js";
import { __test__ as headerTest } from "../../src/lib/zcode/headers.js";

function withGlmRequest(credentials, fn, urlIndex = 0) {
  return glmRequestContext.run({ credentials, urlIndex }, fn);
}

/** buildUrl sets urlIndex on the active ALS store (same as production execute loop). */
function atUrlIndex(executor, urlIndex, credentials, fn) {
  return withGlmRequest(credentials, () => {
    executor.buildUrl("glm-5.2", true, urlIndex, credentials);
    return fn();
  });
}

describe("GlmExecutor", () => {
  let executor;

  beforeEach(() => {
    executor = new GlmExecutor();
    headerTest.sessionIdByConnection.clear();
  });

  const codingPlanCreds = {
    apiKey: "org.key.secret",
    accessToken: "jwt-token",
    providerSpecificData: {
      useCodingPlan: true,
      zcodeJwtToken: "jwt-token",
    },
  };

  it("maps glm-5.2 model in transformRequest", () => {
    const body = executor.transformRequest("glm-5.2", { model: "glm-5.2", messages: [] });
    expect(body.model).toBe("GLM-5.2");
  });

  it("injects native device/session metadata on OAuth inference", () => {
    const credentials = { ...codingPlanCreds, _clientSessionId: "sess_conversation-1" };
    const transformed = withGlmRequest(credentials, () =>
      executor.transformRequest(
        "glm-5.2",
        { model: "glm-5.2", messages: [], metadata: { user_id: "client-value" } },
        true,
        credentials
      )
    );
    const headers = withGlmRequest(credentials, () => executor.buildHeaders(credentials));
    const metadata = JSON.parse(transformed.metadata.user_id);
    expect(metadata.device_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(metadata.account_uuid).toBe("");
    expect(metadata.session_id).toBe("conversation-1");
    expect(headers["x-session-id"]).toBe(metadata.session_id);
    expect(headers["X-Device-Mid"]).toBeUndefined();
  });

  it("uses full ZCode fingerprint on coding plan primary URL with native dual-auth", () => {
    const headers = atUrlIndex(executor, 0, codingPlanCreds, () =>
      executor.buildHeaders({
        ...codingPlanCreds,
        connectionId: "conn-1",
        providerSpecificData: {
          ...codingPlanCreds.providerSpecificData,
          _captchaVerifyParam: "captcha-token",
        },
      })
    );
    expect(headers.Authorization).toBe("Bearer jwt-token");
    expect(headers["x-api-key"]).toBe("jwt-token");
    expect(headers["User-Agent"]).toBe(
      "ZCode/3.17.2 ai-sdk/provider-utils/4.0.27 runtime/node.js/24"
    );
    expect(headers["X-ZCode-App-Version"]).toBe("3.17.2");
    expect(headers["X-ZCode-Agent"]).toBe("glm");
    expect(headers["X-Title"]).toBe("Z Code@electron");
    expect(headers["HTTP-Referer"]).toBe("https://zcode.z.ai");
    expect(headers["anthropic-beta"]).toBe("mid-conversation-system-2026-04-07");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["X-Aliyun-Captcha-Verify-Param"]).toBe("captcha-token");
    expect(headers["X-Aliyun-Captcha-Verify-Region"]).toBe("sgp");
    expect(headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(headers["x-zcode-trace-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(headers["x-query-id"]).toBeUndefined();
    expect(headers["x-session-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(headers["Anthropic-Version"]).toBeUndefined();
    expect(headers["Anthropic-Beta"]).toBeUndefined();
  });

  it("uses the login JWT as x-api-key on Start Plan even without a saved key", () => {
    const startPlanCreds = {
      accessToken: "jwt-token",
      providerSpecificData: {
        useCodingPlan: true,
        zcodeJwtToken: "jwt-token",
      },
    };
    const headers = atUrlIndex(executor, 0, startPlanCreds, () =>
      executor.buildHeaders(startPlanCreds)
    );
    expect(headers.Authorization).toBe("Bearer jwt-token");
    expect(headers["x-api-key"]).toBe("jwt-token");
    expect(headers["anthropic-beta"]).toBe("mid-conversation-system-2026-04-07");
  });

  it.each([
    ["User-Agent", "anthropic-beta", "anthropic-version"],
    ["user-agent", "Anthropic-Beta", "Anthropic-Version"],
  ])("sends case-insensitive dashboard overrides last (%s, %s, %s)", async (agentHeader, betaHeader, versionHeader) => {
    executor.fetchUpstream = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    await executor.execute({
      model: "glm-5.3", body: { model: "glm-5.3", messages: [] },
      credentials: codingPlanCreds, stream: false,
      providerOverrides: { headers: {
        [agentHeader]: "Custom-Agent/1.0",
        [betaHeader]: "custom-beta-feature",
        [versionHeader]: "custom-version",
        "X-Custom-Tracking": "custom-val-123",
      } },
    });
    expect(executor.fetchUpstream).toHaveBeenCalledTimes(1);
    const wire = new Headers(executor.fetchUpstream.mock.calls[0][1].headers);
    expect(wire.get("user-agent")).toBe("Custom-Agent/1.0");
    expect(wire.get("anthropic-beta")).toBe("custom-beta-feature");
    expect(wire.get("anthropic-version")).toBe("custom-version");
    expect(wire.get("x-custom-tracking")).toBe("custom-val-123");
    expect(wire.get("authorization")).toBe("Bearer jwt-token");
    expect(wire.get("x-api-key")).toBe("jwt-token");
  });

  it("reuses x-session-id for the same connection", () => {
    const creds = { ...codingPlanCreds, connectionId: "conn-stable" };
    const first = atUrlIndex(executor, 0, creds, () => executor.buildHeaders(creds));
    const second = atUrlIndex(executor, 0, creds, () => executor.buildHeaders(creds));
    expect(second["x-session-id"]).toBe(first["x-session-id"]);
    expect(second["x-request-id"]).not.toBe(first["x-request-id"]);
  });

  it("uses ZCode API key fingerprint on fallback URL after JWT expiry", () => {
    const headers = atUrlIndex(executor, 1, codingPlanCreds, () =>
      executor.buildHeaders({
        ...codingPlanCreds,
        providerSpecificData: {
          ...codingPlanCreds.providerSpecificData,
          _captchaVerifyParam: "captcha-token",
        },
      })
    );
    expect(headers["x-api-key"]).toBe("org.key.secret");
    expect(headers.Authorization).toBeUndefined();
    expect(headers["User-Agent"]).toBe("ZCode/3.17.2");
    expect(headers["X-ZCode-App-Version"]).toBe("3.17.2");
    expect(headers["X-ZCode-Agent"]).toBe("glm");
    expect(headers["HTTP-Referer"]).toBe("https://zcode.z.ai");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["X-Aliyun-Captcha-Verify-Param"]).toBe("captcha-token");
    expect(headers["X-Aliyun-Captcha-Verify-Region"]).toBeUndefined();
    expect(headers["Anthropic-Beta"]).toBeUndefined();
    expect(headers["x-session-id"]).toBeUndefined();
  });

  it("uses api.z.ai fallback URL without beta for API key only connections", () => {
    const apiKeyCreds = { apiKey: "org.key.secret" };
    expect(executor.buildUrl("glm-5.2", true, 0, apiKeyCreds)).toBe(
      "https://api.z.ai/api/anthropic/v1/messages"
    );
  });

  it("applies ZCode API key headers for API key only connections", () => {
    const headers = executor.buildHeaders({
      apiKey: "org.key.secret",
      providerSpecificData: { _captchaVerifyParam: "verify-abc" },
    });
    expect(headers["x-api-key"]).toBe("org.key.secret");
    expect(headers["X-Aliyun-Captcha-Verify-Param"]).toBe("verify-abc");
    expect(headers["User-Agent"]).toBe("ZCode/3.17.2");
    expect(headers["Anthropic-Beta"]).toBeUndefined();
    expect(headers["x-zcode-trace-id"]).toBeUndefined();
  });

  it("parses GLM 1113 quota errors into a readable message", () => {
    const parsed = executor.parseError(
      { status: 429 },
      JSON.stringify({
        type: "error",
        error: {
          type: "rate_limit_error",
          code: "1113",
          message: "[1113][Insufficient balance or no resource package. Please recharge.][req]",
        },
      })
    );
    expect(parsed.message).toContain("GLM quota exhausted");
    expect(parsed.message).not.toContain('{"type":"error"');
  });

  it.each([3012, "3012"])("identifies GLM activity block %s without suggesting credential or route changes", async (code) => {
    const parsed = await parseUpstreamError(new Response(JSON.stringify({
      code, msg: "request has been blocked due to unusual activity.", logid: "provider-log-canary",
    }), { status: 405, headers: { "Retry-After": "60" } }), executor);

    expect(parsed.statusCode).toBe(405);
    expect(parsed.noCooldown).toBe(true);
    expect(createErrorResult(parsed.statusCode, parsed.message, parsed).noCooldown).toBe(true);
    expect(parsed.message).toContain("Z.AI activity block (code 3012)");
    expect(parsed.message).toContain("unusual activity");
    expect(parsed.message).toContain("contact Z.AI support");
    expect(parsed.message).not.toContain("provider-log-canary");
    expect(parsed.message).not.toMatch(/reconnect|captcha|expired/i);
  });

  it("does not retry a Start Plan activity block or switch to the API-key endpoint", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 3012, msg: "request has been blocked due to unusual activity.",
    }), { status: 405 }));
    executor.fetchUpstream = fetch;
    const proxy = { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.test:3128", strictProxy: true };
    const result = await executor.execute({
      model: "glm-5.3-flash", body: { model: "glm-5.3-flash", messages: [] }, stream: true,
      credentials: codingPlanCreds, proxyOptions: proxy,
    });

    expect(result.response.status).toBe(405);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages");
    expect(fetch.mock.calls[0][2]).toEqual(proxy);
  });

  it.each(["glm-5.3", "glm-5.3-flash"])("applies final native %s effort options without a numeric budget", async (model) => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ content: [] }), { status: 200 }));
    executor.fetchUpstream = fetch;
    await executor.execute({
      model, body: { model, messages: [], thinking: { type: "enabled", budget_tokens: 16000 } },
      stream: false, credentials: codingPlanCreds,
    });

    const sent = JSON.parse(fetch.mock.calls[0][1].body);
    expect(sent.thinking).toEqual({ type: "enabled" });
    expect(sent.output_config.effort).toBe("high");
  });

  it("leaves an unrelated 405 method error unchanged", () => {
    expect(executor.parseError({ status: 405 }, JSON.stringify({ msg: "Method not allowed" })))
      .toEqual({ status: 405, message: "Method not allowed" });
  });

  it.each([3009, "3009", 3010, "3010"])("marks GLM %s concurrency errors as no-cooldown", async (code) => {
    const parsed = await parseUpstreamError(
      new Response(JSON.stringify({ code, msg: "model concurrency limit exceeded" }), {
        status: 429,
        headers: { "Retry-After": "60" },
      }),
      executor
    );
    const result = createErrorResult(parsed.statusCode, parsed.message, parsed);

    expect(parsed.message).toContain("concurrency limit exceeded");
    expect(parsed.cooldownHint).toBeTruthy();
    expect(parsed.noCooldown).toBe(true);
    expect(result.noCooldown).toBe(true);
  });

  it("marks message-only GLM concurrency errors as no-cooldown", async () => {
    const parsed = await parseUpstreamError(
      new Response(JSON.stringify({ msg: "Model Concurrency Limit exceeded" }), {
        status: 429,
      }),
      executor
    );

    expect(parsed.noCooldown).toBe(true);
  });

  it("retries with API key fallback on 401 when apiKey is present", () => {
    withGlmRequest(codingPlanCreds, () => {
      expect(executor.shouldRetry(401, 0)).toBe(false);
      expect(executor.shouldRetry(401, 1)).toBe(false);
    });
  });

  it("exposes two URL fallbacks only within request scope for coding plan + api key", () => {
    withGlmRequest(codingPlanCreds, () => {
      expect(executor.getFallbackCount()).toBe(1);
    });
    expect(executor.getFallbackCount()).toBe(1);
  });

  it("maps glm-5.2 and applies ZCode system on coding plan URL", () => {
    const body = atUrlIndex(executor, 0, codingPlanCreds, () =>
      executor.transformRequest(
        "glm-5.2",
        {
          model: "glm-5.2",
          system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }],
          messages: [{ role: "user", content: "hi" }],
        },
        false,
        codingPlanCreds
      )
    );
    expect(body.model).toBe("GLM-5.2");
    expect(JSON.stringify(body.system)).not.toContain("You are ZCode");
    expect(JSON.stringify(body.system)).toContain("Claude Code");
  });
});