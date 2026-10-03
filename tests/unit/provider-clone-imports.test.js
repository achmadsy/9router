import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ save: vi.fn(), nodes: new Map(), sessions: new Map() }));
vi.mock("next/server", () => ({ NextResponse: { json: (body, init) => ({ status: init?.status || 200, json: async () => body }) } }));
vi.mock("@/models", () => ({ getProviderNodeById: async (id) => mocks.nodes.get(id), createProviderConnection: mocks.save }));
vi.mock("@/lib/oauth/providers", () => ({ extractCodexAccountInfo: () => ({ email: "test@example.test" }) }));
vi.mock("@/lib/oauth/services/cursor", () => ({ CursorService: class {
  async validateImportToken() { return { accessToken: "fake", machineId: "machine-test", expiresIn: 3600 }; }
  extractUserInfo() { return { email: "test@example.test", userId: "user-test" }; }
} }));
vi.mock("@/lib/oauth/services/kiro", () => ({ KiroService: class {
  async exchangeSocialCode() { return { accessToken: "fake", refreshToken: "fake-refresh", profileArn: "profile-test", expiresIn: 3600 }; }
  async refreshToken() { return this.exchangeSocialCode(); }
  async validateApiKey() { return { accessToken: "fake", profileArn: "profile-test", region: "us-east-1" }; }
  extractEmailFromJWT() { return "test@example.test"; }
} }));
vi.mock("@/lib/zcode/auth", () => ({ ZaiAuthFlow: class {
  async start() { return { flowId: "flow-test", pollToken: "fake-poll", provider: "zai", authorizeUrl: "https://example.test" }; }
  async poll() { return { status: "ready", zai: { access_token: "fake" } }; }
  async exchangeForConnection() { return { accessToken: "fake-key", providerSpecificData: { username: "user-test", zcodeJwtToken: "fake-jwt" } }; }
} }));
vi.mock("@/lib/zcode/sessions", () => ({
  createZaiSession: async (data) => mocks.sessions.set(data.flowId, data),
  getZaiSession: async (id) => mocks.sessions.get(id),
  deleteZaiSession: async (id) => mocks.sessions.delete(id),
}));
const routes = {
  "codex/import-token": (await import("../../src/app/api/oauth/codex/import-token/route.js")).POST,
  "codex/bulk-import": (await import("../../src/app/api/oauth/codex/bulk-import/route.js")).POST,
  "grok-cli/bulk-import": (await import("../../src/app/api/oauth/grok-cli/bulk-import/route.js")).POST,
  "cursor/import": (await import("../../src/app/api/oauth/cursor/import/route.js")).POST,
  "kiro/import": (await import("../../src/app/api/oauth/kiro/import/route.js")).POST,
  "kiro/api-key": (await import("../../src/app/api/oauth/kiro/api-key/route.js")).POST,
  "kiro/social-exchange": (await import("../../src/app/api/oauth/kiro/social-exchange/route.js")).POST,
};
const initGlm = (await import("../../src/app/api/oauth/zai/init/route.js")).POST;
const pollGlm = (await import("../../src/app/api/oauth/zai/poll/route.js")).POST;
const bodies = {
  "codex/import-token": { accessToken: "fake" },
  "codex/bulk-import": { accounts: [{ accessToken: "fake", providerSpecificData: { chatgptAccountId: "workspace-test" } }] },
  "grok-cli/bulk-import": { accounts: [{ access_token: "fake", email: "test@example.test" }] },
  "cursor/import": { accessToken: "fake", machineId: "machine-test" },
  "kiro/import": { refreshToken: "fake", clientId: "client-test", clientSecret: "fake-secret" },
  "kiro/api-key": { apiKey: "fake" },
  "kiro/social-exchange": { code: "fake", codeVerifier: "fake", provider: "google" },
};
const req = (path, as, body = {}) => new Request(`http://localhost/api/oauth/${path}${as == null ? "" : `?as=${as}`}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => {
  mocks.nodes.clear(); mocks.sessions.clear();
  for (const base of ["codex", "grok-cli", "cursor", "kiro", "glm"]) mocks.nodes.set(`${base}-clone-test`, { type: "provider-clone", baseProvider: base, prefix: `${base}-2`, name: "Duplicate" });
  mocks.save.mockReset().mockImplementation(async (data) => ({ id: "conn-test", ...data }));
});
describe("provider-specific clone authentication", () => {
  it.each(Object.keys(routes))("saves %s to duplicate instead of original", async (path) => {
    const base = path.split("/")[0];
    expect((await routes[path](req(path, `${base}-clone-test`, bodies[path]))).status).toBe(200);
    expect(mocks.save.mock.calls[0][0]).toMatchObject({ provider: `${base}-clone-test`, providerSpecificData: { baseProvider: base, prefix: `${base}-2` } });
  });
  it.each(Object.keys(routes))("rejects unrelated destination for %s without writes", async (path) => {
    expect((await routes[path](req(path, "glm-clone-test", bodies[path]))).status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("binds GLM polling destination to its initial session", async () => {
    expect((await initGlm(req("zai/init", "glm-clone-test"))).status).toBe(200);
    expect(mocks.sessions.get("flow-test").targetProviderId).toBe("glm-clone-test");
    expect((await pollGlm(req("zai/poll", "glm-clone-test", { flowId: "flow-test" }))).status).toBe(200);
    expect(mocks.save.mock.calls[0][0]).toMatchObject({ provider: "glm-clone-test", providerSpecificData: { baseProvider: "glm", username: "user-test", zcodeJwtToken: "fake-jwt" } });
  });
});
