// HIGH: resolveSelfAwareDecision — precedence, status gating, scopes, manual policy.
import { describe, it, expect } from "vitest";
import { resolveSelfAwareDecision, sanitizeReason, msUntilDailyReset } from "../../src/sse/services/selfAwareCooldown.js";

const NOW = 1_700_000_000_000;
const HINT = { source: "upstream-header", headerName: "Retry-After", expiresAtMs: NOW + 10_000, durationMs: 10_000 };

describe("resolveSelfAwareDecision — precedence", () => {
  it("valid upstream header wins over manual policy", () => {
    const d = resolveSelfAwareDecision({
      provider: "openai", model: "gpt-4o", status: 429,
      cooldownHint: HINT, manualPolicyMs: 60_000, nowMs: NOW,
    });
    expect(d).toMatchObject({ source: "upstream-header", cooldownMs: 10_000, expiresAt: new Date(NOW + 10_000).toISOString() });
  });

  it("manual policy used when no header (429)", () => {
    const d = resolveSelfAwareDecision({
      provider: "openai", model: "gpt-4o", status: 429,
      cooldownHint: null, manualPolicyMs: 45_000, nowMs: NOW,
    });
    expect(d).toMatchObject({ source: "manual-policy", cooldownMs: 45_000, scopeType: "account", scopeId: "account" });
  });

  it("manual policy does NOT apply to 401", () => {
    const d = resolveSelfAwareDecision({
      provider: "openai", model: "gpt-4o", status: 401,
      cooldownHint: null, manualPolicyMs: 45_000, nowMs: NOW,
    });
    expect(d.source).not.toBe("manual-policy");
    expect(d.cooldownMs).toBe(0);
    expect(d.shouldFallback).toBe(false);
  });

  it("manual policy does NOT apply to 5xx", () => {
    for (const status of [500, 502, 503, 504]) {
      const d = resolveSelfAwareDecision({
        provider: "p", model: "m", status,
        cooldownHint: null, manualPolicyMs: 45_000, nowMs: NOW,
      });
      expect(d.cooldownMs).toBe(0);
      expect(d.source === "manual-policy").toBe(false);
    }
  });

  it("manual policy wins over legacy resetsAtMs on 429 (plan precedence)", () => {
    const d = resolveSelfAwareDecision({
      provider: "codex", model: "gpt-5", status: 429,
      cooldownHint: null, resetsAtMs: NOW + 120_000, manualPolicyMs: 10_000, nowMs: NOW,
    });
    expect(d).toMatchObject({ source: "manual-policy", cooldownMs: 10_000, shouldFallback: true });
  });

  it("resetsAtMs used when no manual (legacy precise path)", () => {
    const d = resolveSelfAwareDecision({
      provider: "codex", model: "gpt-5", status: 429,
      cooldownHint: null, resetsAtMs: NOW + 120_000, manualPolicyMs: null, nowMs: NOW,
    });
    expect(d).toMatchObject({ cooldownMs: 120_000, shouldFallback: true, source: "provider-reset" });
  });

  it("no header, no manual, no resetsAt → no self-aware cooldown (caller falls back)", () => {
    const d = resolveSelfAwareDecision({
      provider: "p", model: "m", status: 429,
      cooldownHint: null, manualPolicyMs: null, nowMs: NOW,
    });
    expect(d).toMatchObject({ shouldFallback: false, cooldownMs: 0, source: null });
  });

  it("invalid/expired header hint ignored; manual applies", () => {
    const stale = { ...HINT, expiresAtMs: NOW - 1, durationMs: -1000 };
    const d = resolveSelfAwareDecision({
      provider: "p", model: "m", status: 429,
      cooldownHint: stale, manualPolicyMs: 30_000, nowMs: NOW,
    });
    expect(d.source).toBe("manual-policy");
    expect(d.cooldownMs).toBe(30_000);
  });
});

describe("resolveSelfAwareDecision — scopes", () => {
  it("default scope is account", () => {
    const d = resolveSelfAwareDecision({
      provider: "openai", model: "gpt-4o", status: 429,
      cooldownHint: HINT, scopeType: "account", scopeId: "conn-1", nowMs: NOW,
    });
    expect(d).toMatchObject({ scopeType: "account", scopeId: "conn-1" });
  });

  it("proxy scope when cooldownTarget provided (OpenCode)", () => {
    const d = resolveSelfAwareDecision({
      provider: "opencode", model: "glm-4.6", status: 429,
      cooldownHint: HINT,
      scope: { scopeType: "proxy", scopeId: "pool-a" },
      nowMs: NOW,
    });
    expect(d).toMatchObject({ scopeType: "proxy", scopeId: "pool-a", provider: "opencode" });
  });

  it("provider scope when requested (accountless non-OpenCode)", () => {
    const d = resolveSelfAwareDecision({
      provider: "ollama", model: "llama3", status: 429,
      cooldownHint: HINT,
      scope: { scopeType: "provider", scopeId: "provider" },
      nowMs: NOW,
    });
    expect(d).toMatchObject({ scopeType: "provider", scopeId: "provider" });
  });
});

describe("resolveSelfAwareDecision — cap and sanity", () => {
  it("caps duration at 30 days", () => {
    const huge = { source: "upstream-header", headerName: "Retry-After", expiresAtMs: NOW + 40 * 24 * 3600 * 1000, durationMs: 40 * 24 * 3600 * 1000 };
    const d = resolveSelfAwareDecision({
      provider: "p", model: "m", status: 429, cooldownHint: huge, nowMs: NOW,
    });
    expect(d.cooldownMs).toBeLessThanOrEqual(30 * 24 * 3600 * 1000);
  });

  it("header only honored for quota-like statuses (429/409 + quota text)", () => {
    const d = resolveSelfAwareDecision({
      provider: "p", model: "m", status: 503, cooldownHint: HINT, manualPolicyMs: 5000, nowMs: NOW,
    });
    expect(d.cooldownMs).toBe(0);
  });

  it("quota-like 409 honors header when no quotaResetMs", () => {
    const d = resolveSelfAwareDecision({
      provider: "antigravity", model: "m", status: 409, cooldownHint: HINT, manualPolicyMs: 5000, nowMs: NOW,
    });
    expect(d.source).toBe("upstream-header");
    expect(d.cooldownMs).toBe(10_000);
  });
});

describe("sanitizeReason — secret redaction", () => {
  it("redacts bearer tokens, API keys, and proxy URLs", () => {
    const s = sanitizeReason(
      "401 via proxy http://user:pass@proxy.example:8080 with Bearer abc123secret and sk-abcdef123456 ghp_ABCDEFGHIJKLMNOPQRSTUV xoxb-1234567890-abcdef"
    );
    expect(s).not.toMatch(/pass@/);
    expect(s).not.toMatch(/abc123secret/);
    expect(s).not.toMatch(/sk-abcdef123456/);
    expect(s).not.toMatch(/ghp_ABCDEFGHIJKLMNOPQRSTUV/);
    expect(s).not.toMatch(/xoxb-1234567890/);
    expect(s).toMatch(/REDACTED/);
    expect(s).toMatch(/proxy/);
  });

  it("strips control chars and caps length", () => {
    const s = sanitizeReason("rate\nlimit\u0000exceeded " + "x".repeat(400));
    expect(s).not.toMatch(/\u0000/);
    expect(s.length).toBeLessThanOrEqual(200);
  });

  it("null/empty → null", () => {
    expect(sanitizeReason(null)).toBeNull();
    expect(sanitizeReason("   ")).toBeNull();
  });
});

describe("msUntilDailyReset", () => {
  it("returns null for invalid hour/minute", () => {
    expect(msUntilDailyReset(24, 0)).toBeNull();
    expect(msUntilDailyReset(0, 60)).toBeNull();
    expect(msUntilDailyReset(null, 0)).toBeNull();
  });

  it("before target time today → remaining ms same day", () => {
    // Local midnight+1h = 01:00 target, now 00:00
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const ms = msUntilDailyReset(0, 30, now.getTime());
    expect(ms).toBe(30 * 60 * 1000);
  });

  it("after target time → wait until tomorrow", () => {
    const now = new Date();
    now.setHours(12, 0, 0, 0);
    const ms = msUntilDailyReset(0, 0, now.getTime());
    // ~12h remaining
    expect(ms).toBeGreaterThan(11 * 3600 * 1000);
    expect(ms).toBeLessThanOrEqual(12 * 3600 * 1000);
  });

  it("exactly on target → tomorrow (not 0)", () => {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const ms = msUntilDailyReset(0, 0, now.getTime());
    expect(ms).toBe(24 * 3600 * 1000);
  });
});

describe("resolveSelfAwareDecision — daily policy as manualPolicyMs", () => {
  it("applies computed daily duration as manual wait when no header", () => {
    const d = resolveSelfAwareDecision({
      provider: "opencode", model: "glm-4.6", status: 429,
      manualPolicyMs: 90 * 60 * 1000, // e.g. until next 00:00
      scope: { scopeType: "proxy", scopeId: "pool-a" },
      nowMs: NOW,
    });
    expect(d.source).toBe("manual-policy");
    expect(d.cooldownMs).toBe(90 * 60 * 1000);
    expect(d.scopeType).toBe("proxy");
    expect(d.scopeId).toBe("pool-a");
  });
});
