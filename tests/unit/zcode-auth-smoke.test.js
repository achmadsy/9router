import { describe, it, expect, vi, afterEach } from "vitest";
import { ZaiAuthFlow } from "../../src/lib/zcode/auth.js";
import { createZaiSession, getZaiSession, deleteZaiSession } from "../../src/lib/zcode/sessions.js";

describe("zcode CLI poll oauth (zcode-api method)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
      "User-Agent": "ZCode/3.11.2",
      "X-ZCode-App-Version": "3.11.2",
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
      "User-Agent": "ZCode/3.11.2",
      "X-Title": "Z Code@electron",
    });
    const authorizeUrl = new URL(init.authorizeUrl);
    expect(authorizeUrl.searchParams.get("state")).toBe("oauth-state");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
      "https://zcode.z.ai/app/oauth/login?redirect=zcode%3A%2F%2Foauth%2Fcallback&app_version=3.11.2"
    );
    expect(ready).toMatchObject({
      status: "ready",
      token: "jwt-token",
      zai: { access_token: "zai-token" },
      user: { user_id: "user-1" },
    });
    expect(ready.zai.refresh_token).toBeUndefined();
    expect(flow.nextPollDelayMs).toBe(1000);
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
