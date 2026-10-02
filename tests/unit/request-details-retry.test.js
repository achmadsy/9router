import { afterEach, describe, expect, it, vi } from "vitest";

const { getAdapter, transaction, run, rows } = vi.hoisted(() => {
  const rows = [];
  const run = vi.fn((sql, params) => {
    if (sql.startsWith("INSERT INTO requestDetails")) rows.push(params[0]);
  });
  const transaction = vi.fn((fn) => fn());
  const getAdapter = vi.fn(async () => ({ transaction, run, get: () => ({ c: rows.length }) }));
  return { getAdapter, transaction, run, rows };
});

vi.mock("@/lib/db/driver.js", () => ({ getAdapter }));
vi.mock("@/lib/db/repos/settingsRepo.js", () => ({ getSettings: async () => ({
  enableObservability: true, observabilityBatchSize: 1, observabilityMaxRecords: 200,
}) }));

afterEach(() => {
  vi.useRealTimers();
  delete process.env.ENABLE_REQUEST_LOGS;
  transaction.mockReset().mockImplementation((fn) => fn());
  run.mockClear();
  rows.length = 0;
});

describe("request details retry", () => {
  it("requeues a failed batch and writes it after the database recovers", async () => {
    vi.useFakeTimers();
    process.env.ENABLE_REQUEST_LOGS = "true";
    const { saveRequestDetail } = await import("@/lib/db/repos/requestDetailsRepo.js");
    transaction.mockImplementationOnce(() => { throw new Error("database is locked"); });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await saveRequestDetail({ id: "first", model: "test" });
      await vi.waitFor(() => expect(transaction).toHaveBeenCalledTimes(1));
      expect(rows).toEqual([]);
      await vi.advanceTimersByTimeAsync(5000);
      expect(rows).toEqual(["first"]);
      expect(error).toHaveBeenCalledTimes(1);
      await saveRequestDetail({ id: "second", model: "test" });
      await vi.waitFor(() => expect(rows).toEqual(["first", "second"]));
      await vi.advanceTimersByTimeAsync(5000);
      expect(rows).toEqual(["first", "second"]);
    } finally {
      error.mockRestore();
    }
  });
});
