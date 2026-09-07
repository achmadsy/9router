import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import * as sentryLib from "@/lib/sentry.js";
import {
  normalizeIssueTitle,
  extractOriginFromStack,
} from "@/lib/sentry.js";

// Top-level mock of the Sentry SDK so captureMessage/captureException tests
// observe scope.fingerprint without any network/DSN. Holder is hoisted with
// the mock so the factory can reference it.
const sentryMock = vi.hoisted(() => ({ scope: null, events: [], initOptions: null }));
vi.mock("@sentry/node", () => ({
  init: (opts) => {
    sentryMock.initOptions = opts;
  },
  getClient: () => null,
  withScope: (fn) => sentryMock.scope && fn(sentryMock.scope),
  captureMessage: (msg) => sentryMock.events.push({ message: msg }),
  captureException: (err) => sentryMock.events.push({ exception: err }),
}));

describe("normalizeIssueTitle — Sentry issue grouping", () => {
  it("empties ID-like bracketed content (user example)", () => {
    expect(normalizeIssueTitle("xxx [1234-123]4")).toBe("xxx []");
    expect(normalizeIssueTitle("Upload failed [3f2a9b1c-d4e5-4f6a-8b7c-9d0e1f2a3b4c]")).toBe(
      "Upload failed []"
    );
    expect(normalizeIssueTitle("sync error [8842719]")).toBe("sync error []");
  });

  it("normalizes distinct IDs to identical titles so they group into one issue", () => {
    const a = normalizeIssueTitle("request 9918273645 failed");
    const b = normalizeIssueTitle("request 4455127890 failed");
    expect(a).toBe("request [ID] failed");
    expect(a).toBe(b);
  });

  it("normalizes timestamps, durations and attempt counters", () => {
    expect(normalizeIssueTitle("locked rate_limit 300s [429] at 2026-09-07T15:40:33Z")).toBe(
      "locked rate_limit Ns [429] at [TIME]"
    );
    expect(normalizeIssueTitle("retry attempt 3/5 after 1200ms")).toBe("retry attempt N/N after Nms");
    expect(normalizeIssueTitle("cooldown for 300s")).toBe("cooldown for Ns");
    expect(normalizeIssueTitle("took 1.5h to complete")).toBe("took Nh to complete");
  });

  it("normalizes retry/attempt phrasing both word orders", () => {
    expect(normalizeIssueTitle("failed after 3 attempts")).toBe("failed after N attempts");
    expect(normalizeIssueTitle("onboardUser attempt 12 aborted")).toBe("onboardUser attempt N aborted");
  });

  it("normalizes hash-like ids", () => {
    expect(normalizeIssueTitle("bad entry #a1f3e2")).toBe("bad entry #[ID]");
    expect(normalizeIssueTitle("token abc0def1ghi expired")).toBe("token abc0def1ghi expired"); // g,h,i non-hex → kept
  });

  it("preserves provider, model and status vocabulary needed debugging", () => {
    expect(normalizeIssueTitle("[CHAT] [codex/gpt-5] quota exhausted (429)")).toBe(
      "[CHAT] [codex/gpt-5] quota exhausted (429)"
    );
    expect(normalizeIssueTitle("❌ antigravity [403]: captcha required")).toBe(
      "❌ antigravity [403]: captcha required"
    );
    expect(normalizeIssueTitle("[TOKEN_REFRESH] Codex refresh token already used or invalid. Re-auth required.")).toBe(
      "[TOKEN_REFRESH] Codex refresh token already used or invalid. Re-auth required."
    );
  });

  it("preserves common error numbers below 6 digits (HTTP statuses, ports, version fragments)", () => {
    expect(normalizeIssueTitle("connect ECONNREFUSED 127.0.0.1:20128")).toBe(
      "connect ECONNREFUSED 127.0.0.1:20128"
    );
    expect(normalizeIssueTitle("ZCode upstream triggered Aliyun verification/captcha")).toBe(
      "ZCode upstream triggered Aliyun verification/captcha"
    );
  });

  it("empties ID-like bracketed content with dash/underscore ids, keeps vocabulary", () => {
    expect(normalizeIssueTitle("xxx [req-1234-123]4")).toBe("xxx []");
    expect(normalizeIssueTitle("capture failed [capture-xyz-98765]")).toBe("capture failed []");
    expect(normalizeIssueTitle("[CHAT] [codex/gpt-5] quota exhausted (429)")).toBe(
      "[CHAT] [codex/gpt-5] quota exhausted (429)"
    );
    expect(normalizeIssueTitle("[TOKEN_REFRESH] refresh aborted")).toBe("[TOKEN_REFRESH] refresh aborted");
  });

  it("empties word-stem IDs even when they start with a model prefix", () => {
    expect(normalizeIssueTitle("failed [gpt-request-98765]")).toBe("failed []");
    expect(normalizeIssueTitle("failed [seed-session-98765]")).toBe("failed []");
    expect(normalizeIssueTitle("failed [claude-job-123456]")).toBe("failed []");
  });

  it("preserves version-shaped model names after known prefixes", () => {
    expect(normalizeIssueTitle("failed [gpt-5]")).toBe("failed [gpt-5]");
    expect(normalizeIssueTitle("failed [gpt-4.1-mini]")).toBe("failed [gpt-4.1-mini]");
    expect(normalizeIssueTitle("failed [o3-mini]")).toBe("failed [o3-mini]");
    expect(normalizeIssueTitle("failed [seed-2-0-code-preview-260328]")).toBe(
      "failed [seed-2-0-code-preview-260328]"
    );
  });

  it("empties whole-token bracketed UUIDs without changing standalone UUID normalization", () => {
    const uuid = "abcdef12-abcd-abcd-abcd-abcdefabcdef";
    expect(normalizeIssueTitle(`failed [${uuid}]`)).toBe("failed []");
    expect(normalizeIssueTitle(`failed ${uuid}`)).toBe("failed [ID]");
  });

  it("preserves model/version-shaped tokens (dash-joined, letters + digits)", () => {
    expect(normalizeIssueTitle("model claude-code-20250219 rejected")).toBe(
      "model claude-code-20250219 rejected"
    );
    expect(normalizeIssueTitle("no such model seed-2-0-code-preview-260328")).toBe(
      "no such model seed-2-0-code-preview-260328"
    );
    // standalone digit runs still collapse
    expect(normalizeIssueTitle("request 9918273645 failed")).toBe("request [ID] failed");
  });

  it("fail-opens: non-string and degenerate inputs returned untouched", () => {
    expect(normalizeIssueTitle("")).toBe("");
    expect(normalizeIssueTitle(null)).toBe(null);
    expect(normalizeIssueTitle(undefined)).toBe(undefined);
    expect(normalizeIssueTitle(42)).toBe(42);
  });
});

describe("extractOriginFromStack — caller file/line for Sentry tags", () => {
  const wrapperStack = [
    "Error: boom",
    "    at captureMessage (/home/ubuntu/9router-fork/src/lib/sentry.js:306:15)",
    "    at warn (/home/ubuntu/9router-fork/src/sse/utils/logger.js:91:11)",
    "    at markAccountUnavailable (/home/ubuntu/9router-fork/src/sse/services/auth.js:280:5)",
    "    at async ChatHandler.handle (/home/ubuntu/9router-fork/src/sse/handlers/chat.js:332:9)",
  ].join("\n");

  const consoleStack = [
    "Error: rate limit",
    "    at Array.console.error (/home/ubuntu/9router-fork/src/lib/consoleLogBuffer.js:96:20)",
    "    at refreshTokens (/home/ubuntu/9router-fork/open-sse/services/tokenRefresh/providers.js:120:9)",
  ].join("\n");

  const arrowStack = [
    "Error: captcha",
    "    at Object.execute (/x/node_modules/@sentry/node/build/cjs/xyz.js:5:1)",
    "    at execute (/home/ubuntu/9router-fork/open-sse/executors/zcode.js:151:7)",
  ].join("\n");

  it("skips wrapper frames (sentry.js, logger.js) and returns first app frame", () => {
    const origin = extractOriginFromStack(wrapperStack);
    expect(origin).toEqual({ file: "src/sse/services/auth.js", line: 280 });
  });

  it("skips consoleLogBuffer wrapper and @sentry internals", () => {
    expect(extractOriginFromStack(consoleStack)).toEqual({
      file: "open-sse/services/tokenRefresh/providers.js",
      line: 120,
    });
    expect(extractOriginFromStack(arrowStack)).toEqual({
      file: "open-sse/executors/zcode.js",
      line: 151,
    });
  });

  it("returns null for empty/invalid stacks (fail-open)", () => {
    expect(extractOriginFromStack(null)).toBeNull();
    expect(extractOriginFromStack("")).toBeNull();
    expect(extractOriginFromStack("no frames here")).toBeNull();
  });

  it("skips wrappers on Windows (backslash) stacks and relativizes origin", () => {
    const winStack = [
      "Error: boom",
      "    at captureMessage (C:\\app\\src\\lib\\sentry.js:306:15)",
      "    at warn (C:\\app\\src\\sse\\utils\\logger.js:91:11)",
      "    at markAccountUnavailable (C:\\app\\src\\sse\\services\\auth.js:280:5)",
    ].join("\n");
    expect(extractOriginFromStack(winStack)).toEqual({
      file: "src/sse/services/auth.js",
      line: 280,
    });
  });

  it("skips @sentry/node ESM frames (file:///…@sentry/node/…)", () => {
    const esmStack = [
      "Error: upstream",
      "    at apply (file:///x/node_modules/@sentry/node/build/esm/utils.js:9:2)",
      "    at parseError (/home/ubuntu/9router-fork/open-sse/executors/zcode.js:151:7)",
    ].join("\n");
    expect(extractOriginFromStack(esmStack)).toEqual({
      file: "open-sse/executors/zcode.js",
      line: 151,
    });
  });

  it("live: real Error stack resolves to the test file itself", () => {
    const origin = extractOriginFromStack(new Error("live").stack);
    expect(origin).not.toBeNull();
    expect(origin.file).toMatch(/sentry-issue-grouping\.test\.js$/);
    expect(Number.isInteger(origin.line)).toBe(true);
  });
});

describe("captureMessage fingerprint — Sentry issue grouping", () => {
  let scopeMock;
  let savedBridge;

  beforeEach(() => {
    scopeMock = {
      setLevel: () => {},
      setTag: () => {},
      setExtra: () => {},
      setFingerprint: vi.fn(),
    };
    sentryMock.scope = scopeMock;
    sentryMock.events.length = 0;
    vi.spyOn(sentryLib, "isSentryReady").mockReturnValue(true);
    vi.spyOn(sentryLib, "isDuplicate").mockReturnValue(false);
    // captureMessage prefers the globalThis bridge when present; point it at
    // the same spied module so the mocked readiness applies.
    savedBridge = globalThis.__9router_sentry;
    globalThis.__9router_sentry = { ...sentryLib };
  });

  afterEach(() => {
    globalThis.__9router_sentry = savedBridge;
  });

  it("two captures differing only in IDs from the same site share one fingerprint", () => {
    const fingerprintAt = (msg) => {
      scopeMock.setFingerprint.mockClear();
      sentryMock.events.length = 0;
      sentryLib.captureMessage(msg, "error", { force: true });
      expect(scopeMock.setFingerprint).toHaveBeenCalledTimes(1);
      return scopeMock.setFingerprint.mock.calls[0][0];
    };

    const fp1 = fingerprintAt("request 9918273645 failed");
    const fp2 = fingerprintAt("request 4455127890 failed");
    expect(fp1).toEqual(fp2);
    expect(fp1[0]).toBe("request [ID] failed");
  });

  it("combines normalized title with caller origin file and line", () => {
    // Under vitest the module is transformed, so both syntactically distinct
    // call sites in this file may resolve to the same frame — asserting a
    // line difference here would test the transformer, not grouping. What
    // matters: the fingerprint array is [normalizedTitle, file, line] built
    // from getCallerOrigin, and distinct files/lines yield distinct arrays
    // (covered by the extractOriginFromStack suite).
    sentryLib.captureMessage("request 9918273645 failed", "error", { force: true });
    expect(scopeMock.setFingerprint).toHaveBeenCalledTimes(1);
    const fp = scopeMock.setFingerprint.mock.calls[0][0];

    expect(Array.isArray(fp)).toBe(true);
    expect(fp[0]).toBe("request [ID] failed");
    expect(typeof fp[1]).toBe("string");
    expect(fp[1].length).toBeGreaterThan(0);
    expect(fp[2]).toMatch(/^\d+$/);
  });

});

describe("captureException fingerprint — Sentry issue grouping", () => {
  let scopeMock;
  let savedBridge;

  beforeEach(() => {
    scopeMock = {
      setLevel: () => {},
      setTag: () => {},
      setExtra: () => {},
      setFingerprint: vi.fn(),
    };
    sentryMock.scope = scopeMock;
    sentryMock.events.length = 0;
    vi.spyOn(sentryLib, "isSentryReady").mockReturnValue(true);
    savedBridge = globalThis.__9router_sentry;
    globalThis.__9router_sentry = { ...sentryLib };
  });

  afterEach(() => {
    globalThis.__9router_sentry = savedBridge;
  });

  it("builds [normalizedTitle, originFile, originLine] fingerprint from the Error", () => {
    const err = new Error("upstream request 9918273645 failed");
    sentryLib.captureException(err, { force: true });
    expect(scopeMock.setFingerprint).toHaveBeenCalledTimes(1);
    const fp = scopeMock.setFingerprint.mock.calls[0][0];
    expect(Array.isArray(fp)).toBe(true);
    expect(fp[0]).toBe("upstream request [ID] failed");
    expect(typeof fp[1]).toBe("string");
    expect(fp[1].length).toBeGreaterThan(0);
    expect(fp[2]).toMatch(/^\d+$/);
    expect(sentryMock.events).toHaveLength(1);
    expect(sentryMock.events[0].exception).toBe(err);
  });

  it("captures same-title exceptions from two literal call sites with distinct origins", () => {
    let firstError;
    try {
      throw new Error("upstream request 9918273645 failed");
    } catch (err) {
      firstError = err;
    }
    let secondError;
    try {
      throw new Error("upstream request 4455127890 failed");
    } catch (err) {
      secondError = err;
    }

    const first = sentryLib.captureException(firstError);
    const second = sentryLib.captureException(secondError);

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(scopeMock.setFingerprint).toHaveBeenCalledTimes(2);
    const fp1 = scopeMock.setFingerprint.mock.calls[0][0];
    const fp2 = scopeMock.setFingerprint.mock.calls[1][0];
    expect(fp1[0]).toBe("upstream request [ID] failed");
    expect(fp2[0]).toBe("upstream request [ID] failed");
    expect(fp1[1]).toMatch(/sentry-issue-grouping\.test\.js$/);
    expect(fp2[1]).toMatch(/sentry-issue-grouping\.test\.js$/);
    expect(fp1[1]).toBe(fp2[1]);
    expect(fp1[2]).toMatch(/^\d+$/);
    expect(fp2[2]).toMatch(/^\d+$/);
    expect(fp1[2]).not.toBe(fp2[2]);
    expect(fp1).not.toEqual(fp2);
    expect(sentryMock.events).toHaveLength(2);
    expect(sentryMock.events[0].exception).toBe(firstError);
    expect(sentryMock.events[1].exception).toBe(secondError);
  });

  it("non-Error values fall back to captureMessage with normalized fingerprint", () => {
    sentryLib.captureException("upstream request 4455127890 failed", { force: true });
    expect(scopeMock.setFingerprint).toHaveBeenCalledTimes(1);
    const fp = scopeMock.setFingerprint.mock.calls[0][0];
    expect(fp[0]).toBe("upstream request [ID] failed");
    expect(sentryMock.events).toHaveLength(1);
    // Payload stays the redacted raw text; only the grouping fingerprint is
    // normalized (normalizeIssueTitle runs in the fingerprint, not the body).
    expect(sentryMock.events[0].message).toBe("upstream request 4455127890 failed");
  });

  it("never throws when readiness check fails (fail-open)", () => {
    vi.spyOn(sentryLib, "isSentryReady").mockImplementation(() => {
      throw new Error("boom");
    });
    let res;
    expect(() => {
      res = sentryLib.captureException(new Error("x"));
    }).not.toThrow();
    expect(res).toBeNull();
  });
});

describe("dedup key includes caller origin", () => {
  let scopeMock;
  let savedBridge;

  beforeEach(() => {
    scopeMock = {
      setLevel: () => {},
      setTag: () => {},
      setExtra: () => {},
      setFingerprint: vi.fn(),
    };
    sentryMock.scope = scopeMock;
    sentryMock.events.length = 0;
    vi.spyOn(sentryLib, "isSentryReady").mockReturnValue(true);
    savedBridge = globalThis.__9router_sentry;
    // The capture paths read readiness (and only readiness) off the bridge;
    // point it at the spied module namespace so the mock applies.
    globalThis.__9router_sentry = { ...sentryLib };
  });

  afterEach(() => {
    globalThis.__9router_sentry = savedBridge;
  });

  it("fingerprint contains origin, so two same-title captures from distinct origins are distinct issues", () => {
    // The dedup key is (type, level, normalized title, origin file:line, stage)
    // — the same tuple as the fingerprint. Two call sites whose
    // getCallerOrigin() frames differ (the two capture* calls sit on distinct
    // lines below, called DIRECTLY — no shared wrapper frame in between, which
    // would become the origin for both) must both go through: the fingerprint
    // promises distinct Sentry issues, and the dedup key matches that promise
    // (old bug: key omitted origin, so the second capture was silently
    // swallowed inside the 2s TTL).
    scopeMock.setFingerprint.mockClear();
    sentryMock.events.length = 0;
    const first = sentryLib.captureMessage("upstream request 9918273645 failed", "error");
    expect(first).toBe(true);
    expect(scopeMock.setFingerprint).toHaveBeenCalledTimes(1);
    const fp1 = scopeMock.setFingerprint.mock.calls[0][0];

    scopeMock.setFingerprint.mockClear();
    sentryMock.events.length = 0;
    // Distinct call site: same normalized title, different line -> different
    // origin -> different dedup key -> NOT suppressed.
    const second = sentryLib.captureMessage("upstream request 4455127890 failed", "error");
    expect(second).toBe(true);
    expect(scopeMock.setFingerprint).toHaveBeenCalledTimes(1);
    const fp2 = scopeMock.setFingerprint.mock.calls[0][0];

    // Both captures fired (second not suppressed) even though the titles
    // normalize identically — the origin (line) slot differs, which is the
    // exact tuple both fingerprint and dedup key use. Old code: key omitted
    // origin -> second call swallowed inside the 2s TTL.
    expect(fp1[0]).toBe("upstream request [ID] failed");
    expect(fp2[0]).toBe("upstream request [ID] failed");
    expect(fp1[1]).toBe(fp2[1]);
    expect(fp1[2]).toMatch(/^\d+$/);
    expect(fp2[2]).toMatch(/^\d+$/);
    // Two adjacent but syntactically distinct call sites -> distinct lines.
    expect(fp1[2]).not.toBe(fp2[2]);
  });

  it("two different helper frames as origins both pass dedup (distinct line origins)", () => {
    // Stronger variant: two named helper functions whose frames are the
    // resolved origins. Called directly from this test body, so each capture
    // stack's first non-wrapper frame is the helper's own frame — distinct
    // lines, hence distinct origins in both fingerprint and dedup key.
    const captureViaQuotaHelper = () =>
      sentryLib.captureMessage("upstream request 9918273645 failed", "error");
    const captureViaCaptchaHelper = () =>
      sentryLib.captureMessage("upstream request 9918273645 failed", "error");

    sentryMock.events.length = 0;
    const first = captureViaQuotaHelper();
    const second = captureViaCaptchaHelper();
    expect(first).toBe(true);
    expect(second).toBe(true); // old bug: null — suppressed by title-only key
    expect(sentryMock.events).toHaveLength(2);
  });

  it("same site + same title is still deduplicated by the 2s TTL (no regression)", () => {
    // Without origin in the key this passed trivially; with origin the key is
    // still identical for an identical call site, so real TTL suppression
    // still applies. Use two IDs that normalize to the same title to prove the
    // key collapsed the dynamic parts.
    const captureSameSite = () =>
      sentryLib.captureMessage("quota exhausted for request 7319455021", "error");
    expect(captureSameSite()).toBe(true);
    expect(captureSameSite()).toBeNull(); // identical key -> suppressed
  });

  it("distinct titles from the same site both pass (normal dedup semantics)", () => {
    sentryMock.events.length = 0;
    const a = sentryLib.captureMessage("rate_limit locked 300s [429]", "error");
    const b = sentryLib.captureMessage("captcha challenge detected", "error");
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(sentryMock.events).toHaveLength(2);
  });

  it("context.force bypasses dedup entirely", () => {
    const forced = () =>
      sentryLib.captureMessage("upstream request 9918273645 failed", "error", { force: true });
    expect(forced()).toBe(true);
    expect(forced()).toBe(true); // force skips isDuplicate even for same key
    expect(sentryMock.events).toHaveLength(2);
  });
});

describe("beforeSend frame ordering — newest application frame is the origin", () => {
  // Regression for finding 1: Sentry stacktrace frames arrive OLDEST ->
  // NEWEST in the event object (the SDK parser reverses V8's newest-first
  // order — see @sentry/core utils/stacktrace.js stripSentryFramesAndReverse).
  // The old backstop mapped frames in array order and let
  // extractOriginFromStack scan from the START, picking the OLDEST app frame
  // (outer caller) instead of the throw site. The reverse-frames fix must
  // select the NEWEST app frame.

  let beforeSend;

  beforeAll(() => {
    // initSentry guards on a module-level `initialized` flag, so it can only
    // run once per module instance; capture its options here and share the
    // real beforeSend across these tests.
    process.env.SENTRY_DSN = "https://k@host.ingest.sentry.io/123";
    sentryMock.initOptions = null;
    sentryLib.initSentry();
    delete process.env.SENTRY_DSN;
    expect(sentryMock.initOptions).not.toBeNull();
    beforeSend = sentryMock.initOptions.beforeSend;
    expect(typeof beforeSend).toBe("function");
  });

  it("backstop fingerprints with the NEWEST app frame (oldest app frame present)", () => {
    // Oldest -> newest: logger wrapper -> outer app frame -> throw site.
    // OLDEST app frame chat.js:332 must NOT win; NEWEST app frame
    // providers.js:120 is the throw site.
    const event = {
      exception: {
        values: [
          {
            value: "upstream request 9918273645 failed",
            stacktrace: {
              frames: [
                { function: "warn", filename: "/app/src/sse/utils/logger.js", lineno: 91, colno: 11 },
                {
                  function: "ChatHandler.handle",
                  filename: "/app/src/sse/handlers/chat.js",
                  lineno: 332,
                  colno: 9,
                }, // OLDEST app frame
                {
                  function: "refreshTokens",
                  filename: "/app/open-sse/services/tokenRefresh/providers.js",
                  lineno: 120,
                  colno: 9,
                }, // NEWEST app frame
              ],
            },
          },
        ],
      },
    };
    const out = beforeSend(event, {});
    expect(out.fingerprint).toEqual([
      "upstream request [ID] failed",
      "open-sse/services/tokenRefresh/providers.js",
      "120",
    ]);
  });

  it("backstop fail-opens with empty origin components when no frames", () => {
    const out = beforeSend(
      { exception: { values: [{ value: "boom", stacktrace: { frames: [] } }] } },
      {}
    );
    expect(out.fingerprint).toEqual(["boom", "", ""]);
  });

  it("backstop fail-opens when stacktrace is absent entirely", () => {
    const out = beforeSend({ exception: { values: [{ value: "boom" }] } }, {});
    expect(out.fingerprint).toEqual(["boom", "", ""]);
  });

  it("backstop leaves an existing event fingerprint untouched", () => {
    const event = {
      fingerprint: ["already", "grouped"],
      exception: { values: [{ value: "boom 9918273645" }] },
    };
    const out = beforeSend(event, {});
    expect(out.fingerprint).toEqual(["already", "grouped"]);
  });
});
