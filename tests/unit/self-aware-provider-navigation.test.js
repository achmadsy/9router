import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { activeCooldowns, groupCooldownProviders, filterProviderCooldowns } from "../../src/app/(dashboard)/dashboard/self-aware/providerGroups.js";

const now = Date.parse("2026-10-30T12:00:00Z");
const rows = [
  { id: "a", provider: "glm", model: "one", expiresAtMs: now + 1000 },
  { id: "b", provider: "glm", model: "two", expiresAt: new Date(now + 2000).toISOString() },
  { id: "c", provider: "glm-clone-test", expiresAtMs: now + 3000 },
  { id: "d", provider: "codex", expiresAtMs: now + 4000 },
  { id: "expired", provider: "expired-provider", expiresAtMs: now },
  { id: "invalid", provider: "invalid-provider", expiresAt: "bad date" },
];

describe("Self-Aware provider-first navigation", () => {
  it("shows distinct providers with only unexpired cooldowns", () => {
    expect(groupCooldownProviders(activeCooldowns(rows, now))).toEqual([
      { provider: "codex", count: 1 },
      { provider: "glm", count: 2 },
      { provider: "glm-clone-test", count: 1 },
    ]);
  });

  it("shows no detail rows until a provider is selected", () => {
    expect(filterProviderCooldowns(rows, null)).toEqual([]);
  });

  it("filters by exact provider without merging duplicates", () => {
    expect(filterProviderCooldowns(activeCooldowns(rows, now), "glm").map((row) => row.id)).toEqual(["a", "b"]);
    expect(filterProviderCooldowns(rows, "glm-clone-test").map((row) => row.id)).toEqual(["c"]);
  });

  it("drops expired providers and leaves an empty detail view for the selected provider", () => {
    const active = activeCooldowns(rows, now + 2500);
    expect(groupCooldownProviders(active).some((group) => group.provider === "glm")).toBe(false);
    expect(filterProviderCooldowns(active, "glm")).toEqual([]);
  });

  it("keeps existing table behind selection, with back navigation and explicit global reset scope", () => {
    const page = readFileSync(new URL("../../src/app/(dashboard)/dashboard/self-aware/page.js", import.meta.url), "utf8");
    expect(page).toContain('useState(null)');
    expect(page).toContain("activeProviders.map((group)");
    expect(page).toContain("selectedProvider && visibleCooldowns.length > 0");
    expect(page).toContain("visibleCooldowns.map((c)");
    expect(page).toContain("Back to providers");
    expect(page).toContain("Reset All Providers");
    expect(page).toContain("Clears cooldowns across all providers, not only this view");
  });
});
