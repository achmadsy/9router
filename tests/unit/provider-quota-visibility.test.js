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

  it("shows all quotas by default and hides configured provider rows", () => {
    const quotas = parseQuotaData("antigravity", data);
    expect(filterQuotasByVisibility("antigravity", quotas, {})).toHaveLength(2);

    const visibility = {
      antigravity: { hidden: ["others-weekly"] },
    };
    const visible = filterQuotasByVisibility("antigravity", quotas, visibility);
    const hidden = getHiddenQuotaRows("antigravity", quotas, visibility);

    expect(visible.map((q) => q.modelKey)).toEqual(["gemini-weekly"]);
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

    expect(visible.map((q) => q.modelKey)).toEqual(["gemini-weekly"]);
    expect(hidden.map((q) => q.modelKey)).toEqual(["others-weekly"]);
  });

  it("does not apply one provider hidden list to another provider", () => {
    const quotas = parseQuotaData("antigravity", data);
    const visibility = {
      codex: { hidden: ["gemini"] },
    };
    expect(filterQuotasByVisibility("antigravity", quotas, visibility)).toHaveLength(2);
  });
});
