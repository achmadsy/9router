import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.restoreAllMocks());

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  connections: [],
  pools: {},
  coordinator: null,
  captchaManager: {
    invalidate: vi.fn(),
    setProxy: vi.fn(),
    getVerifyParam: vi.fn(),
  },
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.fetch,
}));

vi.mock("../../src/lib/zcode/captcha-service.js", () => ({
  getCaptchaManager: () => mocks.captchaManager,
  getZcodeCaptchaPort: () => 30110,
}));

vi.mock("@/models", () => ({
  getProviderConnections: vi.fn(async ({ provider } = {}) =>
    mocks.connections.filter((connection) => !provider || connection.provider === provider)
  ),
  getProviderConnectionById: vi.fn(async (id) =>
    mocks.connections.find((connection) => connection.id === id) || null
  ),
  getProxyPoolById: vi.fn(async (id) => mocks.pools[id] || null),
}));

vi.mock("../../src/lib/zcode/planRequests.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, planRequestCoordinator: {
    run: (...args) => mocks.coordinator.run(...args),
    cooldown: () => mocks.coordinator.cooldown(),
    assertReady: () => mocks.coordinator.assertReady(),
    observeResponse: (...args) => mocks.coordinator.observeResponse(...args),
  } };
});

const { createPlanRequestCoordinator } = await import("../../src/lib/zcode/planRequests.js");
const { _clearPlanInspectionCacheForTests } = await import("../../src/lib/zcode/planInspections.js");
const { _clearZcodeBalancesForTests } = await import("../../src/lib/zcode/balances.js");
const { inspectZaiPlans, claimZaiPlan } = await import("../../src/lib/zcode/plans.js");
const { GET, POST } = await import("../../src/app/api/providers/[id]/zai-plans/route.js");

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const activePlan = {
  plan_id: "zcode-v3-start-plan",
  name: "Start Plan",
  status: "active",
};

beforeEach(() => {
  mocks.coordinator = createPlanRequestCoordinator({ intervalMs: 0 });
  _clearPlanInspectionCacheForTests();
  _clearZcodeBalancesForTests();
  mocks.fetch.mockReset();
  mocks.connections = [];
  mocks.pools = {};
  mocks.captchaManager.getVerifyParam.mockReset().mockResolvedValue("captcha-verify-param");
  mocks.captchaManager.invalidate.mockClear();
  mocks.captchaManager.setProxy.mockClear();
});

describe("Z.AI plan operations", () => {
  it("retrieves balance and account-specific offers without raw response fields", async () => {
    mocks.fetch
      .mockResolvedValueOnce(response({
        code: 0,
        data: {
          plans: [activePlan],
          balances: [{ show_name: "GLM-5.3", total_units: 3000000, remaining_units: 2500000 }],
        },
      }))
      .mockResolvedValueOnce(response({
        code: 0,
        data: {
          plans: [
            { plan_id: "zcode-v3-start-plan", name: "Start Plan" },
            { plan_id: "weekend-build", name: "Weekend Build", description: "Bonus" },
          ],
        },
      }));

    const result = await inspectZaiPlans("jwt-secret");

    expect(result.activePlans).toEqual([
      expect.objectContaining({ planId: "zcode-v3-start-plan", status: "active" }),
    ]);
    expect(result.offers).toEqual([
      expect.objectContaining({ planId: "zcode-v3-start-plan", claimable: false }),
      expect.objectContaining({ planId: "weekend-build", claimable: true }),
    ]);
    expect(result.balances[0]).toMatchObject({
      name: "GLM-5.3",
      total: 3000000,
      remaining: 2500000,
    });
    expect(JSON.stringify(result)).not.toContain("jwt-secret");
  });

  it.each([{}, { plans: null }])("accepts a native empty preview %j while keeping campaign offers separate", async (preview) => {
    mocks.fetch
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [] } }))
      .mockResolvedValueOnce(response({ code: 0, data: preview }))
      .mockResolvedValueOnce(response({ code: 0, data: { deliveries: [{ banner: { buttons: [{ action: { type: "claim_zcode_plan", args: { plan_id: "campaign-event" } } }] } }] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { deliveries: [] } }));
    const result = await inspectZaiPlans("own-jwt", null, undefined, { includeCampaigns: true, coordinator: mocks.coordinator });
    expect(result).toMatchObject({ inspectionStatus: "complete", balanceStatus: "available", offers: [{ planId: "campaign-event", source: "campaign" }] });
    expect(result.error).toBeUndefined();
  });

  it.each([[], { plans: {} }, { plans: "invalid" }])("keeps a genuinely malformed preview %j as a source-specific error", async (preview) => {
    mocks.fetch
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [] } }))
      .mockResolvedValueOnce(response({ code: 0, data: preview }))
      .mockResolvedValueOnce(response({ code: 0, data: { deliveries: [{ banner: { buttons: [{ action: { type: "claim_zcode_plan", args: { plan_id: "campaign-event" } } }] } }] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { deliveries: [] } }));
    const result = await inspectZaiPlans("own-jwt", null, undefined, { includeCampaigns: true, coordinator: mocks.coordinator });
    expect(result).toMatchObject({ inspectionStatus: "partial", errorSource: "preview", offers: [{ planId: "campaign-event", source: "campaign" }] });
    expect(result.error).toContain("Invalid plan preview");
    expect(result.errorReasonCode).toBeUndefined();
  });

  it.each([
    ["omitted", { code: 0 }, "missing"],
    ["null", { code: 0, data: null }, "null"],
  ])("reports a successful envelope with %s preview data as unavailable and logs only response types", async (_label, preview, dataType) => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.connections = [{ id: "one", provider: "glm", providerSpecificData: { zcodeJwtToken: "jwt-private-canary" } }];
    mocks.fetch
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [{ plan_id: "zcode-v3-start-plan-0817", status: "active" }] } }))
      .mockResolvedValueOnce(response(preview))
      .mockResolvedValueOnce(response({ code: 0, data: { deliveries: [{ banner: { buttons: [{ action: { type: "claim_zcode_plan", args: { plan_id: "event" } } }] } }] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { deliveries: [] } }));
    const get = () => GET(new Request("http://localhost/api/providers/glm/zai-plans?inspect=true"), { params: Promise.resolve({ id: "glm" }) });
    const body = await (await get()).json();
    expect(body.accounts[0]).toMatchObject({
      balanceStatus: "available", originalStartPlanActive: true,
      inspectionStatus: "partial", errorSource: "preview", errorReasonCode: "preview_missing_data",
      offers: [{ planId: "event", source: "campaign", claimable: true }],
    });
    expect(body.accounts[0].error).toContain("omitted preview data");
    expect(info).toHaveBeenCalledWith("[Plan Management] preview: response", expect.objectContaining({
      connectionId: "one", httpStatus: 200, providerCode: 0, dataType, plansType: "missing",
    }));
    expect(warn).toHaveBeenCalledWith("[Plan Management] preview: failed", expect.objectContaining({
      connectionId: "one", dataType, plansType: "missing",
    }));
    const cached = await (await get()).json();
    expect(cached.accounts[0].cached).toBe(true);
    expect(warn).toHaveBeenCalledWith("[Plan Management] inspection: failed", expect.objectContaining({
      connectionId: "one", cached: true, status: "partial", errorSource: "preview",
    }));
    expect(mocks.fetch).toHaveBeenCalledTimes(4);
    expect(mocks.fetch.mock.calls.every(([, options]) => options.method === "GET")).toBe(true);
    expect(JSON.stringify([...info.mock.calls, ...warn.mock.calls, body])).not.toContain("jwt-private-canary");
  });

  it("claims only a plan that preview offered to the account", async () => {
    mocks.fetch
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [], balances: [] } }))
      .mockResolvedValueOnce(response({
        code: 0,
        data: { plans: [{ plan_id: "weekend-build", name: "Weekend Build" }] },
      }))
      .mockResolvedValueOnce(response({ code: 0, data: { plan: { ...activePlan, plan_id: "weekend-build", name: "Weekend Build" } } }))
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [{ ...activePlan, plan_id: "weekend-build", name: "Weekend Build" }], balances: [] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [] } }));

    const result = await claimZaiPlan("jwt-secret", "weekend-build");

    expect(result.status).toBe("claimed");
    const claimCall = mocks.fetch.mock.calls[2];
    expect(claimCall[0]).toBe("https://zcode.z.ai/api/v1/zcode-plan/billing/claim");
    expect(claimCall[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ plan_id: "weekend-build" }),
    });
  });

  it("refuses an unoffered plan without calling claim", async () => {
    mocks.fetch
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [], balances: [] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { deliveries: [] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { deliveries: [] } }));

    await expect(claimZaiPlan("jwt-secret", "unknown-plan")).rejects.toThrow(
      "not currently offered"
    );
    expect(mocks.fetch).toHaveBeenCalledTimes(4);
  });

  it.each(["future-event-plan-2040", "zcode-v3-start-plan-1029"])("discovers dynamic campaign %s separately from original-plan preparation", async (planId) => {
    mocks.fetch
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { deliveries: [{ banner: {
        title: "Upstream Event Name", buttons: [{ action: { type: "claim_zcode_plan", args: { plan_id: planId } } }],
      } }] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { deliveries: [] } }));
    const result = await inspectZaiPlans("own-jwt", null, undefined, { includeCampaigns: true });
    expect(result.offers).toEqual([expect.objectContaining({ planId, name: "Upstream Event Name", claimable: true })]);
    expect(mocks.fetch.mock.calls.every(([, options]) => options.method === "GET")).toBe(true);
    expect(mocks.fetch.mock.calls[2][1].headers.Authorization).toBe("Bearer own-jwt");
  });

  it("uses raw id for image-only campaigns and excludes an already-present plan", async () => {
    const planId = "unmapped-future-event";
    mocks.fetch
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [{ plan_id: planId, status: "exhausted" }] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { deliveries: [{ banner: {
        buttons: [{ action: { type: "claim_zcode_plan", args: { plan_id: planId } } }],
      } }] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { deliveries: [] } }));
    const result = await inspectZaiPlans("own-jwt", null, undefined, { includeCampaigns: true });
    expect(result.offers[0]).toMatchObject({ planId, name: planId, claimable: false });
  });

  it("rechecks a campaign under the selected account before sending an explicit claim", async () => {
    const planId = "new-campaign-not-hardcoded";
    const proxy = { connectionProxyEnabled: true, connectionProxyUrl: "http://account-proxy.test" };
    mocks.fetch
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { deliveries: [{ banner: {
        buttons: [{ action: { type: "claim_zcode_plan", args: { plan_id: planId } } }],
      } }] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { deliveries: [] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { plan: { plan_id: planId, status: "active" } } }))
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [{ plan_id: planId, status: "active" }] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [] } }));
    expect((await claimZaiPlan("selected-jwt", planId, proxy)).status).toBe("claimed");
    expect(mocks.fetch.mock.calls[4][1].body).toBe(JSON.stringify({ plan_id: planId }));
    for (const [, options, actualProxy] of mocks.fetch.mock.calls) {
      expect(options.headers.Authorization).toBe("Bearer selected-jwt");
      expect(actualProxy).toBe(proxy);
    }
  });

  it("finds an offer only on seq=1 with sequential calls using the same JWT and proxy", async () => {
    const proxy = { connectionProxyEnabled: true, connectionProxyUrl: "http://selected.proxy.test" };
    let completedZero = false;
    mocks.fetch.mockImplementation(async (url, options, actualProxy) => {
      expect(options.headers.Authorization).toBe("Bearer exact-account-jwt");
      expect(actualProxy).toBe(proxy);
      expect(options.method).toBe("GET");
      if (!url.includes("/marketing/touch")) return response({ code: 0, data: { plans: [] } });
      const seq = new URL(url).searchParams.get("seq");
      if (seq === "0") { completedZero = true; return response({ code: 0, data: { deliveries: [] } }); }
      expect(completedZero).toBe(true);
      expect(seq).toBe("1");
      return response({ code: 0, data: { deliveries: [{ banner: { buttons: [
        { action: { type: "claim_zcode_plan", args: { plan_id: "new-weekend-event" } } },
        { action: { type: "claim_zcode_plan", args: { plan_id: "new-weekend-event" } } },
      ] } }] } });
    });
    const result = await inspectZaiPlans("exact-account-jwt", proxy, undefined, { includeCampaigns: true });
    expect(result.offers).toHaveLength(1);
    expect(result.offers[0]).toMatchObject({ planId: "new-weekend-event", claimable: true });
    expect(mocks.fetch.mock.calls.filter(([url]) => url.includes("/marketing/touch")).map(([url]) => new URL(url).searchParams.get("seq"))).toEqual(["0", "1"]);
  });

  it("skips re-claiming plans already in balance before checking campaign or captcha", async () => {
    mocks.fetch
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [{ plan_id: "owned-event", status: "active" }] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [] } }));
    expect((await claimZaiPlan("own-jwt", "owned-event")).status).toBe("already_active");
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.captchaManager.getVerifyParam).not.toHaveBeenCalled();
  });

  it("never auto-claims the 1029 promotion as the original Start Plan", async () => {
    mocks.fetch.mockResolvedValue(response({ code: 0, data: {
      plans: [{ plan_id: "zcode-v3-start-plan-1029", name: "ZCODE GLOBAL BUILD", status: "active" }],
    } }));
    await expect(claimZaiPlan("jwt-secret", null)).rejects.toThrow("Original daily Start Plan (0817) is not active");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch.mock.calls[0][0]).toContain("/billing/balance?");
  });

  it("verifies the captured original daily plan on a generic request", async () => {
    mocks.fetch
      .mockResolvedValueOnce(response({
        code: 0,
        data: { plans: [{ plan_id: "zcode-v3-start-plan-0817", name: "Start Plan", status: "active" }], balances: [] },
      }))
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [] } }));

    const result = await claimZaiPlan("jwt-secret", "zcode-v3-start-plan");

    expect(result.status).toBe("already_active");
    expect(result.planId).toBe("zcode-v3-start-plan-0817");
    expect(mocks.fetch.mock.calls.some(([, options]) => options?.body?.includes("claim"))).toBe(false);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("retries the claim with Aliyun captcha headers when Z.AI demands verification", async () => {
    const datedPlan = { plan_id: "zcode-v3-start-plan-1029", name: "ZCODE GLOBAL BUILD", status: "active" };
    mocks.fetch
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [], balances: [] } }))
      .mockResolvedValueOnce(response({
        code: 0,
        data: { plans: [{ plan_id: "zcode-v3-start-plan-1029", name: "Start Plan" }] },
      }))
      // First claim attempt: captcha gate
      .mockResolvedValueOnce(response({ code: 3007, msg: "captcha verify failed" }, 400))
      // Second attempt with verify param: success
      .mockResolvedValueOnce(response({ code: 0, data: { plan: datedPlan } }))
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [datedPlan], balances: [] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [datedPlan] } }));

    const result = await claimZaiPlan("jwt-secret", "zcode-v3-start-plan-1029", null, undefined, "http://proxy.test:8080");

    expect(result.status).toBe("claimed");
    expect(mocks.captchaManager.getVerifyParam).toHaveBeenCalledTimes(1);
    expect(mocks.captchaManager.setProxy).toHaveBeenCalledWith("http://proxy.test:8080");
    expect(mocks.captchaManager.invalidate).toHaveBeenCalledTimes(1);
    const retryCall = mocks.fetch.mock.calls[3];
    expect(retryCall[1].headers).toMatchObject({
      "X-Aliyun-Captcha-Verify-Param": "captcha-verify-param",
      "X-Aliyun-Captcha-Verify-Region": "sgp",
    });
  });
});

describe("Z.AI plan management API", () => {
  it("scopes account inspection to the provider page and never exposes JWTs", async () => {
    mocks.connections = [
      {
        id: "glm-1",
        provider: "glm",
        name: "Primary",
        email: "primary@example.test",
        isActive: true,
        providerSpecificData: { zcodeJwtToken: "jwt-primary" },
      },
      {
        id: "clone-1",
        provider: "glm-clone-test",
        name: "Clone",
        providerSpecificData: { zcodeJwtToken: "jwt-clone" },
      },
    ];
    mocks.fetch
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [activePlan], balances: [] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { deliveries: [] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { deliveries: [] } }));

    const apiResponse = await GET(
      new Request("http://localhost/api/providers/glm/zai-plans?inspect=true"),
      { params: Promise.resolve({ id: "glm" }) }
    );
    const body = await apiResponse.json();

    expect(apiResponse.status).toBe(200);
    expect(body.totalAccounts).toBe(1);
    expect(body.accounts[0]).toMatchObject({ connectionId: "glm-1", name: "Primary" });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("jwt-primary");
    expect(serialized).not.toContain("jwt-clone");
    expect(serialized).not.toContain("zcodeJwtToken");
  });

  it("paginates before any upstream inspection and clamps page ranges", async () => {
    mocks.connections = Array.from({ length: 23 }, (_, index) => ({
      id: `account-${String(index).padStart(2, "0")}`, provider: "glm", priority: index + 1,
      providerSpecificData: { zcodeJwtToken: `private-jwt-${index}` },
    }));
    const inspected = new Set();
    mocks.fetch.mockImplementation(async (url, options) => {
      inspected.add(options.headers.Authorization);
      return response({ code: 0, data: url.includes("/marketing/touch") ? { deliveries: [] } : { plans: [], balances: [] } });
    });
    const result = await GET(new Request("http://localhost/api/providers/glm/zai-plans?page=99&inspect=true"), {
      params: Promise.resolve({ id: "glm" }),
    });
    const body = await result.json();
    expect(body).toMatchObject({ page: 3, pageSize: 10, totalPages: 3, totalAccounts: 23 });
    expect(body.accounts.map((account) => account.connectionId)).toEqual(["account-20", "account-21", "account-22"]);
    expect([...inspected].sort()).toEqual(["Bearer private-jwt-20", "Bearer private-jwt-21", "Bearer private-jwt-22"]);
    expect(mocks.fetch).toHaveBeenCalledTimes(12);
    expect(JSON.stringify(body)).not.toContain("private-jwt");
  });

  it("lists and searches across all provider accounts without any upstream checks", async () => {
    mocks.connections = Array.from({ length: 23 }, (_, index) => ({
      id: `account-${String(index).padStart(2, "0")}`, provider: "glm", priority: index + 1,
      name: index >= 10 ? `Target ${index}` : `Other ${index}`,
      email: `user${index}@example.test`,
      providerSpecificData: { zcodeJwtToken: `private-jwt-${index}` },
    }));
    mocks.connections.push({ id: "clone", provider: "glm-clone-test", name: "Target clone" });
    const get = async (query = "") => (await GET(new Request(`http://localhost/api/providers/glm/zai-plans${query}`), {
      params: Promise.resolve({ id: "glm" }),
    })).json();
    const initial = await get();
    expect(initial).toMatchObject({ totalAccounts: 23, matchedAccounts: 23, totalPages: 3, page: 1 });
    expect(initial.accounts).toHaveLength(10);
    expect(initial.accounts.every((account) => account.inspectionStatus === "unchecked")).toBe(true);
    const filtered = await get("?search=%20TaRgEt%20&page=99");
    expect(filtered).toMatchObject({ totalAccounts: 23, matchedAccounts: 13, totalPages: 2, page: 2 });
    expect(filtered.accounts.map((account) => account.connectionId)).toEqual(["account-20", "account-21", "account-22"]);
    const email = await get("?search=USER22%40EXAMPLE.TEST&page=-5");
    expect(email).toMatchObject({ matchedAccounts: 1, page: 1, totalPages: 1 });
    expect(email.accounts[0].connectionId).toBe("account-22");
    const empty = await get("?search=no-match&inspect=true");
    expect(empty).toMatchObject({ matchedAccounts: 0, page: 1, totalPages: 1, accounts: [] });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(initial)).not.toMatch(/private-jwt|zcodeJwtToken/);
  });

  it("checks only the selected visible account and never a different provider or page", async () => {
    mocks.connections = Array.from({ length: 11 }, (_, index) => ({
      id: `account-${String(index).padStart(2, "0")}`, provider: "glm", priority: index + 1,
      providerSpecificData: { zcodeJwtToken: `private-jwt-${index}` },
    }));
    mocks.connections.push({ id: "clone", provider: "glm-clone-test", providerSpecificData: { zcodeJwtToken: "clone-secret" } });
    mocks.fetch.mockImplementation(async (url) => response({ code: 0, data: url.includes("/marketing/touch") ? { deliveries: [] } : { plans: [], balances: [] } }));
    const get = async (connectionId) => (await GET(new Request(`http://localhost/api/providers/glm/zai-plans?inspect=true&connectionId=${connectionId}`), {
      params: Promise.resolve({ id: "glm" }),
    })).json();
    const body = await get("account-03");
    expect(body.accounts.find((account) => account.connectionId === "account-03").inspectionStatus).toBe("complete");
    expect(body.accounts.filter((account) => account.inspectionStatus === "unchecked")).toHaveLength(9);
    expect(mocks.fetch).toHaveBeenCalledTimes(4);
    expect(mocks.fetch.mock.calls.every(([, options]) => options.headers.Authorization === "Bearer private-jwt-3")).toBe(true);
    mocks.fetch.mockClear();
    await get("account-10");
    await get("clone");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("bulk-claims with each account's JWT and pool, skipping already-owned plans", async () => {
    const infoLog = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.pools = {
      first: { id: "first", isActive: true, type: "http", strictProxy: true, proxyUrl: "http://first.proxy.test" },
      second: { id: "second", isActive: true, type: "http", strictProxy: true, proxyUrl: "http://second.proxy.test" },
    };
    mocks.connections = ["first", "second"].map((id) => ({
      id, provider: "glm", providerSpecificData: { zcodeJwtToken: `jwt-${id}`, proxyPoolId: id },
    }));
    let claimed = false;
    mocks.fetch.mockImplementation(async (url, options, proxy) => {
      const first = options.headers.Authorization === "Bearer jwt-first";
      expect(proxy.connectionProxyUrl).toBe(first ? "http://first.proxy.test" : "http://second.proxy.test");
      expect(proxy.strictProxy).toBe(true);
      if (url.includes("/billing/claim")) {
        expect(first).toBe(false);
        if (!options.headers["X-Aliyun-Captcha-Verify-Param"]) return response({ code: 3007, msg: "captcha" }, 400);
        claimed = true;
        return response({ code: 0, data: { plan: { plan_id: "event-plan", status: "active" } } });
      }
      if (url.includes("/marketing/touch")) return response({ code: 0, data: { deliveries: [{ banner: {
        buttons: [{ action: { type: "claim_zcode_plan", args: { plan_id: "event-plan" } } }],
      } }] } });
      return response({ code: 0, data: { plans: url.includes("/billing/balance") && (first || claimed)
        ? [{ plan_id: "event-plan", status: "active" }] : [] } });
    });
    const result = await POST(new Request("http://localhost/api/providers/glm/zai-plans", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionIds: ["first", "second"], planId: "event-plan" }),
    }), { params: Promise.resolve({ id: "glm" }) });
    const body = await result.json();
    expect(body.results.map((entry) => entry.status)).toEqual(["already_active", "claimed"]);
    expect(mocks.captchaManager.setProxy).toHaveBeenCalledWith("http://second.proxy.test");
    expect(JSON.stringify(body)).not.toMatch(/jwt-first|jwt-second|proxy.test/);
    expect(infoLog).toHaveBeenCalledWith("[Plan Management] batch: completed", expect.objectContaining({ total: 2, claimed: 1, skipped: 1, failed: 0 }));
    expect(infoLog).toHaveBeenCalledWith("[Plan Management] campaign: result", expect.objectContaining({ connectionId: "second", seq: 1, deliveryCount: 1 }));
    expect(warnLog).toHaveBeenCalledWith("[Plan Management] claim-api: failed", expect.objectContaining({ connectionId: "second", httpStatus: 400, providerCode: 3007 }));
    expect(new Set([...infoLog.mock.calls, ...warnLog.mock.calls].map(([, context]) => context.batchId)).size).toBe(1);
    expect(JSON.stringify([...infoLog.mock.calls, ...warnLog.mock.calls])).not.toMatch(/jwt-first|jwt-second|proxy.test|captcha-verify-param/);
  });

  it("prepares the original plan per account without persisting or returning the project token", async () => {
    const connection = {
      id: "glm-1", provider: "glm", accessToken: "business-token", apiKey: "existing-key.secret",
      providerSpecificData: { zcodeJwtToken: "permanent-jwt" },
    };
    mocks.connections = [connection];
    const before = structuredClone(connection);
    mocks.fetch
      .mockResolvedValueOnce(response({ code: 200, data: { organizations: [{ organizationId: "org", projects: [{ projectId: "project" }] }] } }))
      .mockResolvedValueOnce(response({ code: 200, data: [{ name: "zcode-api-key", apiKey: "key" }] }))
      .mockResolvedValueOnce(response({ code: 200, data: { enabled: true, accessToken: "five-hour-project-token", expiresIn: 18000 } }))
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [{ plan_id: "zcode-v3-start-plan-0817", status: "active" }] } }));
    const result = await POST(new Request("http://localhost/api/providers/glm/zai-plans", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionIds: ["glm-1"], action: "prepare_original_start_plan" }),
    }), { params: Promise.resolve({ id: "glm" }) });
    const body = await result.json();
    expect(body.results[0]).toMatchObject({ ok: true, planId: "zcode-v3-start-plan-0817" });
    expect(connection).toEqual(before);
    expect(JSON.stringify(body)).not.toMatch(/permanent-jwt|business-token|five-hour-project-token|existing-key/);
    expect(mocks.fetch.mock.calls[3][1].headers.Authorization).toBe("Bearer permanent-jwt");
    expect(mocks.fetch.mock.calls.some(([url]) => url.includes("/billing/claim"))).toBe(false);
  });

  it("stops all page inspections after a non-JSON 429 and leaves plan status unknown", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.connections = ["one", "two", "three"].map((id) => ({
      id, provider: "glm", providerSpecificData: { zcodeJwtToken: `jwt-${id}` },
    }));
    mocks.fetch.mockResolvedValue(new Response("<html>too many requests</html>", {
      status: 429, headers: { "Retry-After": "90" },
    }));
    const request = () => GET(new Request("http://localhost/api/providers/glm/zai-plans?inspect=true"), {
      params: Promise.resolve({ id: "glm" }),
    });
    const body = await (await request()).json();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(body.cooldownUntil).toBeGreaterThan(Date.now() + 85_000);
    for (const account of body.accounts) {
      expect(account).toMatchObject({ originalStartPlanActive: null, inspectionStatus: "unavailable", httpStatus: 429 });
      expect(account.error).toContain("cooldown");
      expect(account.error).not.toContain("Invalid provider response");
    }
    await request();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("preserves the original balance when campaign inspection gets a 429", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.connections = [{ id: "one", provider: "glm", providerSpecificData: { zcodeJwtToken: "own-jwt" } }];
    mocks.fetch
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [{ plan_id: "zcode-v3-start-plan-0817", status: "active" }], balances: [{ show_name: "GLM", remaining_units: 123 }] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [] } }))
      .mockResolvedValueOnce(new Response("wait", { status: 429 }));
    const body = await (await GET(new Request("http://localhost/api/providers/glm/zai-plans?inspect=true"), {
      params: Promise.resolve({ id: "glm" }),
    })).json();
    expect(body.accounts[0]).toMatchObject({ originalStartPlanActive: true, inspectionStatus: "partial", httpStatus: 429, balances: [{ name: "GLM", remaining: 123 }] });
    expect(body.accounts[0].campaignError).toContain("cooldown");
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
  });

  it("deduplicates concurrent page refreshes and reuses recent per-account results", async () => {
    mocks.connections = [{ id: "one", provider: "glm", providerSpecificData: { zcodeJwtToken: "own-jwt" } }];
    mocks.fetch.mockImplementation(async (url) => response({ code: 0, data: url.includes("/marketing/touch") ? { deliveries: [] } : { plans: [], balances: [] } }));
    const request = () => GET(new Request("http://localhost/api/providers/glm/zai-plans?inspect=true"), {
      params: Promise.resolve({ id: "glm" }),
    });
    await Promise.all([request(), request()]);
    const cached = await (await request()).json();
    expect(cached.accounts[0].cached).toBe(true);
    expect(mocks.fetch).toHaveBeenCalledTimes(4);
  });

  it("keeps an offer from seq0 when seq1 fails without claiming anything", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.fetch
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { deliveries: [{ banner: { buttons: [{ action: { type: "claim_zcode_plan", args: { plan_id: "event" } } }] } }] } }))
      .mockResolvedValueOnce(new Response("wait", { status: 429 }));
    const result = await inspectZaiPlans("own-jwt", null, undefined, { includeCampaigns: true, coordinator: mocks.coordinator });
    expect(result).toMatchObject({ offers: [{ planId: "event", claimable: true }], inspectionStatus: "partial", httpStatus: 429 });
    expect(mocks.fetch.mock.calls.every(([, options]) => options.method === "GET")).toBe(true);
  });

  it("treats a malformed balance as unknown instead of an inactive original plan", async () => {
    mocks.connections = [{ id: "one", provider: "glm", providerSpecificData: { zcodeJwtToken: "own-jwt" } }];
    mocks.fetch.mockImplementation(async (url) => response({ code: 0, data:
      url.includes("/marketing/touch") ? { deliveries: [] } : url.includes("/billing/preview") ? { plans: [] } : {} }));
    const body = await (await GET(new Request("http://localhost/api/providers/glm/zai-plans?inspect=true"), {
      params: Promise.resolve({ id: "glm" }),
    })).json();
    expect(body.accounts[0]).toMatchObject({ originalStartPlanActive: null, balanceStatus: "unavailable", inspectionStatus: "partial" });
  });

  it("invalidates the cached inspection after an explicit claim", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    mocks.connections = [{ id: "one", provider: "glm", providerSpecificData: { zcodeJwtToken: "own-jwt" } }];
    let claimed = false;
    mocks.fetch.mockImplementation(async (url) => {
      if (url.includes("/billing/claim")) {
        claimed = true;
        return response({ code: 0, data: { plan: { plan_id: "event", status: "active" } } });
      }
      if (url.includes("/marketing/touch")) return response({ code: 0, data: { deliveries: [] } });
      return response({ code: 0, data: { plans: url.includes("/billing/balance")
        ? claimed ? [{ plan_id: "event", status: "active" }] : []
        : claimed ? [] : [{ plan_id: "event" }] } });
    });
    const get = () => GET(new Request("http://localhost/api/providers/glm/zai-plans?inspect=true"), { params: Promise.resolve({ id: "glm" }) });
    await get();
    const result = await (await POST(new Request("http://localhost/api/providers/glm/zai-plans", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionIds: ["one"], planId: "event" }),
    }), { params: Promise.resolve({ id: "glm" }) })).json();
    expect(result.results[0].status).toBe("claimed");
    const after = await (await get()).json();
    expect(after.accounts[0]).toMatchObject({ cached: false, activePlans: [{ planId: "event", status: "active" }] });
    expect(after.accounts[0].offers).toEqual([]);
  });

  it.each([undefined, null, {}, { plans: "malformed" }])("claims a freshly verified campaign with preview %j and logs its result", async (preview) => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.connections = [{ id: "one", provider: "glm", providerSpecificData: { zcodeJwtToken: "own-jwt-canary" } }];
    mocks.fetch
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [] } }))
      .mockResolvedValueOnce(response({ code: 0, data: preview }))
      .mockResolvedValueOnce(response({ code: 0, data: { deliveries: [{ banner: { buttons: [{ action: { type: "claim_zcode_plan", args: { plan_id: "event" } } }] } }] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { deliveries: [] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { plan: { plan_id: "event", status: "active" } } }))
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [{ plan_id: "event", status: "active" }] } }))
      .mockResolvedValueOnce(response({ code: 0, data: {} }));
    const body = await (await POST(new Request("http://localhost/api/providers/glm/zai-plans", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionIds: ["one"], planId: "event" }),
    }), { params: Promise.resolve({ id: "glm" }) })).json();
    expect(body.results[0]).toMatchObject({ ok: true, status: "claimed" });
    expect(info).toHaveBeenCalledWith("[Plan Management] eligibility: verified", expect.objectContaining({ source: "campaign" }));
    expect(info).toHaveBeenCalledWith("[Plan Management] account: completed", expect.objectContaining({ connectionId: "one", status: "claimed" }));
    expect(JSON.stringify([...info.mock.calls, ...warn.mock.calls])).not.toContain("own-jwt-canary");
  });

  it("returns and logs the upstream claim rejection after an empty preview", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    mocks.connections = [{ id: "one", provider: "glm", providerSpecificData: { zcodeJwtToken: "own-jwt" } }];
    mocks.fetch
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [] } }))
      .mockResolvedValueOnce(response({ code: 0, data: {} }))
      .mockResolvedValueOnce(response({ code: 0, data: { deliveries: [{ banner: { buttons: [{ action: { type: "claim_zcode_plan", args: { plan_id: "event" } } }] } }] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { deliveries: [] } }))
      .mockResolvedValueOnce(response({ code: 1004, data: { message: "Not eligible for this campaign" } }));
    const body = await (await POST(new Request("http://localhost/api/providers/glm/zai-plans", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionIds: ["one"], planId: "event" }),
    }), { params: Promise.resolve({ id: "glm" }) })).json();
    expect(body.results[0]).toMatchObject({ ok: false, status: "failed", error: "Not eligible for this campaign" });
    expect(warn).toHaveBeenCalledWith("[Plan Management] account: failed", expect.objectContaining({ connectionId: "one", reason: "Not eligible for this campaign" }));
    expect(warn).toHaveBeenCalledWith("[Plan Management] claim-api: failed", expect.objectContaining({ providerCode: 1004 }));
  });

  it.each([undefined, null, { plans: {} }])("does not treat preview %j plus empty campaigns as verified ineligibility", async (preview) => {
    mocks.fetch
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [] } }))
      .mockResolvedValueOnce(response({ code: 0, data: preview }))
      .mockResolvedValueOnce(response({ code: 0, data: { deliveries: [] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { deliveries: [] } }));
    await expect(claimZaiPlan("own-jwt", "event", null, undefined, "", null, { coordinator: mocks.coordinator })).rejects.toThrow("Could not verify this offer");
    expect(mocks.fetch.mock.calls.some(([url]) => url.includes("/billing/claim"))).toBe(false);
  });

  it.each([401, 403, 429])("does not continue to campaign discovery or claim after preview HTTP %s", async (status) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.fetch
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [] } }))
      .mockResolvedValueOnce(response({ code: status, msg: "Preview rejected" }, status));
    await expect(claimZaiPlan("own-jwt", "event", null, undefined, "", null, { coordinator: mocks.coordinator }))
      .rejects.toMatchObject({ httpStatus: status });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.fetch.mock.calls.some(([url]) => url.includes("/marketing/touch") || url.includes("/billing/claim"))).toBe(false);
  });

  it("does not claim when ownership is unknown even if preview could offer the plan", async () => {
    mocks.fetch
      .mockResolvedValueOnce(response({ code: 0, data: {} }))
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [{ plan_id: "event" }] } }));
    await expect(claimZaiPlan("own-jwt", "event", null, undefined, "", null, { coordinator: mocks.coordinator }))
      .rejects.toThrow("Invalid plan balance response");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not replay a timed-out claim and marks the result uncertain", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.connections = [{ id: "one", provider: "glm", providerSpecificData: { zcodeJwtToken: "own-jwt" } }];
    mocks.fetch
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [{ plan_id: "event" }] } }))
      .mockRejectedValueOnce(new Error("timeout"));
    const body = await (await POST(new Request("http://localhost/api/providers/glm/zai-plans", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionIds: ["one"], planId: "event" }),
    }), { params: Promise.resolve({ id: "glm" }) })).json();
    expect(body.results[0]).toMatchObject({ ok: false, status: "uncertain" });
    expect(mocks.fetch.mock.calls.filter(([url]) => url.includes("/billing/claim"))).toHaveLength(1);
    expect(mocks.captchaManager.getVerifyParam).not.toHaveBeenCalled();
  });

  it("does not send requests for remaining bulk accounts after a claim gets a 429", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.connections = ["one", "two", "three"].map((id) => ({ id, provider: "glm", providerSpecificData: { zcodeJwtToken: `jwt-${id}` } }));
    mocks.fetch
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [{ plan_id: "event" }] } }))
      .mockResolvedValueOnce(new Response("wait", { status: 429, headers: { "Retry-After": "60" } }));
    const body = await (await POST(new Request("http://localhost/api/providers/glm/zai-plans", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionIds: ["one", "two", "three"], planId: "event" }),
    }), { params: Promise.resolve({ id: "glm" }) })).json();
    expect(body.results.map((entry) => entry.status)).toEqual(["failed", "not_attempted", "not_attempted"]);
    expect(body).toMatchObject({ failed: 1, notAttempted: 2, uncertain: 0 });
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    expect(body.cooldownUntil).toBeGreaterThan(Date.now());
    expect(JSON.stringify(body)).not.toContain("jwt-");
  });

  it("honors a provisioning 429 before sending further preparation requests", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.connections = ["one", "two"].map((id) => ({
      id, provider: "glm", accessToken: "business-secret", providerSpecificData: { zcodeJwtToken: `jwt-${id}` },
    }));
    mocks.fetch.mockResolvedValueOnce(new Response("upstream wait", { status: 429, headers: { "Retry-After": "75" } }));
    const body = await (await POST(new Request("http://localhost/api/providers/glm/zai-plans", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionIds: ["one", "two"], action: "prepare_original_start_plan" }),
    }), { params: Promise.resolve({ id: "glm" }) })).json();
    expect(body.results.map((entry) => entry.status)).toEqual(["failed", "not_attempted"]);
    expect(body.results[0]).toMatchObject({ httpStatus: 429 });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(body)).not.toContain("business-secret");
  });

  it("rejects claiming a connection from another provider page", async () => {
    mocks.connections = [{
      id: "clone-1",
      provider: "glm-clone-test",
      name: "Clone",
      providerSpecificData: { zcodeJwtToken: "jwt-clone" },
    }];

    const apiResponse = await POST(
      new Request("http://localhost/api/providers/glm/zai-plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionIds: ["clone-1"], planId: "zcode-v3-start-plan" }),
      }),
      { params: Promise.resolve({ id: "glm" }) }
    );
    const body = await apiResponse.json();

    expect(apiResponse.status).toBe(200);
    expect(body.results[0]).toMatchObject({ ok: false, error: "Connection not found for this provider" });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
