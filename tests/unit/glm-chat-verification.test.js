import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), refresh: vi.fn() }));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: () => ({
  execute: mocks.execute, refreshCredentials: mocks.refresh,
  parseError: (response, body) => ({ status: response.status, message: JSON.parse(body).error.message, noCooldown: true }),
}) }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({ createRequestLogger: async () => ({
  logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(), logError: vi.fn(),
}) }));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}),
}));
import { handleChatCore } from "../../open-sse/handlers/chatCore.js";
import { GlmExecutor } from "../../open-sse/executors/glm.js";

beforeEach(() => { vi.clearAllMocks(); });
describe("GLM interactive verification through chat core", () => {
  it("does not refresh credentials or replay a terminal verification response", async () => {
    mocks.execute.mockResolvedValue(new GlmExecutor().verificationResult());
    const result = await handleChatCore({
      body: { model: "glm/glm-5.3-flash", max_tokens: 1024, reasoning_effort: "max",
        messages: [{ role: "user", content: "offline fixture" }] },
      modelInfo: { provider: "glm", model: "glm-5.3-flash" },
      credentials: { accessToken: "fixture-business", refreshToken: "fixture-refresh",
        providerSpecificData: { zaiPlanMode: "start-plan", zcodeJwtToken: "fixture-login" } },
      connectionId: "verification-fixture", sourceFormatOverride: "openai",
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });
    expect(result.response.status).toBe(403);
    expect(await result.response.text()).toContain("Z.AI interactive verification required");
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.execute.mock.calls[0][0].glmEffort).toBe("max");
    expect(mocks.execute.mock.calls[0][0].glmMaxTokens).toBe(1024);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
