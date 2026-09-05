import { describe, it, expect, vi, beforeEach } from "vitest";
import { getExecutor } from "../../open-sse/executors/index.js";
import { getModelUpstreamId, getProviderModels } from "../../open-sse/config/providerModels.js";
import { getZcodeUsage } from "../../open-sse/services/usage/zcode.js";
import zcodeOAuth from "../../src/lib/oauth/providers/zcode.js";

describe("ZCode Provider Integration", () => {
  it("registers models in providerModels catalog", () => {
    const models = getProviderModels("zcode");
    expect(models.length).toBeGreaterThan(0);
    expect(models.map(m => m.id)).toContain("glm-5.3");
    expect(models.map(m => m.id)).toContain("glm-5.2");
    expect(models.map(m => m.id)).toContain("glm-5-turbo");
    expect(getModelUpstreamId("zcode", "glm-5.3")).toBe("GLM-5.3");
    expect(getModelUpstreamId("zcode", "glm-5.2")).toBe("GLM-5.2");
    expect(getModelUpstreamId("zcode", "glm-5-turbo")).toBe("GLM-5-Turbo");
  });

  it("retrieves ZcodeExecutor with subscription Bearer auth and custom headers", () => {
    const executor = getExecutor("zcode");
    expect(executor).toBeDefined();

    const headers = executor.buildHeaders({
      accessToken: "test-zcode-jwt",
      providerSpecificData: { sessionId: "sess-123" },
    });

    expect(headers["Authorization"]).toBe("Bearer test-zcode-jwt");
    expect(headers["User-Agent"]).toBe("ZCode/3.11.2");
    expect(headers["X-ZCode-Agent"]).toBe("glm");
    expect(headers["x-session-id"]).toBe("sess-123");
    expect(headers["x-api-key"]).toBeUndefined();
  });

  it("transforms request model correctly", () => {
    const executor = getExecutor("zcode");
    const transformed = executor.transformRequest("glm-5.2", { model: "glm-5.2", messages: [] });
    expect(transformed.model).toBe("GLM-5.2");
  });

  it("parses quota and captcha errors informatively", () => {
    const executor = getExecutor("zcode");
    const quotaErr = executor.parseError({ status: 429 }, JSON.stringify({ code: "1113", message: "quota exceeded" }));
    expect(quotaErr.status).toBe(429);
    expect(quotaErr.message).toContain("quota exhausted");

    const captchaErr = executor.parseError({ status: 403 }, JSON.stringify({ message: "verify token required" }));
    expect(captchaErr.status).toBe(403);
    expect(captchaErr.message).toContain("verification/captcha");
  });

  it("handles usage parsing for coding plan", async () => {
    const usage = await getZcodeUsage(null);
    expect(usage.message).toContain("not available");
  });

  it("maps device code token response cleanly without creating api keys", () => {
    const mapped = zcodeOAuth.mapTokens({
      access_token: "jwt-token-abc",
      expires_in: 3600,
      _zcodeEmail: "user@example.com",
      _zcodeJwtToken: "jwt-token-abc",
      _zcodeFlowId: "flow-123",
    });

    expect(mapped.accessToken).toBe("jwt-token-abc");
    expect(mapped.email).toBe("user@example.com");
    expect(mapped.providerSpecificData.useCodingPlan).toBe(true);
    expect(mapped.providerSpecificData.authMethod).toBe("zcode_oauth");
    expect(mapped.apiKey).toBeUndefined();
  });

  it("injects zcode system prompt in transformRequest", () => {
    const executor = getExecutor("zcode");
    const transformed = executor.transformRequest("glm-5.3", {
      model: "glm-5.3",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(transformed.model).toBe("GLM-5.3");
    expect(Array.isArray(transformed.system)).toBe(true);
    expect(transformed.system[0].text).toContain("You are ZCode, an interactive coding agent");
    expect(transformed.system[2].text).toContain("builtin:zai-start-plan/GLM-5.3");
  });
});
