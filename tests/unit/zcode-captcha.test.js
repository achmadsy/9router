import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.fetch }));
vi.mock("../../src/lib/zcode/browser.js", () => ({ launch: vi.fn(), close: vi.fn() }));
import { CaptchaManager } from "../../src/lib/zcode/captcha-manager.js";
import { getCaptchaManager, isCaptchaError } from "../../src/lib/zcode/captcha-service.js";
import { GlmExecutor } from "../../open-sse/executors/glm.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { buildZcodeClientConfigUrl, resolveZcodeClientConfigPlatform } from "../../src/lib/zcode/config.js";

const credentials = { providerSpecificData: { zcodeJwtToken: "fixture-jwt", zaiPlanMode: "start-plan" } };
beforeEach(() => { mocks.fetch.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("Z.AI verification handling", () => {
  it.each([400, 403])("recognizes verification responses with HTTP %s", async (status) => {
    expect(await isCaptchaError(new Response('{"error":{"code":3007,"message":"captcha"}}', { status }))).toBe(true);
  });
  it.each([{ enabled: false }, { enabled: true, skip_model_request: true }])("permits inference when remote policy skips verification: %j", async (policy) => {
    vi.spyOn(getCaptchaManager(), "fetchCaptchaConfig").mockResolvedValue(policy);
    const execute = vi.spyOn(DefaultExecutor.prototype, "execute").mockResolvedValue({ response: new Response('{}') });
    expect((await new GlmExecutor().execute({ model: "glm-5.3-flash", credentials })).response.status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("requires the supported interactive flow before sending protected inference", async () => {
    vi.spyOn(getCaptchaManager(), "fetchCaptchaConfig").mockResolvedValue({ enabled: true });
    const execute = vi.spyOn(DefaultExecutor.prototype, "execute");
    const solve = vi.spyOn(getCaptchaManager(), "getVerifyParam");
    const result = await new GlmExecutor().execute({ model: "glm-5.3-flash", credentials });
    expect(result.response.status).toBe(403);
    expect(await result.response.text()).toContain("official ZCode app");
    expect(execute).not.toHaveBeenCalled();
    expect(solve).not.toHaveBeenCalled();
  });
  it("does not replay a verification rejection even when configuration allowed the first request", async () => {
    vi.spyOn(getCaptchaManager(), "fetchCaptchaConfig").mockResolvedValue({ enabled: false });
    const execute = vi.spyOn(DefaultExecutor.prototype, "execute").mockResolvedValue({ response: new Response("captcha verify failed", { status: 403 }) });
    const result = await new GlmExecutor().execute({ model: "glm-5.3-flash", credentials });
    expect(result.response.status).toBe(403);
    expect(await result.response.text()).toContain("No automatic replay");
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("treats API-key verification rejections as terminal without credential refresh", async () => {
    const execute = vi.spyOn(DefaultExecutor.prototype, "execute").mockResolvedValue({
      response: new Response('captcha verify failed', { status: 403 }), url: "https://api.z.ai/api/anthropic/v1/messages",
    });
    const result = await new GlmExecutor().execute({ model: "glm-5.3", credentials: {
      apiKey: "fixture-static", providerSpecificData: { zaiPlanMode: "api-key" },
    } });
    expect(result.response.status).toBe(403);
    expect(result.skipCredentialRefresh).toBe(true);
    expect(result.url).toContain("api.z.ai");
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("fails closed on missing or invalid remote configuration", async () => {
    const manager = new CaptchaManager();
    for (const data of [{}, { configs: { captcha: { enabled: "false" } } }]) {
      mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data })));
      await expect(manager.fetchCaptchaConfig()).rejects.toThrow(/verification configuration/);
    }
  });
  it("fetches policy over the selected route with TLS validation and no redirects", async () => {
    const manager = new CaptchaManager();
    const proxy = { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.test:3128", strictProxy: true };
    mocks.fetch.mockImplementation(async () => new Response(JSON.stringify({ code: 0, data: { configs: { captcha: { enabled: false } } } })));
    await manager.fetchCaptchaConfig(proxy);
    expect(mocks.fetch.mock.calls[0]).toEqual([buildZcodeClientConfigUrl(), expect.objectContaining({ strictTls: true, redirect: "error" }), proxy]);
    await manager.fetchCaptchaConfig(proxy);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    await manager.fetchCaptchaConfig({ forceDirect: true });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
  it("never shares a pending verification across changed proxy routes", async () => {
    const manager = new CaptchaManager();
    vi.spyOn(manager, "_scheduleTeardown").mockImplementation(() => {});
    vi.spyOn(manager, "openVerificationPage").mockResolvedValue();
    manager.setProxy("http://route-a.test:3128");
    const pending = manager.getVerifyParam();
    expect(() => manager.setProxy("http://route-b.test:3128")).toThrow("another route");
    expect(manager._proxyUrl).toBe("http://route-a.test:3128");
    manager.submit("fake-route-a-result");
    expect(await pending).toBe("fake-route-a-result");
    manager.setProxy("http://route-b.test:3128");
    expect(manager.cachedVerifyParam).toBeNull();
    manager.invalidate();
  });
  it("retains the native client-config platform contract", () => {
    expect(resolveZcodeClientConfigPlatform("linux", "x64")).toBe("linux-x86_64");
    expect(resolveZcodeClientConfigPlatform("win32", "x64")).toBe("windows-x86_64");
    expect(new URL(buildZcodeClientConfigUrl()).searchParams.get("platform")).toBe(resolveZcodeClientConfigPlatform());
  });
});
