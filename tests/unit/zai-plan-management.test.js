import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  connections: [],
  pools: {},
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
      .mockResolvedValueOnce(response({ code: 0, data: { deliveries: [] } }));

    await expect(claimZaiPlan("jwt-secret", "unknown-plan")).rejects.toThrow(
      "not currently offered"
    );
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
  });

  it.each(["future-event-plan-2040", "zcode-v3-start-plan-1029"])("discovers dynamic campaign %s separately from original-plan preparation", async (planId) => {
    mocks.fetch
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { deliveries: [{ banner: {
        title: "Upstream Event Name", buttons: [{ action: { type: "claim_zcode_plan", args: { plan_id: planId } } }],
      } }] } }));
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
      } }] } }));
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
      .mockResolvedValueOnce(response({ code: 0, data: { plan: { plan_id: planId, status: "active" } } }))
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [{ plan_id: planId, status: "active" }] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [] } }));
    expect((await claimZaiPlan("selected-jwt", planId, proxy)).status).toBe("claimed");
    expect(mocks.fetch.mock.calls[3][1].body).toBe(JSON.stringify({ plan_id: planId }));
    for (const [, options, actualProxy] of mocks.fetch.mock.calls) {
      expect(options.headers.Authorization).toBe("Bearer selected-jwt");
      expect(actualProxy).toBe(proxy);
    }
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
      .mockResolvedValueOnce(response({ code: 0, data: { deliveries: [] } }));

    const apiResponse = await GET(
      new Request("http://localhost/api/providers/glm/zai-plans"),
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
    const result = await GET(new Request("http://localhost/api/providers/glm/zai-plans?page=99"), {
      params: Promise.resolve({ id: "glm" }),
    });
    const body = await result.json();
    expect(body).toMatchObject({ page: 3, pageSize: 10, totalPages: 3, totalAccounts: 23 });
    expect(body.accounts.map((account) => account.connectionId)).toEqual(["account-20", "account-21", "account-22"]);
    expect([...inspected].sort()).toEqual(["Bearer private-jwt-20", "Bearer private-jwt-21", "Bearer private-jwt-22"]);
    expect(mocks.fetch).toHaveBeenCalledTimes(9);
    expect(JSON.stringify(body)).not.toContain("private-jwt");
  });

  it("bulk-claims with each account's JWT and pool, skipping already-owned plans", async () => {
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
