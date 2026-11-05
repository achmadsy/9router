import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  sessions: new Map(), locks: new Map(), exchange: vi.fn(), poll: vi.fn(), save: vi.fn(), initialize: vi.fn(),
}));
vi.mock("../../src/lib/zcode/sessions.js", () => ({
  getZaiSession: async (id) => mocks.sessions.get(id),
  updateZaiSession: async (id, patch) => { const value = { ...mocks.sessions.get(id), ...patch }; mocks.sessions.set(id, value); return value; },
  deleteZaiSession: async (id) => mocks.sessions.delete(id),
  withZaiSessionLock: async (id, run) => {
    const promise = (mocks.locks.get(id) || Promise.resolve()).catch(() => {}).then(run);
    mocks.locks.set(id, promise);
    try { return await promise; } finally { if (mocks.locks.get(id) === promise) mocks.locks.delete(id); }
  },
}));
vi.mock("../../src/lib/zcode/auth.js", () => ({ ZaiAuthFlow: class {
  pollIntervalSec = 2;
  get nextPollDelayMs() { return this.pollIntervalSec * 1000; }
  poll = mocks.poll;
  exchangeForConnection = mocks.exchange;
  initializeStartPlan = mocks.initialize;
} }));
vi.mock("../../src/lib/zcode/network.js", () => ({ resolveZaiNetwork: async () => ({ proxyOptions: { forceDirect: true }, network: { route: "direct" } }), zaiNetworkConnectionData: () => ({}) }));
vi.mock("../../src/lib/oauth/utils/savedProvider.js", () => ({ saveOAuthConnection: mocks.save, sessionDestination: () => "glm", readAsParam: () => null }));
import { POST } from "../../src/app/api/oauth/zai/poll/route.js";
const request = () => new Request("http://localhost/api/oauth/zai/poll", { method: "POST", body: JSON.stringify({ flowId: "flow-fixture" }) });
beforeEach(() => {
  mocks.sessions.clear(); mocks.locks.clear();
  for (const fn of [mocks.exchange, mocks.poll, mocks.save, mocks.initialize]) fn.mockReset();
  mocks.sessions.set("flow-fixture", { flowId: "flow-fixture", pollToken: "fixture-poll", expiresAt: Date.now() + 60000, pollIntervalSec: 9, networkRoute: "direct" });
  mocks.poll.mockResolvedValue({ status: "ready", token: "fixture-jwt", zai: { access_token: "fixture-oauth" } });
  mocks.exchange.mockResolvedValue({ accessToken: "fixture-business", providerSpecificData: {} });
  mocks.save.mockResolvedValue({ id: "fixture-connection", provider: "glm" });
});
describe("Z.AI OAuth completion", () => {
  it("completes concurrent and retried polls only once", async () => {
    const one = POST(request()); const two = POST(request());
    expect((await one).status).toBe(200); expect((await two).status).toBe(200);
    expect(mocks.exchange).toHaveBeenCalledTimes(1); expect(mocks.save).toHaveBeenCalledTimes(1);
    expect((await (await POST(request())).json()).status).toBe("ready");
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });
  it("retains exchanged credentials after a persistence failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.save.mockRejectedValueOnce(new Error("fixture persistence failure"));
    expect((await POST(request())).status).toBe(502);
    expect(mocks.sessions.get("flow-fixture").tokenData).toBeTruthy();
    expect((await POST(request())).status).toBe(200);
    expect(mocks.exchange).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
  it("retains ready authorization after exchange failure without polling again", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.exchange.mockRejectedValueOnce(new Error("fixture business failure"));
    expect((await POST(request())).status).toBe(502);
    expect(mocks.sessions.get("flow-fixture").authorization.zai.access_token).toBe("fixture-oauth");
    expect((await POST(request())).status).toBe(200);
    expect(mocks.poll).toHaveBeenCalledTimes(1);
    expect(mocks.exchange).toHaveBeenCalledTimes(2);
    expect(mocks.sessions.get("flow-fixture").authorization).toBeNull();
    error.mockRestore();
  });
  it("preserves and enforces the provider polling interval", async () => {
    mocks.poll.mockResolvedValue({ status: "pending" });
    expect((await (await POST(request())).json()).pollAfterMs).toBe(9000);
    await POST(request());
    expect(mocks.poll).toHaveBeenCalledTimes(1);
  });
});
