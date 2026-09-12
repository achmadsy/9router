// Client IP attached to Sentry events from request ALS / explicit context
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const setTag = vi.fn();
const setUser = vi.fn();
const setExtra = vi.fn();
const setLevel = vi.fn();
const setFingerprint = vi.fn();
let withScopeCb = null;

vi.mock("@sentry/node", () => ({
  init: vi.fn(() => { /* ready */ }),
  getClient: vi.fn(() => ({})),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  withScope: vi.fn((cb) => {
    withScopeCb = cb;
    return cb({
      setTag,
      setUser,
      setExtra,
      setLevel,
      setFingerprint,
      setRequestSession: vi.fn(),
    });
  }),
  setTag: vi.fn(),
  setExtra: vi.fn(),
  requestAsyncStorage: { getStore: () => undefined },
  defaultIntegrations: [],
  contextLinesIntegration: () => ({ name: "ContextLines" }),
}));

describe("Sentry client IP", () => {
  let sentry;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.SENTRY_DSN =
      "https://public@example.com/1";
    delete process.env.SENTRY_DISABLED;
    sentry = await import("@/lib/sentry.js");
    // force init so isSentryReady is true
    sentry.initSentry();
  });

  afterEach(() => {
    delete process.env.SENTRY_DSN;
  });

  it("attaches explicit context.clientIp as user.ip_address + tag", () => {
    const err = new Error("boom");
    sentry.captureException(err, {
      clientIp: "::ffff:203.0.113.9",
      tags: { source: "test" },
    });
    expect(setUser).toHaveBeenCalledWith({ ip_address: "203.0.113.9" });
    expect(setTag).toHaveBeenCalledWith("client_ip", "203.0.113.9");
    expect(setExtra).toHaveBeenCalledWith("client_ip", "203.0.113.9");
  });

  it("uses ALS IP when no explicit clientIp", async () => {
    const { runWithClientIp } = await import("@/lib/requestContext.js");
    await runWithClientIp("198.51.100.4", () => {
      sentry.captureMessage("hello", "error");
    });
    expect(setUser).toHaveBeenCalledWith({ ip_address: "198.51.100.4" });
    expect(setTag).toHaveBeenCalledWith("client_ip", "198.51.100.4");
  });

  it("does not set user when no IP available", () => {
    sentry.captureMessage("no-ip", "info");
    expect(setUser).not.toHaveBeenCalled();
    expect(setTag).not.toHaveBeenCalledWith("client_ip", expect.anything());
  });
});
