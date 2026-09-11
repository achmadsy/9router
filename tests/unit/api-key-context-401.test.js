// MED5 + HIGH4 support: invalid presented keys → 401 via shared resolveApiKeyContext.
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  authenticateApiKey: vi.fn(),
  getConsistentMachineId: vi.fn(),
  maskKey: (k) => k,
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
}));

vi.mock("@/lib/db/index.js", () => ({
  authenticateApiKey: mocks.authenticateApiKey,
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));

vi.mock("open-sse/utils/logger.js", () => ({
  debug: () => {},
  warn: () => {},
  error: () => {},
  maskKey: mocks.maskKey,
}));

const { resolveApiKeyContext } = await import("@/sse/services/apiKeyPolicy.js");

function req(headers = {}) {
  return { headers: { get: (k) => headers[k] ?? headers[k.toLowerCase()] ?? null } };
}

describe("resolveApiKeyContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    mocks.getConsistentMachineId.mockResolvedValue("cli-tok");
  });

  it("401s on invalid presented key even when requireApiKey is false", async () => {
    mocks.authenticateApiKey.mockResolvedValue(null);
    const ctx = await resolveApiKeyContext(req({ Authorization: "Bearer sk-9r-bad" }));
    expect(ctx.errorResponse?.status).toBe(401);
    expect(ctx.keyRow).toBeNull();
  });

  it("401s on paused/inactive key (authenticateApiKey null)", async () => {
    mocks.authenticateApiKey.mockResolvedValue(null);
    const ctx = await resolveApiKeyContext(req({ "x-api-key": "sk-9r-paused" }));
    expect(ctx.errorResponse?.status).toBe(401);
  });

  it("attaches keyRow for valid key when requireApiKey is false", async () => {
    const keyRow = { id: "k1", name: "n", accessMode: "all", targets: [] };
    mocks.authenticateApiKey.mockResolvedValue(keyRow);
    const ctx = await resolveApiKeyContext(req({ Authorization: "Bearer sk-9r-ok" }));
    expect(ctx.errorResponse).toBeNull();
    expect(ctx.keyRow).toEqual(keyRow);
  });

  it("allows trusted local CLI token without inventing a key row", async () => {
    mocks.authenticateApiKey.mockResolvedValue(null);
    const ctx = await resolveApiKeyContext(req({ "x-9r-cli-token": "cli-tok" }));
    expect(ctx.errorResponse).toBeNull();
    expect(ctx.keyRow).toBeNull();
    expect(mocks.authenticateApiKey).not.toHaveBeenCalled();
  });

  it("rejects CLI token without auth when requireApiKey is true", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: true });
    const ctx = await resolveApiKeyContext(req({}));
    expect(ctx.errorResponse?.status).toBe(401);
  });
});
