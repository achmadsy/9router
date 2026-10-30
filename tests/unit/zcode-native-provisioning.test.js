import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.fetch }));
const { enrollZcodeProject } = await import("../../src/lib/zcode/provisioning.js");
const { ZaiAuthFlow } = await import("../../src/lib/zcode/auth.js");
const { prepareOriginalStartPlan } = await import("../../src/lib/zcode/plans.js");

const reply = (data, code = 200) => new Response(JSON.stringify({ code, data }), { status: 200 });
const info = { organizations: [{ organizationId: "org/id", projects: [{ projectId: "project/id" }] }] };
const credentials = {
  apiKey: "existing-key.secret", accessToken: "business-token",
  providerSpecificData: { zcodeJwtToken: "permanent-login-jwt" },
};

afterEach(() => {
  mocks.fetch.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("native ZCode provisioning credential boundaries", () => {
  it("creates a usageScene 1 key and discards the five-hour project token", async () => {
    const snapshot = structuredClone(credentials);
    const proxy = { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.test", strictProxy: true };
    mocks.fetch
      .mockResolvedValueOnce(reply(info))
      .mockResolvedValueOnce(reply([]))
      .mockResolvedValueOnce(reply({ name: "zcode-api-key", apiKey: "native/key" }))
      .mockResolvedValueOnce(reply({ enabled: true, accessToken: "ephemeral-project-token", expiresIn: 18000 }));
    expect(await enrollZcodeProject(credentials, proxy)).toEqual({ enrolled: true });
    expect(credentials).toEqual(snapshot);
    expect(mocks.fetch.mock.calls[2][1].body).toBe(JSON.stringify({ name: "zcode-api-key", usageScene: 1 }));
    expect(mocks.fetch.mock.calls[3][0]).toContain("/org%2Fid/projects/project%2Fid/api_keys/native%2Fkey/access_tokens");
    expect(mocks.fetch.mock.calls[3][1].body).toBe(JSON.stringify({ clientType: "zcode", clientVersion: "3.16.3" }));
    for (const [, options, actualProxy] of mocks.fetch.mock.calls) {
      expect(actualProxy).toBe(proxy);
      expect(options.redirect).toBe("error");
      expect(options.headers.Authorization).not.toContain("ephemeral-project-token");
    }
  });

  it("reuses a generic same-name key without deleting or replacing it", async () => {
    mocks.fetch
      .mockResolvedValueOnce(reply(info))
      .mockResolvedValueOnce(reply([{ name: "zcode-api-key", apiKey: "generic-key", usageScene: -1 }]))
      .mockResolvedValueOnce(reply({ enabled: true, accessToken: "ephemeral-project-token" }));
    await enrollZcodeProject(credentials);
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    expect(mocks.fetch.mock.calls[2][0]).toContain("/generic-key/access_tokens");
    expect(mocks.fetch.mock.calls.filter(([, options]) => options.method === "POST")).toHaveLength(1);
  });

  it("never exposes credential endpoint error bodies or transport details", async () => {
    mocks.fetch.mockResolvedValueOnce(reply({ accessToken: "secret-canary" }, 3001));
    await expect(enrollZcodeProject(credentials)).rejects.toThrow("code 3001");
    mocks.fetch.mockRejectedValueOnce(new Error("https://user:secret-canary@proxy.test"));
    await expect(enrollZcodeProject(credentials)).rejects.toThrow(/^ZCode provisioning network request failed$/);
  });

  it("keeps the existing API-key, business-token and login-JWT exchange contract", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(reply({ access_token: "business-token" }))
      .mockResolvedValueOnce(reply(info))
      .mockResolvedValueOnce(reply([]))
      .mockResolvedValueOnce(reply({ apiKey: "native-key" }))
      .mockResolvedValueOnce(reply({ secretKey: "native-secret" }));
    vi.stubGlobal("fetch", fetch);
    const result = await new ZaiAuthFlow().exchangeForConnection("zai-oauth-token", "permanent-login-jwt");
    expect(result).toMatchObject({
      apiKey: "native-key.native-secret", accessToken: "business-token",
      providerSpecificData: { zcodeJwtToken: "permanent-login-jwt", zaiAccessToken: "zai-oauth-token" },
    });
    expect(result.expiresAt).toBeUndefined();
    expect(fetch.mock.calls[3][1].body).toBe(JSON.stringify({ name: "zcode-api-key", usageScene: 1 }));
  });

  it("logs API stages and empty balance under one attempt without credential values", async () => {
    const infoLog = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.fetch
      .mockResolvedValueOnce(reply(info))
      .mockResolvedValueOnce(reply([{ name: "zcode-api-key", apiKey: "key-secret-canary", usageScene: -1 }]))
      .mockResolvedValueOnce(reply({ enabled: true, accessToken: "project-secret-canary", expiresIn: 18000 }))
      .mockResolvedValueOnce(reply({ plans: [], balances: [] }, 0));
    await expect(prepareOriginalStartPlan({ ...credentials, id: "selected-connection" })).rejects.toThrow("not active");
    const calls = [...infoLog.mock.calls, ...warnLog.mock.calls];
    expect(new Set(calls.map(([, context]) => context.attempt)).size).toBe(1);
    expect(calls.every(([, context]) => context.connectionId === "selected-connection")).toBe(true);
    expect(calls).toContainEqual(["[Start Plan] project-token: result", expect.objectContaining({ enabled: true, tokenReturned: true, expiresIn: 18000, persisted: false })]);
    expect(calls).toContainEqual(["[Start Plan] balance: response", expect.objectContaining({ httpStatus: 200, providerCode: 0 })]);
    expect(calls).toContainEqual(["[Start Plan] balance: result", expect.objectContaining({ planCount: 0, originalPlanActive: false })]);
    expect(warnLog).toHaveBeenCalledWith("[Start Plan] preparation: failed", expect.objectContaining({ reason: expect.stringContaining("not active") }));
    const serialized = JSON.stringify(calls);
    for (const secret of ["key-secret-canary", "project-secret-canary", "business-token", "permanent-login-jwt", "existing-key.secret"]) expect(serialized).not.toContain(secret);
  });

  it("logs the rejected endpoint and provider code without raw error body", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.fetch.mockResolvedValueOnce(reply({ accessToken: "error-body-secret" }, 3001));
    await expect(prepareOriginalStartPlan(credentials)).rejects.toThrow("code 3001");
    expect(warnLog).toHaveBeenCalledWith("[Start Plan] customer-info: failed", expect.objectContaining({ httpStatus: 200, providerCode: 3001 }));
    expect(JSON.stringify(warnLog.mock.calls)).not.toContain("error-body-secret");
  });

  it("forwards manual Refresh All force to each quota fetch", () => {
    const source = readFileSync(new URL("../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js", import.meta.url), "utf8");
    const refreshAll = source.slice(source.indexOf("const refreshAll ="), source.indexOf("}, [refreshingAll"));
    expect(refreshAll).toContain("fetchQuota(conn.id, conn.provider, { force })");
    expect(source).toContain("onClick={() => refreshAll(true)}");
  });

  it("exposes a per-account Add Start Plan action separately from offer claiming", () => {
    const source = readFileSync(new URL("../../src/app/(dashboard)/dashboard/providers/[id]/ZaiPlanManagementModal.js", import.meta.url), "utf8");
    expect(source).toContain('"Add Start Plan"');
    expect(source).toContain('claim([account.connectionId], undefined, `original:${account.connectionId}`, "prepare_original_start_plan")');
    expect(source).toContain("it does not claim promotions or guarantee a grant");
  });
});
