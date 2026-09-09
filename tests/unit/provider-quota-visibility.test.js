import { describe, expect, it } from "vitest";
import {
  filterQuotasByVisibility,
  getHiddenQuotaRows,
  parseQuotaData,
  trimHiddenQuotaKeys,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

describe("provider quota visibility", () => {
  const data = {
    quotas: {
      "gemini-pro-agent": {
        displayName: "Gemini 3.1 Pro (High)",
        used: 200,
        total: 1000,
        resetAt: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString(),
        remainingPercentage: 80,
      },
      "claude-opus-4-6-thinking": {
        displayName: "Claude Opus 4.6 (Thinking)",
        used: 100,
        total: 1000,
        resetAt: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString(),
        remainingPercentage: 90,
      },
    },
  };

  it("groups Antigravity quotas by model family and reset window in fixed order", () => {
    const now = Date.now();
    const quotas = parseQuotaData("antigravity", {
      quotas: {
        "claude-opus-4-6-thinking": {
          remainingPercentage: 60,
          resetAt: new Date(now + 6 * 24 * 60 * 60 * 1000).toISOString(),
        },
        "gemini-3.1-flash-image": {
          remainingPercentage: 70,
          resetAt: new Date(now + 4 * 60 * 60 * 1000).toISOString(),
        },
        "gpt-oss-120b-medium": {
          remainingPercentage: 80,
          resetAt: new Date(now + 3 * 60 * 60 * 1000).toISOString(),
        },
        "gemini-pro-agent": {
          remainingPercentage: 90,
          resetAt: new Date(now + 5 * 24 * 60 * 60 * 1000).toISOString(),
        },
      },
    });

    expect(quotas.map((q) => [q.modelKey, q.name])).toEqual([
      ["gemini-5h", "Gemini (5h)"],
      ["gemini-weekly", "Gemini (Weekly)"],
      ["others-5h", "Others (5h)"],
      ["others-weekly", "Others (Weekly)"],
    ]);
  });

  it("keeps missing or invalid Antigravity reset times out of named windows", () => {
    const quotas = parseQuotaData("antigravity", {
      quotas: {
        "gemini-pro-agent": {
          remainingPercentage: 70,
          resetAt: null,
        },
        "claude-opus-4-6-thinking": {
          remainingPercentage: 60,
          resetAt: "not-a-date",
        },
      },
    });

    expect(quotas.map((q) => [q.modelKey, q.name, q.resetAt])).toEqual([
      ["gemini-unknown", "Gemini (Unknown window)", null],
      ["others-unknown", "Others (Unknown window)", "not-a-date"],
    ]);
  });

  it("synthesizes missing Gemini 5h from weekly-only exhausted quota", () => {
    const now = Date.now();
    const quotas = parseQuotaData("antigravity", {
      quotas: {
        "gemini-pro-agent": {
          used: 1000,
          total: 1000,
          remainingPercentage: 0,
          resetAt: new Date(now + 6 * 24 * 60 * 60 * 1000).toISOString(),
        },
      },
    });

    expect(quotas.map((q) => q.modelKey)).toEqual(["gemini-5h", "gemini-weekly"]);
    const [fiveH, weekly] = quotas;
    expect(fiveH.name).toBe("Gemini (5h)");
    expect(weekly.name).toBe("Gemini (Weekly)");
    expect(fiveH.used).toBe(weekly.used);
    expect(fiveH.total).toBe(weekly.total);
    expect(fiveH.resetAt).toBe(weekly.resetAt);
    expect(fiveH.remainingPercentage).toBe(0);
    expect(weekly.remainingPercentage).toBe(0);
    expect(quotas).toHaveLength(2);
  });

  it("synthesizes missing Others weekly from 5h-only quota", () => {
    const now = Date.now();
    const quotas = parseQuotaData("antigravity", {
      quotas: {
        "claude-opus-4-6-thinking": {
          used: 100,
          total: 1000,
          remainingPercentage: 90,
          resetAt: new Date(now + 3 * 60 * 60 * 1000).toISOString(),
        },
      },
    });

    expect(quotas.map((q) => q.modelKey)).toEqual(["others-5h", "others-weekly"]);
    const [fiveH, weekly] = quotas;
    expect(fiveH.used).toBe(weekly.used);
    expect(fiveH.total).toBe(weekly.total);
    expect(fiveH.resetAt).toBe(weekly.resetAt);
    expect(fiveH.remainingPercentage).toBe(weekly.remainingPercentage);
    expect(weekly.name).toBe("Others (Weekly)");
  });

  it("does not duplicate when both named windows are present", () => {
    const now = Date.now();
    const fiveHReset = new Date(now + 3 * 60 * 60 * 1000).toISOString();
    const weeklyReset = new Date(now + 6 * 24 * 60 * 60 * 1000).toISOString();
    const quotas = parseQuotaData("antigravity", {
      quotas: {
        "gemini-3.1-flash-image": {
          used: 10,
          total: 100,
          remainingPercentage: 90,
          resetAt: fiveHReset,
        },
        "gemini-pro-agent": {
          used: 20,
          total: 100,
          remainingPercentage: 80,
          resetAt: weeklyReset,
        },
      },
    });

    expect(quotas.map((q) => q.modelKey)).toEqual(["gemini-5h", "gemini-weekly"]);
    expect(quotas[0].resetAt).toBe(fiveHReset);
    expect(quotas[1].resetAt).toBe(weeklyReset);
  });

  it("does not synthesize named windows from unknown-only quotas", () => {
    const quotas = parseQuotaData("antigravity", {
      quotas: {
        "claude-opus-4-6-thinking": {
          remainingPercentage: 60,
          resetAt: "not-a-date",
        },
      },
    });

    expect(quotas.map((q) => q.modelKey)).toEqual(["others-unknown"]);
  });

  it("clones quota values into missing sibling with only key and name overridden", () => {
    const now = Date.now();
    const resetAt = new Date(now + 6 * 24 * 60 * 60 * 1000).toISOString();
    const quotas = parseQuotaData("antigravity", {
      quotas: {
        "gemini-pro-agent": {
          used: 200,
          total: 1000,
          remainingPercentage: 80,
          resetAt,
        },
      },
    });

    const byKey = Object.fromEntries(quotas.map((q) => [q.modelKey, q]));
    expect(Object.keys(byKey).sort()).toEqual(["gemini-5h", "gemini-weekly"]);
    expect(byKey["gemini-5h"]).toMatchObject({
      used: 200,
      total: 1000,
      resetAt,
      remainingPercentage: 80,
    });
    expect(byKey["gemini-5h"].name).toBe("Gemini (5h)");
    expect(byKey["gemini-5h"]).not.toBe(byKey["gemini-weekly"]);
  });

  it("shows all quotas by default and hides configured provider rows", () => {
    const quotas = parseQuotaData("antigravity", data);
    expect(quotas.map((q) => q.modelKey)).toEqual([
      "gemini-5h",
      "gemini-weekly",
      "others-5h",
      "others-weekly",
    ]);

    const visibility = {
      antigravity: { hidden: ["others-weekly"] },
    };
    const visible = filterQuotasByVisibility("antigravity", quotas, visibility);
    const hidden = getHiddenQuotaRows("antigravity", quotas, visibility);

    expect(visible.map((q) => q.modelKey)).toEqual(["gemini-5h", "gemini-weekly", "others-5h"]);
    expect(hidden.map((q) => q.modelKey)).toEqual(["others-weekly"]);
  });

  it("trims stale or obsolete model keys", () => {
    const quotas = parseQuotaData("antigravity", data);
    const trimmed = trimHiddenQuotaKeys(["others-weekly", "stale-model-xyz", "gemini-3.8-flash-low"], quotas);
    expect(trimmed).toEqual(["others-weekly"]);

    const visibility = {
      antigravity: { hidden: ["others-weekly", "stale-model-xyz"] },
    };
    const visible = filterQuotasByVisibility("antigravity", quotas, visibility);
    const hidden = getHiddenQuotaRows("antigravity", quotas, visibility);

    expect(visible.map((q) => q.modelKey)).toEqual(["gemini-5h", "gemini-weekly", "others-5h"]);
    expect(hidden.map((q) => q.modelKey)).toEqual(["others-weekly"]);
  });

  it("does not apply one provider hidden list to another provider", () => {
    const quotas = parseQuotaData("antigravity", data);
    const visibility = {
      codex: { hidden: ["gemini"] },
    };
    expect(filterQuotasByVisibility("antigravity", quotas, visibility)).toHaveLength(4);
  });
});
