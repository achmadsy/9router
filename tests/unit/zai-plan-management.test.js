import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  connections: [],
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
  getProxyPoolById: vi.fn(async () => null),
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
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [] } }));

    await expect(claimZaiPlan("jwt-secret", "unknown-plan")).rejects.toThrow(
      "not currently offered"
    );
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("auto-selects the dated Start Plan campaign variant the account is offered", async () => {
    const datedPlan = { plan_id: "zcode-v3-start-plan-1029", name: "Start Plan", status: "active" };
    mocks.fetch
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [], balances: [] } }))
      .mockResolvedValueOnce(response({
        code: 0,
        data: { plans: [{ plan_id: "zcode-v3-start-plan-1029", name: "Start Plan" }] },
      }))
      .mockResolvedValueOnce(response({ code: 0, data: { plan: datedPlan } }))
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [datedPlan], balances: [] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [datedPlan] } }));

    const result = await claimZaiPlan("jwt-secret", null);

    expect(result.status).toBe("claimed");
    expect(result.planId).toBe("zcode-v3-start-plan-1029");
    expect(mocks.fetch.mock.calls[2][1].body).toBe(JSON.stringify({ plan_id: "zcode-v3-start-plan-1029" }));
  });

  it("treats any active dated Start Plan variant as already active on auto-claim", async () => {
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
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("retries the claim with Aliyun captcha headers when Z.AI demands verification", async () => {
    const datedPlan = { plan_id: "zcode-v3-start-plan-1029", name: "Start Plan", status: "active" };
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

    const result = await claimZaiPlan("jwt-secret", null, null, undefined, "http://proxy.test:8080");

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
      .mockResolvedValueOnce(response({ code: 0, data: { plans: [] } }));

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
