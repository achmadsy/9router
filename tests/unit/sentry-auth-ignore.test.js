// AUTH "No credentials" / "No active credentials" must be Sentry-ignored;
// real errors (e.g. ERROR 400) must still report.
import { describe, it, expect } from "vitest";
import { isSentryIgnoredMessage } from "../../src/lib/sentry.js";

describe("isSentryIgnoredMessage — no-credentials states", () => {
  it("ignores [AUTH] No credentials for <provider>", () => {
    expect(isSentryIgnoredMessage("[AUTH] No credentials for glm")).toBe(true);
  });

  it("ignores [AUTH] No active credentials for provider: <p>", () => {
    expect(isSentryIgnoredMessage("[AUTH] No active credentials for provider: glm")).toBe(true);
  });

  it("does NOT ignore real upstream errors like ERROR 400", () => {
    expect(isSentryIgnoredMessage("ERROR 400 · glm/glm-5.3 · 12ms")).toBe(false);
  });
});
