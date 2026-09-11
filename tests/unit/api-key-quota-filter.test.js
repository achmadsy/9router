// Quota scope projection: restricted key filters providers/models; ALL unrestricted.
import { describe, it, expect } from "vitest";
import { API_KEY_ACCESS_MODE, API_KEY_TARGET_TYPE } from "@/lib/apiKeys/constants.js";
import {
  resolveQuotaScope,
  connectionInScope,
  expandComboMembers,
} from "@/lib/apiKeys/quotaScope.js";

const combos = [
  { id: "c1", name: "best", models: ["openai/gpt-4o", "c2"] },
  { id: "c2", name: "inner", models: [{ id: "anthropic/claude-3-5-sonnet-20241022" }] },
];

describe("resolveQuotaScope", () => {
  it("ALL → null (unrestricted)", async () => {
    const scope = await resolveQuotaScope({ accessMode: API_KEY_ACCESS_MODE.ALL, targets: [] });
    expect(scope).toBe(null);
  });

  it("restricted with model+combo → reachable set includes combo members recursively", async () => {
    const scope = await resolveQuotaScope({
      accessMode: API_KEY_ACCESS_MODE.RESTRICTED,
      targets: [
        { targetType: API_KEY_TARGET_TYPE.MODEL, targetId: "openai/gpt-4o-mini" },
        { targetType: API_KEY_TARGET_TYPE.COMBO, targetId: "c1" },
      ],
    }, { getCombos: async () => combos });

    expect(scope.modelIds.has("openai/gpt-4o-mini")).toBe(true);
    expect(scope.modelIds.has("openai/gpt-4o")).toBe(true);
    expect(scope.modelIds.has("anthropic/claude-3-5-sonnet-20241022")).toBe(true);
    expect(scope.comboIds.has("c1")).toBe(true);
    expect(scope.isEmpty).toBe(false);
  });

  it("empty restricted → deny-all (isEmpty) even with production loaders available", async () => {
    const scope = await resolveQuotaScope({
      accessMode: API_KEY_ACCESS_MODE.RESTRICTED,
      targets: [],
    }, { getCombos: async () => combos });
    expect(scope.isEmpty).toBe(true);
    expect(connectionInScope(scope, { provider: "openai" })).toBe(false);
  });

  it("combo-only restricted key resolves member providers", async () => {
    const scope = await resolveQuotaScope({
      accessMode: API_KEY_ACCESS_MODE.RESTRICTED,
      targets: [{ targetType: API_KEY_TARGET_TYPE.COMBO, targetId: "c1" }],
    }, { getCombos: async () => combos });

    expect(scope.isEmpty).toBe(false);
    expect(scope.comboIds.has("c1")).toBe(true);
    expect(scope.modelIds.has("openai/gpt-4o")).toBe(true);
    expect(scope.modelIds.has("anthropic/claude-3-5-sonnet-20241022")).toBe(true);
    expect(connectionInScope(scope, { provider: "openai" })).toBe(true);
    expect(connectionInScope(scope, { provider: "anthropic" })).toBe(true);
    expect(connectionInScope(scope, { provider: "google" })).toBe(false);
  });
});

describe("connectionInScope", () => {
  it("null scope allows all", () => {
    expect(connectionInScope(null, { provider: "anything" })).toBe(true);
  });

  it("provider in prefix of reachable model allowed; others not", async () => {
    const scope = await resolveQuotaScope({
      accessMode: API_KEY_ACCESS_MODE.RESTRICTED,
      targets: [{ targetType: API_KEY_TARGET_TYPE.MODEL, targetId: "openai/gpt-4o-mini" }],
    }, { getCombos: async () => combos });
    expect(connectionInScope(scope, { provider: "openai" })).toBe(true);
    expect(connectionInScope(scope, { provider: "anthropic" })).toBe(false);
  });
});

describe("expandComboMembers", () => {
  it("visits nested combos without cycles", () => {
    const byId = Object.fromEntries(combos.map((c) => [c.id, c]));
    const byName = Object.fromEntries(combos.map((c) => [c.name, c]));
    const get = (id) => byId[id] || byName[id];
    const members = expandComboMembers(byId.c1, get);
    expect(members).toContain("openai/gpt-4o");
    expect(members).toContain("anthropic/claude-3-5-sonnet-20241022");

    // cyclic combo should not hang
    const cyclic = { id: "cy", name: "cy", models: ["cy"] };
    const members2 = expandComboMembers(cyclic, (id) => (id === "cy" ? cyclic : null));
    expect(members2).toContain("cy");
  });
});
