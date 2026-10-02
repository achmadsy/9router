import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getComboModels: vi.fn(),
  getModelInfo: vi.fn(),
  getProviderCredentials: vi.fn(),
  handleChatCore: vi.fn(),
  resolveApiKeyContext: vi.fn(),
  authorizeOriginalResource: vi.fn(),
  handleComboChat: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/sse/services/model.js", () => ({ getComboModels: mocks.getComboModels, getModelInfo: mocks.getModelInfo }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: vi.fn(), clearAccountError: vi.fn(),
  extractApiKey: () => "sk-test", isValidApiKey: vi.fn(),
}));
vi.mock("@/sse/services/apiKeyPolicy.js", () => ({
  resolveApiKeyContext: mocks.resolveApiKeyContext,
  authorizeOriginalResource: mocks.authorizeOriginalResource,
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));
vi.mock("open-sse/services/combo.js", () => ({
  handleComboChat: mocks.handleComboChat,
  handleFusionChat: mocks.handleComboChat,
  detectRequiredCapabilities: () => new Set(),
}));
vi.mock("open-sse/services/capacityAdapter.js", () => ({
  augmentModelsWithCapacityAdapter: (models) => models,
  withCapacityAdapterStripping: (fn) => fn,
  getActiveAdapterStrategy: () => "fallback",
}));
vi.mock("open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: () => null }));
vi.mock("open-sse/utils/claudeHeaderCache.js", () => ({ cacheClaudeHeaders: vi.fn() }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn() }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn(), checkAndRefreshToken: async (_provider, credentials) => credentials,
}));
vi.mock("@/sse/services/antigravityQuota.js", () => ({
  handleAntigravityQuotaError: vi.fn(), clearAntigravityStrikes: vi.fn(),
}));
vi.mock("open-sse/services/projectId.js", () => ({ getProjectIdForConnection: vi.fn() }));

const { handleChat } = await import("@/sse/handlers/chat.js");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettings.mockResolvedValue({ comboStrategy: "fallback" });
  mocks.getComboModels.mockImplementation(async (model) => model === "tier-premium" ? ["nested-tier"] : model === "nested-tier" ? ["cx/gpt-6-sol"] : null);
  mocks.getModelInfo.mockImplementation(async (model) => model === "nested-tier"
    ? { provider: null, model: "nested-tier" }
    : { provider: "codex", model: "gpt-6-sol" });
  mocks.getProviderCredentials.mockResolvedValue({ connectionId: "account-one" });
  mocks.resolveApiKeyContext.mockResolvedValue({ keyRow: { id: "default-key", name: "Default Key" }, errorResponse: null });
  mocks.authorizeOriginalResource.mockResolvedValue(null);
  mocks.handleChatCore.mockResolvedValue({ success: true, response: new Response("ok") });
  mocks.handleComboChat.mockImplementation(async ({ body, models, handleSingleModel }) => handleSingleModel(body, models[0]));
});

function request() {
  return new Request("http://localhost/v1/messages", {
    method: "POST", headers: { authorization: "Bearer sk-test" },
    body: JSON.stringify({ model: "tier-premium", messages: [{ role: "user", content: "hi" }] }),
  });
}

describe("nested combo API-key attribution", () => {
  it.each(["fallback", "fusion"])("keeps key ID and name through %s recursion", async (strategy) => {
    mocks.getSettings.mockResolvedValue({ comboStrategy: strategy });
    const response = await handleChat(request());
    expect(response.status).toBe(200);
    expect(mocks.handleComboChat).toHaveBeenCalledTimes(2);
    expect(mocks.handleChatCore).toHaveBeenCalledWith(expect.objectContaining({
      apiKeyId: "default-key", apiKeyNameSnapshot: "Default Key",
    }));
  });
});
