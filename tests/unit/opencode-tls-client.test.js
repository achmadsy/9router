import { describe, it, expect, vi, beforeEach } from "vitest";

// The free gate keys on the TLS ClientHello: on one process and egress IP the
// same body/headers answered 429 over Node's OpenSSL fingerprint and 200 over
// the cipher list below. These tests pin the wiring, not the upstream.
const { createSessionMock, loadRuntimeDepMock } = vi.hoisted(() => ({
  createSessionMock: vi.fn(),
  loadRuntimeDepMock: vi.fn(),
}));

vi.mock("../../open-sse/services/lazyRuntime.js", () => ({
  loadRuntimeDep: loadRuntimeDepMock,
}));

describe("opencodeTlsClient", () => {
  beforeEach(async () => {
    vi.resetModules();
    createSessionMock.mockReset();
    loadRuntimeDepMock.mockReset();
    loadRuntimeDepMock.mockResolvedValue({ createSession: createSessionMock });
  });

  it("uses the cipher list the upstream accepts and sends ALPN-negotiated requests", async () => {
    const response = new Response("data: ok\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const fetchMock = vi.fn().mockResolvedValue(response);
    createSessionMock.mockResolvedValue({ fetch: fetchMock, close: vi.fn() });

    const { opencodeTlsFetch, __test__ } = await import("../../open-sse/services/opencodeTlsClient.js");
    const result = await opencodeTlsFetch("https://opencode.ai/inference/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(createSessionMock).toHaveBeenCalledTimes(1);
    const options = createSessionMock.mock.calls[0][0];
    expect(options.emulation.tlsOptions.cipherList).toBe(__test__.OPENCODE_CIPHER_LIST);
    // BoringSSL family list: AES-128-GCM first plus the legacy CBC entries the
    // upstream fingerprints on. Dropping any of them is refused upstream.
    expect(__test__.OPENCODE_CIPHER_LIST.split(":")).toHaveLength(17);
    expect(__test__.OPENCODE_CIPHER_LIST.startsWith("TLS_AES_128_GCM_SHA256")).toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://opencode.ai/inference/v1/chat/completions",
      expect.objectContaining({ method: "POST", body: "{}" })
    );
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toBe("text/event-stream");
  });

  it("does not follow redirects when forwarding request content", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 307,
      headers: { location: "https://other.example/collect" },
    }));
    createSessionMock.mockResolvedValue({ fetch: fetchMock, close: vi.fn() });

    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");
    const result = await opencodeTlsFetch("https://opencode.ai/inference/v1/chat/completions", {
      method: "POST", body: "private request content",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1].redirect).toBe("manual");
    expect(createSessionMock.mock.calls[0][0].insecure).not.toBe(true);
    expect(result.status).toBe(307);
    expect(result.headers.get("location")).toBe("https://other.example/collect");
  });

  it("returns the live stream without reading or buffering it", async () => {
    let controller;
    const stream = new ReadableStream({
      start(value) { controller = value; },
    });
    const upstream = new Response(stream, { headers: { "content-type": "text/event-stream" } });
    const fetchMock = vi.fn().mockResolvedValue(upstream);
    createSessionMock.mockResolvedValue({ fetch: fetchMock, close: vi.fn() });

    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");
    const result = await opencodeTlsFetch("https://opencode.ai/inference/v1/chat/completions", {});

    expect(result.body).toBe(upstream.body);
    expect(upstream.bodyUsed).toBe(false);
    const reader = result.body.getReader();
    controller.enqueue(new TextEncoder().encode("data: first\n\n"));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
    controller.close();
    expect((await reader.read()).done).toBe(true);
    reader.releaseLock();
  });

  it("reuses one session across requests", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response("ok", { status: 200 }));
    createSessionMock.mockResolvedValue({ fetch: fetchMock, close: vi.fn() });

    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");
    await opencodeTlsFetch("https://opencode.ai/a", {});
    await opencodeTlsFetch("https://opencode.ai/b", {});

    expect(createSessionMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces an actionable error when wreq-js is unavailable", async () => {
    loadRuntimeDepMock.mockRejectedValue(new Error("MODULE_NOT_FOUND"));

    const { opencodeTlsFetch, OpencodeTlsUnavailableError } = await import(
      "../../open-sse/services/opencodeTlsClient.js"
    );

    await expect(opencodeTlsFetch("https://opencode.ai/a", {})).rejects.toBeInstanceOf(
      OpencodeTlsUnavailableError
    );
  });

  it("forwards the abort signal so a cancelled stream stops upstream", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response("ok", { status: 200 }));
    createSessionMock.mockResolvedValue({ fetch: fetchMock, close: vi.fn() });

    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");
    const controller = new AbortController();
    await opencodeTlsFetch("https://opencode.ai/a", {}, { signal: controller.signal });

    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });
});
