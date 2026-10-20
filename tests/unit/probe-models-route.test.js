import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyProbeAdminAuth: vi.fn(),
  verifyCsrfOrigin: vi.fn(),
  assertPublicUrlResolved: vi.fn(),
  discoverModelsOnSidecar: vi.fn(),
  buildModelsList: vi.fn(),
  resolveApiKeyContext: vi.fn(),
  filterCatalogByPolicy: vi.fn(),
  loadCombosForPolicy: vi.fn(),
}));

vi.mock("@/lib/probe/auth.js", () => ({
  verifyProbeAdminAuth: mocks.verifyProbeAdminAuth,
  verifyCsrfOrigin: mocks.verifyCsrfOrigin,
}));
vi.mock("@/shared/utils/ssrfGuard.js", () => ({ assertPublicUrlResolved: mocks.assertPublicUrlResolved }));
vi.mock("@/lib/probe/sidecarClient.js", () => ({ discoverModelsOnSidecar: mocks.discoverModelsOnSidecar }));
vi.mock("@/app/api/v1/models/route.js", () => ({ buildModelsList: mocks.buildModelsList }));
vi.mock("@/sse/services/apiKeyPolicy.js", () => ({ resolveApiKeyContext: mocks.resolveApiKeyContext }));
vi.mock("@/lib/apiKeys/policy.js", () => ({
  filterCatalogByPolicy: mocks.filterCatalogByPolicy,
  loadCombosForPolicy: mocks.loadCombosForPolicy,
}));

const { POST } = await import("../../src/app/api/probe/models/route.js");

function request(body, headers = {}) {
  return new Request("https://router.test/api/probe/models", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://router.test", host: "router.test", ...headers },
    body: JSON.stringify(body),
  });
}

describe("Probe model discovery route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyProbeAdminAuth.mockResolvedValue({ authorized: true, ownerId: "admin" });
    mocks.verifyCsrfOrigin.mockReturnValue(true);
    mocks.resolveApiKeyContext.mockResolvedValue({ keyRow: null, errorResponse: null });
    mocks.buildModelsList.mockResolvedValue([{ id: "openai/a" }, { id: "openai/a" }, { id: "openai/b" }]);
    mocks.loadCombosForPolicy.mockResolvedValue([]);
    mocks.filterCatalogByPolicy.mockImplementation((_row, models) => models);
  });

  it("requires Probe admin authentication", async () => {
    mocks.verifyProbeAdminAuth.mockResolvedValue({ authorized: false, ownerId: null });
    expect((await POST(request({ source: "this_9router" }))).status).toBe(401);
  });

  it("rejects a CSRF origin mismatch", async () => {
    mocks.verifyCsrfOrigin.mockReturnValue(false);
    expect((await POST(request({ source: "this_9router" }))).status).toBe(403);
  });

  it("builds and policy-filters the local catalog in process", async () => {
    const response = await POST(request({ source: "this_9router", apiKey: "sk-restricted" }));
    expect(response.status).toBe(200);
    expect(mocks.resolveApiKeyContext).toHaveBeenCalledWith(expect.any(Object), { requireApiKey: false });
    expect(await response.json()).toEqual({ models: [{ id: "openai/a" }, { id: "openai/b" }] });
    expect(mocks.discoverModelsOnSidecar).not.toHaveBeenCalled();
  });

  it("preserves local API-key authentication errors", async () => {
    mocks.resolveApiKeyContext.mockResolvedValue({
      keyRow: null,
      errorResponse: Response.json({ error: { message: "Invalid API key" } }, { status: 401 }),
    });
    expect((await POST(request({ source: "this_9router", apiKey: "bad" }))).status).toBe(401);
  });

  it("validates custom URL then delegates to sidecar", async () => {
    mocks.discoverModelsOnSidecar.mockResolvedValue(Response.json({ models: [{ id: "custom/a" }] }));
    const response = await POST(request({ source: "custom", endpoint: "https://api.example.com/v1", apiKey: "secret" }));
    expect(response.status).toBe(200);
    expect(mocks.assertPublicUrlResolved).toHaveBeenCalledWith("https://api.example.com/v1", { requireResolve: true });
    expect(mocks.discoverModelsOnSidecar).toHaveBeenCalledWith(
      { baseUrl: "https://api.example.com/v1", apiKey: "secret" },
      expect.any(AbortSignal)
    );
  });

  it("returns 400 when custom URL is blocked", async () => {
    mocks.assertPublicUrlResolved.mockRejectedValue(new Error("Blocked URL: internal host"));
    const response = await POST(request({ source: "custom", endpoint: "http://169.254.169.254/v1" }));
    expect(response.status).toBe(400);
    expect(mocks.discoverModelsOnSidecar).not.toHaveBeenCalled();
  });
});
