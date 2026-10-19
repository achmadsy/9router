import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  getProviderConnections: vi.fn(async () => []),
  getCombos: vi.fn(async () => [{ id: "combo-1", name: "combo-fast" }]),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
  getProviderNodes: vi.fn(async () => []),
}));

const mocks = vi.hoisted(() => ({
  resolveApiKeyContext: vi.fn(),
  filterCatalogByPolicy: vi.fn(),
  loadCombosForPolicy: vi.fn(),
}));

vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: vi.fn(async () => ({})),
}));

vi.mock("@/sse/services/apiKeyPolicy.js", () => ({
  resolveApiKeyContext: mocks.resolveApiKeyContext,
}));

vi.mock("@/lib/apiKeys/policy.js", () => ({
  filterCatalogByPolicy: mocks.filterCatalogByPolicy,
  loadCombosForPolicy: mocks.loadCombosForPolicy,
}));

const { GET } = await import("../../src/app/api/v1/models/route.js");

describe("GET /v1/models ACL and policy enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadCombosForPolicy.mockResolvedValue([{ id: "combo-1", name: "combo-fast" }]);
  });

  it("returns full catalog when no key presented and no policy restriction", async () => {
    mocks.resolveApiKeyContext.mockResolvedValue({
      apiKey: null,
      keyRow: null,
      errorResponse: null,
    });
    mocks.filterCatalogByPolicy.mockImplementation((keyRow, data) => data);

    const req = new Request("https://router.test/v1/models");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
    expect(mocks.resolveApiKeyContext).toHaveBeenCalledWith(req);
    expect(mocks.filterCatalogByPolicy).toHaveBeenCalledWith(
      null,
      expect.any(Array),
      { combos: [{ id: "combo-1", name: "combo-fast" }] }
    );
  });

  it("returns 401 when presented API key is invalid or paused", async () => {
    const errorResponse = Response.json(
      { error: { message: "Invalid API key", type: "invalid_request_error", code: "invalid_api_key" } },
      { status: 401 }
    );
    mocks.resolveApiKeyContext.mockResolvedValue({
      apiKey: "sk-bad",
      keyRow: null,
      errorResponse,
    });

    const req = new Request("https://router.test/v1/models", {
      headers: { authorization: "Bearer sk-bad" },
    });
    const res = await GET(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_api_key");
    expect(mocks.filterCatalogByPolicy).not.toHaveBeenCalled();
  });

  it("returns 429 when API key token quota is exhausted", async () => {
    const errorResponse = Response.json(
      { error: { message: "API key token limit exceeded", type: "insufficient_quota", code: "token_limit_exceeded" } },
      { status: 429 }
    );
    mocks.resolveApiKeyContext.mockResolvedValue({
      apiKey: "sk-exhausted",
      keyRow: { id: "k-1", tokenLimit: 100 },
      errorResponse,
    });

    const req = new Request("https://router.test/v1/models", {
      headers: { authorization: "Bearer sk-exhausted" },
    });
    const res = await GET(req);

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe("token_limit_exceeded");
    expect(mocks.filterCatalogByPolicy).not.toHaveBeenCalled();
  });

  it("filters catalog down to allowed models for restricted API keys", async () => {
    const keyRow = {
      id: "k-restricted",
      accessMode: "restricted",
      targets: [{ targetType: "model", targetId: "openai/gpt-4o" }],
    };
    mocks.resolveApiKeyContext.mockResolvedValue({
      apiKey: "sk-restricted",
      keyRow,
      errorResponse: null,
    });
    const filteredCatalog = [{ id: "openai/gpt-4o", object: "model" }];
    mocks.filterCatalogByPolicy.mockReturnValue(filteredCatalog);

    const req = new Request("https://router.test/v1/models", {
      headers: { authorization: "Bearer sk-restricted" },
    });
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual(filteredCatalog);
    expect(mocks.filterCatalogByPolicy).toHaveBeenCalledWith(
      keyRow,
      expect.any(Array),
      { combos: [{ id: "combo-1", name: "combo-fast" }] }
    );
  });
});
