import { describe, expect, it } from "vitest";
import {
  aggregateProviderQuotas,
  getRemainingPercentage,
  groupQuotaConnections,
  parseQuotaData,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

function connection(id, provider, extra = {}) {
  return { id, provider, isActive: true, ...extra };
}

describe("grouped quota provider cards", () => {
  it("groups GLM, Grok CLI, and Kiro while leaving other accounts separate", () => {
    const items = groupQuotaConnections([
      connection("glm-1", "glm"),
      connection("codex-1", "codex"),
      connection("kiro-1", "kiro"),
      connection("glm-2", "glm"),
      connection("grok-1", "grok-cli"),
      connection("kiro-2", "kiro"),
    ]);

    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({ type: "group", provider: "glm" });
    expect(items[0].connections.map(({ id }) => id)).toEqual(["glm-1", "glm-2"]);
    expect(items[1]).toMatchObject({ type: "single", connection: { id: "codex-1" } });
    expect(items[2].connections.map(({ id }) => id)).toEqual(["kiro-1", "kiro-2"]);
    expect(items[3]).toMatchObject({ type: "group", provider: "grok-cli" });
  });

  it("keeps GLM China separate from Zai GLM Coding", () => {
    const items = groupQuotaConnections([
      connection("intl", "glm"),
      connection("china", "glm-cn"),
    ]);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ type: "group", provider: "glm" });
    expect(items[1]).toMatchObject({ type: "single", connection: { id: "china" } });
  });

  it("sums matching Kiro quota buckets and uses the earliest reset", () => {
    const connections = [connection("one", "kiro"), connection("two", "kiro")];
    const quotaData = {
      one: {
        quotas: [{ name: "agentic_request", used: 120, total: 500, resetAt: "2026-11-10T00:00:00.000Z" }],
      },
      two: {
        quotas: [{ name: "agentic_request", used: 30, total: 250, resetAt: "2026-11-05T00:00:00.000Z" }],
      },
    };

    const result = aggregateProviderQuotas(connections, quotaData, {});

    expect(result.successfulAccounts).toBe(2);
    expect(result.failedConnections).toEqual([]);
    expect(result.quotas).toEqual([
      expect.objectContaining({
        name: "agentic_request",
        used: 150,
        total: 750,
        accountCount: 2,
        resetAt: "2026-11-05T00:00:00.000Z",
      }),
    ]);
  });

  it("weights percentage-style GLM limits by summed capacity", () => {
    const connections = [connection("one", "glm"), connection("two", "glm")];
    const quotaData = {
      one: { quotas: [{ name: "Session (5h)", used: 25, total: 100, remainingPercentage: 75 }] },
      two: { quotas: [{ name: "Session (5h)", used: 45, total: 100, remainingPercentage: 55 }] },
    };

    const result = aggregateProviderQuotas(connections, quotaData, {});

    expect(result.quotas[0]).toMatchObject({ used: 70, total: 200, accountCount: 2 });
    expect(result.quotas[0]).not.toHaveProperty("remainingPercentage");
    expect(getRemainingPercentage(result.quotas[0])).toBe(65);
  });

  it("normalizes GLM Start Plan units before grouping", () => {
    const quotas = parseQuotaData("glm", {
      quotas: {
        "Start: GLM-5.3": {
          used: 250,
          total: 1000,
          remaining: 750,
          remainingPercentage: 75,
          unlimited: false,
        },
        "Session (5h)": {
          used: 25,
          total: 100,
          remaining: 75,
          remainingPercentage: 75,
          unlimited: false,
        },
      },
    });

    expect(quotas).toEqual([
      expect.objectContaining({ name: "Start: GLM-5.3", used: 250, total: 1000, remainingPercentage: 75 }),
      expect.objectContaining({ name: "Session (5h)", used: 25, total: 100, remainingPercentage: 75 }),
    ]);
    expect(quotas[0]).not.toHaveProperty("remaining");
    expect(getRemainingPercentage(quotas[0])).toBe(75);

    const result = aggregateProviderQuotas(
      [connection("oauth", "glm"), connection("api-key", "glm")],
      {
        oauth: { quotas },
        "api-key": { quotas: [{ name: "Session (5h)", used: 45, total: 100, remainingPercentage: 55 }] },
      },
      {},
    );
    const start = result.quotas.find((quota) => quota.name === "Start: GLM-5.3");
    const session = result.quotas.find((quota) => quota.name === "Session (5h)");

    expect(start).not.toHaveProperty("remainingPercentage");
    expect(getRemainingPercentage(start)).toBe(75);
    expect(getRemainingPercentage(session)).toBe(65);
  });

  it("does not add Grok's synthetic depleted unit to a paid capacity pool", () => {
    const connections = [
      connection("paid", "grok-cli"),
      connection("depleted", "grok-cli"),
    ];
    const quotaData = {
      paid: { quotas: [{ name: "On-demand", used: 35, total: 100, remainingPercentage: 65 }] },
      depleted: { quotas: [{ name: "On-demand", used: 1, total: 1, remainingPercentage: 0 }] },
    };

    const result = aggregateProviderQuotas(connections, quotaData, {});

    expect(result.quotas[0]).toMatchObject({ used: 35, total: 100, accountCount: 2 });
  });

  it("keeps successful totals when another account fails", () => {
    const connections = [connection("good", "kiro"), connection("bad", "kiro")];
    const quotaData = {
      good: { quotas: [{ name: "agentic_request", used: 10, total: 50 }] },
      bad: { quotas: [], message: "Token expired" },
    };

    const result = aggregateProviderQuotas(connections, quotaData, { bad: "401 Unauthorized" });

    expect(result.quotas[0]).toMatchObject({ used: 10, total: 50 });
    expect(result.successfulAccounts).toBe(1);
    expect(result.failedConnections).toHaveLength(1);
    expect(result.failedConnections[0].connection.id).toBe("bad");
  });

  it("marks missing quota data as unavailable instead of silently treating it as zero", () => {
    const connections = [connection("good", "glm"), connection("missing", "glm")];
    const quotaData = {
      good: { quotas: [{ name: "Weekly (7d)", used: 20, total: 100 }] },
    };

    const result = aggregateProviderQuotas(connections, quotaData, {});

    expect(result.quotas[0]).toMatchObject({ used: 20, total: 100 });
    expect(result.failedConnections).toEqual([
      expect.objectContaining({
        connection: expect.objectContaining({ id: "missing" }),
        message: "Quota unavailable",
      }),
    ]);
  });
});
