import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Freebuff OAuth", () => {
  it("starts custom device login and echoes server HMAC inputs", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          loginUrl: "https://freebuff.com/login?code=abc",
          fingerprintHash: "hash-123",
          expiresAt: "2030-01-02T03:04:05.000Z",
          expiresInMs: 600000,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const { default: freebuff } = await import("../../src/lib/oauth/providers/freebuff.js");
    const result = await freebuff.requestDeviceCode({
      apiBaseUrl: "https://freebuff.com",
      initiateUrl: "https://freebuff.com/api/auth/cli/code",
    });

    // VansRouter parity: fingerprintId is crypto.randomUUID().
    expect(result.device_code).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result.verification_uri_complete).toBe(
      "https://freebuff.com/login?code=abc",
    );
    expect(result._freebuffFingerprintHash).toBe("hash-123");
    expect(result._freebuffExpiresAt).toBe("2030-01-02T03:04:05.000Z");
    expect(result.expires_in).toBe(600);

    const [, init] = globalThis.fetch.mock.calls[0];
    expect(JSON.parse(init.body).fingerprintId).toBe(result.device_code);
  });

  it("maps HTTP 401 to authorization_pending", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "not ready" }), { status: 401 }),
    );

    const { default: freebuff } = await import("../../src/lib/oauth/providers/freebuff.js");
    const result = await freebuff.pollToken(
      { statusUrl: "https://freebuff.com/api/auth/cli/status" },
      "enhanced-device",
      null,
      {
        _freebuffFingerprintHash: "hash-123",
        _freebuffExpiresAt: "2030-01-02T03:04:05.000Z",
      },
    );

    expect(result).toEqual({
      ok: false,
      data: { error: "authorization_pending" },
    });
  });

  it("maps nested user authToken and persists device mid", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          user: {
            id: "user-1",
            name: "Free Buff",
            email: "free@example.com",
            authToken: "token-123",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const { default: freebuff } = await import("../../src/lib/oauth/providers/freebuff.js");
    const polled = await freebuff.pollToken(
      { statusUrl: "https://freebuff.com/api/auth/cli/status" },
      "enhanced-device",
      null,
      {
        _freebuffFingerprintHash: "hash-123",
        _freebuffExpiresAt: "2030-01-02T03:04:05.000Z",
      },
    );
    const mapped = freebuff.mapTokens(polled.data);

    expect(mapped.accessToken).toBe("token-123");
    expect(mapped.email).toBe("free@example.com");
    expect(mapped.providerSpecificData).toMatchObject({
      userId: "user-1",
      fingerprintId: "enhanced-device",
      deviceMid: "enhanced-device",
    });
  });

  it("uses VansRouter-style UUID fingerprintId on login initiate", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          loginUrl: "https://freebuff.com/login?code=abc",
          fingerprintHash: "hash-123",
          expiresAt: "2030-01-02T03:04:05.000Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const { default: freebuff } = await import("../../src/lib/oauth/providers/freebuff.js");
    const result = await freebuff.requestDeviceCode({
      apiBaseUrl: "https://freebuff.com",
      initiateUrl: "https://freebuff.com/api/auth/cli/code",
    });

    expect(result.device_code).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result.device_code.startsWith("enhanced-")).toBe(false);
  });
});

describe("Freebuff inference protocol", () => {
  it("injects required free-mode session metadata", async () => {
    const { FreebuffExecutor } = await import("../../open-sse/executors/freebuff.js");
    const executor = new FreebuffExecutor();
    const body = executor.injectSessionMetadata(
      {
        model: "z-ai/glm-5.3-flash",
        messages: [{ role: "user", content: "hi" }],
        codebuff_metadata: { run_id: "caller-run" },
      },
      "instance-123",
      {
        id: "connection-1",
        providerSpecificData: { deviceMid: "enhanced-device" },
      },
      "server-run",
    );

    expect(body.codebuff_metadata).toMatchObject({
      freebuff_instance_id: "instance-123",
      cost_mode: "free",
      run_id: "server-run",
      client_id: "enhanced-device",
      llm_step_number: "1",
    });
    // VansRouter parity: stable per-execute trace id.
    expect(body.codebuff_metadata.trace_session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toMatch(
      /^You are Buffy, the strategic coding assistant\./,
    );
    expect(body.messages[0].content).toContain(
      "This request is routed by 9Router through the Freebuff provider.",
    );
  });

  it("matches VansRouter chat wire: end_turn, no-fallback provider, no reasoning knobs", async () => {
    const { FreebuffExecutor } = await import("../../open-sse/executors/freebuff.js");
    const executor = new FreebuffExecutor();
    const body = executor.injectSessionMetadata(
      {
        model: "z-ai/glm-5.3-flash",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "x", parameters: {} } }],
        reasoning_effort: "max",
        reasoning: { effort: "high" },
      },
      "instance-123",
      { id: "connection-1" },
      "server-run",
    );

    expect(body.tools.map((t) => t.function.name)).toContain("end_turn");
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.reasoning).toBeUndefined();
    expect(body.provider).toMatchObject({ allow_fallbacks: false });
  });

  it("claims sessions on the CLI route without wallet header (VansRouter parity)", async () => {
    const proxyFetch = await import("../../open-sse/utils/proxyFetch.js");
    const calls = [];
    const spy = vi.spyOn(proxyFetch, "proxyAwareFetch").mockImplementation(async (url, init) => {
      calls.push([url, init]);
      return new Response(
        JSON.stringify({ status: "active", instanceId: "i-1", model: "m", expiresAt: "2030-01-01T00:00:00.000Z" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    try {
      const { FreebuffExecutor } = await import("../../open-sse/executors/freebuff.js");
      const executor = new FreebuffExecutor();
      const session = await executor.ensureSession({
        credentials: { id: "c-adm", accessToken: "tok" },
        model: "z-ai/glm-5.3-flash",
        log: null,
      });
      expect(session.instanceId).toBe("i-1");
      expect(calls[0][0]).toBe("https://www.codebuff.com/api/v1/freebuff/session");
      expect(calls[0][1].headers["x-freebuff-wallet-spend-limit"]).toBeUndefined();
      expect(calls[0][1].headers["User-Agent"]).toBe("codebuff-cli/0.0.138");
    } finally {
      spy.mockRestore();
    }
  });

  it("only classifies gate codes when HTTP status also matches", async () => {
    const { __test__ } = await import("../../open-sse/executors/freebuff.js");

    expect(
      __test__.parseErrorGate(
        JSON.stringify({ error: "session_expired" }),
        410,
      ),
    ).toMatchObject({ code: "session_expired", endsTheSession: true });
    expect(
      __test__.parseErrorGate(
        JSON.stringify({ error: "session_expired" }),
        409,
      ),
    ).toBeNull();
    expect(
      __test__.parseErrorGate(
        JSON.stringify({ error: "session_limit_reached" }),
        409,
      ),
    ).toMatchObject({ endsTheSession: false });
  });

  it("maps every picker model to its upstream root agent id", async () => {
    const { __test__ } = await import("../../open-sse/executors/freebuff.js");

    // VansRouter parity: mapped free roots use base3-free-*.
    expect(__test__.rootAgentForModel("z-ai/glm-5.3-flash")).toBe(
      "base3-free-glm-5-3-flash",
    );
    expect(__test__.rootAgentForModel("deepseek/deepseek-v4-flash")).toBe(
      "base3-free-deepseek-flash",
    );
    expect(__test__.rootAgentForModel("mimo/mimo-v2.5")).toBe("base3-free-mimo");
    // Upstream's legacy-caller fallback for unmapped models.
    expect(__test__.rootAgentForModel("unknown/model")).toBe("base2-free");
    // Same-model reviewer pairing (session_model_mismatch guard).
    expect(__test__.reviewerAgentForModel("z-ai/glm-5.3-flash")).toBe(
      "code-reviewer-glm-5-3-flash",
    );
    expect(__test__.reviewerAgentForModel("unknown/model")).toBe(
      "code-reviewer-deepseek-flash",
    );
  });

  it("dedupes concurrent session claims for the same token+model (VansRouter inflight)", async () => {
    const proxyFetch = await import("../../open-sse/utils/proxyFetch.js");
    let resolveFirst;
    let calls = 0;
    const spy = vi.spyOn(proxyFetch, "proxyAwareFetch").mockImplementation(
      () =>
        new Promise((resolve) => {
          calls += 1;
          resolveFirst = () =>
            resolve(
              new Response(
                JSON.stringify({
                  status: "active",
                  instanceId: "i-dedupe",
                  model: "z-ai/glm-5.3-flash",
                  expiresAt: "2030-01-01T00:00:00.000Z",
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              ),
            );
        }),
    );
    try {
      const { FreebuffExecutor, __test__ } = await import("../../open-sse/executors/freebuff.js");
      __test__.sessionCache.clear();
      __test__.inflight.clear();
      const executor = new FreebuffExecutor();
      const creds = { id: "c-inflight", accessToken: "tok-inflight" };
      const p1 = executor.ensureSession({ credentials: creds, model: "z-ai/glm-5.3-flash", log: null });
      const p2 = executor.ensureSession({ credentials: creds, model: "z-ai/glm-5.3-flash", log: null });
      resolveFirst();
      const [a, b] = await Promise.all([p1, p2]);
      expect(calls).toBe(1);
      expect(a.instanceId).toBe("i-dedupe");
      expect(b.instanceId).toBe("i-dedupe");
      expect(__test__.inflight.size).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("builds agent steps with child run wiring like upstream addAgentStep", async () => {
    const { __test__ } = await import("../../open-sse/executors/freebuff.js");
    const step = __test__.makeAgentStep({
      stepNumber: 3,
      childRunIds: ["child-run-9"],
      messageId: "msg-1",
      startTime: new Date("2030-01-01T00:00:00Z"),
    });
    expect(step.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(step.stepNumber).toBe(3);
    expect(step.childRunIds).toEqual(["child-run-9"]);
    expect(step.messageId).toBe("msg-1");
    expect(step.status).toBe("completed");
    expect(step.startTime).toBe("2030-01-01T00:00:00.000Z");
  });
});

describe("Freebuff usage", () => {
  it("uses proxy-aware fetch contract and normalizes balance", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          type: "usage-response",
          usage: 2,
          remainingBalance: 3,
          balanceBreakdown: { free: 2, paid: 1 },
          next_quota_reset: "2030-01-02T08:00:00.000Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const { getFreebuffUsage } = await import("../../open-sse/services/usage/freebuff.js");
    const result = await getFreebuffUsage(
      "token-123",
      null,
      null,
      globalThis.fetch,
    );

    expect(result.quotas.balance).toMatchObject({
      used: 2,
      total: 5,
      remainingPercentage: 60,
      resetAt: "2030-01-02T08:00:00.000Z",
    });
    expect(result.quotas.balance_free.total).toBe(2);
    expect(result.quotas.balance_paid.total).toBe(1);

    const [url, init] = globalThis.fetch.mock.calls[0];
    // Quota poll is GET session status — POST /freebuff/session would claim
    // a session and burn a daily unit. Token travels as Bearer only.
    expect(url).toBe("https://www.codebuff.com/api/v1/freebuff/session");
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer token-123");
    expect(init.body).toBeUndefined();
  });
});
