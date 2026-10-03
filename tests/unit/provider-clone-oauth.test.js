import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ nodes: new Map(), save: vi.fn(), exchange: vi.fn(), poll: vi.fn() }));
vi.mock("next/server", () => ({ NextResponse: { json: (body, init) => ({ status: init?.status || 200, json: async () => body }) } }));
vi.mock("@/models", () => ({
  getProviderNodeById: vi.fn(async (id) => mocks.nodes.get(id)),
  createProviderConnection: mocks.save,
}));
vi.mock("@/lib/oauth/providers", () => ({
  getProvider: vi.fn(), generateAuthData: vi.fn(), requestDeviceCode: vi.fn(),
  exchangeTokens: mocks.exchange, pollForToken: mocks.poll,
}));
vi.mock("@/lib/oauth/utils/ideDetect", () => ({ detectIdeInstalled: vi.fn() }));
import { GET, POST } from "../../src/app/api/oauth/[provider]/[action]/route.js";
import * as server from "../../src/lib/oauth/utils/server.js";
import { resolveSavedProviderId, applySavedProvider } from "../../src/lib/oauth/utils/savedProvider.js";
let callback;
const providers = ["codex", "xai", "trae", "windsurf", "zed", "github", "kiro", "qwen", "gitlab", "glm", "xiaomi-mimo"];
const tokens = { accessToken: "fake", email: "same@example.test", providerSpecificData: { workspaceId: "workspace", clientSecret: "fake-secret", systemId: "test-system" } };
const request = (provider, action, body = {}, as = `${provider}-clone-test`) => POST(new Request(`http://localhost/api/oauth/${provider}/${action}?as=${as}`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}), { params: Promise.resolve({ provider, action }) });
beforeEach(() => {
  mocks.nodes.clear();
  providers.forEach((provider) => mocks.nodes.set(`${provider}-clone-test`, { type: "provider-clone", baseProvider: provider, prefix: `${provider}-2`, name: "Duplicate" }));
  mocks.save.mockReset().mockImplementation(async (data) => ({ id: "test-connection", ...data }));
  mocks.exchange.mockReset().mockResolvedValue(tokens);
  mocks.poll.mockReset().mockResolvedValue({ success: true, tokens });
  vi.spyOn(http, "createServer").mockImplementation((handler) => {
    callback = handler;
    return { listen: (_port, _host, ready) => ready(), address: () => ({ port: 12345 }), on: vi.fn(), close: vi.fn() };
  });
});
afterEach(() => {
  for (const name of ["Codex", "Xai", "Trae", "Windsurf", "Zed"]) {
    server[`stop${name}Proxy`]();
    server[`clear${name}Session`]( "test-state");
  }
  vi.restoreAllMocks();
});

describe("global provider clone OAuth destination", () => {
  it.each(providers)("validates and merges %s clone without dropping token metadata", async (provider) => {
    const saved = await resolveSavedProviderId(`${provider}-clone-test`, provider);
    expect(applySavedProvider({ ...tokens, provider }, saved)).toMatchObject({
      provider: `${provider}-clone-test`, providerSpecificData: { ...tokens.providerSpecificData, baseProvider: provider },
    });
    await expect(resolveSavedProviderId("xai-clone-test", provider === "xai" ? "codex" : provider)).rejects.toThrow("Invalid OAuth destination");
  });

  it.each(["qwen", "gitlab", "codex", "zed"])("preserves %s duplicate on manual exchange", async (provider) => {
    const res = await request(provider, "exchange", { code: "fake-code", codeVerifier: "fake", redirectUri: "http://localhost/callback", state: "test-state" });
    expect(res.status).toBe(200);
    expect(mocks.save.mock.calls[0][0]).toMatchObject({ provider: `${provider}-clone-test`, providerSpecificData: tokens.providerSpecificData });
  });

  it.each(["github", "kiro", "qwen", "glm"])("preserves %s device-code metadata", async (provider) => {
    const res = await request(provider, "poll", { deviceCode: "fake", codeVerifier: "fake" });
    expect(res.status).toBe(200);
    expect(mocks.save.mock.calls[0][0]).toMatchObject({ provider: `${provider}-clone-test`, providerSpecificData: { ...tokens.providerSpecificData, baseProvider: provider } });
  });

  it.each(["trae", "windsurf"])("preserves %s paste-token metadata", async (provider) => {
    expect((await request(provider, "exchange", { code: "fake-token" })).status).toBe(200);
    expect(mocks.save.mock.calls[0][0].providerSpecificData).toMatchObject(tokens.providerSpecificData);
  });

  it.each(["xai", "trae", "windsurf", "zed"])("saves %s automatic callback using registered duplicate session", async (provider) => {
    if (provider === "xai") {
      const q = new URLSearchParams({ state: "test-state", app_port: "20127", code_verifier: "fake", redirect_uri: "http://localhost/callback", as: `${provider}-clone-test` });
      expect((await GET(new Request(`http://localhost/api/oauth/xai/start-proxy?${q}`), { params: Promise.resolve({ provider, action: "start-proxy" }) })).status).toBe(200);
    } else {
      await server[`start${provider === "zed" ? "Zed" : provider === "trae" ? "Trae" : "Windsurf"}Proxy`]();
      expect((await request(provider, "register-session", { state: "test-state", codeVerifier: "fake", systemId: "test-system" })).status).toBe(200);
    }
    const paths = { xai: "/callback?code=fake-code&state=test-state", trae: "/callback?state=test-state&refreshToken=fake", windsurf: "/windsurf-auth-callback?state=test-state&access_token=fake", zed: "/?user_id=123&access_token=fake" };
    await callback({ url: paths[provider], headers: {}, method: "GET" }, { writeHead: vi.fn(), end: vi.fn() });
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ provider: `${provider}-clone-test`, providerSpecificData: expect.objectContaining({ ...tokens.providerSpecificData, baseProvider: provider }) }));
  });

  it("rejects manual exchange that changes a registered proxy destination", async () => {
    server.registerTraeSession({ state: "test-state", targetProviderId: "trae-clone-test" });
    const res = await request("trae", "exchange", { state: "test-state", code: "fake" }, "trae");
    expect(res.status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("supports the legacy Kimi Coding clone alias", async () => {
    mocks.nodes.set("kimi-coding-clone-test", { type: "provider-clone", baseProvider: "kimi-coding" });
    expect((await resolveSavedProviderId("kimi-coding-clone-test", "kimi")).provider).toBe("kimi-coding-clone-test");
  });

  it("keeps session secrets out of poll-status responses", async () => {
    server.registerXaiSession({ state: "test-state", codeVerifier: "secret-verifier", redirectUri: "secret-uri" });
    server.getXaiSessionStatus("test-state").status = "done";
    const res = await GET(new Request("http://localhost/api/oauth/xai/poll-status?state=test-state"), { params: Promise.resolve({ provider: "xai", action: "poll-status" }) });
    expect(await res.json()).toEqual({ status: "done" });
  });
});
