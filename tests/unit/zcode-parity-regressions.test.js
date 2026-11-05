import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), verification: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.fetch }));
vi.mock("../../src/lib/zcode/captcha-service.js", () => ({
  getCaptchaManager: () => ({ fetchCaptchaConfig: mocks.verification }),
  isCaptchaError: async () => false,
}));
import { GlmExecutor } from "../../open-sse/executors/glm.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { ZaiAuthFlow } from "../../src/lib/zcode/auth.js";
import { parseZcodeProjectToken, resolveZcodeBusinessSession, getZcodeProjectToken, invalidateZcodeProjectToken } from "../../src/lib/zcode/provisioning.js";
import { injectZcodeSystemPrompt } from "../../src/lib/zcode/systemPrompt.js";
import { normalizeZaiCredentials, resolveZaiPlanMode } from "../../src/lib/zcode/access.js";

const reply = (data) => new Response(JSON.stringify({ code: 200, data }));
const token = (extra = {}) => ({ enable: true, accessToken: "fixture-project-token", tokenType: "Bearer",
  expiresIn: 18000, expiresAt: Date.now() + 18_000_000, ...extra });
const credentials = { connectionId: "parity-account", accessToken: "fixture-business", apiKey: "fixture-static",
  providerSpecificData: { zcodeJwtToken: "fixture-login", zaiPlanMode: "start-plan" } };
afterEach(() => { vi.restoreAllMocks(); mocks.fetch.mockReset(); mocks.verification.mockReset(); });

describe("native-shaped ZCode contracts", () => {
  it.each([true, undefined])("accepts raw enable=%s responses", (enable) => {
    expect(parseZcodeProjectToken(token({ enable })).token).toBe("fixture-project-token");
  });
  it.each([{ enable: false }, { tokenType: "Basic" }, { expiresIn: 0 }, { expiresAt: 0 }, { accessToken: " " }])("rejects invalid project credentials %j", (patch) => {
    expect(() => parseZcodeProjectToken(token(patch))).toThrow();
  });
  it("rejects a business failure envelope even when data contains a token", async () => {
    const flow = new ZaiAuthFlow();
    flow._fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 500, success: false,
      data: { access_token: "secret-canary" } })));
    await expect(flow._fetchBizToken("fixture-oauth")).rejects.toThrow("code 500");
  });
  it("reads legacy business credentials without sending the static API key", async () => {
    const legacy = { accessToken: "static-key.secret", providerSpecificData: { authMethod: "cli_poll", zaiBusinessToken: "business-token" } };
    const fetch = vi.fn().mockResolvedValue(reply({ organizations: [] }));
    await resolveZcodeBusinessSession(legacy, null, fetch);
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe("business-token");
    expect(normalizeZaiCredentials(legacy).apiKey).toBe("static-key.secret");
    expect(legacy.accessToken).toBe("static-key.secret");
  });
  it("preserves string-valued system instructions", () => {
    expect(JSON.stringify(injectZcodeSystemPrompt({ system: "Keep this caller policy" }).system)).toContain("Keep this caller policy");
  });
  it("uses explicit plans independently of model names", () => {
    expect(resolveZaiPlanMode(credentials)).toBe("start-plan");
    const ex = new GlmExecutor();
    expect(ex.buildUrl("GLM-5.3", false, 0, credentials)).toContain("zcode-plan");
    expect(ex.buildUrl("glm-5.3", false, 0, { ...credentials, providerSpecificData: { zaiPlanMode: "api-key" } })).toContain("api.z.ai");
    expect(ex.getFallbackCount()).toBe(1);
  });
  it.each(["claude", "openai"])("normalizes final upstream-cased %s requests without replacing caller instructions", async (source) => {
    mocks.verification.mockResolvedValue({ skip_model_request: true });
    const c = structuredClone(credentials);
    const body = translateRequest(source, "claude", "GLM-5.3-Flash", {
      model: "glm-5.3-flash", messages: [...(source === "openai" ? [{ role: "system", content: "Caller policy" }] : []), { role: "user", content: "offline" }], ...(source === "claude" ? { system: "Caller policy" } : {}),
      reasoning_effort: "max", temperature: 0.7, top_p: 0.9, max_tokens: 1024,
    }, false, c, "glm", null, [], c.connectionId);
    const ex = new GlmExecutor(); ex.fetchUpstream = vi.fn().mockResolvedValue(reply({}));
    const out = await ex.execute({ model: "glm-5.3-flash", body, credentials: c, stream: false, providerSessionId: "sess_actual-conversation", glmMaxTokens: 1024 });
    expect(out.transformedBody.thinking).toEqual({ type: "enabled" });
    expect(out.transformedBody.output_config.effort).toBe("max");
    expect(out.transformedBody.max_tokens).toBe(1024);
    expect(out.transformedBody.temperature).toBeUndefined();
    expect(out.transformedBody.top_p).toBeUndefined();
    expect(JSON.stringify(out.transformedBody.system)).toContain("Caller policy");
    expect(JSON.stringify(out.transformedBody.system)).not.toContain("You are ZCode");
    expect(out.headers["x-session-id"]).toBe("actual-conversation");
  });
  it("does not send inference or launch a solver when verification is required", async () => {
    mocks.verification.mockResolvedValue({ enabled: true, skip_model_request: false });
    const ex = new GlmExecutor(); ex.fetchUpstream = vi.fn();
    const result = await ex.execute({ model: "glm-5.3-flash", body: {}, credentials });
    expect(result.response.status).toBe(403);
    expect(await result.response.text()).toContain("official ZCode app");
    expect(ex.fetchUpstream).not.toHaveBeenCalled();
  });
  it("does not spend an API key when the selected Start Plan login credential is missing", async () => {
    const ex = new GlmExecutor(); ex.fetchUpstream = vi.fn();
    const result = await ex.execute({ model: "glm-5.3", body: {},
      credentials: { apiKey: "fixture-static", providerSpecificData: { zaiPlanMode: "start-plan" } } });
    expect(result.response.status).toBe(403);
    expect(result.skipCredentialRefresh).toBe(true);
    expect(ex.fetchUpstream).not.toHaveBeenCalled();
  });
  it("redacts proxy transport errors", async () => {
    mocks.fetch.mockRejectedValueOnce(new Error("http://user:proxy-secret@proxy.test:3128"));
    await expect(new GlmExecutor().fetchUpstream("https://zcode.z.ai/test", {}, {}))
      .rejects.toThrow(/^Z.AI inference network request failed on the selected route$/);
  });
  it("pins inference to strict TLS and prevents redirects or proxy fallback", async () => {
    mocks.fetch.mockResolvedValue(reply({}));
    await new GlmExecutor().fetchUpstream("https://zcode.z.ai/test", {}, { connectionProxyEnabled: true });
    expect(mocks.fetch.mock.calls[0][1]).toMatchObject({ strictTls: true, redirect: "error" });
    expect(mocks.fetch.mock.calls[0][2].strictProxy).toBe(true);
  });
  it("selects only an explicitly owned team project and fails closed on a mismatch", async () => {
    const c = { ...credentials, connectionId: "team-fixture", providerSpecificData: {
      ...credentials.providerSpecificData, zaiPlanMode: "team-coding-plan", zaiOrganizationId: "org-team", zaiProjectId: "project-team",
    } };
    const fetch = vi.fn(async (url) => url.endsWith("getCustomerInfo")
      ? reply({ organizations: [{ organizationId: "org-team", projects: [{ projectId: "project-team", projectType: "2" }] }] })
      : url.endsWith("access_tokens") ? reply(token()) : reply([{ name: "zcode-api-key", apiKey: "key" }]));
    await getZcodeProjectToken(c, null, fetch);
    expect(fetch.mock.calls[1][0]).toContain("/org-team/projects/project-team/api_keys");
    const before = fetch.mock.calls.length;
    await expect(getZcodeProjectToken({ ...c, providerSpecificData: { ...c.providerSpecificData, zaiProjectId: "unowned" } }, null, fetch)).rejects.toThrow("No available");
    expect(fetch).toHaveBeenCalledTimes(before + 1);
    invalidateZcodeProjectToken(c);
  });
  it("refreshes near-expiry project credentials and invalidates rejected credentials without replay", async () => {
    const c = { ...credentials, connectionId: "expiring-fixture", providerSpecificData: { ...credentials.providerSpecificData, zaiPlanMode: "individual-coding-plan" } };
    let issuance = 0;
    mocks.fetch.mockImplementation(async (url) => url.endsWith("getCustomerInfo")
      ? reply({ organizations: [{ organizationId: "org", projects: [{ projectId: "project" }] }] })
      : url.endsWith("access_tokens") ? reply(token({ accessToken: `project-${++issuance}`, expiresIn: issuance === 1 ? 60 : 18000 }))
      : reply([{ name: "zcode-api-key", apiKey: "key" }]));
    const proxy = { strictProxy: true };
    await getZcodeProjectToken(c, proxy);
    await getZcodeProjectToken(c, proxy);
    expect(issuance).toBe(2);
    const ex = new GlmExecutor();
    ex.fetchUpstream = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));
    await ex.execute({ model: "glm-5.3", body: { messages: [] }, credentials: c, proxyOptions: proxy });
    expect(ex.fetchUpstream).toHaveBeenCalledTimes(1);
    await getZcodeProjectToken(c, proxy);
    expect(issuance).toBe(3);
    invalidateZcodeProjectToken(c, proxy);
  });
  it("caches project tokens only within the credential and route scope", async () => {
    const c = { ...credentials, providerSpecificData: { ...credentials.providerSpecificData, zaiPlanMode: "individual-coding-plan" } };
    const fetch = vi.fn(async (url) => url.endsWith("getCustomerInfo")
      ? reply({ organizations: [{ organizationId: "org", projects: [{ projectId: "project" }] }] })
      : url.endsWith("access_tokens") ? reply(token()) : reply([{ name: "zcode-api-key", apiKey: "key" }]));
    invalidateZcodeProjectToken(c);
    await getZcodeProjectToken(c, null, fetch);
    await getZcodeProjectToken(c, null, fetch);
    expect(fetch).toHaveBeenCalledTimes(3);
    invalidateZcodeProjectToken(c);
    await getZcodeProjectToken(c, null, fetch);
    expect(fetch).toHaveBeenCalledTimes(6);
  });
});
