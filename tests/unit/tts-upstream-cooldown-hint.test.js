// Special TTS adapters must surface upstream status + wait-header cooldownHint
// (no 429→502 degradation) through handleTtsCore.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleTtsCore } from "../../open-sse/handlers/ttsCore.js";

const originalFetch = global.fetch;

describe("TTS special adapters — 429 + Retry-After cooldownHint", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("OpenAI adapter (throwUpstreamError path) keeps 429 + cooldownHint", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { message: "Rate limit reached" } }),
        { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "30" } }
      )
    );

    const before = Date.now();
    const result = await handleTtsCore({
      provider: "openai",
      model: "tts-1/alloy",
      input: "hello",
      credentials: { apiKey: "test-key" },
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(429);
    expect(result.error).toBe("Rate limit reached");
    expect(result.cooldownHint).toBeTruthy();
    expect(result.cooldownHint).toMatchObject({
      source: "upstream-header",
      headerName: "Retry-After",
      format: "delta-seconds",
    });
    expect(result.cooldownHint.durationMs).toBeGreaterThanOrEqual(29_000);
    expect(result.cooldownHint.durationMs).toBeLessThanOrEqual(31_000);
    expect(result.cooldownHint.expiresAtMs).toBeGreaterThanOrEqual(before + 29_000);
  });

  it("MiniMax adapter (already-consumed body, makeUpstreamError) keeps 429 + cooldownHint", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ base_resp: { status_code: 1004, status_msg: "frequency limited" } }),
        { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "12" } }
      )
    );

    const result = await handleTtsCore({
      provider: "minimax",
      model: "speech-2.8-hd/English_expressive_narrator",
      input: "hello",
      credentials: { apiKey: "test-key" },
      responseFormat: "json",
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(429);
    expect(result.cooldownHint).toBeTruthy();
    expect(result.cooldownHint).toMatchObject({
      source: "upstream-header",
      headerName: "Retry-After",
      format: "delta-seconds",
    });
    expect(result.cooldownHint.durationMs).toBeGreaterThanOrEqual(11_000);
    expect(result.cooldownHint.durationMs).toBeLessThanOrEqual(13_000);
  });

  it("OpenAI adapter non-429 upstream error keeps upstream status, no hint", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { message: "Invalid API key" } }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await handleTtsCore({
      provider: "openai",
      model: "tts-1/alloy",
      input: "hello",
      credentials: { apiKey: "test-key" },
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toBe("Invalid API key");
    expect(result.cooldownHint).toBeNull();
  });
});
