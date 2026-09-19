import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  getModelAliases: vi.fn(),
  setModelAlias: vi.fn(),
  getCustomModels: vi.fn(),
  getProviderConnections: vi.fn(),
  getProviderNodes: vi.fn(),
  getDisabledModels: vi.fn(),
  getModelCapabilityOverrides: vi.fn(),
}));
const getCapabilitiesForModel = vi.hoisted(() => vi.fn());

vi.mock("@/models", () => ({
  getModelAliases: db.getModelAliases,
  setModelAlias: db.setModelAlias,
  getCustomModels: db.getCustomModels,
  getProviderConnections: db.getProviderConnections,
  getProviderNodes: db.getProviderNodes,
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: db.getDisabledModels }));
vi.mock("@/lib/db/repos/modelCapabilityRepo.js", () => ({
  getModelCapabilityOverrides: db.getModelCapabilityOverrides,
}));
vi.mock("@/shared/constants/config", () => ({
  AI_MODELS: [
    { provider: "alpha", model: "model-a", name: "Model A" },
    { provider: "beta", model: "model-b", name: "Model B" },
  ],
}));
vi.mock("@/shared/constants/providers", () => ({
  AI_PROVIDERS: {
    alpha: { id: "alpha", alias: "a", name: "Alpha" },
    beta: { id: "beta", alias: "b", name: "Beta" },
  },
  getProviderAlias: (provider) => ({ alpha: "a", beta: "b" })[provider] || provider,
}));
vi.mock("open-sse/providers/capabilities.js", () => ({ getCapabilitiesForModel }));

const { GET } = await import("../../src/app/api/models/route.js");

beforeEach(() => {
  vi.clearAllMocks();
  db.getModelAliases.mockResolvedValue({});
  db.getCustomModels.mockResolvedValue([]);
  db.getProviderConnections.mockResolvedValue([]);
  db.getProviderNodes.mockResolvedValue([]);
  db.getDisabledModels.mockResolvedValue({});
  db.getModelCapabilityOverrides.mockResolvedValue([]);
  getCapabilitiesForModel.mockReturnValue({
    vision: false,
    search: false,
    reasoning: false,
    contextWindow: 200000,
    maxOutput: 64000,
  });
});

describe("models API pagination", () => {
  it("returns one requested page and resolves caps only for visible rows", async () => {
    const response = await GET(new Request("http://localhost/api/models?page=2&pageSize=1"));
    const data = await response.json();

    expect(data.pagination).toEqual({ page: 2, pageSize: 1, total: 2, totalPages: 2 });
    expect(data.models.map((model) => model.model)).toEqual(["model-b"]);
    expect(getCapabilitiesForModel).toHaveBeenCalledTimes(1);
    expect(getCapabilitiesForModel).toHaveBeenCalledWith("beta", "model-b");
  });

  it("searches configured provider names and hides generated compatible IDs", async () => {
    db.getCustomModels.mockResolvedValue([{
      providerAlias: "openai-compatible-chat-b13cbcde-eb74-4f13-92be-4a7051fee3cc",
      id: "custom-model",
      name: "Custom Model",
      type: "llm",
    }]);
    db.getProviderNodes.mockResolvedValue([{
      id: "openai-compatible-chat-b13cbcde-eb74-4f13-92be-4a7051fee3cc",
      name: "Work API",
      prefix: "work",
    }]);

    const response = await GET(new Request("http://localhost/api/models?page=1&pageSize=20&search=work"));
    const data = await response.json();

    expect(data.pagination.total).toBe(1);
    expect(data.models[0]).toEqual(expect.objectContaining({
      providerName: "Work API",
      providerPrefix: "work",
      model: "custom-model",
    }));
  });

  it("preserves full-list behavior for existing callers without paging params", async () => {
    const response = await GET(new Request("http://localhost/api/models"));
    const data = await response.json();

    expect(data.pagination).toBeUndefined();
    expect(data.models).toHaveLength(2);
    expect(getCapabilitiesForModel).toHaveBeenCalledTimes(2);
  });
});
