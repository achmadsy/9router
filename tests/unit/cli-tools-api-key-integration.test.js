import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getApiKeys: vi.fn(),
  getRecoverableApiKeySecret: vi.fn(),
}));

vi.mock("@/lib/db", () => mocks);

const { resolveCliApiKey } = await import("@/app/api/cli-tools/resolveApiKey.js");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getApiKeys.mockResolvedValue([]);
  mocks.getRecoverableApiKeySecret.mockResolvedValue(null);
});

describe("CLI API key fallback", () => {
  it("uses explicitly supplied key without reading DB", async () => {
    expect(await resolveCliApiKey("  sk-explicit  ")).toBe("sk-explicit");
    expect(mocks.getApiKeys).not.toHaveBeenCalled();
  });

  it("recovers first active key's secret instead of reading metadata.key", async () => {
    mocks.getApiKeys.mockResolvedValue([
      { id: "paused", isActive: false },
      { id: "legacy", isActive: true },
      { id: "current", isActive: true },
    ]);
    mocks.getRecoverableApiKeySecret.mockImplementation(async (id) => id === "current" ? "sk-current" : null);

    expect(await resolveCliApiKey("")).toBe("sk-current");
    expect(mocks.getRecoverableApiKeySecret.mock.calls.map(([id]) => id)).toEqual(["legacy", "current"]);
  });

  it("returns empty when no active key is recoverable", async () => {
    mocks.getApiKeys.mockResolvedValue([{ id: "legacy", isActive: true }]);
    expect(await resolveCliApiKey("sk_9router")).toBe("");
  });
});
