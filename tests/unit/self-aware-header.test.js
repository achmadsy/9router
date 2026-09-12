// HIGH: upstream wait-header parser — formats, precedence, validation, quota-like statuses.
import { describe, it, expect } from "vitest";
import { parseWaitHeaderCooldown, parseRateLimitCooldown, isQuotaLikeStatus, SELF_AWARE_HEADER_ORDER, MAX_SELF_AWARE_COOLDOWN_MS } from "../../open-sse/utils/retryAfter.js";

const NOW = 1_700_000_000_000;

function headers(obj) {
  const map = Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (k) => map[k.toLowerCase()] ?? null };
}

describe("parseWaitHeaderCooldown — header precedence", () => {
  it("prefers Retry-After over all others", () => {
    const h = headers({
      "Retry-After": "10",
      "x-retry-after": "20",
      "x-ratelimit-reset-after": "30",
      "x-ratelimit-reset": "40",
    });
    const r = parseWaitHeaderCooldown(h, { status: 429, nowMs: NOW });
    expect(r).toMatchObject({ source: "upstream-header", headerName: "Retry-After", durationMs: 10_000, format: "delta-seconds" });
    expect(r.expiresAtMs).toBe(NOW + 10_000);
  });

  it("uses x-retry-after when Retry-After absent", () => {
    const h = headers({ "x-retry-after": "15" });
    const r = parseWaitHeaderCooldown(h, { status: 429, nowMs: NOW });
    expect(r).toMatchObject({ headerName: "x-retry-after", durationMs: 15_000 });
  });

  it("uses x-ratelimit-reset-after (OpenAI-style seconds) next", () => {
    const h = headers({ "x-ratelimit-reset-after": "2.5" });
    const r = parseWaitHeaderCooldown(h, { status: 429, nowMs: NOW });
    expect(r).toMatchObject({ headerName: "x-ratelimit-reset-after", durationMs: 2500, format: "delta-seconds" });
  });

  it("uses x-ratelimit-reset (absolute unix seconds) last", () => {
    const absSec = Math.floor(NOW / 1000) + 60;
    const h = headers({ "x-ratelimit-reset": String(absSec) });
    const r = parseWaitHeaderCooldown(h, { status: 429, nowMs: NOW });
    expect(r).toMatchObject({ headerName: "x-ratelimit-reset", format: "unix-seconds" });
    expect(r.durationMs).toBeCloseTo(absSec * 1000 - NOW, -2);
    expect(r.expiresAtMs).toBe(absSec * 1000);
  });

  it("HEADER order constant documented", () => {
    expect(SELF_AWARE_HEADER_ORDER).toEqual(["Retry-After", "x-retry-after", "x-ratelimit-reset-after", "x-ratelimit-reset"]);
  });
});

describe("parseWaitHeaderCooldown — formats", () => {
  it("parses integer delta-seconds", () => {
    const r = parseWaitHeaderCooldown(headers({ "Retry-After": "90" }), { status: 429, nowMs: NOW });
    expect(r.format).toBe("delta-seconds");
    expect(r.durationMs).toBe(90_000);
  });

  it("parses decimal delta-seconds", () => {
    const r = parseWaitHeaderCooldown(headers({ "Retry-After": "0.25" }), { status: 429, nowMs: NOW });
    expect(r.durationMs).toBe(250);
  });

  it("parses HTTP-date", () => {
    const date = new Date(NOW + 45_000).toUTCString();
    const r = parseWaitHeaderCooldown(headers({ "Retry-After": date }), { status: 429, nowMs: NOW });
    expect(r.format).toBe("http-date");
    expect(r.expiresAtMs).toBe(NOW + 45_000);
  });

  it("parses UNIX milliseconds when value looks like ms epoch", () => {
    const r = parseWaitHeaderCooldown(headers({ "x-ratelimit-reset": String(NOW + 30_000) }), { status: 429, nowMs: NOW });
    expect(r.format).toBe("unix-milliseconds");
    expect(r.expiresAtMs).toBe(NOW + 30_000);
  });
});

describe("parseWaitHeaderCooldown — validation rejects", () => {
  it("null headers → null", () => {
    expect(parseWaitHeaderCooldown(null, { status: 429, nowMs: NOW })).toBeNull();
  });

  it("empty value → null", () => {
    expect(parseWaitHeaderCooldown(headers({ "Retry-After": "  " }), { status: 429, nowMs: NOW })).toBeNull();
  });

  it("non-finite → null", () => {
    expect(parseWaitHeaderCooldown(headers({ "Retry-After": "abc" }), { status: 429, nowMs: NOW })).toBeNull();
  });

  it("zero → null", () => {
    expect(parseWaitHeaderCooldown(headers({ "Retry-After": "0" }), { status: 429, nowMs: NOW })).toBeNull();
  });

  it("negative → null", () => {
    expect(parseWaitHeaderCooldown(headers({ "Retry-After": "-5" }), { status: 429, nowMs: NOW })).toBeNull();
  });

  it("past HTTP-date → null", () => {
    const past = new Date(NOW - 60_000).toUTCString();
    expect(parseWaitHeaderCooldown(headers({ "Retry-After": past }), { status: 429, nowMs: NOW })).toBeNull();
  });

  it("over-cap duration → null", () => {
    const over = Math.ceil(MAX_SELF_AWARE_COOLDOWN_MS / 1000) + 10;
    expect(parseWaitHeaderCooldown(headers({ "Retry-After": String(over) }), { status: 429, nowMs: NOW })).toBeNull();
  });

  it("exactly at cap is accepted", () => {
    const at = Math.floor(MAX_SELF_AWARE_COOLDOWN_MS / 1000);
    const r = parseWaitHeaderCooldown(headers({ "Retry-After": String(at) }), { status: 429, nowMs: NOW });
    expect(r).not.toBeNull();
    expect(r.durationMs).toBeLessThanOrEqual(MAX_SELF_AWARE_COOLDOWN_MS);
  });
});

describe("parseWaitHeaderCooldown — status gating", () => {
  it("applies on HTTP 429", () => {
    expect(parseWaitHeaderCooldown(headers({ "Retry-After": "5" }), { status: 429, nowMs: NOW })).not.toBeNull();
  });

  it("applies on known quota-like 409 (antigravity quota exhaustion)", () => {
    expect(parseWaitHeaderCooldown(headers({ "Retry-After": "30" }), { status: 409, nowMs: NOW })).toMatchObject({
      headerName: "Retry-After",
      durationMs: 30_000,
    });
  });

  it("applies when errorText matches quota-like classification even if status is odd", () => {
    // e.g. some providers surface quota exhaustion as non-429 with quota text
    expect(parseWaitHeaderCooldown(
      headers({ "Retry-After": "10" }),
      { status: 400, errorText: "quota exceeded for this model", nowMs: NOW }
    )).not.toBeNull();
  });

  it("ignores HTTP 503 (generic unavailable)", () => {
    expect(parseWaitHeaderCooldown(headers({ "Retry-After": "5" }), { status: 503, nowMs: NOW })).toBeNull();
  });

  it("ignores HTTP 401", () => {
    expect(parseWaitHeaderCooldown(headers({ "Retry-After": "5" }), { status: 401, nowMs: NOW })).toBeNull();
  });

  it("ignores HTTP 500", () => {
    expect(parseWaitHeaderCooldown(headers({ "Retry-After": "5" }), { status: 500, nowMs: NOW })).toBeNull();
  });

  it("ignores unrelated 5xx even with a wait header present", () => {
    expect(parseWaitHeaderCooldown(headers({ "Retry-After": "60" }), { status: 502, nowMs: NOW })).toBeNull();
    expect(parseWaitHeaderCooldown(headers({ "Retry-After": "60" }), { status: 504, nowMs: NOW })).toBeNull();
  });

  it("parseRateLimitCooldown is a back-compat alias of parseWaitHeaderCooldown", () => {
    expect(parseRateLimitCooldown).toBe(parseWaitHeaderCooldown);
    const r = parseRateLimitCooldown(headers({ "Retry-After": "5" }), { status: 429, nowMs: NOW });
    expect(r).toMatchObject({ headerName: "Retry-After", durationMs: 5000 });
  });

  it("when first header invalid, falls through to next valid header", () => {
    const h = headers({ "Retry-After": "bogus", "x-retry-after": "7" });
    const r = parseWaitHeaderCooldown(h, { status: 429, nowMs: NOW });
    expect(r).toMatchObject({ headerName: "x-retry-after", durationMs: 7000 });
  });
});

describe("isQuotaLikeStatus", () => {
  it("429 and 409 are quota-like", () => {
    expect(isQuotaLikeStatus(429)).toBe(true);
    expect(isQuotaLikeStatus(409)).toBe(true);
  });

  it("quota-like error text matches even without 429", () => {
    expect(isQuotaLikeStatus(400, "quota exceeded")).toBe(true);
    expect(isQuotaLikeStatus(500, "rate limit reached")).toBe(true);
    expect(isQuotaLikeStatus(503, "overloaded, try later")).toBe(true);
  });

  it("unrelated statuses / neutral text stay false", () => {
    expect(isQuotaLikeStatus(401, "invalid api key")).toBe(false);
    expect(isQuotaLikeStatus(500, "internal server error")).toBe(false);
    expect(isQuotaLikeStatus(502, "bad gateway")).toBe(false);
    expect(isQuotaLikeStatus(503, "service unavailable")).toBe(false);
    expect(isQuotaLikeStatus(undefined)).toBe(false);
  });
});
