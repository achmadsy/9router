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

    expect(result.device_code).toMatch(/^(enhanced-|codebuff-cli-)/);
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
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toMatch(
      /^You are Buffy, the strategic coding assistant\./,
    );
    expect(body.messages[0].content).toContain(
      "This request is routed by 9Router through the Freebuff provider.",
    );
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
    expect(url).toBe("https://codebuff.com/api/v1/usage");
    expect(init.headers.Authorization).toBe("Bearer token-123");
    expect(JSON.parse(init.body)).toEqual({
      fingerprintId: "cli-usage",
      authToken: "token-123",
    });
  });
});
