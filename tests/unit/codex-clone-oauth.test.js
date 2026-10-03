import { readFileSync } from "node:fs";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  nodes: new Map(),
  connections: new Map(),
  pollForToken: vi.fn(),
  exchangeTokens: vi.fn(),
  createProviderConnection: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (body, init) => ({ status: init?.status || 200, json: async () => body }) },
}));
vi.mock("@/models", () => ({
  getProviderNodeById: vi.fn(async (id) => mocks.nodes.get(id) || null),
  createProviderConnection: mocks.createProviderConnection,
}));
vi.mock("@/lib/oauth/providers", () => ({
  getProvider: vi.fn(), generateAuthData: vi.fn(), requestDeviceCode: vi.fn(),
  pollForToken: mocks.pollForToken, exchangeTokens: mocks.exchangeTokens,
  extractCodexAccountInfo: vi.fn(() => ({ email: "same@example.test", chatgptAccountId: "account-test" })),
}));
vi.mock("@/lib/oauth/utils/ideDetect", () => ({ detectIdeInstalled: vi.fn() }));

import { GET, POST } from "../../src/app/api/oauth/[provider]/[action]/route.js";
import {
  registerCodexSession, getCodexSessionStatus, clearCodexSession, stopCodexProxy,
} from "../../src/lib/oauth/utils/server.js";

const cloneId = "codex-clone-test";
const otherCloneId = "codex-clone-other";
const clone = { id: cloneId, type: "provider-clone", baseProvider: "codex", prefix: "codex-2", name: "Codex 2" };
let callback;
const states = ["clone-state", "base-state", "other-state"];
const start = (as, state = "clone-state") => {
  const query = new URLSearchParams({ app_port: "20127", state, code_verifier: "fake-verifier", redirect_uri: "http://localhost:1455/auth/callback" });
  if (as !== undefined) query.set("as", as);
  return GET(new Request(`http://localhost/api/oauth/codex/start-proxy?${query}`), {
    params: Promise.resolve({ provider: "codex", action: "start-proxy" }),
  });
};
const exchange = (as) => POST(new Request(`http://localhost/api/oauth/codex/exchange${as === undefined ? "" : `?as=${encodeURIComponent(as)}`}`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ code: "fake-code", state: "clone-state", codeVerifier: "fake-verifier", redirectUri: "http://localhost:1455/auth/callback" }),
}), { params: Promise.resolve({ provider: "codex", action: "exchange" }) });
const receive = async (query = "code=fake-code&state=clone-state") => {
  const res = { writeHead: vi.fn(), end: vi.fn() };
  await callback({ url: `/auth/callback?${query}` }, res);
  return res;
};

beforeEach(() => {
  mocks.nodes.clear();
  mocks.nodes.set(cloneId, { ...clone });
  mocks.nodes.set(otherCloneId, { ...clone, id: otherCloneId });
  mocks.connections.clear();
  mocks.createProviderConnection.mockReset().mockImplementation(async (data) => {
    const key = `${data.provider}:${data.email}`;
    const connection = { id: mocks.connections.get(key)?.id || `conn-${mocks.connections.size}`, ...data };
    mocks.connections.set(key, connection);
    return connection;
  });
  mocks.exchangeTokens.mockReset().mockResolvedValue({
    accessToken: "fake-access", refreshToken: "fake-refresh", email: "same@example.test", expiresIn: 3600,
    providerSpecificData: { chatgptAccountId: "account-test", chatgptPlanType: "plus" },
  });
  vi.spyOn(http, "createServer").mockImplementation((handler) => {
    callback = handler;
    return { listen: (_port, _host, ready) => ready(), on: vi.fn(), close: vi.fn() };
  });
});
afterEach(() => {
  stopCodexProxy();
  states.forEach(clearCodexSession);
  vi.restoreAllMocks();
});

describe("Codex duplicate OAuth", () => {
  it("includes the duplicate destination on the modal's proxy request", () => {
    const source = readFileSync(new URL("../../src/shared/components/OAuthModal.js", import.meta.url), "utf8");
    const codexRequest = source.slice(source.indexOf('// Codex: start proxy'), source.indexOf('// xAI: same'));
    expect(codexRequest).toContain("fetch(withAs(proxyUrl.toString()))");
  });

  it("saves automatic callback to the duplicate and retains token metadata", async () => {
    expect((await start(cloneId)).status).toBe(200);
    await receive();
    expect(mocks.createProviderConnection).toHaveBeenCalledWith(expect.objectContaining({
      provider: cloneId,
      providerSpecificData: { baseProvider: "codex", prefix: "codex-2", nodeName: "Codex 2", chatgptAccountId: "account-test", chatgptPlanType: "plus" },
    }));
    expect(getCodexSessionStatus("clone-state").status).toBe("done");
    expect(mocks.connections.has("codex:same@example.test")).toBe(false);
  });

  it("saves manual authorization-code exchange to the duplicate", async () => {
    const res = await exchange(cloneId);
    expect(res.status).toBe(200);
    expect((await res.json()).connection.provider).toBe(cloneId);
    expect(mocks.createProviderConnection.mock.calls[0][0].providerSpecificData).toMatchObject({ baseProvider: "codex", chatgptAccountId: "account-test" });
  });

  it("keeps access-token login saving to the selected duplicate", async () => {
    const code = `eyJheader.${Buffer.from(JSON.stringify({ account_id: "account-test" })).toString("base64url")}.signature`;
    const res = await POST(new Request(`http://localhost/api/oauth/codex/exchange?as=${cloneId}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }),
    }), { params: Promise.resolve({ provider: "codex", action: "exchange" }) });
    expect(res.status).toBe(200);
    expect(mocks.createProviderConnection.mock.calls[0][0]).toMatchObject({ provider: cloneId, authType: "access_token" });
  });

  it("keeps device-code polling saving to the selected duplicate", async () => {
    mocks.pollForToken.mockResolvedValueOnce({ success: true, tokens: { accessToken: "fake-access" } });
    const res = await POST(new Request(`http://localhost/api/oauth/codex/poll?as=${cloneId}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceCode: "fake-device", codeVerifier: "fake-verifier" }),
    }), { params: Promise.resolve({ provider: "codex", action: "poll" }) });
    expect(res.status).toBe(200);
    expect(mocks.createProviderConnection.mock.calls[0][0]).toMatchObject({ provider: cloneId });
  });

  it("keeps original Codex behavior without a destination", async () => {
    await start(undefined, "base-state");
    await receive("code=fake-code&state=base-state");
    expect(mocks.createProviderConnection.mock.calls[0][0].provider).toBe("codex");
    expect((await exchange(undefined)).status).toBe(200);
  });

  it("keeps the same account isolated across original and duplicate pools", async () => {
    await exchange(undefined);
    const original = { ...mocks.connections.get("codex:same@example.test") };
    await start(cloneId);
    await receive();
    expect(mocks.connections.size).toBe(2);
    expect(mocks.connections.get("codex:same@example.test")).toEqual(original);
  });

  it.each(["", "missing-clone-test", "codex-clone-missing", "xai-clone-test"])("rejects invalid destination %s before starting or writing", async (id) => {
    mocks.nodes.set("xai-clone-test", { ...clone, id: "xai-clone-test", baseProvider: "xai" });
    expect((await start(id)).status).toBe(400);
    expect(http.createServer).not.toHaveBeenCalled();
    expect((await exchange(id)).status).toBe(400);
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
  });

  it("rejects a clone whose stored base disagrees with its embedded base", async () => {
    mocks.nodes.set(cloneId, { ...clone, baseProvider: "xai" });
    expect((await start(cloneId)).status).toBe(400);
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
  });

  it("rejects a deleted clone before callback persistence", async () => {
    await start(cloneId);
    mocks.nodes.delete(cloneId);
    await receive();
    expect(getCodexSessionStatus("clone-state").status).toBe("error");
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
  });

  it("rejects a clone deleted during token exchange", async () => {
    await start(cloneId);
    mocks.exchangeTokens.mockImplementationOnce(async () => {
      mocks.nodes.delete(cloneId);
      return { accessToken: "fake-access", email: "same@example.test" };
    });
    await receive();
    expect(getCodexSessionStatus("clone-state").status).toBe("error");
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
  });

  it("rejects callback destination overrides", async () => {
    await start(cloneId);
    await receive(`code=fake-code&state=clone-state&as=${otherCloneId}`);
    expect(getCodexSessionStatus("clone-state").status).toBe("error");
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
  });

  it("cannot replace the destination of an existing session", async () => {
    await start(cloneId);
    expect(registerCodexSession({ state: "clone-state", codeVerifier: "other", redirectUri: "http://localhost:1455/auth/callback", targetProviderId: otherCloneId })).toBe(false);
    await receive();
    expect(mocks.createProviderConnection.mock.calls[0][0].provider).toBe(cloneId);
  });

  it("looks up destination by state rather than most recent login", async () => {
    await start(cloneId);
    await start(undefined, "base-state");
    await receive();
    expect(mocks.createProviderConnection.mock.calls[0][0].provider).toBe(cloneId);
    expect(getCodexSessionStatus("base-state").status).toBe("pending");
  });
});
