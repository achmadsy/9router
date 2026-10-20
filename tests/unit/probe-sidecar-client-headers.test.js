import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalUrl = process.env.PROBE_SIDECAR_URL;
const originalToken = process.env.PROBE_SIDECAR_TOKEN;

beforeEach(() => {
  process.env.PROBE_SIDECAR_URL = "https://sidecar.internal";
  process.env.PROBE_SIDECAR_TOKEN = "sidecar-control-token";
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalUrl === undefined) delete process.env.PROBE_SIDECAR_URL;
  else process.env.PROBE_SIDECAR_URL = originalUrl;
  if (originalToken === undefined) delete process.env.PROBE_SIDECAR_TOKEN;
  else process.env.PROBE_SIDECAR_TOKEN = originalToken;
});

describe("Probe sidecar custom-header payloads", () => {
  it("sends model headers in JSON without changing sidecar authorization", async () => {
    const { discoverModelsOnSidecar } = await import("../../src/lib/probe/sidecarClient.js");
    fetch.mockResolvedValue(Response.json({ models: [] }));

    await discoverModelsOnSidecar({
      baseUrl: "https://gateway.example/v1",
      apiKey: "upstream-key",
      customHeaders: { "User-Agent": "Probe Client/1.0", "X-Tenant": "acme" },
    });

    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe("https://sidecar.internal/v1/models");
    expect(options.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer sidecar-control-token",
    });
    expect(JSON.parse(options.body)).toEqual({
      baseUrl: "https://gateway.example/v1",
      apiKey: "upstream-key",
      customHeaders: { "User-Agent": "Probe Client/1.0", "X-Tenant": "acme" },
    });
  });

  it("keeps target and judge headers separate in run JSON", async () => {
    const { runProbeOnSidecar } = await import("../../src/lib/probe/sidecarClient.js");
    fetch.mockResolvedValue(new Response("", { status: 200 }));

    await runProbeOnSidecar({
      runId: "prun_test",
      target: {
        endpoint: "https://target.example/v1",
        model: "target-model",
        apiKey: "target-key",
        customHeaders: { "User-Agent": "Target Agent", "X-Target": "only-target" },
      },
      judge: {
        endpoint: "https://judge.example/v1",
        model: "judge-model",
        apiKey: "judge-key",
        customHeaders: { "User-Agent": "Judge Agent", "X-Judge": "only-judge" },
      },
    });

    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe("https://sidecar.internal/v1/runs");
    expect(options.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer sidecar-control-token",
      accept: "text/event-stream",
    });
    expect(JSON.parse(options.body)).toEqual({
      id: "prun_test",
      baseUrl: "https://target.example/v1",
      modelId: "target-model",
      apiKey: "target-key",
      customHeaders: { "User-Agent": "Target Agent", "X-Target": "only-target" },
      judge: {
        baseUrl: "https://judge.example/v1",
        modelId: "judge-model",
        apiKey: "judge-key",
        customHeaders: { "User-Agent": "Judge Agent", "X-Judge": "only-judge" },
      },
    });
  });
});
