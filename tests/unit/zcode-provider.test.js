import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { getExecutor } from "../../open-sse/executors/index.js";
import { getModelUpstreamId, getProviderModels } from "../../open-sse/config/providerModels.js";
import { getZcodeUsage } from "../../open-sse/services/usage/zcode.js";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import zcodeOAuth from "../../src/lib/oauth/providers/zcode.js";
import {
  exchangeTokens as exchangeOAuthTokens,
  generateAuthData,
  pollForToken,
} from "../../src/lib/oauth/providers/index.js";
import { ZcodeAuthService } from "../../src/lib/oauth/services/zcode.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ZCode Provider Integration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    proxyAwareFetch.mockReset();
  });

  it("registers Start Plan models", () => {
    const models = getProviderModels("zcode");
    expect(models.length).toBeGreaterThan(0);
    expect(models.map((model) => model.id)).toContain("glm-5.3");
    expect(models.map((model) => model.id)).toContain("glm-5.2");
    expect(models.map((model) => model.id)).toContain("glm-5-turbo");
    expect(getModelUpstreamId("zcode", "glm-5.3")).toBe("GLM-5.3");
  });

  it("uses Start Plan Anthropic URL and unsigned bearer headers", () => {
    const executor = getExecutor("zcode");
    const credentials = {
      accessToken: "test-zcode-jwt",
      providerSpecificData: { sessionId: "sess_session-123" },
    };
    const headers = executor.buildHeaders(credentials);

    expect(executor.config.format).toBe("claude");
    expect(executor.buildUrl("glm-5.3", true, 0, credentials)).toBe(
      "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages",
    );
    expect(headers.Authorization).toBe("Bearer test-zcode-jwt");
    expect(headers["User-Agent"]).toBe("ZCode/3.11.2");
    expect(headers["X-ZCode-App-Version"]).toBe("3.11.2");
    expect(headers["X-ZCode-Agent"]).toBe("glm");
    expect(headers["X-Session-Id"]).toBeUndefined();
    expect(headers["x-request-id"]).toBeTruthy();
    expect(headers["x-zcode-trace-id"]).toBeTruthy();
    expect(headers["x-zcode-session-type"]).toBe("other");
    expect(headers["x-query-id"]).toBeTruthy();
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["X-Client-Sig"]).toBeUndefined();
  });

  it("normalizes model IDs and injects idempotent Anthropic system blocks", () => {
    const executor = getExecutor("zcode");
    const input = {
      model: "zcode/builtin:zai-start-plan/GLM-5.3",
      system: [{ type: "text", text: "Preserve this instruction" }],
      messages: [{ role: "user", content: "hello" }],
    };
    const credentials = {
      providerSpecificData: { sessionId: "sess_session-123" },
    };
    const transformed = executor.transformRequest(input.model, input, true, credentials);
    const reinjected = executor.transformRequest(
      transformed.model,
      transformed,
      true,
      credentials,
    );
    const nonStreaming = executor.transformRequest(
      input.model,
      { ...input, stream: false },
      false,
      credentials,
    );
    const streaming = executor.transformRequest(
      input.model,
      { ...input, stream: true },
      true,
      credentials,
    );

    expect(transformed.model).toBe("GLM-5.3");
    for (const request of [nonStreaming, streaming]) {
      expect(request.model).toBe("GLM-5.3");
      expect(request.provider).toBeUndefined();
      expect(request.provider_code).toBeUndefined();
      const metadataUser = JSON.parse(request.metadata.user_id);
      expect(metadataUser).toMatchObject({
        account_uuid: "",
        session_id: "session-123",
      });
      expect(metadataUser.device_id).toBeTruthy();
      expect(metadataUser.device_id).toBe(
        executor.buildHeaders(credentials)["X-Device-Mid"],
      );
    }
    expect(transformed.system[0].text).toContain("You are ZCode, an interactive coding agent");
    expect(transformed.system[2].text).toContain("builtin:zai-start-plan/GLM-5.3");
    expect(transformed.system).toContainEqual({ type: "text", text: "Preserve this instruction" });
    expect(
      reinjected.system.filter((block) =>
        String(block.text).includes("You are ZCode, an interactive coding agent"),
      ),
    ).toHaveLength(1);
  });

  it("parses quota, busy, and captcha errors", () => {
    const executor = getExecutor("zcode");
    const quota = executor.parseError(
      { status: 429 },
      JSON.stringify({ code: "1113", message: "quota exceeded" }),
    );
    const busy = executor.parseError(
      { status: 429 },
      JSON.stringify({ code: "3008", message: "busy" }),
    );
    const captcha = executor.parseError(
      { status: 403 },
      JSON.stringify({ message: "verify token required" }),
    );

    expect(quota.message).toContain("quota exhausted");
    expect(busy.message).toContain("Start Plan is busy");
    expect(captcha.message).toContain("verification/captcha");
  });

  it("uses authoritative init metadata and maps complete ready payload", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: {
          flow_id: "flow-authoritative",
          poll_token: "server-poll-token",
          authorize_url: "https://chat.z.ai/oauth?state=state-authoritative",
          poll_interval_sec: 4,
          expires_at: Math.floor(Date.now() / 1000) + 300,
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: {
          status: "ready",
          token: "raw-zcode-jwt",
          zai: { access_token: "zai-account-token" },
          user: { user_id: "user-123", email: "user@example.com", name: "User" },
        },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const service = new ZcodeAuthService();
    const init = await service.initFlow();
    const ready = await service.pollFlow(init.flowId);

    expect(init).toMatchObject({
      flowId: "flow-authoritative",
      state: "state-authoritative",
      pollInterval: 4,
    });
    const authorizeUrl = new URL(init.authorizeUrl);
    expect(authorizeUrl.origin).toBe("https://chat.z.ai");
    expect(authorizeUrl.searchParams.get("state")).toBe("state-authoritative");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
      "https://zcode.z.ai/app/oauth/login?redirect=zcode%3A%2F%2Foauth%2Fcallback&app_version=3.11.2",
    );
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toMatch(/^Bearer [a-f0-9]{64}$/);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).not.toBe("Bearer server-poll-token");
    expect(fetchMock.mock.calls[1][1].headers["X-ZCode-Agent"]).toBeUndefined();
    expect(fetchMock.mock.calls[1][1].headers["x-request-id"]).toBeTruthy();
    expect(ready).toMatchObject({
      status: "ready",
      tokens: {
        accessToken: "raw-zcode-jwt",
        zaiAccessToken: "zai-account-token",
        providerSpecificData: {
          useStartPlan: true,
          zcodeJwtToken: "raw-zcode-jwt",
          zcodeUserId: "user-123",
        },
      },
    });
  });

  it("completes explicit provider polling with the official flow ID", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: {
          flow_id: "flow-explicit",
          authorize_url: "https://chat.z.ai/oauth?state=state-explicit",
          expires_at: Math.floor(Date.now() / 1000) + 300,
          poll_interval_sec: 2,
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: {
          status: "ready",
          token: "explicit-zcode-jwt",
          zai: { access_token: "explicit-zai-token" },
          user: { user_id: "explicit-user", email: "explicit@example.com" },
        },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const authData = await generateAuthData("zcode", "http://localhost:20128/callback");
    const result = await pollForToken("zcode", authData.flowId);

    expect(authData).toMatchObject({
      flowId: "flow-explicit",
      expiresIn: expect.any(Number),
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://zcode.z.ai/api/v1/oauth/cli/init",
      "https://zcode.z.ai/api/v1/oauth/cli/poll/flow-explicit",
    ]);
    expect(result).toMatchObject({
      success: true,
      tokens: {
        accessToken: "explicit-zcode-jwt",
        email: "explicit@example.com",
        providerSpecificData: {
          zcodeJwtToken: "explicit-zcode-jwt",
          zaiAccessToken: "explicit-zai-token",
          zaiUserId: "explicit-user",
          flowId: "flow-explicit",
        },
      },
    });
  });

  it("reports explicit provider polling as pending without exchanging callback code", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: {
          flow_id: "flow-pending-explicit",
          authorize_url: "https://chat.z.ai/oauth?state=state-pending-explicit",
          expires_at: Math.floor(Date.now() / 1000) + 300,
          poll_interval_sec: 3,
        },
      }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { status: "pending" } }));
    vi.stubGlobal("fetch", fetchMock);

    const authData = await generateAuthData("zcode", "http://localhost:20128/callback");
    const result = await pollForToken("zcode", authData.flowId);

    expect(result).toEqual({
      success: false,
      error: "authorization_pending",
      errorDescription: "Authorization is not ready yet",
      pending: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).not.toBe("https://zcode.z.ai/api/v1/oauth/token");
  });

  it("maps failed and expired explicit polling states without creating tokens", async () => {
    const failedFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: {
          flow_id: "flow-failed-explicit",
          authorize_url: "https://chat.z.ai/oauth?state=state-failed-explicit",
          expires_at: Math.floor(Date.now() / 1000) + 300,
          poll_interval_sec: 2,
        },
      }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { status: "failed" } }));
    vi.stubGlobal("fetch", failedFetch);

    const failedAuth = await generateAuthData("zcode", "http://localhost:20128/callback");
    await expect(pollForToken("zcode", failedAuth.flowId)).resolves.toEqual({
      success: false,
      error: "access_denied",
      errorDescription: "Authorization denied",
    });

    const service = new ZcodeAuthService();
    await expect(service.pollFlow("missing-or-expired-flow")).resolves.toEqual({
      status: "expired",
      error: "OAuth session expired or not found",
    });
    const provider = zcodeOAuth;
    const expired = await provider.pollToken(provider.config, "missing-or-expired-flow");
    expect(expired).toEqual({
      ok: false,
      data: {
        error: "expired_token",
        error_description: "OAuth session expired or not found",
      },
    });
  });

  it("exchanges manual callback using stored native state and desktop bridge", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 300;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: {
          flow_id: "flow-manual",
          authorize_url: "https://chat.z.ai/oauth?state=state-manual&redirect_uri=old",
          expires_at: expiresAt,
          poll_interval_sec: 2,
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: {
          token: "raw-zcode-jwt",
          zai: { access_token: "zai-account-token" },
          expires_in: 3600,
          user: { user_id: "user-manual", email: "manual@example.com", name: "Manual" },
        },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const service = new ZcodeAuthService();
    await service.initFlow();
    const ready = await service.exchangeCallback(
      "zcode://oauth/callback?authCode=callback-code&state=state-manual&redirect_uri=https%3A%2F%2Fevil.example",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("https://zcode.z.ai/api/v1/oauth/token");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      provider: "zai",
      code: "callback-code",
      redirect_uri:
        "https://zcode.z.ai/app/oauth/login?redirect=zcode%3A%2F%2Foauth%2Fcallback&app_version=3.11.2",
      state: "state-manual",
    });
    expect(ready).toMatchObject({
      status: "ready",
      tokens: {
        accessToken: "raw-zcode-jwt",
        zaiAccessToken: "zai-account-token",
        expiresIn: 3600,
        providerSpecificData: {
          zcodeUserId: "user-manual",
          flowId: "flow-manual",
        },
      },
    });
  });

  it("reports bounded upstream exchange details without exposing OAuth secrets", async () => {
    const callbackCode = "code-sensitive-callback-value";
    const state = "sensitive-state-value-123456";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: {
          flow_id: "flow-error",
          authorize_url: `https://chat.z.ai/oauth?state=${state}`,
          expires_at: Math.floor(Date.now() / 1000) + 300,
          poll_interval_sec: 2,
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        code: 5007,
        msg: `exchange rejected code ${callbackCode}, state ${state}`,
        data: null,
      }, 500));
    vi.stubGlobal("fetch", fetchMock);

    const service = new ZcodeAuthService();
    await service.initFlow();

    let error;
    try {
      await service.exchangeCallback(
        `https://zcode.z.ai/app/oauth/login?code=${callbackCode}&state=${state}`,
      );
    } catch (caught) {
      error = caught;
    }

    expect(error?.message).toContain("ZCode auth exchange: HTTP 500; upstream code 5007");
    expect(error?.message).toContain("[REDACTED]");
    expect(error?.message).not.toContain(callbackCode);
    expect(error?.message).not.toContain(state);
    expect(fetchMock.mock.calls[1][1].headers).toMatchObject({
      "Content-Type": "application/json",
      "User-Agent": "ZCode/3.11.2",
      "X-ZCode-App-Version": "3.11.2",
      "X-Title": "Z Code@electron",
      "HTTP-Referer": "https://zcode.z.ai",
      "X-Platform": `${process.platform}-${process.arch}`,
      "X-Release-Channel": "stable",
      "X-Os-Category": process.platform === "darwin"
        ? "macos"
        : process.platform === "win32"
          ? "windows"
          : "linux",
    });
    expect(fetchMock.mock.calls[1][1].headers["X-Client-Language"]).toBeTruthy();
    expect(fetchMock.mock.calls[1][1].headers["X-Client-Timezone"]).toBeTruthy();
    expect(fetchMock.mock.calls[1][1].headers["X-Os-Version"]).toBeTruthy();
    expect(fetchMock.mock.calls[1][1].headers["X-Device-Mid"]).toBeTruthy();
    expect(fetchMock.mock.calls[1][1].headers["x-request-id"]).toBeTruthy();
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBeUndefined();
    expect(fetchMock.mock.calls[1][1].headers["X-ZCode-Agent"]).toBeUndefined();
    expect(fetchMock.mock.calls[1][1].headers["anthropic-version"]).toBeUndefined();
  });

  it("initializes once across provider authorize and exchange", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: {
          flow_id: "flow-provider",
          authorize_url: "https://chat.z.ai/oauth?state=state-provider",
          expires_at: Math.floor(Date.now() / 1000) + 300,
          poll_interval_sec: 2,
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: {
          token: "provider-zcode-jwt",
          zai: { access_token: "provider-zai-token" },
          user: { user_id: "provider-user", email: "provider@example.com" },
        },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const authData = await generateAuthData(
      "zcode",
      "http://localhost:20128/callback",
    );
    const mapped = await exchangeOAuthTokens(
      "zcode",
      "zcode://oauth/callback?code=provider-code&state=state-provider",
      authData.redirectUri,
      null,
      authData.state,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://zcode.z.ai/api/v1/oauth/cli/init",
      "https://zcode.z.ai/api/v1/oauth/token",
    ]);
    expect(authData).toMatchObject({
      flowType: "authorization_code",
      state: "state-provider",
    });
    expect(mapped.accessToken).toBe("provider-zcode-jwt");
  });

  it("rejects callbacks without a matching pending state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({
      code: 0,
      data: {
        flow_id: "flow-state-check",
        authorize_url: "https://chat.z.ai/oauth?state=expected-state",
        expires_at: Math.floor(Date.now() / 1000) + 300,
        poll_interval_sec: 2,
      },
    })));

    const service = new ZcodeAuthService();
    await service.initFlow();
    await expect(
      service.exchangeCallback("zcode:/oauth/callback?code=test-code&state=wrong-state"),
    ).rejects.toThrow("session not found");
  });

  it("rejects non-numeric success code and incomplete ready payload", async () => {
    const invalidEnvelopeFetch = vi.fn().mockResolvedValue(jsonResponse({ code: "0", data: {} }));
    vi.stubGlobal("fetch", invalidEnvelopeFetch);
    await expect(new ZcodeAuthService().initFlow()).rejects.toThrow("business error 0");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: {
          flow_id: "flow-incomplete",
          poll_token: "poll-token",
          authorize_url: "https://chat.z.ai/oauth?state=state-authoritative",
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: { status: "ready", token: "raw-zcode-jwt", user: { user_id: "user-123" } },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const service = new ZcodeAuthService();
    const init = await service.initFlow();
    await expect(service.pollFlow(init.flowId)).resolves.toMatchObject({
      status: "failed",
      error: expect.stringContaining("zai.access_token"),
    });
  });

  it("keeps OAuth polling pending on transient upstream failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: {
          flow_id: "flow-transient",
          poll_token: "poll-token",
          authorize_url: "https://chat.z.ai/oauth?state=state-authoritative",
          poll_interval_sec: 3,
        },
      }))
      .mockResolvedValueOnce(jsonResponse({ message: "busy" }, 503));
    vi.stubGlobal("fetch", fetchMock);

    const service = new ZcodeAuthService();
    const init = await service.initFlow();
    await expect(service.pollFlow(init.flowId)).resolves.toEqual({
      status: "pending",
      retryAfter: 3,
    });
  });

  it("maps raw ZCode JWT for Start Plan inference", () => {
    const mapped = zcodeOAuth.mapTokens({
      access_token: "jwt-token-abc",
      _zaiAccessToken: "zai-account-token",
      _zcodeEmail: "user@example.com",
      _zcodeDisplayName: "ZCode User",
      _zcodeJwtToken: "jwt-token-abc",
      _zcodeUserId: "user-123",
      _zcodeFlowId: "flow-123",
    });

    expect(mapped.accessToken).toBe("jwt-token-abc");
    expect(mapped.apiKey).toBeUndefined();
    expect(mapped.providerSpecificData).toMatchObject({
      authMethod: "zcode_oauth",
      useStartPlan: true,
      zcodeJwtToken: "jwt-token-abc",
      zaiAccessToken: "zai-account-token",
      zaiUserId: "user-123",
      flowId: "flow-123",
    });
  });

  it("matches official balance request and parses only returned quota values", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      code: 0,
      data: {
        plan_name: "Start Plan",
        balances: [{
          model: "GLM-5.3",
          package_name: "Daily",
          total: 1000,
          used: 250,
          remaining: 750,
          reset_at: "2026-09-09T16:00:00Z",
        }],
      },
    }));

    const usage = await getZcodeUsage({
      accessToken: "jwt-token",
      providerSpecificData: { zcodeJwtToken: "jwt-token", sessionId: "session-id" },
    });

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(proxyAwareFetch).toHaveBeenCalledWith(
      "https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=3.11.2",
      {
        method: "GET",
        headers: { Authorization: "Bearer jwt-token" },
        signal: expect.any(AbortSignal),
      },
      null,
    );
    expect(proxyAwareFetch.mock.calls[0][1]).not.toHaveProperty("body");
    expect(proxyAwareFetch.mock.calls[0][1].headers).toEqual({
      Authorization: "Bearer jwt-token",
    });
    expect(usage.plan).toBe("Start Plan");
    expect(Object.values(usage.quotas)).toEqual([
      expect.objectContaining({
        used: 250,
        total: 1000,
        remaining: 750,
        remainingPercentage: 75,
        packageName: "Daily",
      }),
    ]);
  });

  it("never fabricates 100% quota when balance has no usage", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      code: 0,
      data: { plan_name: "Start Plan" },
    }));

    const empty = await getZcodeUsage({ accessToken: "jwt-token" });
    expect(empty.quotas).toEqual({});
    expect(empty.message).toContain("not available");
    expect(JSON.stringify(empty)).not.toContain('"remainingPercentage":100');
  });

  it("reports re-login for a 401 from balance", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ message: "unauthorized" }, 401));

    await expect(getZcodeUsage({ accessToken: "expired" })).resolves.toMatchObject({
      message: expect.stringContaining("re-login"),
    });
  });

  it("rejects malformed balance payloads without synthetic quotas", async () => {
    proxyAwareFetch.mockResolvedValueOnce(new Response("not-json", { status: 200 }));

    const usage = await getZcodeUsage({ accessToken: "jwt-token" });
    expect(usage.quotas).toEqual({});
    expect(usage.message).toContain("not available");
  });
});
