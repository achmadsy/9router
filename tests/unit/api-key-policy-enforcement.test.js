// Policy semantics: ALL vs RESTRICTED, combo vs model targets, deny-all, catalog filter.
import { describe, it, expect } from "vitest";
import { API_KEY_ACCESS_MODE, API_KEY_TARGET_TYPE } from "@/lib/apiKeys/constants.js";
import {
  authorizeResource,
  filterCatalogByPolicy,
  isModelAllowed,
  normalizeTargets,
  modelNotAllowedResponse,
} from "@/lib/apiKeys/policy.js";

const allKey = { id: "k1", accessMode: API_KEY_ACCESS_MODE.ALL, targets: [] };
const restrictedKey = {
  id: "k2",
  accessMode: API_KEY_ACCESS_MODE.RESTRICTED,
  targets: [
    { targetType: API_KEY_TARGET_TYPE.MODEL, targetId: "openai/gpt-4o" },
    { targetType: API_KEY_TARGET_TYPE.COMBO, targetId: "combo-best" },
    { targetType: API_KEY_TARGET_TYPE.MODEL, targetId: "alias-only" },
  ],
};
const emptyRestricted = { id: "k3", accessMode: API_KEY_ACCESS_MODE.RESTRICTED, targets: [] };

// Combo target stored as UUID (legacy/editor) — auth must still match by name.
const uuidComboKey = {
  id: "k4",
  accessMode: API_KEY_ACCESS_MODE.RESTRICTED,
  targets: [{ targetType: API_KEY_TARGET_TYPE.COMBO, targetId: "uuid-1111" }],
};
const comboCatalog = [{ id: "uuid-1111", name: "combo-best" }];

describe("authorizeResource", () => {
  it("ALL key allows every model/combo", async () => {
    expect((await authorizeResource(allKey, "any/model")).allowed).toBe(true);
    expect((await authorizeResource(allKey, "combo-x")).allowed).toBe(true);
  });

  it("RESTRICTED allows only selected exact model ids", async () => {
    expect((await authorizeResource(restrictedKey, "openai/gpt-4o")).allowed).toBe(true);
    expect((await authorizeResource(restrictedKey, "openai/gpt-4o-mini")).allowed).toBe(false);
    expect((await authorizeResource(restrictedKey, "alias-only")).allowed).toBe(true);
  });

  it("RESTRICTED combo grant does not grant direct member calls", async () => {
    // combo-best members are not separately selected → direct member denied
    expect((await authorizeResource(restrictedKey, "combo-best")).allowed).toBe(true);
    expect((await authorizeResource(restrictedKey, "member-model")).allowed).toBe(false);
  });

  it("combo-by-name works when target stored as combo UUID", async () => {
    const byName = await authorizeResource(uuidComboKey, "combo-best", {
      getCombos: async () => comboCatalog,
    });
    expect(byName.allowed).toBe(true);

    // Still does not grant direct access to combo member models.
    expect((await authorizeResource(uuidComboKey, "openai/gpt-4o", { getCombos: async () => comboCatalog })).allowed).toBe(false);
  });

  it("empty restricted = deny-all", async () => {
    expect((await authorizeResource(emptyRestricted, "openai/gpt-4o")).allowed).toBe(false);
    expect((await authorizeResource(emptyRestricted, "any")).allowed).toBe(false);
  });

  it("null key denied", async () => {
    expect((await authorizeResource(null, "m")).allowed).toBe(false);
  });

  it("isModelAllowed mirrors authorizeResource", async () => {
    expect(await isModelAllowed(restrictedKey, "openai/gpt-4o")).toBe(true);
    expect(await isModelAllowed(restrictedKey, "nope")).toBe(false);
  });
});

describe("filterCatalogByPolicy", () => {
  const catalog = [
    { id: "openai/gpt-4o" },
    { id: "openai/gpt-4o-mini" },
    { id: "combo-best" },
    { id: "alias-only" },
  ];

  it("ALL keeps full catalog", () => {
    expect(filterCatalogByPolicy(allKey, catalog)).toHaveLength(4);
  });

  it("restricted keeps only selected ids", () => {
    const out = filterCatalogByPolicy(restrictedKey, catalog);
    expect(out.map((m) => m.id).sort()).toEqual(["alias-only", "combo-best", "openai/gpt-4o"]);
  });

  it("restricted with UUID combo target keeps combo by name alias", () => {
    const out = filterCatalogByPolicy(uuidComboKey, catalog, { combos: comboCatalog });
    expect(out.map((m) => m.id)).toEqual(["combo-best"]);
  });

  it("empty restricted yields empty catalog", () => {
    expect(filterCatalogByPolicy(emptyRestricted, catalog)).toEqual([]);
  });
});

describe("normalizeTargets", () => {
  it("dedupes and drops invalid entries", () => {
    const out = normalizeTargets([
      { targetType: "model", targetId: "a" },
      { targetType: "model", targetId: "a" },
      { targetType: "combo", targetId: "b" },
      { targetType: "model", targetId: "" },
      { targetType: "nope", targetId: "c" },
      "plain-string",
    ]);
    expect(out).toEqual([
      { targetType: "model", targetId: "a" },
      { targetType: "combo", targetId: "b" },
      { targetType: "model", targetId: "plain-string" },
    ]);
  });
});

describe("modelNotAllowedResponse", () => {
  it("emits 403 OpenAI-shaped body", () => {
    const { status, body } = modelNotAllowedResponse("openai/gpt-4o");
    expect(status).toBe(403);
    expect(body.error.message).toBe("API key does not access model 'openai/gpt-4o'.");
    expect(body.error.code).toBe("model_not_allowed");
    expect(body.error.param).toBe("model");
    expect(body.error.type).toBe("invalid_request_error");
  });
});
