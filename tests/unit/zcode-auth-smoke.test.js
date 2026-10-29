import { describe, it, expect, vi, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyFetch: vi.fn(),
}));

// proxyAwareFetch captures global fetch at module load, so Start Plan billing
// calls must be routed through a module mock instead of vi.stubGlobal("fetch").
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.proxyFetch,
}));

const { ZaiAuthFlow } = await import("../../src/lib/zcode/auth.js");
const { createZaiSession, getZaiSession, deleteZaiSession } = await import("../../src/lib/zcode/sessions.js");

describe("zcode CLI poll oauth (zcode-api method)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    mocks.proxyFetch.mockReset();
  });

  it("generates poll token and session roundtrip", async () => {
    const flow = new ZaiAuthFlow();
    expect(flow.pollToken).toMatch(/^[a-f0-9]{64}$/);

    await createZaiSession({
      flowId: "flow-test-1",
      pollToken: flow.pollToken,
      provider: "zai",
    });
    const s = await getZaiSession("flow-test-1");
    expect(s?.flowId).toBe("flow-test-1");
    expect(s?.pollToken).toBe(flow.pollToken);
    await deleteZaiSession("flow-test-1");
    expect(await getZaiSession("flow-test-1")).toBeNull();
  });

  it("poll before start returns failed", async () => {
    const flow = new ZaiAuthFlow();
    const status = await flow.poll();
    expect(status.status).toBe("failed");
  });

  it("matches native init and poll wire requests", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          data: {
            flow_id: "flow-1",
            authorize_url: "https://zcode.z.ai/login?state=oauth-state",
            expires_at: Math.floor(Date.now() / 1000) + 300,
            poll_interval_sec: 1,
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          data: {
            status: "ready",
            token: "jwt-token",
            user: { user_id: "user-1", email: "test@example.com" },
            zai: { access_token: "zai-token", refresh_token: "ignored" },
          },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const pollToken = "a".repeat(64);
    const flow = new ZaiAuthFlow("https://zcode.z.ai/api/v1", pollToken);
    const init = await flow.start();
    const ready = await flow.poll();

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://zcode.z.ai/api/v1/oauth/cli/init"
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ provider: "zai" }),
    });
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      Authorization: `Bearer ${pollToken}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://zcode.z.ai",
      "User-Agent": "ZCode/3.16.3",
      "X-ZCode-App-Version": "3.16.3",
      "X-Title": "Z Code@electron",
      "X-Release-Channel": "production",
    });
    expect(fetchMock.mock.calls[0][1].headers["x-request-id"]).toMatch(
      /^[0-9a-f-]{36}$/i
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://zcode.z.ai/api/v1/oauth/cli/poll/flow-1"
    );
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "GET" });
    expect(fetchMock.mock.calls[1][1].headers).toMatchObject({
      Authorization: `Bearer ${pollToken}`,
      "User-Agent": "ZCode/3.16.3",
      "X-Title": "Z Code@electron",
    });
    const authorizeUrl = new URL(init.authorizeUrl);
    expect(authorizeUrl.searchParams.get("state")).toBe("oauth-state");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
      "https://zcode.z.ai/app/oauth/login?redirect=zcode%3A%2F%2Foauth%2Fcallback&app_version=3.16.3"
    );
    expect(init.startPlanAuthorizeUrl).toBeUndefined();
    expect(ready).toMatchObject({
      status: "ready",
      token: "jwt-token",
      zai: { access_token: "zai-token" },
      user: { user_id: "user-1" },
    });
    expect(ready.zai.refresh_token).toBeUndefined();
    expect(flow.nextPollDelayMs).toBe(1000);
  });

  it("claims the official Start Plan and verifies the active entitlement", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const activePlan = {
      plan_id: "zcode-v3-start-plan-1029",
      name: "Start Plan",
      status: "active",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 0, data: { plans: [] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          data: { plans: [{ plan_id: "zcode-v3-start-plan-1029", name: "Start Plan" }] },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 0, data: { plan: activePlan } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 0, data: { plans: [activePlan] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 0, data: { plans: [] } }),
      });
    vi.stubGlobal("fetch", fetchMock);
    mocks.proxyFetch.mockImplementation(fetchMock);

    await expect(new ZaiAuthFlow().initializeStartPlan("zcode-jwt")).resolves.toMatchObject({
      status: "claimed",
      planId: "zcode-v3-start-plan-1029",
    });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=3.16.3",
      "https://zcode.z.ai/api/v1/zcode-plan/billing/preview?app_version=3.16.3&platform=linux-x64",
      "https://zcode.z.ai/api/v1/zcode-plan/billing/claim",
      "https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=3.16.3",
      "https://zcode.z.ai/api/v1/zcode-plan/billing/preview?app_version=3.16.3&platform=linux-x64",
    ]);
    expect(fetchMock.mock.calls[2][1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ plan_id: "zcode-v3-start-plan-1029" }),
      headers: {
        Authorization: "Bearer zcode-jwt",
        "Content-Type": "application/json",
        "User-Agent": "ZCode/3.16.3",
        "X-ZCode-App-Version": "3.16.3",
        "X-Platform": "linux-x64",
      },
    });
    expect(infoSpy).toHaveBeenCalledWith(
      "[Start Plan] Created and verified",
      expect.objectContaining({
        provider: "zai",
        planId: "zcode-v3-start-plan-1029",
        status: "claimed",
      })
    );
    expect(JSON.stringify(infoSpy.mock.calls)).not.toContain("zcode-jwt");
  });

  it("does not claim when an active Start Plan already exists", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        code: 0,
        data: {
          plans: [{ plan_id: "zcode-v3-start-plan", name: "Start Plan", status: "active" }],
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    mocks.proxyFetch.mockImplementation(fetchMock);

    await expect(new ZaiAuthFlow().initializeStartPlan("zcode-jwt")).resolves.toMatchObject({
      status: "already_active",
      planId: "zcode-v3-start-plan",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/billing/claim"))).toBe(false);
    expect(infoSpy).toHaveBeenCalledWith(
      "[Start Plan] Active trial already present",
      expect.objectContaining({ status: "already_active" })
    );
  });

  it("rejects accounts without the official Start Plan preview", async () => {
    vi.useFakeTimers();
    try {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const fetchMock = vi.fn().mockImplementation(async (url) => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(
          url.includes("/billing/preview")
            ? { code: 0, data: { plans: [{ plan_id: "weekend-build", name: "Weekend Build" }] } }
            : { code: 0, data: { plans: [] } }
        ),
      }));
      vi.stubGlobal("fetch", fetchMock);
      mocks.proxyFetch.mockImplementation(fetchMock);

      const assertion = expect(new ZaiAuthFlow().initializeStartPlan("zcode-jwt")).rejects.toThrow(
        "No Start Plan is currently offered to this account"
      );
      await vi.advanceTimersByTimeAsync(31 * 1000);
      await assertion;

      // 1 initial inspection + 6 activation retries, never a claim
      expect(fetchMock).toHaveBeenCalledTimes(14);
      expect(fetchMock.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        "[Start Plan] Creation failed",
        expect.objectContaining({ reason: expect.stringContaining("No Start Plan is currently offered") })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("redacts provider errors while creating Start Plan", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.proxyFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        code: 1113,
        msg: "failed; bearer secret-token-value; jwt=eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.signature",
        access_token: "provider-access-token-canary",
      }),
    });

    await expect(new ZaiAuthFlow().initializeStartPlan("zcode-jwt")).rejects.toThrow("failed");

    const logs = JSON.stringify(warnSpy.mock.calls);
    expect(logs).toContain("[Start Plan] Creation failed");
    expect(logs).not.toContain("secret-token-value");
    expect(logs).not.toContain("provider-access-token-canary");
    expect(logs).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(logs).not.toContain("zcode-jwt");
  });

  it("does not expose malformed Start Plan response bodies", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.proxyFetch.mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => "Bearer malformed-secret-token eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.signature",
    });

    await expect(new ZaiAuthFlow().initializeStartPlan("zcode-jwt")).rejects.toThrow(
      "Invalid provider response"
    );

    const logs = JSON.stringify(warnSpy.mock.calls);
    expect(logs).not.toContain("malformed-secret-token");
    expect(logs).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("logs a safe reason when the Start Plan request fails before a response", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.proxyFetch.mockRejectedValue(
      new Error("network failure with bearer network-secret-token")
    );

    await expect(new ZaiAuthFlow().initializeStartPlan("zcode-jwt")).rejects.toThrow(
      "network failure"
    );

    expect(warnSpy).toHaveBeenCalledWith(
      "[Start Plan] Creation failed",
      expect.objectContaining({
        provider: "zai",
        reason: expect.stringContaining("network failure"),
      })
    );
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("network-secret-token");
  });

  it("uses the configured endpoint origin in native request headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        code: 0,
        data: {
          flow_id: "flow-custom",
          authorize_url: "https://login.example.test?state=oauth-state",
          expires_at: Math.floor(Date.now() / 1000) + 300,
          poll_interval_sec: 1,
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await new ZaiAuthFlow("https://custom-zcode.example/api/v1").start();

    expect(fetchMock.mock.calls[0][1].headers["HTTP-Referer"]).toBe(
      "https://custom-zcode.example"
    );
  });

  it("rejects invalid native polling timing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        code: 0,
        data: {
          flow_id: "flow-1",
          authorize_url: "https://zcode.z.ai/login?state=oauth-state",
          expires_at: Math.floor(Date.now() / 1000) + 300,
          poll_interval_sec: 0.5,
        },
      }),
    }));

    await expect(new ZaiAuthFlow().start()).rejects.toThrow("invalid response data");
  });

  it("rejects an incomplete native init envelope", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        code: 0,
        data: { flow_id: "flow-1", authorize_url: "https://zcode.z.ai/login" },
      }),
    }));

    await expect(new ZaiAuthFlow().start()).rejects.toThrow("invalid response data");
  });
});
