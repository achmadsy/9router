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
  it("fails closed on old engines rather than turning rejudge into target execution", async () => {
    const { runProbeOnSidecar } = await import("../../src/lib/probe/sidecarClient.js");
    fetch.mockResolvedValue(Response.json({ status: "ok" }));
    await expect(runProbeOnSidecar({ operation: "rejudge", target: { endpoint: "https://target.example/v1", model: "m" } })).rejects.toThrow("engine update required");
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe("https://sidecar.internal/health");
  });
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

  it.each(["glm/glm-5", "glm-5.1", "z-ai/glm-5.2", "GLM/GLM-5.3", "glm/glm-5.3-flash"])("automatically samples %s with the fixed budget", async model => {
    const { runProbeOnSidecar } = await import("../../src/lib/probe/sidecarClient.js");
    fetch.mockResolvedValueOnce(Response.json({ capabilities: ["glm-distribution-v1"] }))
      .mockResolvedValueOnce(new Response(""));
    await runProbeOnSidecar({ config: { distributionSampling: false }, target: { endpoint: "https://target.example/v1", model } });
    expect(JSON.parse(fetch.mock.calls[1][1].body).distributionSampling).toEqual({ enabled: true, maxCalls: 51 });
  });

  it("forwards saved evidence but never enables fresh sampling during rejudge", async () => {
    const { runProbeOnSidecar } = await import("../../src/lib/probe/sidecarClient.js");
    fetch.mockResolvedValueOnce(Response.json({ capabilities: ["saved-result-replay", "glm-distribution-v1"] }))
      .mockResolvedValueOnce(new Response(""));
    const evidence = { version: 1, observations: [] };
    await runProbeOnSidecar({ operation: "rejudge", previousResults: [], savedDistributionEvidence: evidence,
      config: { distributionSampling: true }, target: { endpoint: "https://target.example/v1", model: "glm/glm-5.3" } });
    const body = JSON.parse(fetch.mock.calls[1][1].body);
    expect(body.savedDistributionEvidence).toEqual(evidence);
    expect(body).not.toHaveProperty("distributionSampling");
  });

  it("uses only the resolved target selector, never the claim or a caller sampling flag", async () => {
    const { runProbeOnSidecar } = await import("../../src/lib/probe/sidecarClient.js");
    fetch.mockResolvedValue(new Response(""));
    await runProbeOnSidecar({ config: { distributionSampling: true }, target: {
      endpoint: "https://target.example/v1", model: "other-model", claimedModel: "glm-5.3",
    } });
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(fetch.mock.calls[0][1].body)).not.toHaveProperty("distributionSampling");
  });

  it("rejects distribution features on old engines without starting a run", async () => {
    const { runProbeOnSidecar } = await import("../../src/lib/probe/sidecarClient.js");
    fetch.mockResolvedValue(Response.json({ capabilities: ["saved-result-replay"] }));
    await expect(runProbeOnSidecar({ config: { distributionSampling: true }, target: { endpoint: "https://target.example/v1", model: "glm/glm-5.3" } })).rejects.toThrow("engine update required");
    expect(fetch).toHaveBeenCalledOnce();
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
      requestRetries: 5,
    });
  });
});
