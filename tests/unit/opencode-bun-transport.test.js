import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { timingSafeEqual } from "node:crypto";

const source = readFileSync(new URL("../../open-sse/services/opencodeBunTransport.js", import.meta.url), "utf8")
  .replace('import { timingSafeEqual } from "node:crypto";', "");
function helper() {
  const env = { OPENCODE_BUN_TRANSPORT_TOKEN: "test-token", HTTPS_PROXY: "http://env-proxy:8080", http_proxy: "http://env-proxy:8080", NO_PROXY: "opencode.ai" };
  let handler;
  const upstream = vi.fn(async () => new Response("data: ok\n\n", { headers: { "content-type": "text/event-stream" } }));
  vm.runInNewContext(source, { timingSafeEqual, process: { env, exit: () => { throw new Error("exit"); } },
    Bun: { serve: (options) => { expect(options.hostname).toBe("127.0.0.1"); handler = options.fetch; } },
    fetch: upstream, Request, Response, Headers, URL, Buffer, console: { log() {}, error() {} },
  });
  const invoke = (payload = {}, token = "test-token") => handler(new Request("http://127.0.0.1:20131/fetch", {
    method: "POST", headers: { "content-type": "application/json", "x-9r-bun-transport-token": token },
    body: JSON.stringify({ url: "https://opencode.ai/inference/openai/v1/chat/completions", method: "POST", body: "{}", ...payload }),
  }));
  return { env, upstream, invoke };
}

describe("OpenCode Bun helper security and routing", () => {
  it("clears inherited proxy environment only within its own process", async () => {
    const { env, upstream, invoke } = helper();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.http_proxy).toBeUndefined();
    expect(env.NO_PROXY).toBeUndefined();
    const result = await invoke();
    expect(result.status).toBe(200);
    expect(upstream.mock.calls[0][1].proxy).toBeUndefined();
    expect(upstream.mock.calls[0][1].redirect).toBe("manual");
    expect(upstream.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(upstream.mock.calls[0][1].tls).toBeUndefined();
    expect(upstream.mock.calls[0][1].headers.get("authorization")).toBeNull();
    expect(result.bodyUsed).toBe(false);
    expect(await result.text()).toBe("data: ok\n\n");
  });
  it("passes exact proxy credentials while keeping the header allowlist", async () => {
    const { upstream, invoke } = helper();
    await invoke({ proxyUrl: "http://account:secret@proxy.example:8080", headers: { authorization: "Bearer public", "x-custom-secret": "drop", "user-agent": "native" } });
    expect(upstream.mock.calls[0][1].proxy).toBe("http://account:secret@proxy.example:8080");
    expect(upstream.mock.calls[0][1].headers.get("authorization")).toBe("Bearer public");
    expect(upstream.mock.calls[0][1].headers.has("x-custom-secret")).toBe(false);
  });
  it("rejects a missing/wrong helper token before dispatch", async () => {
    const { upstream, invoke } = helper();
    expect((await invoke({}, "wrong")).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });
  it.each(["http://opencode.ai/inference/a", "https://other.example/inference/a", "https://opencode.ai/other", "https://opencode.ai:8443/inference/a"])("rejects disallowed target %s", async (url) => {
    const { upstream, invoke } = helper();
    expect((await invoke({ url })).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("rejects non-POST payloads and non-string bodies", async () => {
    const { upstream, invoke } = helper();
    expect((await invoke({ method: "GET" })).status).toBe(400);
    expect((await invoke({ body: {} })).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
  it.each([429, 307])("preserves provider %s without following or retrying", async (status) => {
    const { upstream, invoke } = helper();
    upstream.mockResolvedValue(new Response("provider", { status, headers: { location: "https://other.example", "retry-after": "32400" } }));
    const response = await invoke();
    expect(response.status).toBe(status);
    expect(response.headers.get("retry-after")).toBe("32400");
    expect(response.headers.has("x-9r-bun-transport-error")).toBe(false);
    expect(upstream).toHaveBeenCalledOnce();
  });
  it("does not expose proxy credentials or tokens in helper failure output", async () => {
    const { upstream, invoke } = helper();
    upstream.mockRejectedValue(new Error("http://account:secret@proxy.example test-token"));
    const response = await invoke();
    expect(response.status).toBe(502);
    expect(response.headers.get("x-9r-bun-transport-error")).toBe("1");
    expect(await response.text()).not.toMatch(/account|secret|test-token/);
  });
});
